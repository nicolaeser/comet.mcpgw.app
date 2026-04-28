import { randomUUID } from "node:crypto";
import { getTaskRedisClient } from "../../runtime/redis.js";
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  McpJsonRpcError,
} from "../json-rpc.js";

export type TaskStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "input_required"
  | "working";

export interface Task {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
}

interface StoredTask {
  task: Task;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const DEFAULT_TASK_TTL_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const RESULT_WAIT_FALLBACK_MS = 2_000;
const REDIS_PREFIX = "mcp:task:";

export class TaskStore {
  private readonly memoryTasks = new Map<string, StoredTask>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly aborts = new Map<string, AbortController>();

  registerAbort(taskId: string, controller: AbortController): void {
    this.aborts.set(taskId, controller);
  }

  releaseAbort(taskId: string): void {
    this.aborts.delete(taskId);
  }

  private get redis() {
    return getTaskRedisClient();
  }

  async create(ttl: number | null = DEFAULT_TASK_TTL_MS): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      taskId: randomUUID(),
      status: "working",
      statusMessage: "The operation is in progress.",
      createdAt: now,
      lastUpdatedAt: now,
      ttl,
      pollInterval: DEFAULT_POLL_INTERVAL_MS,
    };

    const stored: StoredTask = { task };
    await this.save(task.taskId, stored);
    return task;
  }

  async list(): Promise<Task[]> {
    if (this.redis) {
      const keys = await this.redis.keys(`${REDIS_PREFIX}*`);
      const tasks: Task[] = [];
      for (const key of keys) {
        const stored = await this.getStored(key.replace(REDIS_PREFIX, ""));
        if (stored) tasks.push(stored.task);
      }
      return tasks;
    }
    this.pruneExpired();
    return [...this.memoryTasks.values()].map(({ task }) => task);
  }

  async get(taskId: string): Promise<Task> {
    const stored = await this.getStored(taskId);
    if (!stored) {
      throw new McpJsonRpcError(JSON_RPC_INVALID_PARAMS, "Unknown task");
    }
    return stored.task;
  }

  async complete(taskId: string, result: unknown): Promise<Task | undefined> {
    const stored = await this.getStored(taskId);
    if (!stored || isTerminal(stored.task.status)) return undefined;

    stored.result = result;
    await this.transition(stored, "completed");
    return stored.task;
  }

  async completeWithErrorResult(
    taskId: string,
    result: unknown,
    statusMessage: string,
  ): Promise<Task | undefined> {
    const stored = await this.getStored(taskId);
    if (!stored || isTerminal(stored.task.status)) return undefined;

    stored.result = result;
    await this.transition(stored, "failed", statusMessage);
    return stored.task;
  }

  async fail(taskId: string, error: unknown): Promise<Task | undefined> {
    const stored = await this.getStored(taskId);
    if (!stored || isTerminal(stored.task.status)) return undefined;

    const mcpError =
      error instanceof McpJsonRpcError
        ? error
        : new McpJsonRpcError(JSON_RPC_INTERNAL_ERROR, "Task failed");

    stored.error = {
      code: mcpError.code,
      message: mcpError.message,
      data: mcpError.data,
    };
    await this.transition(stored, "failed", mcpError.message);
    return stored.task;
  }

  async cancel(taskId: string): Promise<Task> {
    const stored = await this.getStored(taskId);
    if (!stored) {
      throw new McpJsonRpcError(JSON_RPC_INVALID_PARAMS, "Unknown task");
    }
    if (isTerminal(stored.task.status)) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        "Task is already complete",
      );
    }

    stored.error = {
      code: JSON_RPC_INVALID_PARAMS,
      message: "Task was cancelled",
    };
    await this.transition(stored, "cancelled", "The task was cancelled by request.");

    const controller = this.aborts.get(taskId);
    if (controller) {
      this.aborts.delete(taskId);
      controller.abort("Task was cancelled");
    }

    return stored.task;
  }

  async result(taskId: string): Promise<unknown> {
    while (true) {
      const wait = this.registerWaiter(taskId);

      const stored = await this.getStored(taskId);
      if (!stored) {
        wait.cancel();
        throw new McpJsonRpcError(JSON_RPC_INVALID_PARAMS, "Unknown task");
      }

      if (isTerminal(stored.task.status)) {
        wait.cancel();
        if (stored.error) {
          throw new McpJsonRpcError(
            stored.error.code,
            stored.error.message,
            stored.error.data,
          );
        }
        return stored.result;
      }

      await wait.promise;
    }
  }

  private registerWaiter(taskId: string): {
    promise: Promise<void>;
    cancel: () => void;
  } {
    let wakeup: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      wakeup = resolve;
    });

    const taskWaiters = this.waiters.get(taskId) ?? new Set();
    taskWaiters.add(wakeup);
    this.waiters.set(taskId, taskWaiters);

    const timer = setTimeout(wakeup, RESULT_WAIT_FALLBACK_MS);

    const cancel = () => {
      clearTimeout(timer);
      const set = this.waiters.get(taskId);
      if (set) {
        set.delete(wakeup);
        if (set.size === 0) this.waiters.delete(taskId);
      }
    };

    void promise.then(cancel);
    return { promise, cancel };
  }

  private async getStored(taskId: string): Promise<StoredTask | undefined> {
    if (this.redis) {
      const data = await this.redis.get(`${REDIS_PREFIX}${taskId}`);
      return data ? JSON.parse(data) : undefined;
    }
    this.pruneExpired();
    return this.memoryTasks.get(taskId);
  }

  private async save(taskId: string, stored: StoredTask): Promise<void> {
    if (this.redis) {
      const ttlSeconds = stored.task.ttl ? Math.ceil(stored.task.ttl / 1000) : 3600;
      await this.redis.set(
        `${REDIS_PREFIX}${taskId}`,
        JSON.stringify(stored),
        "EX",
        ttlSeconds,
      );
    } else {
      this.memoryTasks.set(taskId, stored);
    }
  }

  private async transition(
    stored: StoredTask,
    status: TaskStatus,
    statusMessage?: string,
  ): Promise<void> {
    stored.task.status = status;
    stored.task.lastUpdatedAt = new Date().toISOString();
    stored.task.statusMessage = statusMessage;

    await this.save(stored.task.taskId, stored);

    const taskWaiters = this.waiters.get(stored.task.taskId);
    if (taskWaiters) {
      this.waiters.delete(stored.task.taskId);
      for (const resolve of taskWaiters) {
        resolve();
      }
    }

    if (isTerminal(status)) {
      this.aborts.delete(stored.task.taskId);
    }
  }

  private pruneExpired(): void {
    if (this.redis) return;
    const now = Date.now();
    for (const [taskId, stored] of this.memoryTasks) {
      if (stored.task.ttl === null) continue;
      const createdAt = Date.parse(stored.task.createdAt);
      if (Number.isFinite(createdAt) && createdAt + stored.task.ttl <= now) {
        this.memoryTasks.delete(taskId);
        this.waiters.delete(taskId);
      }
    }
  }
}

function isTerminal(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
