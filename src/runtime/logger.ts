import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFormat = "json" | "pretty";
export type LoggingMode = "none" | "standard";

export interface LogFields {
  [key: string]: unknown;
}

export interface LogOptions {
  privacySafe?: boolean;
}

export interface Logger {
  debug(message: string, fields?: LogFields, options?: LogOptions): void;
  info(message: string, fields?: LogFields, options?: LogOptions): void;
  warn(message: string, fields?: LogFields, options?: LogOptions): void;
  error(message: string, fields?: LogFields, options?: LogOptions): void;
  child(bindings: LogFields): Logger;
  withContext<T>(bindings: LogFields, fn: () => T): T;
}

const LEVEL_RANK: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEYS = new Set([
  "authorization",
  "apikey",
  "api_key",
  "password",
  "secret",
  "token",
  "session_token",
  "cookie",
  "set-cookie",
  "bearer",
  "x-api-key",
  "private",
  "credential",
  "credentials",
  "passphrase",
]);

const PID = process.pid;
const HOSTNAME = (() => {
  try {
    return process.env.HOSTNAME ?? "";
  } catch {
    return "";
  }
})();

interface LoggerState {
  level: LogLevel;
  format: LogFormat;
  redactSensitive: boolean;
  dropNonPrivacySafeFields: boolean;
  serviceName: string;
  serviceVersion?: string;
  baseFields: LogFields;
}

const state: LoggerState = {
  level: "info",
  format: "pretty",
  redactSensitive: true,
  dropNonPrivacySafeFields: false,
  serviceName: "comet-mcpgw",
  serviceVersion: undefined,
  baseFields: {},
};

const als = new AsyncLocalStorage<LogFields>();

export function configureLogger(opts: {
  level?: LogLevel;
  format?: LogFormat;
  redactSensitive?: boolean;
  legacyMode?: LoggingMode;
  serviceName?: string;
  serviceVersion?: string;
  baseFields?: LogFields;
}): void {
  if (opts.level !== undefined) state.level = opts.level;
  if (opts.format !== undefined) state.format = opts.format;
  if (opts.redactSensitive !== undefined) state.redactSensitive = opts.redactSensitive;
  if (opts.serviceName !== undefined) state.serviceName = opts.serviceName;
  if (opts.serviceVersion !== undefined) state.serviceVersion = opts.serviceVersion;
  if (opts.baseFields !== undefined) state.baseFields = opts.baseFields;

  if (opts.legacyMode !== undefined) {
    state.dropNonPrivacySafeFields = opts.legacyMode === "none";
  }
}

function shouldLog(target: Exclude<LogLevel, "silent">): boolean {
  if (state.level === "silent") return false;
  return LEVEL_RANK[target] >= LEVEL_RANK[state.level];
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function redactValue(value: unknown, key?: string): unknown {
  if (state.redactSensitive && key && isSensitiveKey(key)) {
    if (value === undefined || value === null) return value;
    if (typeof value === "string") {
      return value.length > 6 ? `${value.slice(0, 3)}…[REDACTED]` : "[REDACTED]";
    }
    return "[REDACTED]";
  }
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  return value;
}

function redactFields(fields: LogFields): LogFields {
  if (!state.redactSensitive) return fields;
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = redactValue(v, k);
  }
  return out;
}

function formatPretty(level: Exclude<LogLevel, "silent">, message: string, fields: LogFields): string {
  const ts = new Date().toISOString();
  const tag = `[${level}]`.padEnd(7);
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  let suffix = "";
  if (entries.length > 0) {
    const parts = entries.map(([k, v]) => {
      if (v === null) return `${k}=null`;
      if (typeof v === "string") {
        return /[\s="]/.test(v) ? `${k}=${JSON.stringify(v)}` : `${k}=${v}`;
      }
      if (typeof v === "object") return `${k}=${JSON.stringify(v)}`;
      return `${k}=${String(v)}`;
    });
    suffix = ` ${parts.join(" ")}`;
  }
  return `${ts} ${tag} ${message}${suffix}`;
}

function formatJson(level: Exclude<LogLevel, "silent">, message: string, fields: LogFields): string {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    service: state.serviceName,
    pid: PID,
  };
  if (state.serviceVersion) record.version = state.serviceVersion;
  if (HOSTNAME) record.host = HOSTNAME;
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) record[k] = v;
  }
  return JSON.stringify(record);
}

function emit(
  target: Exclude<LogLevel, "silent">,
  message: string,
  bound: LogFields,
  callerFields: LogFields | undefined,
  options: LogOptions,
): void {
  if (!shouldLog(target)) return;

  let fields: LogFields = { ...state.baseFields, ...(als.getStore() ?? {}), ...bound };
  if (callerFields && !(state.dropNonPrivacySafeFields && !options.privacySafe)) {
    fields = { ...fields, ...callerFields };
  }
  fields = redactFields(fields);

  const line =
    state.format === "json"
      ? formatJson(target, message, fields)
      : formatPretty(target, message, fields);

  const stream = target === "error" || target === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function makeLogger(bound: LogFields): Logger {
  const wrap =
    (target: Exclude<LogLevel, "silent">) =>
    (message: string, fields?: LogFields, options: LogOptions = {}) =>
      emit(target, message, bound, fields, options);

  return {
    debug: wrap("debug"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
    child(bindings) {
      return makeLogger({ ...bound, ...bindings });
    },
    withContext(bindings, fn) {
      const merged = { ...(als.getStore() ?? {}), ...bindings };
      return als.run(merged, fn);
    },
  };
}

export const logger: Logger = makeLogger({});
