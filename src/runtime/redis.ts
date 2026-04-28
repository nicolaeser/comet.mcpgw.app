import { Redis, type RedisOptions } from "ioredis";
import type { RuntimeConfig } from "../config/environment.js";
import { logger } from "./logger.js";

export type RedisClient = Redis;

let sessionRedisClient: RedisClient | null = null;
let taskRedisClient: RedisClient | null = null;
let toolCacheRedisClient: RedisClient | null = null;
let rateLimitRedisClient: RedisClient | null = null;
let cometResultRedisClient: RedisClient | null = null;

const baseRedisOptions: RedisOptions = {
  connectTimeout: 5_000,
  enableReadyCheck: true,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
};

function createRedisClient(redisUrl: string, db: number): RedisClient {
  return new Redis(redisUrl, { ...baseRedisOptions, db });
}

function bindRedisErrorLog(client: RedisClient, name: string): void {
  client.on("error", () => {
    logger.warn(`${name} Redis client reported an error`);
  });
}

async function connectRedisClient(
  redisUrl: string,
  db: number,
  name: string,
): Promise<RedisClient | null> {
  const client = createRedisClient(redisUrl, db);
  bindRedisErrorLog(client, name);

  try {
    await client.connect();
  } catch {
    client.disconnect();
    logger.warn(`${name} Redis connection unavailable`);
    return null;
  }

  logger.info(`${name} Redis connection established`, undefined, {
    privacySafe: true,
  });
  return client;
}

export function getSessionRedisClient(): RedisClient | null {
  return sessionRedisClient;
}

export function getTaskRedisClient(): RedisClient | null {
  return taskRedisClient;
}

export function getToolCacheRedisClient(): RedisClient | null {
  return toolCacheRedisClient;
}

export function getRedisClient(): RedisClient | null {
  return getToolCacheRedisClient();
}

export function getRateLimitRedisClient(): RedisClient | null {
  return rateLimitRedisClient;
}

export function getCometResultRedisClient(): RedisClient | null {
  return cometResultRedisClient;
}

export async function initializeRedis(
  config: Pick<RuntimeConfig, "redisUrl">,
): Promise<void> {
  if (!config.redisUrl) {
    logger.info("Redis integration disabled", undefined, { privacySafe: true });
    return;
  }

  sessionRedisClient = await connectRedisClient(config.redisUrl, 0, "Session");
  rateLimitRedisClient = await connectRedisClient(
    config.redisUrl,
    1,
    "Rate limit",
  );
  taskRedisClient = await connectRedisClient(config.redisUrl, 2, "Task");
  toolCacheRedisClient = await connectRedisClient(
    config.redisUrl,
    3,
    "Tool cache",
  );
  cometResultRedisClient = await connectRedisClient(
    config.redisUrl,
    4,
    "Comet result",
  );
}

async function closeClient(
  client: RedisClient | null,
  name: string,
): Promise<void> {
  if (!client) return;

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }

  logger.info(`${name} Redis connection closed`, undefined, {
    privacySafe: true,
  });
}

export async function closeRedisClient(): Promise<void> {
  const sessionClient = sessionRedisClient;
  const taskClient = taskRedisClient;
  const toolCacheClient = toolCacheRedisClient;
  const rateLimitClient = rateLimitRedisClient;
  const cometResultClient = cometResultRedisClient;

  sessionRedisClient = null;
  taskRedisClient = null;
  toolCacheRedisClient = null;
  rateLimitRedisClient = null;
  cometResultRedisClient = null;

  await Promise.all([
    closeClient(sessionClient, "Session"),
    closeClient(taskClient, "Task"),
    closeClient(toolCacheClient, "Tool cache"),
    closeClient(rateLimitClient, "Rate limit"),
    closeClient(cometResultClient, "Comet result"),
  ]);
}
