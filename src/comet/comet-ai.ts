import type { CometCDPClient } from "./cdp-client.js";

const INPUT_SELECTORS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

export class CometAI {
  private lastResponseText = "";
  private stableResponseCount = 0;
  private readonly STABILITY_THRESHOLD = 2;

  private pinnedLabel: string | null = null;
  private unsubLoadEvent: (() => void) | null = null;

  constructor(private readonly client: CometCDPClient) {}

  async setTabLabel(label: string | null): Promise<void> {
    this.pinnedLabel = label || null;
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

  private async applyTabLabel(label: string | null): Promise<void> {
    const prefix = label ? `[${label}]` : "";
    await this.client.evaluate(`
      (() => {
        const prefix = ${JSON.stringify(prefix)};
        const w = window;
        if (w.__cometLabelObs) { try { w.__cometLabelObs.disconnect(); } catch {} }
        w.__cometLabel = prefix;

        const stripExisting = (t) => (t || '').replace(/^\\s*\\[[^\\]]+\\]\\s*/, '');
        const apply = () => {
          const stripped = stripExisting(document.title);
          const wanted = prefix ? prefix + ' ' + stripped : stripped;
          if (document.title !== wanted) document.title = wanted;
        };
        apply();
        if (!prefix) return true;

        const titleEl = document.querySelector('title');
        const head = document.querySelector('head');
        if (!head) return false;
        const obs = new MutationObserver(() => {
          if (!document.title.startsWith(prefix)) apply();
        });
        if (titleEl) obs.observe(titleEl, { childList: true, characterData: true, subtree: true });
        obs.observe(head, { childList: true, subtree: true });
        w.__cometLabelObs = obs;
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
    const result = await this.client.evaluate(`
      (() => {
        const allowTexts = [
          'allow once', 'allow this time', 'allow',
          'einmal erlauben', 'erlauben', 'zulassen',
        ];

        const visibleButtons = [...document.querySelectorAll('button')]
          .filter((btn) => !btn.disabled && btn.offsetParent !== null);

        for (const btn of visibleButtons) {
          const t = (btn.innerText || '').trim().toLowerCase();
          if (allowTexts.some((a) => t === a || t === a + '.' || t.startsWith(a))) {
            btn.click();
            return true;
          }
        }

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
          answerEls = [...document.querySelectorAll('[class*="prose"]')]
            .filter(el => !el.closest('nav, aside, header, footer, [contenteditable], [data-ask-input-container]'));
        }
        const lastAnswer = answerEls[answerEls.length - 1] || null;
        const hasProseContent = answerEls.some(el => {
          const text = (el.innerText || '').trim();
          if (text.length < 1) return false;
          return !['Library', 'Discover', 'Spaces', 'Finance', 'Account', 'Upgrade', 'Home', 'Search'].some(ui => text.startsWith(ui));
        });

        const workingPatterns = [
          'Working', 'Searching', 'Reviewing sources', 'Preparing to assist',
          'Clicking', 'Typing:', 'Navigating to', 'Reading', 'Analyzing',
          'Browsing', 'Looking at', 'Checking', 'Opening', 'Scrolling',
          'Waiting', 'Processing',
          'Arbeite', 'Suche', 'Prüfe', 'Pr\\u00fcfe', 'Lese', 'Analysiere',
          'Klicke', 'Tippe:', 'Navigiere', 'Öffne', '\\u00d6ffne', 'Warte', 'Bereite vor'
        ];
        const hasWorkingText = workingPatterns.some(p => body.includes(p));

        let status = 'idle';

        if (awaitingInput && !hasLoadingSpinner && !hasThinkingIndicator) {
          status = 'awaiting_input';
        } else if (hasActiveStopButton) {
          status = 'working';
        } else if (hasLoadingSpinner || hasThinkingIndicator) {
          status = 'working';
        }
        else if (hasStepsCompleted || hasFinishedMarker) status = 'completed';
        else if (inputReadyForFollowUp && hasProseContent) status = 'completed';
        else if (onSearchPage && !hasActiveStopButton && hasProseContent) status = 'completed';
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
              response = validTexts.slice(-3).join('\\n\\n');
            }
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
          response: response.substring(0, 8000),
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

    const isStable = this.isResponseStable(statusResult.response);

    if (
      isStable &&
      statusResult.response.length > 50 &&
      !statusResult.hasStopButton &&
      !statusResult.awaitingInput
    ) {
      statusResult.status = "completed";
    }

    return {
      ...statusResult,
      agentBrowsingUrl,
      isStable,
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
