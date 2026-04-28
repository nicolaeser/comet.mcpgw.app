import CDP from "chrome-remote-interface";
import type {
  CDPTarget,
  CDPVersion,
  CometState,
  EvaluateResult,
  NavigateResult,
  ScreenshotResult,
} from "./types.js";

const HTTP_TIMEOUT_MS = 5_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const EVALUATE_TIMEOUT_MS = Number(process.env.COMET_EVALUATE_TIMEOUT_MS ?? 8_000);

export interface CDPConfig {
  cdpHost: string;
  cdpPort: number;
  cdpHttpBase: string;
}

export function loadCDPConfig(): CDPConfig {
  const raw = process.env.COMET_CDP_URL ?? "http://host.docker.internal:9222";
  const url = new URL(raw);
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  return {
    cdpHost: url.hostname,
    cdpPort: port,
    cdpHttpBase: `${url.protocol}//${url.hostname}:${port}`,
  };
}

async function fetchJson<T>(url: string, method: "GET" | "PUT" = "GET"): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`CDP HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function cdpGetVersion(config?: CDPConfig): Promise<CDPVersion> {
  const c = config ?? loadCDPConfig();
  return fetchJson<CDPVersion>(`${c.cdpHttpBase}/json/version`);
}

export async function cdpListTargets(config?: CDPConfig): Promise<CDPTarget[]> {
  const c = config ?? loadCDPConfig();
  return fetchJson<CDPTarget[]>(`${c.cdpHttpBase}/json/list`);
}

export async function cdpNewTab(url?: string, config?: CDPConfig): Promise<CDPTarget> {
  const c = config ?? loadCDPConfig();
  const endpoint = url
    ? `${c.cdpHttpBase}/json/new?${encodeURIComponent(url)}`
    : `${c.cdpHttpBase}/json/new`;
  return fetchJson<CDPTarget>(endpoint, "PUT");
}

export async function cdpCloseTab(targetId: string, config?: CDPConfig): Promise<boolean> {
  const c = config ?? loadCDPConfig();
  try {
    await fetchJson(`${c.cdpHttpBase}/json/close/${targetId}`);
    return true;
  } catch {
    return false;
  }
}

export interface ConsoleEntry {
  ts: number;
  level: string;
  text: string;
  url?: string;
  line?: number;
}

export interface NetworkEntry {
  ts: number;
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  encodedDataLength?: number;
  durationMs?: number;
  failed?: boolean;
  failureReason?: string;
}

export interface EventSourceEntry {
  ts: number;
  requestId: string;
  url?: string;
  eventName: string;
  eventId?: string;
  data: string;
}

export interface WebSocketFrameEntry {
  ts: number;
  requestId: string;
  url?: string;
  direction: "sent" | "received";
  opcode?: number;
  mask?: boolean;
  payloadData: string;
}

const MAX_CONSOLE = Number(process.env.COMET_MAX_CONSOLE ?? 500);
const MAX_NETWORK = Number(process.env.COMET_MAX_NETWORK ?? 500);
const MAX_EVENT_SOURCE = Number(process.env.COMET_MAX_EVENT_SOURCE ?? 1000);
const MAX_WEBSOCKET = Number(process.env.COMET_MAX_WEBSOCKET ?? 1000);

export class CometCDPClient {
  private config: CDPConfig;
  private client: CDP.Client | null = null;
  private state: CometState = { connected: false };

  private ownedTargetId: string | undefined;

  private childTargetIds = new Set<string>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isReconnecting = false;
  private lastHealthCheck = 0;
  private healthCheckCache = false;
  private readonly HEALTH_CHECK_CACHE_MS = 2_000;

  private consoleBuffer: ConsoleEntry[] = [];
  private networkBuffer: NetworkEntry[] = [];
  private networkInFlight = new Map<string, NetworkEntry>();
  private networkUrlByRequestId = new Map<string, string>();
  private eventSourceBuffer: EventSourceEntry[] = [];
  private webSocketBuffer: WebSocketFrameEntry[] = [];

  private mainFrameLoadCbs = new Set<() => void>();

  onMainFrameLoad(cb: () => void): () => void {
    this.mainFrameLoadCbs.add(cb);
    return () => {
      this.mainFrameLoadCbs.delete(cb);
    };
  }

  constructor(config?: CDPConfig) {
    this.config = config ?? loadCDPConfig();
  }

  get isConnected(): boolean {
    return this.state.connected && this.client !== null;
  }

  get currentState(): CometState {
    return { ...this.state };
  }

  get cdpEndpoint(): string {
    return this.config.cdpHttpBase;
  }

  get targetId(): string | undefined {
    return this.ownedTargetId;
  }

  get childTargets(): string[] {
    return [...this.childTargetIds];
  }

  async isConnectionHealthy(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastHealthCheck < this.HEALTH_CHECK_CACHE_MS) {
      return this.healthCheckCache;
    }
    if (!this.client) {
      this.healthCheckCache = false;
      this.lastHealthCheck = now;
      return false;
    }
    try {
      await this.client.Runtime.evaluate({
        expression: "1+1",
        timeout: 3_000,
      } as unknown as Parameters<typeof this.client.Runtime.evaluate>[0]);
      this.healthCheckCache = true;
      this.lastHealthCheck = now;
      return true;
    } catch {
      this.healthCheckCache = false;
      this.lastHealthCheck = now;
      return false;
    }
  }

  invalidateHealthCache(): void {
    this.lastHealthCheck = 0;
    this.healthCheckCache = false;
  }

  async ensureConnection(): Promise<void> {
    if (!(await this.isConnectionHealthy())) {
      this.invalidateHealthCache();
      await this.reconnect();
    }
  }

  async preOperationCheck(): Promise<void> {
    if (!this.client) {
      await this.reconnect();
      return;
    }
    if (
      Date.now() - this.lastHealthCheck < this.HEALTH_CHECK_CACHE_MS &&
      this.healthCheckCache
    ) {
      return;
    }
    if (!(await this.isConnectionHealthy())) {
      this.invalidateHealthCache();
      await this.reconnect();
    }
  }

  async getVersion(): Promise<CDPVersion> {
    return cdpGetVersion(this.config);
  }

  async listTargets(): Promise<CDPTarget[]> {
    return cdpListTargets(this.config);
  }

  async newTab(url?: string): Promise<CDPTarget> {
    return cdpNewTab(url, this.config);
  }

  async closeTab(targetId: string): Promise<boolean> {
    if (this.client) {
      try {
        const result = await this.client.Target.closeTarget({ targetId });
        return result.success;
      } catch {

      }
    }
    return cdpCloseTab(targetId, this.config);
  }

  async findOwnAgentBrowsingTab(): Promise<CDPTarget | null> {
    if (!this.ownedTargetId) return null;
    const targets = await this.listTargets();

    if (this.childTargetIds.size > 0) {
      for (const t of targets) {
        if (!this.childTargetIds.has(t.id)) continue;
        if (t.type !== "page") continue;
        if (t.url.includes("perplexity.ai")) continue;
        if (t.url.includes("chrome-extension")) continue;
        if (t.url.includes("chrome://")) continue;
        if (t.url.startsWith("devtools://")) continue;
        if (t.url === "about:blank") continue;
        return t;
      }
    }

    const ownTab = targets.find((t) => t.id === this.ownedTargetId);
    const ownUrl = ownTab?.url ?? "";
    const sidecarThreadId = (() => {
      const m = ownUrl.match(/\/sidecar\/(?:search|thread|library)\/([a-f0-9-]+)/i);
      return m ? m[1] : null;
    })();

    const overlays = targets.filter(
      (t) =>
        t.type === "page" &&
        /chrome-extension:\/\/[^/]+\/overlay\.html/.test(t.url) &&
        /Browser Agent Overlay/i.test(t.title ?? ""),
    );
    if (overlays.length === 0) return null;

    if (sidecarThreadId) {
      const exact = overlays.find((t) => t.url.toLowerCase().includes(sidecarThreadId.toLowerCase()));
      if (exact) return exact;
    }
    if (overlays.length === 1) return overlays[0];
    return null;
  }

  async connect(targetId: string): Promise<string> {
    if (this.client) await this.disconnect();

    const options: CDP.Options = {
      host: this.config.cdpHost,
      port: this.config.cdpPort,
      target: targetId,
    };

    this.client = await CDP(options);

    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.DOM.enable(),
      this.client.Network.enable(),
    ]);

    try {
      const fireLoadCbs = () => {
        for (const cb of this.mainFrameLoadCbs) {
          try {
            cb();
          } catch {}
        }
      };
      this.client.Page.loadEventFired(fireLoadCbs);
      try {
        const page = this.client.Page as unknown as {
          frameNavigated: (cb: (params: { frame: { id: string; parentId?: string; url: string } }) => void) => void;
        };
        page.frameNavigated((params) => {
          if (params.frame.parentId) return;
          fireLoadCbs();
        });
      } catch {}
    } catch {}

    try {
      const target = this.client.Target as unknown as {
        setDiscoverTargets: (params: { discover: boolean }) => Promise<void>;
        targetCreated: (cb: (params: { targetInfo: { targetId: string; openerId?: string; url: string; type: string } }) => void) => void;
        targetDestroyed: (cb: (params: { targetId: string }) => void) => void;
      };
      await target.setDiscoverTargets({ discover: true });
      target.targetCreated((params) => {
        if (params.targetInfo.openerId === this.ownedTargetId) {
          this.childTargetIds.add(params.targetInfo.targetId);
        }
      });
      target.targetDestroyed((params) => {
        this.childTargetIds.delete(params.targetId);
      });
    } catch {

    }

    try {
      const runtime = this.client.Runtime as unknown as {
        consoleAPICalled: (cb: (p: {
          type: string;
          args: { type: string; value?: unknown; description?: string }[];
          stackTrace?: { callFrames: { url: string; lineNumber: number }[] };
        }) => void) => void;
      };
      runtime.consoleAPICalled((p) => {
        const text = (p.args ?? [])
          .map((a) => {
            if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
            return a.description ?? "";
          })
          .join(" ");
        const frame = p.stackTrace?.callFrames?.[0];
        this.pushConsole({
          ts: Date.now(),
          level: p.type,
          text,
          url: frame?.url,
          line: frame?.lineNumber,
        });
      });
    } catch {

    }

    try {
      const network = this.client.Network as unknown as {
        requestWillBeSent: (cb: (p: {
          requestId: string;
          request: { url: string; method: string };
          type?: string;
          timestamp: number;
        }) => void) => void;
        responseReceived: (cb: (p: {
          requestId: string;
          response: { status: number; statusText: string; mimeType: string; encodedDataLength?: number };
          timestamp: number;
        }) => void) => void;
        loadingFinished: (cb: (p: { requestId: string; encodedDataLength: number; timestamp: number }) => void) => void;
        loadingFailed: (cb: (p: { requestId: string; errorText: string; timestamp: number }) => void) => void;
      };
      network.requestWillBeSent((p) => {
        const entry: NetworkEntry = {
          ts: Date.now(),
          requestId: p.requestId,
          method: p.request.method,
          url: p.request.url,
          resourceType: p.type ?? "Other",
        };
        this.networkInFlight.set(p.requestId, entry);
        this.networkUrlByRequestId.set(p.requestId, p.request.url);
        this.pushNetwork(entry);
      });
      network.responseReceived((p) => {
        const entry = this.networkInFlight.get(p.requestId);
        if (!entry) return;
        entry.status = p.response.status;
        entry.statusText = p.response.statusText;
        entry.mimeType = p.response.mimeType;
        if (typeof p.response.encodedDataLength === "number") {
          entry.encodedDataLength = p.response.encodedDataLength;
        }
      });
      network.loadingFinished((p) => {
        const entry = this.networkInFlight.get(p.requestId);
        if (!entry) return;
        entry.encodedDataLength = p.encodedDataLength;
        entry.durationMs = Date.now() - entry.ts;
        this.networkInFlight.delete(p.requestId);
      });
      network.loadingFailed((p) => {
        const entry = this.networkInFlight.get(p.requestId);
        if (!entry) return;
        entry.failed = true;
        entry.failureReason = p.errorText;
        entry.durationMs = Date.now() - entry.ts;
        this.networkInFlight.delete(p.requestId);
      });
    } catch {

    }

    try {
      const network = this.client.Network as unknown as {
        eventSourceMessageReceived: (cb: (p: {
          requestId: string;
          timestamp: number;
          eventName: string;
          eventId?: string;
          data: string;
        }) => void) => void;
        webSocketCreated: (cb: (p: { requestId: string; url: string }) => void) => void;
        webSocketFrameReceived: (cb: (p: {
          requestId: string;
          timestamp: number;
          response: { opcode?: number; mask?: boolean; payloadData: string };
        }) => void) => void;
        webSocketFrameSent: (cb: (p: {
          requestId: string;
          timestamp: number;
          response: { opcode?: number; mask?: boolean; payloadData: string };
        }) => void) => void;
      };
      network.eventSourceMessageReceived((p) => {
        this.pushEventSource({
          ts: Date.now(),
          requestId: p.requestId,
          url: this.networkUrlByRequestId.get(p.requestId),
          eventName: p.eventName,
          eventId: p.eventId,
          data: p.data,
        });
      });
      network.webSocketCreated((p) => {
        this.networkUrlByRequestId.set(p.requestId, p.url);
      });
      network.webSocketFrameReceived((p) => {
        this.pushWebSocketFrame({
          ts: Date.now(),
          requestId: p.requestId,
          url: this.networkUrlByRequestId.get(p.requestId),
          direction: "received",
          opcode: p.response.opcode,
          mask: p.response.mask,
          payloadData: p.response.payloadData,
        });
      });
      network.webSocketFrameSent((p) => {
        this.pushWebSocketFrame({
          ts: Date.now(),
          requestId: p.requestId,
          url: this.networkUrlByRequestId.get(p.requestId),
          direction: "sent",
          opcode: p.response.opcode,
          mask: p.response.mask,
          payloadData: p.response.payloadData,
        });
      });
    } catch {

    }

    try {
      const { windowId } = await (this.client as unknown as {
        Browser: {
          getWindowForTarget: (params: { targetId?: string }) => Promise<{ windowId: number }>;
          setWindowBounds: (params: { windowId: number; bounds: Record<string, unknown> }) => Promise<void>;
        };
      }).Browser.getWindowForTarget({ targetId });
      await (this.client as unknown as {
        Browser: { setWindowBounds: (params: { windowId: number; bounds: Record<string, unknown> }) => Promise<void> };
      }).Browser.setWindowBounds({
        windowId,
        bounds: { width: 1440, height: 900, windowState: "normal" },
      });
    } catch {

    }

    this.state.connected = true;
    this.state.activeTabId = targetId;
    this.ownedTargetId = targetId;
    this.reconnectAttempts = 0;

    const { result } = await this.client.Runtime.evaluate({
      expression: "window.location.href",
    });
    this.state.currentUrl = result.value as string;

    return `Connected to tab: ${this.state.currentUrl}`;
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.close();
    } catch {

    }
    this.client = null;
    this.state.connected = false;
    this.state.activeTabId = undefined;
    this.networkInFlight.clear();
  }

  async reconnect(): Promise<string> {
    await this.disconnect();

    try {
      await this.getVersion();
    } catch (err) {
      throw new Error(
        `Cannot reach Comet CDP at ${this.cdpEndpoint}. Ensure Comet is running with --remote-debugging-port and reachable from this container. (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    if (!this.ownedTargetId) {
      throw new Error("No owned tab to reconnect to (call comet_connect first).");
    }

    const targets = await this.listTargets();
    if (!targets.some((t) => t.id === this.ownedTargetId)) {
      throw new Error(
        `Owned tab ${this.ownedTargetId} no longer exists. The task tab was closed externally.`,
      );
    }
    return this.connect(this.ownedTargetId);
  }

  private async isHealthy(): Promise<boolean> {
    if (!this.client || !this.state.connected) return false;
    try {
      const result = await Promise.race([
        this.client.Runtime.evaluate({ expression: "1+1", returnByValue: true }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Health check timeout")), HEALTH_CHECK_TIMEOUT_MS),
        ),
      ]);
      return (result as { result?: { value?: unknown } })?.result?.value === 2;
    } catch {
      this.state.connected = false;
      return false;
    }
  }

  private async ensureHealthyConnection(): Promise<void> {
    if (await this.isHealthy()) return;
    await this.reconnect();
  }

  private isConnectionError(err: unknown): boolean {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return [
      "websocket", "closed", "not open", "disconnected", "readystate",
      "econnrefused", "econnreset", "etimedout", "epipe", "socket hang up",
      "protocol error", "target closed", "session closed", "execution context",
      "not found", "detached", "crashed", "inspected target navigated", "aborted",
    ].some((pattern) => message.includes(pattern));
  }

  async withAutoReconnect<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isReconnecting) {
      let waited = 0;
      while (this.isReconnecting && waited < 20) {
        await new Promise((r) => setTimeout(r, 300));
        waited += 1;
      }
    }
    try {
      await this.preOperationCheck();
    } catch {

    }
    try {
      const result = await operation();
      this.reconnectAttempts = 0;
      return result;
    } catch (err) {
      if (
        !this.isConnectionError(err) ||
        this.reconnectAttempts >= this.maxReconnectAttempts
      ) {
        throw err;
      }
      this.reconnectAttempts += 1;
      this.isReconnecting = true;
      this.invalidateHealthCache();
      try {
        const delay = Math.min(300 * Math.pow(1.3, this.reconnectAttempts - 1), 2_000);
        await new Promise((r) => setTimeout(r, delay));
        await this.reconnect();
        return await operation();
      } finally {
        this.isReconnecting = false;
      }
    }
  }

  async addScriptToEvaluateOnNewDocument(source: string): Promise<string | null> {
    this.ensureClient();
    try {
      const r = (await (this.client!.Page as unknown as {
        addScriptToEvaluateOnNewDocument: (p: { source: string }) => Promise<{ identifier: string }>;
      }).addScriptToEvaluateOnNewDocument({ source })) as { identifier: string };
      return r.identifier ?? null;
    } catch {
      return null;
    }
  }

  async removeScriptToEvaluateOnNewDocument(identifier: string): Promise<void> {
    this.ensureClient();
    try {
      await (this.client!.Page as unknown as {
        removeScriptToEvaluateOnNewDocument: (p: { identifier: string }) => Promise<void>;
      }).removeScriptToEvaluateOnNewDocument({ identifier });
    } catch {}
  }

  async navigate(url: string, waitForLoad = true): Promise<NavigateResult> {
    this.ensureClient();
    const result = (await this.client!.Page.navigate({ url })) as NavigateResult;
    if (waitForLoad) {
      try {
        await Promise.race([
          this.client!.Page.loadEventFired(),
          new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
        ]);
      } catch {

      }
    }
    this.state.currentUrl = url;
    return result;
  }

  async screenshot(
    format: "png" | "jpeg" = "png",
    opts: { fullPage?: boolean; quality?: number } = {},
  ): Promise<ScreenshotResult> {
    this.ensureClient();
    const params: Record<string, unknown> = { format };
    if (format === "jpeg" && typeof opts.quality === "number") params.quality = opts.quality;
    if (opts.fullPage) params.captureBeyondViewport = true;
    return (await (
      this.client!.Page as unknown as {
        captureScreenshot: (p: Record<string, unknown>) => Promise<ScreenshotResult>;
      }
    ).captureScreenshot(params)) as ScreenshotResult;
  }

  async printPDF(opts: Record<string, unknown> = {}): Promise<{ data: string }> {
    this.ensureClient();
    return (await (
      this.client!.Page as unknown as {
        printToPDF: (p: Record<string, unknown>) => Promise<{ data: string }>;
      }
    ).printToPDF(opts)) as { data: string };
  }

  async historyBack(): Promise<boolean> {
    this.ensureClient();
    const page = this.client!.Page as unknown as {
      getNavigationHistory: () => Promise<{ currentIndex: number; entries: { id: number }[] }>;
      navigateToHistoryEntry: (p: { entryId: number }) => Promise<void>;
    };
    const h = await page.getNavigationHistory();
    if (h.currentIndex <= 0) return false;
    await page.navigateToHistoryEntry({ entryId: h.entries[h.currentIndex - 1].id });
    return true;
  }

  async historyForward(): Promise<boolean> {
    this.ensureClient();
    const page = this.client!.Page as unknown as {
      getNavigationHistory: () => Promise<{ currentIndex: number; entries: { id: number }[] }>;
      navigateToHistoryEntry: (p: { entryId: number }) => Promise<void>;
    };
    const h = await page.getNavigationHistory();
    if (h.currentIndex >= h.entries.length - 1) return false;
    await page.navigateToHistoryEntry({ entryId: h.entries[h.currentIndex + 1].id });
    return true;
  }

  async reload(ignoreCache = false): Promise<void> {
    this.ensureClient();
    await (this.client!.Page as unknown as {
      reload: (p: { ignoreCache?: boolean }) => Promise<void>;
    }).reload({ ignoreCache });
  }

  async getCookies(urls?: string[]): Promise<Record<string, unknown>[]> {
    this.ensureClient();
    const r = await (this.client!.Network as unknown as {
      getCookies: (p: { urls?: string[] }) => Promise<{ cookies: Record<string, unknown>[] }>;
    }).getCookies(urls ? { urls } : {});
    return r.cookies;
  }

  async setCookie(params: Record<string, unknown>): Promise<boolean> {
    this.ensureClient();
    const r = await (this.client!.Network as unknown as {
      setCookie: (p: Record<string, unknown>) => Promise<{ success: boolean }>;
    }).setCookie(params);
    return r.success;
  }

  async clearCache(): Promise<void> {
    this.ensureClient();
    await (this.client!.Network as unknown as {
      clearBrowserCache: () => Promise<void>;
    }).clearBrowserCache();
  }

  async clearCookies(): Promise<void> {
    this.ensureClient();
    await (this.client!.Network as unknown as {
      clearBrowserCookies: () => Promise<void>;
    }).clearBrowserCookies();
  }

  async setBlockedURLs(patterns: string[]): Promise<void> {
    this.ensureClient();
    await (this.client!.Network as unknown as {
      setBlockedURLs: (p: { urls: string[] }) => Promise<void>;
    }).setBlockedURLs({ urls: patterns });
  }

  async setViewport(p: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
  }): Promise<void> {
    this.ensureClient();
    await (this.client!.Emulation as unknown as {
      setDeviceMetricsOverride: (p: Record<string, unknown>) => Promise<void>;
    }).setDeviceMetricsOverride({
      width: p.width,
      height: p.height,
      deviceScaleFactor: p.deviceScaleFactor ?? 1,
      mobile: Boolean(p.mobile),
    });
  }

  async clearViewport(): Promise<void> {
    this.ensureClient();
    await (this.client!.Emulation as unknown as {
      clearDeviceMetricsOverride: () => Promise<void>;
    }).clearDeviceMetricsOverride();
  }

  async clickSelector(selector: string): Promise<{ success: boolean; error?: string }> {
    this.ensureClient();
    const r = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { success: false, error: 'no element matches selector' };
        if (el.disabled) return { success: false, error: 'element disabled' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        try {
          el.click();
        } catch (e) {
          return { success: false, error: String(e && e.message ? e.message : e) };
        }
        return { success: true };
      })()
    `);
    return r.result.value as { success: boolean; error?: string };
  }

  async getOuterHTML(selector?: string): Promise<string | null> {
    this.ensureClient();
    if (!selector) {
      const r = await this.evaluate("document.documentElement.outerHTML");
      return (r.result.value as string | undefined) ?? null;
    }
    const r = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.outerHTML : null;
      })()
    `);
    return (r.result.value as string | null) ?? null;
  }

  async domQuery(selector: string, limit: number): Promise<Record<string, unknown>[]> {
    this.ensureClient();
    const r = await this.evaluate(`
      (() => {
        const out = [];
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        const max = Math.min(els.length, ${Math.max(1, Math.floor(limit))});
        for (let i = 0; i < max; i++) {
          const el = els[i];
          const attrs = {};
          for (const a of el.attributes) attrs[a.name] = a.value;
          const text = (el.textContent || '').trim().substring(0, 400);
          out.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            class: el.className || undefined,
            attrs,
            text,
            visible: el.offsetParent !== null,
          });
        }
        return { total: els.length, items: out };
      })()
    `);
    return [r.result.value as Record<string, unknown>];
  }

  getConsoleEntries(opts: { limit?: number; level?: string; substring?: string } = {}): ConsoleEntry[] {
    let entries = this.consoleBuffer;
    if (opts.level) entries = entries.filter((e) => e.level === opts.level);
    if (opts.substring) entries = entries.filter((e) => e.text.includes(opts.substring!));
    if (opts.limit) entries = entries.slice(-opts.limit);
    return entries;
  }

  clearConsoleBuffer(): void {
    this.consoleBuffer = [];
  }

  getNetworkEntries(opts: { limit?: number; urlSubstring?: string; onlyFailed?: boolean; minStatus?: number } = {}): NetworkEntry[] {
    let entries = this.networkBuffer;
    if (opts.urlSubstring) entries = entries.filter((e) => e.url.includes(opts.urlSubstring!));
    if (opts.onlyFailed) entries = entries.filter((e) => e.failed || (e.status !== undefined && e.status >= 400));
    if (typeof opts.minStatus === "number") entries = entries.filter((e) => e.status !== undefined && e.status >= opts.minStatus!);
    if (opts.limit) entries = entries.slice(-opts.limit);
    return entries;
  }

  clearNetworkBuffer(): void {
    this.networkBuffer = [];
    this.networkInFlight.clear();
  }

  getEventSourceEntries(opts: {
    limit?: number;
    urlSubstring?: string;
    eventName?: string;
    substring?: string;
  } = {}): EventSourceEntry[] {
    let entries = this.eventSourceBuffer;
    if (opts.urlSubstring) entries = entries.filter((e) => (e.url ?? "").includes(opts.urlSubstring!));
    if (opts.eventName) entries = entries.filter((e) => e.eventName === opts.eventName);
    if (opts.substring) entries = entries.filter((e) => e.data.includes(opts.substring!));
    if (opts.limit) entries = entries.slice(-opts.limit);
    return entries;
  }

  clearEventSourceBuffer(): void {
    this.eventSourceBuffer = [];
  }

  getWebSocketFrames(opts: {
    limit?: number;
    urlSubstring?: string;
    direction?: "sent" | "received";
    substring?: string;
  } = {}): WebSocketFrameEntry[] {
    let frames = this.webSocketBuffer;
    if (opts.urlSubstring) frames = frames.filter((e) => (e.url ?? "").includes(opts.urlSubstring!));
    if (opts.direction) frames = frames.filter((e) => e.direction === opts.direction);
    if (opts.substring) frames = frames.filter((e) => e.payloadData.includes(opts.substring!));
    if (opts.limit) frames = frames.slice(-opts.limit);
    return frames;
  }

  clearWebSocketBuffer(): void {
    this.webSocketBuffer = [];
  }

  clearProtocolBuffers(): void {
    this.clearEventSourceBuffer();
    this.clearWebSocketBuffer();
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleBuffer.push(entry);
    if (this.consoleBuffer.length > MAX_CONSOLE) {
      this.consoleBuffer.splice(0, this.consoleBuffer.length - MAX_CONSOLE);
    }
  }

  private pushNetwork(entry: NetworkEntry): void {
    this.networkBuffer.push(entry);
    if (this.networkBuffer.length > MAX_NETWORK) {
      this.networkBuffer.splice(0, this.networkBuffer.length - MAX_NETWORK);
    }
  }

  private pushEventSource(entry: EventSourceEntry): void {
    this.eventSourceBuffer.push(entry);
    if (this.eventSourceBuffer.length > MAX_EVENT_SOURCE) {
      this.eventSourceBuffer.splice(0, this.eventSourceBuffer.length - MAX_EVENT_SOURCE);
    }
  }

  private pushWebSocketFrame(entry: WebSocketFrameEntry): void {
    this.webSocketBuffer.push(entry);
    if (this.webSocketBuffer.length > MAX_WEBSOCKET) {
      this.webSocketBuffer.splice(0, this.webSocketBuffer.length - MAX_WEBSOCKET);
    }
  }

  async evaluate(expression: string): Promise<EvaluateResult> {
    this.ensureClient();
    const evalPromise = this.client!.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as Promise<EvaluateResult>;
    return Promise.race([
      evalPromise,
      new Promise<EvaluateResult>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Runtime.evaluate timed out after ${EVALUATE_TIMEOUT_MS}ms`)),
          EVALUATE_TIMEOUT_MS,
        ),
      ),
    ]);
  }

  async safeEvaluate(expression: string): Promise<EvaluateResult> {
    await this.ensureHealthyConnection();
    return this.withAutoReconnect(async () => this.evaluate(expression));
  }

  async pressKey(key: string): Promise<void> {
    this.ensureClient();
    await this.client!.Input.dispatchKeyEvent({ type: "keyDown", key });
    await this.client!.Input.dispatchKeyEvent({ type: "keyUp", key });
  }

  async isOnPerplexityTab(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const result = await this.client.Runtime.evaluate({
        expression:
          "JSON.stringify({ url: window.location.href, sidecar: document.documentElement && document.documentElement.getAttribute('data-erp') === 'sidecar' })",
      });
      const raw = (result.result.value as string | undefined) ?? "";
      try {
        const parsed = JSON.parse(raw) as { url?: string; sidecar?: boolean };
        return Boolean(parsed.sidecar) || (parsed.url ?? "").includes("perplexity.ai");
      } catch {
        return raw.includes("perplexity.ai");
      }
    } catch {
      return false;
    }
  }

  async ensureOnOwnedTab(): Promise<boolean> {
    if (!this.ownedTargetId) return false;
    if (await this.isOnPerplexityTab()) return true;
    try {
      const targets = await this.listTargets();
      if (!targets.some((t) => t.id === this.ownedTargetId)) return false;
      await this.connect(this.ownedTargetId);
      return true;
    } catch {
      return false;
    }
  }

  async insertText(text: string): Promise<void> {
    this.ensureClient();
    await (
      this.client! as unknown as {
        Input: { insertText: (params: { text: string }) => Promise<void> };
      }
    ).Input.insertText({ text });
  }

  private ensureClient(): void {
    if (!this.client) {
      throw new Error("Not connected to Comet. Call comet_connect first.");
    }
  }
}
