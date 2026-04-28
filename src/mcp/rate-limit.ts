import type { RateLimitDefaults } from "../config/environment.js";
import { getRateLimitRedisClient } from "../runtime/redis.js";
import type { ClientRateLimitRule, RateLimitRule, Tool } from "../types.js";

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimitCheck {
  key: string;
  max: number;
  scope: "client" | "tool";
  windowMs: number;
}

type RedisRateLimitResult = [
  allowed: number,
  failedIndex: number,
  retryAfterMs: number,
];

const REDIS_RATE_LIMIT_SCRIPT = `
for i = 1, #KEYS do
  local max = tonumber(ARGV[(i - 1) * 2 + 1])
  local count = tonumber(redis.call("GET", KEYS[i]) or "0")
  if count >= max then
    local ttl = redis.call("PTTL", KEYS[i])
    if ttl < 0 then ttl = 0 end
    return {0, i, ttl}
  end
end

for i = 1, #KEYS do
  local window = tonumber(ARGV[(i - 1) * 2 + 2])
  local count = redis.call("INCR", KEYS[i])
  if count == 1 then
    redis.call("PEXPIRE", KEYS[i], window)
  end
end

return {1, 0, 0}
`;

export interface ToolRateLimitContext {
  tool: Tool;
  sessionId?: string;
  clientHeaders: Record<string, string>;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs?: number;
  scope?: "client" | "tool";
}

export class ToolRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly defaults: RateLimitDefaults) {}

  async check(context: ToolRateLimitContext): Promise<RateLimitDecision> {
    const checks = this.createChecks(context);
    if (checks.length === 0) return { allowed: true };

    const redis = getRateLimitRedisClient();
    if (redis) {
      return this.checkRedis(checks);
    }

    return this.checkMemory(checks);
  }

  private checkMemory(checks: RateLimitCheck[]): RateLimitDecision {
    const now = Date.now();
    const buckets = checks.map((check) => ({
      check,
      bucket: this.resolveBucket(check, now),
    }));

    for (const { check, bucket } of buckets) {
      if (bucket.count >= check.max) {
        return {
          allowed: false,
          retryAfterMs: Math.max(bucket.resetAt - now, 0),
          scope: check.scope,
        };
      }
    }

    for (const { check, bucket } of buckets) {
      bucket.count += 1;
      this.buckets.set(check.key, bucket);
    }

    this.prune(now);

    return { allowed: true };
  }

  private async checkRedis(
    checks: RateLimitCheck[],
  ): Promise<RateLimitDecision> {
    const redis = getRateLimitRedisClient();
    if (!redis) return this.checkMemory(checks);

    const keys = checks.map((check) => `mcp:rate-limit:${check.key}`);
    const args = checks.flatMap((check) => [
      String(check.max),
      String(check.windowMs),
    ]);

    try {
      const result = (await redis.eval(
        REDIS_RATE_LIMIT_SCRIPT,
        keys.length,
        ...keys,
        ...args,
      )) as RedisRateLimitResult;

      if (result[0] === 1) {
        return { allowed: true };
      }

      const failedCheck = checks[result[1] - 1];
      return {
        allowed: false,
        retryAfterMs: result[2],
        scope: failedCheck?.scope,
      };
    } catch {
      return this.checkMemory(checks);
    }
  }

  private createChecks(context: ToolRateLimitContext): RateLimitCheck[] {
    const rateLimit = context.tool.rateLimit;
    if (!rateLimit) return [];

    const checks: RateLimitCheck[] = [];

    if (rateLimit.tool) {
      checks.push({
        key: `tool:${context.tool.name}`,
        max: rateLimit.tool.max,
        scope: "tool",
        windowMs: this.resolveWindow(rateLimit.tool),
      });
    }

    if (rateLimit.client) {
      const clientId = this.resolveClientId(context, rateLimit.client);
      checks.push({
        key: `client:${context.tool.name}:${clientId}`,
        max: rateLimit.client.max,
        scope: "client",
        windowMs: this.resolveWindow(rateLimit.client),
      });
    }

    return checks.filter((check) => check.max > 0);
  }

  private resolveClientId(
    context: ToolRateLimitContext,
    rule: ClientRateLimitRule,
  ): string {
    const header = rule.idHeader?.toLowerCase() || this.defaults.clientIdHeader;
    return context.clientHeaders[header] || context.sessionId || "anonymous";
  }

  private resolveWindow(rule: RateLimitRule): number {
    return rule.windowMs ?? this.defaults.windowMs;
  }

  private resolveBucket(check: RateLimitCheck, now: number): Bucket {
    const existing = this.buckets.get(check.key);
    if (existing && existing.resetAt > now) {
      return existing;
    }

    return { count: 0, resetAt: now + check.windowMs };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
