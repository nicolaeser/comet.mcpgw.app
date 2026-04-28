import { logger } from "../runtime/logger.js";
import { cometResultStore } from "./result-store.js";
import {
  isCompletedCometStatus,
  saveCometStatusResult,
} from "./result-capture.js";
import { taskRegistry } from "./task-registry.js";

export interface CometResultWatcherOptions {
  timeoutMs?: number;
  closeTimeoutMs?: number;
}

const DEFAULT_WATCH_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_WATCH_INTERVAL_MS = 2_000;
const MAX_CONSECUTIVE_ERRORS = 5;

const activeWatchers = new Map<string, Promise<void>>();

function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function watchTimeoutMs(timeoutMs: number | undefined): number {
  return Math.max(
    timeoutMs ?? 0,
    envPositiveInteger("COMET_RESULT_WATCH_TIMEOUT_MS", DEFAULT_WATCH_TIMEOUT_MS),
  );
}

function watchIntervalMs(): number {
  return envPositiveInteger("COMET_RESULT_WATCH_INTERVAL_MS", DEFAULT_WATCH_INTERVAL_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleClose(taskId: string, closeTimeoutMs: number | undefined): void {
  const fire = () => {
    void taskRegistry.close(taskId).catch(() => {});
  };
  if (closeTimeoutMs && closeTimeoutMs > 0) {
    const timer = setTimeout(fire, closeTimeoutMs);
    timer.unref?.();
    return;
  }
  setImmediate(fire);
}

export function ensureCometResultWatcher(
  taskId: string,
  options: CometResultWatcherOptions = {},
): boolean {
  if (activeWatchers.has(taskId)) return false;

  const watcher = runCometResultWatcher(taskId, options)
    .catch((err) => {
      logger.warn(
        "Comet result watcher failed",
        {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        },
        { privacySafe: true },
      );
    })
    .finally(() => {
      activeWatchers.delete(taskId);
    });

  activeWatchers.set(taskId, watcher);
  return true;
}

async function runCometResultWatcher(
  taskId: string,
  options: CometResultWatcherOptions,
): Promise<void> {
  const deadline = Date.now() + watchTimeoutMs(options.timeoutMs);
  const interval = watchIntervalMs();
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    await delay(interval);

    try {
      const done = await taskRegistry.withTask(taskId, async (task) => {
        const status = await task.ai.getAgentStatus();
        const completed = isCompletedCometStatus(status);
        const shouldClose = completed && (task.autoCloseOnCompletion ?? !task.keepAlive);
        await saveCometStatusResult(
          task,
          status,
          "background-watcher",
          completed ? "completed" : undefined,
          shouldClose,
        );
        if (completed) {
          if (shouldClose) scheduleClose(task.id, options.closeTimeoutMs);
          return true;
        }
        return false;
      });

      consecutiveErrors = 0;
      if (done) return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("No task with id")) {
        const existing = await cometResultStore.get(taskId);
        if (!existing || existing.status === "working" || existing.status === "input_required") {
          await cometResultStore.save({
            taskId,
            status: "closed",
            error: "Task closed before a completed result was captured.",
            source: "background-watcher",
          });
        }
        return;
      }

      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        await cometResultStore.save({
          taskId,
          status: "failed",
          error: message,
          source: "background-watcher",
        });
        return;
      }
    }
  }

  const existing = await cometResultStore.get(taskId);
  if (!existing || existing.status === "working" || existing.status === "input_required") {
    await cometResultStore.save({
      taskId,
      status: "timeout",
      error: `Background result watcher timed out after ${watchTimeoutMs(options.timeoutMs)}ms.`,
      source: "background-watcher",
    });
  }
}
