import { createRequire } from "node:module";
import { z } from "zod";
import type { LogFormat, LogLevel, LoggingMode } from "../runtime/logger.js";

export type AuthMode = "bearer" | "none";

const DEFAULT_PORT = 3000;
const DEFAULT_SERVER_NAME = "comet-mcpgw";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LOGGING_MODE: LoggingMode = "standard";
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_CLIENT_RATE_LIMIT_HEADER = "x-client-id";
const DEFAULT_AUTH_MODE: AuthMode = "bearer";
const DEFAULT_COMET_CDP_URL = "http://host.docker.internal:9222";

export interface RateLimitDefaults {
  windowMs: number;
  clientIdHeader: string;
}

export interface RuntimeConfig {
  port: number;
  publicBaseUrl: string | null;
  serverName: string;
  serverVersion: string;
  sessionTtlMs: number;
  authMode: AuthMode;
  apiKey: string | null;
  allowedOrigins: string[];
  authDisabledOnPurpose: boolean;
  loggingMode: LoggingMode;
  logLevel: LogLevel | null;
  logFormat: LogFormat;
  logRedact: boolean;
  redisUrl: string | null;
  rateLimits: RateLimitDefaults;
  comet: CometConfig;
}

export interface CometConfig {
  cdpHost: string;
  cdpPort: number;
  cdpHttpBase: string;
}

const BooleanEnvSchema = z
  .string()
  .trim()
  .toLowerCase()
  .optional()
  .transform((value, ctx) => {
    if (!value) return false;
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;

    ctx.addIssue({
      code: "custom",
      message: "Expected a boolean value",
    });
    return z.NEVER;
  });

const RuntimeEnvSchema = z.object({
  PORT: positiveIntegerEnv("PORT", DEFAULT_PORT).refine(
    (port) => port <= 65_535,
    "PORT must be between 1 and 65535",
  ),
  PUBLIC_BASE_URL: nullableUrl(),
  SERVER_NAME: optionalTrimmedString(DEFAULT_SERVER_NAME),
  SESSION_TTL_MS: positiveIntegerEnv("SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS),
  API_KEY: nullableTrimmedString(),
  AUTH_MODE: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .pipe(z.enum(["bearer", "none"]).default(DEFAULT_AUTH_MODE)),
  DISABLE_AUTH: BooleanEnvSchema,
  MCP_ALLOWED_ORIGINS: z
    .string()
    .trim()
    .optional()
    .transform((value) => parseAllowedOrigins(value)),
  LOGGING_MODE: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .pipe(z.enum(["standard", "none"]).default(DEFAULT_LOGGING_MODE)),
  LOG_LEVEL: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .pipe(z.enum(["debug", "info", "warn", "error", "silent"]).optional()),
  LOG_FORMAT: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .pipe(z.enum(["json", "pretty"]).optional()),
  LOG_REDACT: BooleanEnvSchema,
  REDIS_URL: nullableTrimmedString(),
  RATE_LIMIT_WINDOW_MS: positiveIntegerEnv(
    "RATE_LIMIT_WINDOW_MS",
    DEFAULT_RATE_LIMIT_WINDOW_MS,
  ),
  RATE_LIMIT_CLIENT_ID_HEADER: optionalTrimmedString(
    DEFAULT_CLIENT_RATE_LIMIT_HEADER,
  ).transform((value) => value.toLowerCase()),
  COMET_CDP_URL: optionalTrimmedString(DEFAULT_COMET_CDP_URL),
});

function positiveIntegerEnv(name: string, defaultValue: number) {
  return z
    .string()
    .trim()
    .optional()
    .transform((rawValue, ctx) => {
      if (!rawValue) return defaultValue;

      const value = Number(rawValue);
      if (!Number.isSafeInteger(value) || value <= 0) {
        ctx.addIssue({
          code: "custom",
          message: `${name} must be a positive integer`,
        });
        return z.NEVER;
      }

      return value;
    });
}

function optionalTrimmedString(defaultValue: string) {
  return z
    .string()
    .trim()
    .optional()
    .transform((value) => value || defaultValue);
}

function nullableTrimmedString() {
  return z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null);
}

function nullableUrl() {
  return z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      if (!value) return null;
      return new URL(value).origin;
    });
}

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => new URL(origin).origin);
}

function readPackageVersion(): string {
  const require = createRequire(import.meta.url);
  return (require("../../package.json") as { version: string }).version;
}

function parseRuntimeEnv(): z.infer<typeof RuntimeEnvSchema> {
  const parsed = RuntimeEnvSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;

  const message = parsed.error.issues
    .map((issue) => {
      const name = issue.path.join(".") || "environment";
      return `${name}: ${issue.message}`;
    })
    .join("; ");

  throw new Error(`Invalid runtime configuration: ${message}`);
}

export function loadRuntimeConfig(): RuntimeConfig {
  const env = parseRuntimeEnv();
  const authMode = env.DISABLE_AUTH ? "none" : env.AUTH_MODE;

  if (authMode === "bearer" && !env.API_KEY) {
    throw new Error(
      "Invalid runtime configuration: API_KEY is required when AUTH_MODE=bearer. " +
        "Set API_KEY to a strong secret, or set AUTH_MODE=none / DISABLE_AUTH=true to opt out explicitly.",
    );
  }

  return {
    port: env.PORT,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    serverName: env.SERVER_NAME,
    serverVersion: readPackageVersion(),
    sessionTtlMs: env.SESSION_TTL_MS,
    authMode,
    apiKey: authMode === "none" ? null : env.API_KEY,
    allowedOrigins: env.MCP_ALLOWED_ORIGINS,
    authDisabledOnPurpose: authMode === "none",
    loggingMode: env.LOGGING_MODE,
    logLevel: env.LOG_LEVEL ?? null,
    logFormat: env.LOG_FORMAT ?? "pretty",
    logRedact: env.LOG_REDACT === false ? false : true,
    redisUrl: env.REDIS_URL,
    rateLimits: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      clientIdHeader: env.RATE_LIMIT_CLIENT_ID_HEADER,
    },
    comet: parseCometConfig(env.COMET_CDP_URL),
  };
}

function parseCometConfig(rawUrl: string): CometConfig {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `COMET_CDP_URL must use http or https (got "${url.protocol}")`,
    );
  }

  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);

  return {
    cdpHost: url.hostname,
    cdpPort: port,
    cdpHttpBase: `${url.protocol}//${url.hostname}:${port}`,
  };
}
