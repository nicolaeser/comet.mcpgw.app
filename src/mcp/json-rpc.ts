export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcClientResponse = JsonRpcResponse;

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const JSON_RPC_SERVER_ERROR = -32000;
export const MCP_ERROR_UNAUTHORIZED = -32001;
export const MCP_ERROR_RESOURCE_NOT_FOUND = -32002;
export const MCP_ERROR_ORIGIN_NOT_ALLOWED = -32004;

export class McpJsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id: normalizeJsonRpcId(id),
    error: {
      code,
      message,
      ...(data !== undefined && { data }),
    },
  };
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJsonRpcClientResponse(
  value: unknown,
): value is JsonRpcClientResponse {
  if (!isJsonRpcMessage(value)) return false;
  if (!("id" in value) || value.method !== undefined) return false;
  return "result" in value || "error" in value;
}

export function parseJsonRpcId(
  value: unknown,
): { ok: true; value: JsonRpcId } | { ok: false } {
  if (
    value === undefined ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { ok: true, value: value ?? null };
  }

  return { ok: false };
}

function normalizeJsonRpcId(id: unknown): JsonRpcId {
  if (typeof id === "string") return id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  return null;
}
