import { getCometResultRedisClient } from "../runtime/redis.js";

export type CometResultStatus =
  | "closed"
  | "completed"
  | "failed"
  | "input_required"
  | "timeout"
  | "working";

export interface CometResultRecord {
  taskId: string;
  label?: string;
  prompt?: string;
  status: CometResultStatus;
  response?: string;
  responseTruncated?: boolean;
  error?: string;
  currentStep?: string;
  steps?: string[];
  stream?: {
    status: string;
    sawSse: boolean;
    sawAgent: boolean;
    sawWebSocket: boolean;
    textCompleted: boolean;
    sseClosed: boolean;
    sseActive: boolean;
    streamRequestCount: number;
    sseChunkCount: number;
    sseBytes: number;
    eventCount: number;
  };
  awaitingInput?: boolean;
  confirmationKind?: string;
  confirmationPrompt?: string;
  agentBrowsingUrl?: string;
  keepAlive?: boolean;
  autoCloseOnCompletion?: boolean;
  closedAfterCompletion?: boolean;
  source?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  expiresAt: string;
}

export interface SaveCometResultInput {
  taskId: string;
  label?: string;
  prompt?: string;
  status: CometResultStatus;
  response?: string;
  error?: string;
  currentStep?: string;
  steps?: string[];
  stream?: CometResultRecord["stream"];
  awaitingInput?: boolean;
  confirmationKind?: string;
  confirmationPrompt?: string;
  agentBrowsingUrl?: string;
  keepAlive?: boolean;
  autoCloseOnCompletion?: boolean;
  closedAfterCompletion?: boolean;
  source?: string;
}

export interface ListCometResultsOptions {
  limit?: number;
  since?: number;
  status?: CometResultStatus;
}

export interface DeleteCometResultsOptions {
  before?: number;
  status?: CometResultStatus;
}

const RESULT_PREFIX = "comet:result:";
const RESULT_INDEX = "comet:results:index";
const DEFAULT_RESULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_TEXT = 1_000_000;

function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function resultTtlMs(): number {
  return envPositiveInteger("COMET_RESULT_TTL_MS", DEFAULT_RESULT_TTL_MS);
}

function maxResponseText(): number {
  return envPositiveInteger("COMET_RESULT_MAX_TEXT", DEFAULT_MAX_RESPONSE_TEXT);
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiresAtIso(nowMs: number): string {
  return new Date(nowMs + resultTtlMs()).toISOString();
}

function isTerminal(status: CometResultStatus): boolean {
  return status === "closed" || status === "completed" || status === "failed" || status === "timeout";
}

function clampLimit(limit: number | undefined): number {
  if (!limit) return 20;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function trimResponse(response: string | undefined): {
  response?: string;
  responseTruncated?: boolean;
} {
  if (response === undefined) return {};
  const max = maxResponseText();
  if (response.length <= max) return { response, responseTruncated: false };
  return { response: response.slice(0, max), responseTruncated: true };
}

function parseRecord(raw: string | null): CometResultRecord | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as CometResultRecord;
  } catch {
    return undefined;
  }
}

export class CometResultStore {
  private readonly memory = new Map<string, CometResultRecord>();

  private get redis() {
    return getCometResultRedisClient();
  }

  async save(input: SaveCometResultInput): Promise<CometResultRecord> {
    const existing = await this.get(input.taskId);
    const now = nowIso();
    const nowMs = Date.now();
    const trimmed = trimResponse(input.response);
    const record: CometResultRecord = {
      ...existing,
      ...input,
      ...trimmed,
      taskId: input.taskId,
      status: input.status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: isTerminal(input.status) ? existing?.completedAt ?? now : existing?.completedAt,
      expiresAt: expiresAtIso(nowMs),
    };

    if (input.response === undefined && existing?.response !== undefined) {
      record.response = existing.response;
      record.responseTruncated = existing.responseTruncated;
    }

    await this.write(record);
    return record;
  }

  async get(taskId: string): Promise<CometResultRecord | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(`${RESULT_PREFIX}${taskId}`);
        const parsed = parseRecord(raw);
        if (!parsed && raw) await this.redis.del(`${RESULT_PREFIX}${taskId}`);
        return parsed ?? this.memory.get(taskId);
      } catch {
        return this.memory.get(taskId);
      }
    }
    this.pruneMemory();
    return this.memory.get(taskId);
  }

  async list(options: ListCometResultsOptions = {}): Promise<CometResultRecord[]> {
    const limit = clampLimit(options.limit);
    if (this.redis) {
      try {
        const ids = await this.redis.zrevrange(RESULT_INDEX, 0, Math.max(limit * 8, limit) - 1);
        const records: CometResultRecord[] = [];
        const stale: string[] = [];
        for (const id of ids) {
          const record = await this.get(id);
          if (!record) {
            stale.push(id);
            continue;
          }
          if (!matchesListOptions(record, options)) continue;
          records.push(record);
          if (records.length >= limit) break;
        }
        if (stale.length > 0) await this.redis.zrem(RESULT_INDEX, ...stale);
        return records;
      } catch {
      }
    }

    this.pruneMemory();
    return [...this.memory.values()]
      .filter((record) => matchesListOptions(record, options))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit);
  }

  async delete(taskId: string): Promise<boolean> {
    if (this.redis) {
      try {
        const deleted = await this.redis.del(`${RESULT_PREFIX}${taskId}`);
        await this.redis.zrem(RESULT_INDEX, taskId);
        return deleted > 0 || this.memory.delete(taskId);
      } catch {
      }
    }
    return this.memory.delete(taskId);
  }

  async deleteMatching(options: DeleteCometResultsOptions = {}): Promise<number> {
    if (this.redis) {
      try {
        const ids = await this.redis.zrange(RESULT_INDEX, 0, -1);
        const toDelete: string[] = [];
        for (const id of ids) {
          const record = await this.get(id);
          if (!record) {
            toDelete.push(id);
            continue;
          }
          if (matchesDeleteOptions(record, options)) toDelete.push(id);
        }
        if (toDelete.length === 0) return 0;
        await this.redis.del(...toDelete.map((id) => `${RESULT_PREFIX}${id}`));
        await this.redis.zrem(RESULT_INDEX, ...toDelete);
        return toDelete.length;
      } catch {
      }
    }

    this.pruneMemory();
    let deleted = 0;
    for (const [taskId, record] of this.memory) {
      if (!matchesDeleteOptions(record, options)) continue;
      this.memory.delete(taskId);
      deleted += 1;
    }
    return deleted;
  }

  private async write(record: CometResultRecord): Promise<void> {
    if (this.redis) {
      try {
        const ttlSeconds = Math.max(1, Math.ceil(resultTtlMs() / 1000));
        await this.redis
          .multi()
          .set(`${RESULT_PREFIX}${record.taskId}`, JSON.stringify(record), "EX", ttlSeconds)
          .zadd(RESULT_INDEX, Date.parse(record.updatedAt), record.taskId)
          .exec();
        return;
      } catch {
      }
    }
    this.memory.set(record.taskId, record);
    this.pruneMemory();
  }

  private pruneMemory(): void {
    const now = Date.now();
    for (const [taskId, record] of this.memory) {
      const expiresAt = Date.parse(record.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        this.memory.delete(taskId);
      }
    }
  }
}

function matchesListOptions(
  record: CometResultRecord,
  options: ListCometResultsOptions,
): boolean {
  if (options.status && record.status !== options.status) return false;
  if (options.since && Date.parse(record.updatedAt) < options.since) return false;
  return true;
}

function matchesDeleteOptions(
  record: CometResultRecord,
  options: DeleteCometResultsOptions,
): boolean {
  if (options.status && record.status !== options.status) return false;
  if (options.before && Date.parse(record.updatedAt) >= options.before) return false;
  return true;
}

export const cometResultStore = new CometResultStore();
