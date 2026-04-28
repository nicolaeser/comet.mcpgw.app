import type { IncomingHttpHeaders } from "node:http";

const INTERNAL_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "accept-encoding",
  "mcp-session-id",
]);

export function extractClientHeaders(
  incoming: IncomingHttpHeaders,
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(incoming)) {
    if (!INTERNAL_HEADERS.has(key) && typeof value === "string") {
      headers[key] = value;
    }
  }

  return headers;
}
