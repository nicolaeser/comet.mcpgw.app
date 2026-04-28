import type {
  CometCDPClient,
  WebSocketFrameEntry,
} from "./cdp-client.js";

const INPUT_SELECTORS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

interface StreamSignals {
  status: "idle" | "working" | "completed";
  response: string;
  steps: string[];
  currentStep: string;
  sawSse: boolean;
  sawAgent: boolean;
  textCompleted: boolean;
  sseClosed: boolean;
  eventCount: number;
  lastEventAt?: number;
  error?: string;
  browserTool?: string;
  agentAction?: string;
}

export class CometAI {
  private lastResponseText = "";
  private stableResponseCount = 0;
  private readonly STABILITY_THRESHOLD = 2;

  private pinnedLabel: string | null = null;
  private unsubLoadEvent: (() => void) | null = null;
  private titleHookScriptId: string | null = null;

  constructor(private readonly client: CometCDPClient) {}

  async setTabLabel(label: string | null): Promise<void> {
    this.pinnedLabel = label || null;

    if (this.pinnedLabel) {
      if (this.titleHookScriptId === null) {
        this.titleHookScriptId = await this.client.addScriptToEvaluateOnNewDocument(
          this.titleHookSource(),
        );
      }
    } else if (this.titleHookScriptId !== null) {
      await this.client.removeScriptToEvaluateOnNewDocument(this.titleHookScriptId);
      this.titleHookScriptId = null;
    }

    await this.applyTabLabel(this.pinnedLabel);

    if (this.pinnedLabel && !this.unsubLoadEvent) {
      this.unsubLoadEvent = this.client.onMainFrameLoad(() => {
        if (this.pinnedLabel === null) return;
        setTimeout(() => {
          void this.applyTabLabel(this.pinnedLabel).catch(() => {});
        }, 250);
      });
    } else if (!this.pinnedLabel && this.unsubLoadEvent) {
      this.unsubLoadEvent();
      this.unsubLoadEvent = null;
    }
  }

  private titleHookSource(): string {
    return `
      (() => {
        const w = window;
        if (w.__cometTitleHook) return;
        try {
          const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
          if (!desc || typeof desc.set !== 'function' || typeof desc.get !== 'function') return;
          const realSet = desc.set;
          const realGet = desc.get;
          w.__cometTitleRealSet = realSet;
          w.__cometTitleRealGet = realGet;
          const stripExisting = (t) => (t || '').replace(/^\\s*\\[[^\\]]+\\]\\s*/, '');
          Object.defineProperty(Document.prototype, 'title', {
            configurable: true,
            enumerable: desc.enumerable,
            get: function () { return realGet.call(this); },
            set: function (v) {
              const p = w.__cometLabel || '';
              const stripped = stripExisting(String(v == null ? '' : v));
              const wanted = p ? p + ' ' + stripped : stripped;
              realSet.call(this, wanted);
            },
          });
          w.__cometTitleHook = true;
        } catch {}
      })();
    `;
  }

  private async applyTabLabel(label: string | null): Promise<void> {
    const prefix = label ? `[${label}]` : "";
    const intervalMs = (() => {
      const raw = process.env.COMET_LABEL_REPAIR_MS;
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n >= 200 ? Math.floor(n) : 750;
    })();
    await this.client.evaluate(`
      (() => {
        const prefix = ${JSON.stringify(prefix)};
        const intervalMs = ${intervalMs};
        const w = window;
        if (w.__cometLabelObs) { try { w.__cometLabelObs.disconnect(); } catch {} }
        if (w.__cometLabelHeadObs) { try { w.__cometLabelHeadObs.disconnect(); } catch {} }
        if (w.__cometLabelTimer) { try { clearInterval(w.__cometLabelTimer); } catch {} }
        w.__cometLabel = prefix;

        const stripExisting = (t) => (t || '').replace(/^\\s*\\[[^\\]]+\\]\\s*/, '');

        if (!w.__cometTitleHook) {
          try {
            const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
            if (desc && typeof desc.set === 'function' && typeof desc.get === 'function') {
              const realSet = desc.set;
              const realGet = desc.get;
              w.__cometTitleRealSet = realSet;
              w.__cometTitleRealGet = realGet;
              Object.defineProperty(Document.prototype, 'title', {
                configurable: true,
                enumerable: desc.enumerable,
                get: function () { return realGet.call(this); },
                set: function (v) {
                  const p = w.__cometLabel || '';
                  const stripped = stripExisting(String(v == null ? '' : v));
                  const wanted = p ? p + ' ' + stripped : stripped;
                  realSet.call(this, wanted);
                },
              });
              w.__cometTitleHook = true;
            }
          } catch {}
        }

        const apply = () => {
          const stripped = stripExisting(document.title);
          const wanted = prefix ? prefix + ' ' + stripped : stripped;
          if (document.title !== wanted) {
            if (w.__cometTitleRealSet) {
              try { w.__cometTitleRealSet.call(document, wanted); return; } catch {}
            }
            document.title = wanted;
          }
        };
        apply();
        if (!prefix) return true;

        const head = document.head || document.querySelector('head');
        if (!head) return false;

        let titleObs = null;
        const bindTitle = () => {
          if (titleObs) { try { titleObs.disconnect(); } catch {} }
          const el = document.querySelector('title');
          if (!el) return;
          titleObs = new MutationObserver(() => {
            if (!document.title.startsWith(prefix)) apply();
          });
          titleObs.observe(el, { childList: true, characterData: true, subtree: true });
          w.__cometLabelObs = titleObs;
        };
        bindTitle();

        const headObs = new MutationObserver((records) => {
          for (const r of records) {
            for (const n of r.addedNodes) {
              if (n.nodeName === 'TITLE') { bindTitle(); break; }
            }
            for (const n of r.removedNodes) {
              if (n.nodeName === 'TITLE') { bindTitle(); break; }
            }
          }
          if (!document.title.startsWith(prefix)) apply();
        });
        headObs.observe(head, { childList: true });
        w.__cometLabelHeadObs = headObs;

        w.__cometLabelTimer = setInterval(() => {
          if (w.__cometLabel !== prefix) return;
          if (!document.title.startsWith(prefix)) apply();
        }, intervalMs);

        return true;
      })()
    `);
  }

  private async findInputElement(): Promise<string | null> {
    for (const selector of INPUT_SELECTORS) {
      const result = await this.client.evaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `);
      if (result.result.value === true) {
        return selector;
      }
    }
    return null;
  }

  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.findInputElement();

    if (!inputSelector) {
      throw new Error("Could not find input element. Navigate to Perplexity first.");
    }

    const focused = await this.client.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el) {
          el.focus();
          try { document.execCommand('selectAll', false, null); } catch {}
          try { document.execCommand('delete', false, null); } catch {}
          if (el.innerText && el.innerText.length > 0) {
            el.innerHTML = '';
          }
          return { kind: 'contenteditable' };
        }
        const textarea = document.querySelector('textarea');
        if (textarea) {
          textarea.focus();
          textarea.value = '';
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return { kind: 'textarea' };
        }
        return { kind: null };
      })()
    `);

    const focusKind = (focused.result.value as { kind: string | null })?.kind;
    if (!focusKind) {
      throw new Error("Failed to focus input element");
    }

    try {
      await this.client.insertText(prompt);
    } catch {

    }

    const verified = await this.client.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length > 0) return true;
        const textarea = document.querySelector('textarea');
        if (textarea && textarea.value.trim().length > 0) return true;
        return false;
      })()
    `);

    if (!verified.result.value) {
      const fallback = await this.client.evaluate(`
        (() => {
          const text = ${JSON.stringify(prompt)};
          const el = document.querySelector('[contenteditable="true"]');
          if (el) {
            el.focus();
            try {
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, text);
            } catch {}
            if (!el.innerText || el.innerText.trim().length === 0) {
              el.textContent = text;
              try {
                const dt = new DataTransfer();
                dt.setData('text/plain', text);
                el.dispatchEvent(new InputEvent('input', {
                  inputType: 'insertText',
                  data: text,
                  dataTransfer: dt,
                  bubbles: true,
                }));
              } catch {
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
            return el.innerText.trim().length > 0;
          }
          const textarea = document.querySelector('textarea');
          if (textarea) {
            textarea.focus();
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            return textarea.value.trim().length > 0;
          }
          return false;
        })()
      `);
      if (!fallback.result.value) {
        throw new Error("Failed to type into input element (foreground/background fallback also failed)");
      }
    }

    await this.submitPrompt();

    return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? "..." : ""}"`;
  }

  private async submitPrompt(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));

    const hasContent = await this.client.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length > 0) return true;
        const textarea = document.querySelector('textarea');
        if (textarea && textarea.value.trim().length > 0) return true;
        return false;
      })()
    `);

    if (!hasContent.result.value) {
      throw new Error("Prompt text not found in input - typing may have failed");
    }

    await this.client.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('textarea');
        if (!el) return { success: false, reason: 'no input element' };

        el.focus();

        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });

        el.dispatchEvent(enterEvent);

        const keyupEvent = new KeyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        });
        el.dispatchEvent(keyupEvent);

        return { success: true };
      })()
    `);

    await new Promise((resolve) => setTimeout(resolve, 800));

    const submitted = await this.client.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;
        const hasThinking = document.body.innerText.includes('Thinking');
        return hasLoading || hasThinking;
      })()
    `);
    if (submitted.result.value) return;

    await this.client.evaluate(`
      (() => {
        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="Ask"]',
          'button[type="submit"]',
          'form button[type="button"]:last-of-type',
        ];

        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return { success: true, method: 'selector', selector: sel };
          }
        }

        const inputEl = document.querySelector('[contenteditable="true"]') ||
                        document.querySelector('textarea');
        if (inputEl) {
          let parent = inputEl.parentElement;
          let candidates = [];

          for (let i = 0; i < 5 && parent; i++) {
            const btns = parent.querySelectorAll('button');
            for (const btn of btns) {
              if (btn.disabled || btn.offsetParent === null) continue;

              const btnRect = btn.getBoundingClientRect();
              const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

              if (ariaLabel.includes('search') || ariaLabel.includes('research') ||
                  ariaLabel.includes('labs') || ariaLabel.includes('learn') ||
                  ariaLabel.includes('attach') || ariaLabel.includes('voice') ||
                  ariaLabel.includes('menu') || ariaLabel.includes('more')) {
                continue;
              }

              if (btnRect.width > 0 && btnRect.height > 0) {
                candidates.push({ btn, x: btnRect.right, y: btnRect.top });
              }
            }
            parent = parent.parentElement;
          }

          if (candidates.length > 0) {
            candidates.sort((a, b) => b.x - a.x);
            candidates[0].btn.click();
            return { success: true, method: 'position' };
          }
        }

        return { success: false, reason: 'no button found' };
      })()
    `);

    await new Promise((resolve) => setTimeout(resolve, 500));

    const finalCheck = await this.client.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        const hasThinking = document.body.innerText.includes('Thinking');
        return hasLoading || hasThinking;
      })()
    `);

    if (!finalCheck.result.value) {
      await this.client.evaluate(`
        (() => {
          const form = document.querySelector('form');
          if (form) {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        })()
      `);
    }
  }

  isResponseStable(currentResponse: string): boolean {
    if (currentResponse && currentResponse.length > 50) {
      if (currentResponse === this.lastResponseText) {
        this.stableResponseCount++;
      } else {
        this.stableResponseCount = 0;
        this.lastResponseText = currentResponse;
      }
      return this.stableResponseCount >= this.STABILITY_THRESHOLD;
    }
    return false;
  }

  resetStabilityTracking(): void {
    this.lastResponseText = "";
    this.stableResponseCount = 0;
  }

  getStreamSignals(): StreamSignals {
    const sseEvents = this.client
      .getEventSourceEntries({ limit: 1000 })
      .filter(
        (entry) =>
          !entry.url ||
          entry.url.includes("/rest/sse/perplexity_ask") ||
          entry.url.includes("/rest/sse/"),
      );
    const sseRequestIds = new Set(sseEvents.map((entry) => entry.requestId));
    const sseNetworkEntries = this.client
      .getNetworkEntries({
        limit: 100,
        urlSubstring: "/rest/sse/perplexity_ask",
      })
      .filter(
        (entry) => sseRequestIds.size === 0 || sseRequestIds.has(entry.requestId),
      );
    const latestSseNetworkEntry = sseNetworkEntries.at(-1);

    const allWsFrames = this.client.getWebSocketFrames({ limit: 250 });
    const agentWsFrames = allWsFrames.filter(
      (frame) => !frame.url || frame.url.includes("/agent"),
    );
    const wsFrames = agentWsFrames.length > 0 ? agentWsFrames : allWsFrames;

    let textCompleted = false;
    let sawAgent = wsFrames.length > 0;
    let error: string | undefined;
    let browserTool: string | undefined;
    let agentAction: string | undefined;
    const steps: string[] = [];
    const responseCandidates: string[] = [];
    const responseChunks: string[] = [];

    for (const event of sseEvents) {
      const parsed = parseJsonLike(event.data);
      if (parsed === "[DONE]") {
        textCompleted = true;
        continue;
      }
      const signal = collectPayloadSignals(parsed);
      if (signal.textCompleted) textCompleted = true;
      if (signal.sawAgent) sawAgent = true;
      if (signal.error && !error) error = signal.error;
      if (signal.browserTool) browserTool = signal.browserTool;
      if (signal.agentAction) agentAction = signal.agentAction;
      steps.push(...signal.steps);
      responseCandidates.push(...signal.responseCandidates);
      responseChunks.push(...signal.responseChunks);
    }

    for (const frame of wsFrames) {
      const signal = collectWebSocketSignals(frame);
      if (signal.sawAgent) sawAgent = true;
      if (signal.agentAction) agentAction = signal.agentAction;
      if (signal.error && !error) error = signal.error;
      steps.push(...signal.steps);
    }

    const response = selectBestResponse(responseCandidates, responseChunks);
    const uniqueSteps = uniqueTail(steps.map(cleanStep).filter(Boolean), 5);
    const currentStep =
      uniqueSteps.at(-1) ||
      cleanStep(agentAction) ||
      cleanStep(browserTool) ||
      "";
    const sseClosed = Boolean(
      latestSseNetworkEntry?.durationMs !== undefined || latestSseNetworkEntry?.failed,
    );
    const sawSse = sseEvents.length > 0;
    const status =
      textCompleted || sseClosed
        ? "completed"
        : sawSse || sawAgent
        ? "working"
        : "idle";

    return {
      status,
      response,
      steps: uniqueSteps,
      currentStep,
      sawSse,
      sawAgent,
      textCompleted,
      sseClosed,
      eventCount: sseEvents.length,
      lastEventAt: sseEvents.at(-1)?.ts,
      error,
      browserTool,
      agentAction,
    };
  }

  async acceptInFlowConfirmation(opts: { allowDestructive?: boolean } = {}): Promise<{
    clicked: boolean;
    kind: "browser_control" | "destructive" | null;
    text: string;
  }> {
    const allowDestructive = Boolean(opts.allowDestructive);
    const result = await this.client.evaluate(`
      (() => {
        const SAFE = ${JSON.stringify([
          'continue', 'proceed', 'next', 'ok', 'okay', 'got it', 'understood',
          'allow', 'allow once', 'allow this time',
          'fortfahren', 'weiter', 'verstanden', 'erlauben', 'einmal erlauben', 'zulassen',
        ])};
        const DESTR = ${JSON.stringify([
          'send', 'submit', 'confirm', 'pay', 'purchase', 'buy', 'checkout',
          'place order', 'sign in', 'log in', 'authorize', 'approve', 'delete', 'post', 'publish',
          'senden', 'absenden', 'bestätigen', 'kaufen', 'bezahlen',
          'anmelden', 'einloggen', 'genehmigen', 'löschen', 'veröffentlichen',
        ])};
        const allowDestructive = ${JSON.stringify(allowDestructive)};
        const matchText = (t, list) => list.some((x) => t === x || t === x + '.' || t.startsWith(x + ' '));
        const visible = [...document.querySelectorAll('button')]
          .filter((b) => !b.disabled && b.offsetParent !== null);
        for (const btn of visible) {
          const t = (btn.innerText || '').trim().toLowerCase();
          if (!t) continue;
          if (matchText(t, SAFE)) {
            const card = btn.closest('[role="dialog"], [class*="banner"], [class*="confirm"], [class*="prompt"], div');
            const text = card ? (card.innerText || '').trim().substring(0, 400) : t;
            try { btn.click(); } catch {}
            return { clicked: true, kind: 'browser_control', text };
          }
        }
        if (allowDestructive) {
          for (const btn of visible) {
            const t = (btn.innerText || '').trim().toLowerCase();
            if (!t) continue;
            if (matchText(t, DESTR)) {
              const card = btn.closest('[role="dialog"], [class*="banner"], [class*="confirm"], [class*="prompt"], [class*="card"]');
              if (!card) continue;
              const text = (card.innerText || '').trim().substring(0, 400);
              try { btn.click(); } catch {}
              return { clicked: true, kind: 'destructive', text };
            }
          }
        }
        return { clicked: false, kind: null, text: '' };
      })()
    `);
    return result.result.value as { clicked: boolean; kind: "browser_control" | "destructive" | null; text: string };
  }

  async acceptBrowserControlBanner(): Promise<boolean> {
    const inFlow = await this.acceptInFlowConfirmation({ allowDestructive: false });
    if (inFlow.clicked) return true;
    const result = await this.client.evaluate(`
      (() => {
        for (const useEl of document.querySelectorAll('svg use')) {
          const href = useEl.getAttribute('xlink:href') || useEl.getAttribute('href');
          if (href !== '#pplx-icon-click') continue;
          const banner = useEl.closest('[class*="banner"], .relative, div');
          if (!banner) continue;
          const primary = [...banner.querySelectorAll('button')].find((btn) => {
            if (btn.disabled || btn.offsetParent === null) return false;
            const cls = btn.className || '';
            return /bg-button-bg/.test(cls);
          });
          if (primary) { primary.click(); return true; }
        }
        return false;
      })()
    `);
    return Boolean(result.result.value);
  }

  async getAnswerSnapshot(): Promise<{ count: number; lastLength: number; lastText: string }> {
    const result = await this.client.evaluate(`
      (() => {
        let els = [...document.querySelectorAll('[id^="markdown-content-"]')];
        if (els.length === 0) {
          els = [...document.querySelectorAll('[class*="prose"]')]
            .filter((el) => !el.closest('[contenteditable], [data-ask-input-container]'));
        }
        const last = els[els.length - 1];
        const text = last ? (last.innerText || '') : '';
        return {
          count: els.length,
          lastLength: text.length,
          lastText: text.substring(0, 100),
        };
      })()
    `);
    return result.result.value as { count: number; lastLength: number; lastText: string };
  }

  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed" | "awaiting_input";
    steps: string[];
    currentStep: string;
    response: string;
    hasStopButton: boolean;
    agentBrowsingUrl: string;
    isStable: boolean;
    surface: "sidecar" | "thread" | "home";
    awaitingInput: boolean;
    confirmationPrompt: string;
    confirmationKind: "browser_control" | "safe" | "destructive" | "unknown" | null;
    stream: {
      status: "idle" | "working" | "completed";
      sawSse: boolean;
      sawAgent: boolean;
      textCompleted: boolean;
      sseClosed: boolean;
      eventCount: number;
      responseLength: number;
      currentStep: string;
      lastEventAt?: number;
      error?: string;
    };
  }> {
    let agentBrowsingUrl = "";
    try {
      const tab = await this.client.findOwnAgentBrowsingTab();
      if (tab) agentBrowsingUrl = tab.url;
    } catch {

    }

    const result = await this.client.safeEvaluate(`
      (() => {
        const body = document.body.innerText;
        const url = location.href;
        const onSearchPage = /\\/search\\//.test(url);
        const onSidecar = /\\/sidecar(\\b|\\/|\\?|$)/.test(url) || document.documentElement.getAttribute('data-erp') === 'sidecar';

        let hasActiveStopButton = false;
        for (const btn of document.querySelectorAll('button')) {
          if (btn.disabled || btn.offsetParent === null) continue;
          const use = btn.querySelector('svg use');
          const href = use && (use.getAttribute('xlink:href') || use.getAttribute('href'));
          if (href === '#pplx-icon-player-stop-filled' || href === '#pplx-icon-player-stop') {
            hasActiveStopButton = true;
            break;
          }
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('stop') || aria.includes('cancel') || aria.includes('stoppen') || aria.includes('abbrechen')) {
            hasActiveStopButton = true;
            break;
          }
        }

        const SAFE_CONFIRM_TEXTS = [
          'continue', 'proceed', 'next', 'ok', 'okay', 'got it', 'understood',
          'allow', 'allow once', 'allow this time',
          'fortfahren', 'weiter', 'verstanden', 'erlauben', 'einmal erlauben', 'zulassen',
        ];
        const DESTRUCTIVE_CONFIRM_TEXTS = [
          'send', 'submit', 'confirm', 'pay', 'purchase', 'buy', 'checkout',
          'place order', 'sign in', 'log in', 'authorize', 'approve', 'delete', 'post', 'publish',
          'senden', 'absenden', 'bestätigen', 'best\\u00e4tigen', 'kaufen', 'bezahlen',
          'anmelden', 'einloggen', 'genehmigen', 'löschen', 'l\\u00f6schen', 'veröffentlichen', 'ver\\u00f6ffentlichen',
        ];
        const matchText = (txt, list) => list.some((t) => txt === t || txt === t + '.' || txt.startsWith(t + ' '));

        let confirmationKind = null;
        let confirmationPrompt = '';

        const allowVisible = [...document.querySelectorAll('button')]
          .filter((b) => !b.disabled && b.offsetParent !== null);
        for (const btn of allowVisible) {
          const t = (btn.innerText || '').trim().toLowerCase();
          if (!t) continue;
          if (matchText(t, SAFE_CONFIRM_TEXTS)) {
            const card = btn.closest('[role="dialog"], [class*="banner"], [class*="confirm"], [class*="prompt"], form, section, article, div');
            confirmationKind = 'browser_control';
            const ctxText = card ? (card.innerText || '').trim() : (btn.innerText || '').trim();
            confirmationPrompt = ctxText.substring(0, 400);
            break;
          }
        }
        if (!confirmationKind) {
          for (const btn of allowVisible) {
            const t = (btn.innerText || '').trim().toLowerCase();
            if (!t) continue;
            if (matchText(t, DESTRUCTIVE_CONFIRM_TEXTS)) {
              const card = btn.closest('[role="dialog"], [class*="banner"], [class*="confirm"], [class*="prompt"], [class*="card"]');
              if (!card) continue;
              const ctxText = (card.innerText || '').trim();
              const looksLikeAgentCard = /agent|comet|assistant|allow|confirm|verify|review|proceed|send|order|pay/i.test(ctxText);
              if (!looksLikeAgentCard) continue;
              confirmationKind = 'destructive';
              confirmationPrompt = ctxText.substring(0, 400);
              break;
            }
          }
        }
        if (!confirmationKind) {
          for (const useEl of document.querySelectorAll('svg use')) {
            const href = useEl.getAttribute('xlink:href') || useEl.getAttribute('href');
            if (href !== '#pplx-icon-click') continue;
            const banner = useEl.closest('[class*="banner"], .relative, div');
            if (!banner) continue;
            confirmationKind = 'browser_control';
            confirmationPrompt = (banner.innerText || '').trim().substring(0, 400);
            break;
          }
        }
        const awaitingInput = confirmationKind !== null;

        let inputReadyForFollowUp = false;
        const askInput = document.getElementById('ask-input');
        if (askInput) {
          const ph = (askInput.getAttribute('aria-placeholder') || '').toLowerCase();
          if (
            ph.includes('follow-up') || ph.includes('follow up') ||
            ph.includes('nachfrage') || ph.includes('folgefrage') ||
            ph.includes('ask anything') || ph.includes('was möchten')
          ) {
            inputReadyForFollowUp = true;
          }
        }

        const hasLoadingSpinner = document.querySelector(
          '[class*="animate-spin"], [class*="animate-pulse"], [class*="loading"], [class*="thinking"]'
        ) !== null;

        const hasThinkingIndicator = body.includes('Thinking') && !body.includes('Thinking about');

        const hasStepsCompleted =
          /\\d+ steps? completed/i.test(body) ||
          /\\d+\\s*Schritte?\\s*abgeschlossen/i.test(body);
        const hasFinishedMarker =
          (body.includes('Finished') || body.includes('Fertig') || body.includes('Abgeschlossen')) &&
          !hasActiveStopButton;
        const hasReviewedSources =
          /Reviewed \\d+ sources?/i.test(body) ||
          /\\d+\\s*Quellen?\\s*(geprüft|gepr\\u00fcft|gesichtet)/i.test(body);
        const hasSourcesIndicator = /\\d+\\s*(sources?|quellen?)/i.test(body);
        const hasAskFollowUp =
          body.includes('Ask a follow-up') ||
          body.includes('Ask follow-up') ||
          body.includes('Folgefrage') ||
          body.includes('Nachfrage');

        let answerEls = [...document.querySelectorAll('[id^="markdown-content-"]')];
        if (answerEls.length === 0) {
          answerEls = [...document.querySelectorAll(
            '[class*="prose"], [data-message-author-role="assistant"], [data-role="assistant"], ' +
            '[data-testid*="assistant"], [data-testid*="message"], [class*="assistant-message"], ' +
            '[class*="MessageBubble"], [class*="message-bubble"], [class*="chat-message"]'
          )]
            .filter(el => !el.closest('nav, aside, header, footer, [contenteditable], [data-ask-input-container]'));
        }
        const lastAnswer = answerEls[answerEls.length - 1] || null;
        const hasProseContent = answerEls.some(el => {
          const text = (el.innerText || '').trim();
          if (text.length < 1) return false;
          return !['Library', 'Discover', 'Spaces', 'Finance', 'Account', 'Upgrade', 'Home', 'Search'].some(ui => text.startsWith(ui));
        });

        const agenticCompletionPatterns = [
          "I've completed", "I have completed", "Task complete", "Task completed",
          "I've finished", "I have finished", "Here's what I found", "Here is what I found",
          "Here's what I did", "Here is what I did", "Done.", "All done",
          "Successfully completed", "Aufgabe abgeschlossen", "Fertig.", "Erledigt"
        ];
        const hasAgenticCompletion = agenticCompletionPatterns.some(p => body.includes(p));

        const workingPatterns = [
          'Working', 'Searching', 'Reviewing sources', 'Preparing to assist',
          'Clicking', 'Typing:', 'Navigating to', 'Reading', 'Analyzing',
          'Browsing', 'Looking at', 'Checking', 'Opening', 'Scrolling',
          'Waiting', 'Processing',
          'Arbeite', 'Suche', 'Prüfe', 'Pr\\u00fcfe', 'Lese', 'Analysiere',
          'Klicke', 'Tippe:', 'Navigiere', 'Öffne', '\\u00d6ffne', 'Warte', 'Bereite vor'
        ];
        const hasWorkingText = workingPatterns.some(p => body.includes(p));

        const declinePatterns = [
          'Cancelled', 'Canceled', 'Declined', 'Denied', 'Action declined',
          'Permission denied', 'Stopped by user',
          'Abgebrochen', 'Abgelehnt', 'Verweigert',
        ];
        const declineHit = declinePatterns.find((p) => body.includes(p));
        const wasDeclined = Boolean(declineHit) && !hasActiveStopButton && !hasLoadingSpinner;

        let status = 'idle';

        if (wasDeclined) {
          status = 'completed';
        } else if (awaitingInput && !hasLoadingSpinner && !hasThinkingIndicator) {
          status = 'awaiting_input';
        } else if (hasActiveStopButton) {
          status = 'working';
        } else if (hasLoadingSpinner || hasThinkingIndicator) {
          status = 'working';
        }
        else if (hasStepsCompleted || hasFinishedMarker) status = 'completed';
        else if (hasAgenticCompletion && !hasActiveStopButton && !hasLoadingSpinner) status = 'completed';
        else if (inputReadyForFollowUp && hasProseContent) status = 'completed';
        else if (onSearchPage && !hasActiveStopButton && hasProseContent) status = 'completed';
        else if (onSidecar && !hasActiveStopButton && !hasLoadingSpinner && hasProseContent) status = 'completed';
        else if (hasAskFollowUp && hasProseContent) status = 'completed';
        else if (hasSourcesIndicator && hasProseContent) status = 'completed';
        else if (hasReviewedSources) status = 'completed';
        else if (hasWorkingText) status = 'working';

        const steps = [];
        const stepPatterns = [
          /Preparing to assist[^\\n]*/g, /Clicking[^\\n]*/g, /Typing:[^\\n]*/g,
          /Navigating[^\\n]*/g, /Reading[^\\n]*/g, /Searching[^\\n]*/g, /Found[^\\n]*/g,
          /Arbeite[^\\n]*/g, /Suche[^\\n]*/g, /Lese[^\\n]*/g, /Klicke[^\\n]*/g,
          /Tippe:[^\\n]*/g, /Navigiere[^\\n]*/g, /Pr\\u00fcfe[^\\n]*/g
        ];
        for (const pattern of stepPatterns) {
          const matches = body.match(pattern);
          if (matches) steps.push(...matches.map(s => s.trim().substring(0, 100)));
        }

        let response = '';
        if (status === 'completed') {
          const mainContent = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
          const bodyText = mainContent.innerText;

          if (lastAnswer) {
            const t = (lastAnswer.innerText || '').trim();
            if (t.length > 0) response = t;
          }

          const stepsMatch =
            bodyText.match(/(\\d+)\\s*steps?\\s*completed/i) ||
            bodyText.match(/(\\d+)\\s*Schritte?\\s*abgeschlossen/i);
          if (stepsMatch) {
            const markerIndex = bodyText.indexOf(stepsMatch[0]);
            if (markerIndex !== -1) {
              let afterMarker = bodyText.substring(markerIndex + stepsMatch[0].length).trim();
              afterMarker = afterMarker.replace(/^[>›→\\s]+/, '').trim();

              const endMarkers = [
                'Ask anything', 'Ask a follow-up', 'Add details', 'Type a message',
                'Fragen Sie irgendetwas', 'Folgefrage', 'Nachfrage'
              ];
              let endIndex = afterMarker.length;
              for (const marker of endMarkers) {
                const idx = afterMarker.indexOf(marker);
                if (idx !== -1 && idx < endIndex) {
                  endIndex = idx;
                }
              }

              response = afterMarker.substring(0, endIndex).trim();
            }
          }

          if (!response || response.length < 1) {
            const sourcesMatch = bodyText.match(/Reviewed\\s+\\d+\\s+sources?/i);
            if (sourcesMatch) {
              const markerIndex = bodyText.indexOf(sourcesMatch[0]);
              if (markerIndex !== -1) {
                let afterMarker = bodyText.substring(markerIndex + sourcesMatch[0].length).trim();
                const endMarkers = ['Ask anything', 'Ask a follow-up', 'Add details'];
                let endIndex = afterMarker.length;
                for (const marker of endMarkers) {
                  const idx = afterMarker.indexOf(marker);
                  if (idx !== -1 && idx < endIndex) endIndex = idx;
                }
                response = afterMarker.substring(0, endIndex).trim();
              }
            }
          }

          if (!response || response.length < 1) {
            const allProseEls = [...mainContent.querySelectorAll('[class*="prose"]')];
            const validTexts = allProseEls
              .filter(el => {
                if (el.closest('nav, aside, header, footer, form, [contenteditable], [data-ask-input-container]')) return false;
                const text = el.innerText.trim();
                const isUIText = ['Library', 'Discover', 'Spaces', 'Finance', 'Account',
                                  'Upgrade', 'Home', 'Search'].some(ui => text.startsWith(ui));
                return !isUIText && text.length > 0;
              })
              .map(el => el.innerText.trim());
            if (validTexts.length > 0) {
              const seen = new Set();
              const unique = [];
              for (const t of validTexts) {
                const key = t.substring(0, 120);
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(t);
              }
              response = unique.slice(-3).join('\\n\\n');
            }
          }

          if (wasDeclined && (!response || response.length < 5)) {
            response = 'Comet reported: ' + declineHit;
          }

          if (response) {
            response = response
              .replace(/View All/gi, '')
              .replace(/Show more/gi, '')
              .replace(/Ask a follow-up/gi, '')
              .replace(/Ask anything\\.*/gi, '')
              .replace(/Fragen Sie irgendetwas\\.*/gi, '')
              .replace(/Folgefrage stellen\\.*/gi, '')
              .replace(/Add details to this task\\.*/gi, '')
              .replace(/\\d+\\s*(sources?|quellen?)\\s*$/gi, '')
              .replace(/[\\u{1F300}-\\u{1F9FF}]/gu, '')
              .replace(/^[>›→\\s]+/gm, '')
              .replace(/\\n{3,}/g, '\\n\\n')
              .trim();
          }
        }

        return {
          status,
          steps: [...new Set(steps)].slice(-5),
          currentStep: steps.length > 0 ? steps[steps.length - 1] : '',
          response: response.substring(0, 32000),
          hasStopButton: hasActiveStopButton,
          surface: onSidecar ? 'sidecar' : (onSearchPage ? 'thread' : 'home'),
          awaitingInput,
          confirmationPrompt,
          confirmationKind
        };
      })()
    `);

    const statusResult = result.result.value as {
      status: "idle" | "working" | "completed" | "awaiting_input";
      steps: string[];
      currentStep: string;
      response: string;
      hasStopButton: boolean;
      surface: "sidecar" | "thread" | "home";
      awaitingInput: boolean;
      confirmationPrompt: string;
      confirmationKind: "browser_control" | "safe" | "destructive" | "unknown" | null;
    };

    const stream = this.getStreamSignals();
    let response = statusResult.response;
    if (
      stream.response &&
      (!response || (stream.textCompleted && stream.response.length > response.length * 1.15))
    ) {
      response = stream.response;
    }

    const combinedSteps = uniqueTail(
      [...statusResult.steps, ...stream.steps].map(cleanStep).filter(Boolean),
      5,
    );
    const currentStep =
      statusResult.currentStep || stream.currentStep || combinedSteps.at(-1) || "";

    let combinedStatus = statusResult.status;
    if (
      stream.status === "completed" &&
      !statusResult.awaitingInput &&
      (response || !statusResult.hasStopButton)
    ) {
      combinedStatus = "completed";
    } else if (
      stream.status === "working" &&
      combinedStatus === "idle" &&
      !statusResult.awaitingInput
    ) {
      combinedStatus = "working";
    }

    const isStable = this.isResponseStable(response);

    if (
      isStable &&
      response.length > 50 &&
      !statusResult.hasStopButton &&
      !statusResult.awaitingInput
    ) {
      combinedStatus = "completed";
    }

    return {
      ...statusResult,
      status: combinedStatus,
      steps: combinedSteps.length > 0 ? combinedSteps : statusResult.steps,
      currentStep,
      response,
      agentBrowsingUrl,
      isStable,
      stream: {
        status: stream.status,
        sawSse: stream.sawSse,
        sawAgent: stream.sawAgent,
        textCompleted: stream.textCompleted,
        sseClosed: stream.sseClosed,
        eventCount: stream.eventCount,
        responseLength: stream.response.length,
        currentStep: stream.currentStep,
        lastEventAt: stream.lastEventAt,
        error: stream.error,
      },
    };
  }

  async stopAgent(): Promise<boolean> {
    const result = await this.client.evaluate(`
      (() => {
        for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')) {
          btn.click();
          return true;
        }
        for (const btn of document.querySelectorAll('button')) {
          if (btn.querySelector('svg rect')) {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }

  async isComputerModeActive(): Promise<boolean> {
    const result = await this.client.evaluate(`
      (() => {
        if (/\\/computer(\\b|\\/|\\?|$)/.test(location.pathname)) return true;

        const haystack = [
          ...document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], [role="option"]'),
        ];
        for (const el of haystack) {
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const txt = (el.textContent || '').trim().toLowerCase();
          const isComputerLabel =
            aria === 'computer' || txt === 'computer' ||
            aria.includes('computer mode') || txt.includes('computer mode') ||
            aria.startsWith('computer ') || txt.startsWith('computer ');
          let isComputerByIcon = false;
          if (!isComputerLabel) {
            const use = el.querySelector('svg use');
            const href = use && (use.getAttribute('xlink:href') || use.getAttribute('href'));
            isComputerByIcon =
              href === '#pplx-icon-custom-computer' ||
              href === '#pplx-icon-custom-computer-dashboard-check' ||
              href === '#pplx-icon-custom-perplexity-v2v';
          }
          if (!isComputerLabel && !isComputerByIcon) continue;
          const ariaChecked =
            el.getAttribute('aria-pressed') === 'true' ||
            el.getAttribute('data-state') === 'checked' ||
            el.getAttribute('aria-selected') === 'true' ||
            (el.classList && el.classList.contains('selected'));
          if (ariaChecked) return true;
          if (el.classList && el.classList.contains('bg-quiet')) return true;
        }
        return false;
      })()
    `);
    return Boolean(result.result.value);
  }

  async ensureComputerModeOff(): Promise<{ wasOn: boolean; turnedOff: boolean }> {
    const wasOn = await this.isComputerModeActive();
    if (!wasOn) return { wasOn: false, turnedOff: false };

    const onComputerPage = await this.client.evaluate(
      `/\\/computer(\\b|\\/|\\?|$)/.test(location.pathname)`,
    );
    if (onComputerPage.result.value) {
      try {
        await this.client.navigate("https://www.perplexity.ai/", true);
        await new Promise((r) => setTimeout(r, 1500));
      } catch {}
    }

    await this.client.evaluate(`
      (() => {
        const haystack = [
          ...document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], [role="option"]'),
        ];
        for (const el of haystack) {
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const txt = (el.textContent || '').trim().toLowerCase();
          const isComputerLabel =
            aria === 'computer' || txt === 'computer' ||
            aria.includes('computer mode') || txt.includes('computer mode') ||
            aria.startsWith('computer ') || txt.startsWith('computer ');
          let isComputerByIcon = false;
          if (!isComputerLabel) {
            const use = el.querySelector('svg use');
            const href = use && (use.getAttribute('xlink:href') || use.getAttribute('href'));
            isComputerByIcon =
              href === '#pplx-icon-custom-computer' ||
              href === '#pplx-icon-custom-computer-dashboard-check' ||
              href === '#pplx-icon-custom-perplexity-v2v';
          }
          if (!isComputerLabel && !isComputerByIcon) continue;
          const ariaChecked =
            el.getAttribute('aria-pressed') === 'true' ||
            el.getAttribute('data-state') === 'checked' ||
            el.getAttribute('aria-selected') === 'true' ||
            (el.classList && el.classList.contains('selected'));
          const bgQuiet = el.classList && el.classList.contains('bg-quiet');
          if (!ariaChecked && !bgQuiet) continue;
          try { el.click(); } catch {}
        }
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 400));

    const turnedOff = !(await this.isComputerModeActive());
    return { wasOn: true, turnedOff };
  }

  async getCurrentMode(): Promise<"search" | "research" | "labs" | "learn" | "unknown"> {
    const result = await this.client.evaluate(`
      (() => {
        for (const m of ['Search', 'Research', 'Labs', 'Learn']) {
          const btn = document.querySelector('button[aria-label="' + m + '"]');
          if (btn && btn.getAttribute('data-state') === 'checked') return m.toLowerCase();
        }
        const pill = document.querySelector('[data-ask-input-container="true"] button .truncate');
        if (pill) {
          const t = pill.innerText.trim().toLowerCase();
          if (t.startsWith('search') || t.startsWith('suche')) return 'search';
          if (t.startsWith('research') || t.startsWith('recherche')) return 'research';
          if (t.startsWith('labs') || t.startsWith('labor')) return 'labs';
          if (t.startsWith('learn') || t.startsWith('lernen')) return 'learn';
        }
        return 'unknown';
      })()
    `);
    return result.result.value as "search" | "research" | "labs" | "learn" | "unknown";
  }

  async setMode(mode: "search" | "research" | "labs" | "learn"): Promise<{ success: boolean; error?: string }> {
    const aria = mode.charAt(0).toUpperCase() + mode.slice(1);
    const aliases: Record<string, string[]> = {
      search:   ["search", "suche", "suchen"],
      research: ["research", "recherche", "tiefenrecherche"],
      labs:     ["labs", "labor"],
      learn:    ["learn", "lernen"],
    };
    const click = await this.client.evaluate(`
      (() => {
        const btn = document.querySelector('button[aria-label="${aria}"]');
        if (btn) { btn.click(); return { success: true, needsSelect: false }; }
        const pillBtn = document.querySelector('[data-ask-input-container="true"] button .truncate');
        const wrap = pillBtn && pillBtn.closest('button');
        if (wrap) { wrap.click(); return { success: true, needsSelect: true }; }
        return { success: false, error: 'Mode selector not found' };
      })()
    `);
    const cr = click.result.value as { success: boolean; needsSelect: boolean; error?: string };
    if (!cr.success) return { success: false, error: cr.error ?? "click failed" };
    if (!cr.needsSelect) return { success: true };
    await new Promise((r) => setTimeout(r, 300));
    const sel = await this.client.evaluate(`
      (() => {
        const wanted = ${JSON.stringify(aliases[mode])};
        const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
        for (const item of items) {
          const t = (item.innerText || '').trim().toLowerCase();
          if (!t) continue;
          if (wanted.some((w) => t === w || t.startsWith(w))) { item.click(); return { success: true }; }
        }
        document.body.click();
        return { success: false, error: 'mode not exposed in current menu' };
      })()
    `);
    return sel.result.value as { success: boolean; error?: string };
  }
}

interface PayloadSignals {
  textCompleted: boolean;
  sawAgent: boolean;
  steps: string[];
  responseCandidates: string[];
  responseChunks: string[];
  error?: string;
  browserTool?: string;
  agentAction?: string;
}

function emptyPayloadSignals(): PayloadSignals {
  return {
    textCompleted: false,
    sawAgent: false,
    steps: [],
    responseCandidates: [],
    responseChunks: [],
  };
}

function parseJsonLike(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "[DONE]") return "[DONE]";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function collectWebSocketSignals(frame: WebSocketFrameEntry): PayloadSignals {
  const parsed = parseJsonLike(frame.payloadData);
  const signals = collectPayloadSignals(parsed);
  if (frame.url?.includes("/agent")) {
    signals.sawAgent = true;
  }
  return signals;
}

function collectPayloadSignals(value: unknown): PayloadSignals {
  const out = emptyPayloadSignals();
  visitPayload(value, [], out);
  return out;
}

function visitPayload(
  value: unknown,
  path: string[],
  out: PayloadSignals,
): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) visitPayload(item, path, out);
    return;
  }

  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    const nextPath = [...path, lowerKey];

    if (lowerKey.includes("entropy_request") || lowerKey === "browser_tool") {
      out.sawAgent = true;
    }

    if (
      typeof child === "boolean" &&
      (lowerKey === "text_completed" ||
        lowerKey === "textcompleted" ||
        lowerKey === "completed" ||
        lowerKey === "done")
    ) {
      out.textCompleted = out.textCompleted || child;
    }

    if (typeof child === "string") {
      const text = child.trim();
      if (!text) continue;

      if (lowerKey === "step_type") {
        out.browserTool = text;
        if (text === "ENTROPY_REQUEST") out.sawAgent = true;
      } else if (lowerKey === "action") {
        out.agentAction = text;
        out.sawAgent = true;
      } else if (lowerKey === "path" || lowerKey === "status" || lowerKey.includes("step")) {
        if (text.length <= 200) out.steps.push(text);
      } else if (lowerKey.includes("error")) {
        out.error = out.error ?? text.substring(0, 500);
      }

      if (isLikelyResponseKey(lowerKey, nextPath) && isLikelyResponseText(text)) {
        if (isChunkKey(lowerKey)) {
          out.responseChunks.push(text);
        } else {
          out.responseCandidates.push(text);
        }
      }
    }

    visitPayload(child, nextPath, out);
  }
}

function isLikelyResponseKey(key: string, path: string[]): boolean {
  if (key === "text_completed") return false;
  if (
    key.includes("uuid") ||
    key.endsWith("id") ||
    key.includes("_id") ||
    key.includes("url") ||
    key.includes("slug") ||
    key.includes("model") ||
    key.includes("source") ||
    key.includes("mode") ||
    key.includes("header") ||
    key.includes("path")
  ) {
    return false;
  }

  if (
    [
      "answer",
      "content",
      "delta",
      "final_answer",
      "markdown",
      "message",
      "output",
      "response",
      "text",
      "token",
    ].includes(key)
  ) {
    return true;
  }

  return path.some((part) =>
    ["answer", "assistant", "content", "message", "response"].includes(part),
  );
}

function isChunkKey(key: string): boolean {
  return key === "delta" || key === "token";
}

function isLikelyResponseText(text: string): boolean {
  if (text.length < 2) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^[a-f0-9-]{20,}$/i.test(text)) return false;
  if (/^[A-Z_]+$/.test(text) && text.length < 40) return false;
  if (/^[\[{].*[\]}]$/.test(text) && text.length > 500) return false;
  return true;
}

function selectBestResponse(candidates: string[], chunks: string[]): string {
  const bestCandidate =
    candidates
      .map(cleanResponse)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] ?? "";
  const joinedChunks = cleanResponse(chunks.join(""));

  if (!bestCandidate) return joinedChunks.substring(0, 32_000);
  if (joinedChunks.length > bestCandidate.length * 2 && bestCandidate.length < 500) {
    return joinedChunks.substring(0, 32_000);
  }
  return bestCandidate.substring(0, 32_000);
}

function cleanResponse(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function cleanStep(step: string | undefined): string {
  if (!step) return "";
  return step
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 140);
}

function uniqueTail(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique.slice(-limit);
}
