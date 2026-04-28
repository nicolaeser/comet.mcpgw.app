import { getSessionRedisClient } from "../../runtime/redis.js";
import { logger } from "../../runtime/logger.js";
import type { McpServerSession } from "../server.js";

const REDIS_SESSION_PREFIX = "mcp:session:";

export class McpSessionStore {
  private readonly memorySessions = new Map<string, McpServerSession>();
  private readonly memoryLastSeen = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ttlMs: number) {}

  private get redis() {
    return getSessionRedisClient();
  }

  get size(): number {
    return this.memorySessions.size;
  }

  get(sessionId: string): McpServerSession | undefined {
    return this.memorySessions.get(sessionId);
  }

  async has(sessionId: string): Promise<boolean> {
    if (this.memorySessions.has(sessionId)) return true;
    
    if (this.redis) {
      const exists = await this.redis.exists(`${REDIS_SESSION_PREFIX}${sessionId}`);
      return exists === 1;
    }
    
    return false;
  }

  async register(sessionId: string, session: McpServerSession): Promise<void> {
    this.memorySessions.set(sessionId, session);
    await this.touch(sessionId);
    logger.info("MCP session opened", { sessionId });
  }

  async touch(sessionId: string): Promise<void> {
    const now = Date.now();
    if (this.redis) {
      await this.redis.set(
        `${REDIS_SESSION_PREFIX}${sessionId}`,
        now.toString(),
        "PX",
        this.ttlMs,
      );
    } else {
      this.memoryLastSeen.set(sessionId, now);
    }
  }

  async remove(sessionId: string, reason: string): Promise<void> {
    const session = this.memorySessions.get(sessionId);
    this.memorySessions.delete(sessionId);
    this.memoryLastSeen.delete(sessionId);

    if (this.redis) {
      await this.redis.del(`${REDIS_SESSION_PREFIX}${sessionId}`);
    }

    if (session) {
      try {
        session.close();
      } catch (err) {
        logger.warn("MCP session close failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("MCP session closed", { sessionId, reason });
  }

  async closeAll(reason: string): Promise<void> {
    for (const sessionId of [...this.memorySessions.keys()]) {
      await this.remove(sessionId, reason);
    }
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.removeExpiredSessions(), 60_000);
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private async removeExpiredSessions(): Promise<void> {
    if (this.redis) {
      for (const sessionId of this.memorySessions.keys()) {
        const exists = await this.redis.exists(`${REDIS_SESSION_PREFIX}${sessionId}`);
        if (!exists) {
          await this.remove(sessionId, "idle-timeout");
        }
      }
      return;
    }

    const cutoff = Date.now() - this.ttlMs;
    for (const [sessionId, lastSeen] of this.memoryLastSeen) {
      if (lastSeen < cutoff) {
        await this.remove(sessionId, "idle-timeout");
      }
    }
  }
}
