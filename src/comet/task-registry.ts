import { randomUUID } from "node:crypto";
import { CometAI } from "./comet-ai.js";
import {
  CometCDPClient,
  cdpCloseTab,
  cdpGetVersion,
  cdpListTargets,
  cdpNewTab,
  loadCDPConfig,
} from "./cdp-client.js";
import { logger } from "../runtime/logger.js";

export type AttachedKind = "new" | "sidecar" | "thread";

export interface CometTask {
  id: string;
  label?: string;
  keepAlive: boolean;
  client: CometCDPClient;
  ai: CometAI;
  createdAt: number;
  lastUsedAt: number;

  lock: Promise<void>;
  attachedKind: AttachedKind;
  autoCloseOnCompletion?: boolean;

  preexistingTargetIds: ReadonlySet<string>;
}

function isSidecarUrl(url: string): boolean {
  return /perplexity\.ai\/sidecar(\b|\/|\?|$)/.test(url);
}

function isThreadUrl(url: string): boolean {
  if (isSidecarUrl(url)) return false;
  return /perplexity\.ai\/(search|thread)\//.test(url);
}

export interface AttachableTarget {
  id: string;
  kind: AttachedKind;
  url: string;
  title?: string;
}

export async function listAttachableTargets(): Promise<AttachableTarget[]> {
  const targets = await cdpListTargets();
  const out: AttachableTarget[] = [];
  for (const t of targets) {
    if (t.type !== "page") continue;
    if (isSidecarUrl(t.url)) out.push({ id: t.id, kind: "sidecar", url: t.url, title: t.title });
    else if (isThreadUrl(t.url)) out.push({ id: t.id, kind: "thread", url: t.url, title: t.title });
  }
  return out;
}

export interface FindOptions {
  targetId?: string;
  urlContains?: string;
  titleContains?: string;
  ownedTabIds?: ReadonlySet<string>;
}

async function findPerplexityTarget(
  mode: "sidecar" | "thread" | "auto",
  opts: FindOptions = {},
): Promise<{ id: string; kind: AttachedKind } | { error: string; candidates: AttachableTarget[] } | null> {
  const all = await listAttachableTargets();
  const owned = opts.ownedTabIds ?? new Set<string>();
  const free = all.filter((t) => !owned.has(t.id));

  if (opts.targetId) {
    const exact = all.find((t) => t.id === opts.targetId);
    if (!exact) return { error: `No page target with id "${opts.targetId}".`, candidates: free };
    if (mode !== "auto" && exact.kind !== mode) {
      return {
        error: `Target ${opts.targetId} is a ${exact.kind}, not a ${mode}.`,
        candidates: free,
      };
    }
    if (owned.has(exact.id)) {
      return {
        error: `Target ${opts.targetId} is already owned by another active task. Use comet_tasks to find it.`,
        candidates: free.filter((t) => mode === "auto" || t.kind === mode),
      };
    }
    return { id: exact.id, kind: exact.kind };
  }

  let pool = free;
  if (mode !== "auto") pool = pool.filter((t) => t.kind === mode);

  if (opts.urlContains) {
    const needle = opts.urlContains.toLowerCase();
    pool = pool.filter((t) => t.url.toLowerCase().includes(needle));
  }
  if (opts.titleContains) {
    const needle = opts.titleContains.toLowerCase();
    pool = pool.filter((t) => (t.title ?? "").toLowerCase().includes(needle));
  }

  if (pool.length === 0) {
    if (mode === "auto") return null;
    return {
      error:
        `No unattached ${mode} target matched the filter. ` +
        (free.length > 0 ? "See candidates below." : "No free Perplexity surfaces are open."),
      candidates: free,
    };
  }

  if (pool.length > 1) {
    if (mode === "auto") {
      const activeSidecar = pool.find(
        (t) => t.kind === "sidecar" && /\/sidecar\/(search|thread|library)/.test(t.url),
      );
      if (activeSidecar) return { id: activeSidecar.id, kind: activeSidecar.kind };
      const sidecar = pool.find((t) => t.kind === "sidecar");
      if (sidecar) return { id: sidecar.id, kind: sidecar.kind };
      return { id: pool[0].id, kind: pool[0].kind };
    }
    return {
      error:
        `Ambiguous: ${pool.length} ${mode} tabs match. ` +
        `Disambiguate via target_id, url_contains or title_contains.`,
      candidates: pool,
    };
  }

  return { id: pool[0].id, kind: pool[0].kind };
}

function envIntMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class TaskRegistry {
  private tasks = new Map<string, CometTask>();
  private pendingTabIds = new Set<string>();
  private idleTimer: NodeJS.Timeout | null = null;

  private readonly idleTtlMs = envIntMs("COMET_TASK_IDLE_TTL_MS", 30 * 60 * 1000);
  private readonly idleSweepMs = envIntMs("COMET_TASK_IDLE_SWEEP_MS", 60 * 1000);
  private readonly autoSidecarWaitMs = envIntMs("COMET_AUTO_SIDECAR_WAIT_MS", 2_000);
  private windowFittedOnce = false;

  async create(
    label?: string,
    opts: {
      keepAlive?: boolean;
      onProgress?: (step: number, total: number, message: string) => void | Promise<void>;
      attach?: "new" | "sidecar" | "thread" | "auto";
      targetId?: string;
      urlContains?: string;
      titleContains?: string;
    } = {},
  ): Promise<CometTask> {
    const total = 5;
    const report = async (step: number, message: string) => {
      try {
        await opts.onProgress?.(step, total, message);
      } catch {

      }
    };

    const attachMode = opts.attach ?? "new";
    let targetId: string;
    let attachedKind: "new" | "sidecar" | "thread" = "new";

    const preexistingTargetIds: ReadonlySet<string> = await (async () => {
      try {
        const targets = await cdpListTargets();
        return new Set(targets.filter((t) => t.type === "page").map((t) => t.id));
      } catch {
        return new Set<string>();
      }
    })();

    let pendingClaim: string | undefined;
    const claimTab = (id: string) => {
      pendingClaim = id;
      this.pendingTabIds.add(id);
    };

    try {

    if (attachMode !== "new") {
      await report(0, `looking for existing ${attachMode} target`);
      const ownedTabIds = new Set<string>([
        ...([...this.tasks.values()].map((t) => t.client.targetId).filter(Boolean) as string[]),
        ...this.pendingTabIds,
      ]);
      const existing = await findPerplexityTarget(attachMode, {
        targetId: opts.targetId,
        urlContains: opts.urlContains,
        titleContains: opts.titleContains,
        ownedTabIds,
      });
      if (existing && "id" in existing) {
        targetId = existing.id;
        attachedKind = existing.kind;
        claimTab(targetId);
      } else if (existing && "error" in existing) {
        const lines = [existing.error];
        if (existing.candidates.length > 0) {
          lines.push("Candidates:");
          for (const c of existing.candidates) {
            lines.push(`  • [${c.kind}] id=${c.id} url=${c.url}${c.title ? ` title=${c.title}` : ""}`);
          }
        }
        throw new Error(lines.join("\n"));
      } else if (attachMode === "auto") {
        const deadline = Date.now() + this.autoSidecarWaitMs;
        let attached: { id: string; kind: AttachedKind } | null = null;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          const retry = await findPerplexityTarget("auto", {
            urlContains: opts.urlContains,
            titleContains: opts.titleContains,
            ownedTabIds,
          });
          if (retry && "id" in retry) {
            attached = { id: retry.id, kind: retry.kind };
            break;
          }
        }
        if (attached) {
          targetId = attached.id;
          attachedKind = attached.kind;
          claimTab(targetId);
        } else {
          await report(0, "no existing Perplexity surface — opening fresh tab");
          const tab = await cdpNewTab("https://www.perplexity.ai/");
          targetId = tab.id;
          claimTab(targetId);
          await new Promise((r) => setTimeout(r, 800));
        }
      } else {
        throw new Error(
          `No existing Comet ${attachMode} target found. ` +
            `Open the ${attachMode} in Comet first, or call comet_connect with attach="new".`,
        );
      }
    } else {
      await report(0, "opening fresh Perplexity tab");
      const tab = await cdpNewTab("https://www.perplexity.ai/");
      targetId = tab.id;
      claimTab(targetId);
      await new Promise((r) => setTimeout(r, 800));
    }

    await report(1, "attaching CDP socket");
    const client = new CometCDPClient();
    await client.connect(targetId);

    if (!this.windowFittedOnce && process.env.COMET_AUTO_FIT_WINDOW !== "false") {
      this.windowFittedOnce = true;
      const mode = process.env.COMET_AUTO_FIT_WINDOW_MODE === "fullscreen" ? "fullscreen" : "maximize";
      try {
        const fit = await client.fitWindowToDisplay({ mode });
        logger.info(
          "Comet window fit to display",
          { ok: fit.ok, state: fit.state, width: fit.width, height: fit.height, error: fit.error },
          { privacySafe: true },
        );
      } catch (err) {
        logger.warn(
          "Comet window fit failed",
          { error: err instanceof Error ? err.message : String(err) },
          { privacySafe: true },
        );
      }
    }

    if (attachedKind === "new") {
      await report(2, "navigating to perplexity.ai");
      try {
        await client.navigate("https://www.perplexity.ai/", true);
      } catch {

      }
      await report(3, "waiting for page to settle");
      await new Promise((r) => setTimeout(r, 1_500));
    } else {
      await report(2, `attached to existing ${attachedKind}`);
      await report(3, "verifying DOM is ready");
      await new Promise((r) => setTimeout(r, 200));
    }

    const ai = new CometAI(client);

    try {
      const guard = await ai.ensureComputerModeOff();
      if (guard.wasOn && !guard.turnedOff) {
        logger.warn(
          "Comet task created but Computer mode could not be disabled",
          { taskId: targetId },
          { privacySafe: true },
        );
      }
    } catch {}

    if (label) {
      try {
        await ai.setTabLabel(label);
      } catch {}
    }
    const task: CometTask = {
      id: randomUUID(),
      label,
      keepAlive: Boolean(opts.keepAlive),
      client,
      ai,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      lock: Promise.resolve(),
      attachedKind,
      preexistingTargetIds,
    };
    this.tasks.set(task.id, task);
    await report(total, "task ready");
    logger.info(
      "Comet task created",
      {
        taskId: task.id,
        label: label ?? null,
        targetId,
        keepAlive: task.keepAlive,
        attachedKind,
      },
      { privacySafe: true },
    );
    return task;
    } finally {
      if (pendingClaim) this.pendingTabIds.delete(pendingClaim);
    }
  }

  rename(id: string, label: string | undefined): CometTask | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.label = label;
    void t.ai.setTabLabel(label ?? null).catch(() => {});
    return t;
  }

  setKeepAlive(id: string, keepAlive: boolean): CometTask | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.keepAlive = keepAlive;
    return t;
  }

  startCleanup(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.sweepIdle();
    }, this.idleSweepMs);
    this.idleTimer.unref?.();
  }

  stopCleanup(): void {
    if (!this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.keepAlive) continue;
      if (now - task.lastUsedAt < this.idleTtlMs) continue;
      logger.info(
        "Comet task auto-closed (idle)",
        { taskId: task.id, idleMs: now - task.lastUsedAt },
        { privacySafe: true },
      );
      try {
        await this.close(task.id);
      } catch {

      }
    }
  }

  get(id: string): CometTask | undefined {
    const t = this.tasks.get(id);
    if (t) t.lastUsedAt = Date.now();
    return t;
  }

  list(): CometTask[] {
    return [...this.tasks.values()];
  }

  resolve(id?: string): CometTask {
    if (id) {
      const t = this.get(id);
      if (!t) {
        throw new Error(
          `No task with id "${id}". Use comet_tasks to list active tasks.`,
        );
      }
      return t;
    }
    const all = this.list();
    if (all.length === 0) {
      throw new Error("No active task. Call comet_connect first to create one.");
    }
    if (all.length === 1) return all[0];
    return all.reduce((a, b) => (b.lastUsedAt > a.lastUsedAt ? b : a));
  }

  resolveOrNull(id?: string): CometTask | null {
    if (id) return this.get(id) ?? null;
    const all = this.list();
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];
    return all.reduce((a, b) => (b.lastUsedAt > a.lastUsedAt ? b : a));
  }

  async withTask<T>(id: string | undefined, op: (task: CometTask) => Promise<T>): Promise<T> {
    const task = this.resolve(id);
    const previous = task.lock;
    let release!: () => void;
    task.lock = new Promise<void>((r) => (release = r));
    try {
      await previous;
      task.lastUsedAt = Date.now();
      return await op(task);
    } finally {
      release();
    }
  }

  async close(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) return false;

    try {
      await task.lock;
    } catch {

    }
    if (task.attachedKind !== "new") {
      try {
        await task.ai.setTabLabel(null);
      } catch {}
    }

    const targetId = task.client.targetId;
    const childIds = task.client.childTargets;
    const closedChildren: string[] = [];
    const attemptedIds = new Set<string>();
    for (const childId of childIds) {
      attemptedIds.add(childId);
      try {
        const ok = await task.client.closeTab(childId);
        if (ok) closedChildren.push(childId);
      } catch {

      }
    }

    const closedAuxiliary: string[] = [];
    try {
      const otherTaskTabIds = new Set<string>();
      for (const other of this.tasks.values()) {
        if (other.id === id) continue;
        if (other.client.targetId) otherTaskTabIds.add(other.client.targetId);
        for (const c of other.client.childTargets) otherTaskTabIds.add(c);
      }
      for (const pendingId of this.pendingTabIds) {
        if (pendingId === targetId) continue;
        otherTaskTabIds.add(pendingId);
      }
      const allTargets = await cdpListTargets();
      for (const t of allTargets) {
        if (t.type !== "page") continue;
        if (task.preexistingTargetIds.has(t.id)) continue;
        if (t.id === targetId) continue;
        if (attemptedIds.has(t.id)) continue;
        if (otherTaskTabIds.has(t.id)) continue;
        if (t.url.startsWith("chrome://")) continue;
        if (t.url.startsWith("devtools://")) continue;
        attemptedIds.add(t.id);
        try {
          const ok = await cdpCloseTab(t.id);
          if (ok) closedAuxiliary.push(t.id);
        } catch {

        }
      }
    } catch {

    }

    let closedOwned = false;
    if (
      targetId &&
      task.attachedKind === "new" &&
      task.client.shouldCloseTargetOnTaskClose
    ) {
      try {
        closedOwned = await task.client.closeTab(targetId);
      } catch {

      }
    }

    try {
      await task.client.disconnect();
    } catch {

    }

    this.tasks.delete(id);
    logger.info(
      "Comet task closed",
      {
        taskId: id,
        closedOwnedTab: closedOwned,
        closedChildTabs: closedChildren.length,
        closedAuxiliaryTabs: closedAuxiliary.length,
        attachedKind: task.attachedKind,
      },
      { privacySafe: true },
    );
    return true;
  }

  async closeAll(): Promise<void> {
    const ids = [...this.tasks.keys()];
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }
}

export const taskRegistry = new TaskRegistry();

export async function getBrowserVersion() {
  return cdpGetVersion();
}

export async function listAllTargets() {
  return cdpListTargets();
}

export function getCDPEndpoint(): string {
  return loadCDPConfig().cdpHttpBase;
}
