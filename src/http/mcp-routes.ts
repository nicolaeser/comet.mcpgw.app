import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { RuntimeConfig } from "../config/environment.js";
import type { ToolRateLimiter } from "../mcp/rate-limit.js";
import { createMcpServerSession, isInitializeRequest } from "../mcp/server.js";
import type { McpSessionStore } from "../mcp/persistence/session-store.js";
import {
  jsonRpcError,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_PARSE_ERROR,
  MCP_ERROR_ORIGIN_NOT_ALLOWED,
} from "../mcp/json-rpc.js";
import { isSupportedProtocolVersion } from "../mcp/protocol.js";
import { LATEST_PROTOCOL_VERSION } from "../mcp/protocol.js";
import { logger } from "../runtime/logger.js";
import { extractClientHeaders } from "./headers.js";

interface McpRouterOptions {
  config: RuntimeConfig;
  rateLimiter: ToolRateLimiter;
  sessions: McpSessionStore;
}

function createSessionId(): string {
  return `${randomUUID()}-${randomUUID()}-${Date.now()}`;
}

function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getSessionId(req: Request): string | undefined {
  const value = req.headers["mcp-session-id"];
  return typeof value === "string" ? value : undefined;
}

function getProtocolVersion(req: Request): string | undefined {
  const value = req.headers["mcp-protocol-version"];
  return typeof value === "string" ? value : undefined;
}

function rejectMissingSession(res: Response): void {
  res
    .status(400)
    .json(
      jsonRpcError(
        null,
        JSON_RPC_INVALID_REQUEST,
        "Missing or invalid mcp-session-id header",
      ),
    );
}

function rejectUnsupportedProtocolVersion(res: Response): void {
  res
    .status(400)
    .json(
      jsonRpcError(
        null,
        JSON_RPC_INVALID_REQUEST,
        "Unsupported MCP protocol version",
      ),
    );
}

function hasSupportedProtocolVersion(req: Request): boolean {
  const protocolVersion = getProtocolVersion(req);
  return !protocolVersion || isSupportedProtocolVersion(protocolVersion);
}

function isAllowedOrigin(req: Request, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return true;

  try {
    const parsedOrigin = new URL(origin);
    const requestHost = req.headers.host;
    if (requestHost && parsedOrigin.host === requestHost) return true;
    if (requestHost && isLoopbackPair(parsedOrigin.hostname, requestHost)) {
      return true;
    }

    return allowedOrigins.includes(parsedOrigin.origin);
  } catch {
    return false;
  }
}

function isLoopbackPair(originHostname: string, requestHost: string): boolean {
  return (
    isLoopbackHost(originHostname) && isLoopbackHost(parseHost(requestHost))
  );
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;

  if (isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }

  return false;
}

function parseHost(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host.split(":")[0] ?? host;
  }
}

function applyCorsHeaders(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "mcp-session-id, mcp-protocol-version",
  );

  const requestedHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    typeof requestedHeaders === "string"
      ? requestedHeaders
      : "authorization, content-type, mcp-session-id, mcp-protocol-version",
  );
  res.vary("Origin");
  res.vary("Access-Control-Request-Headers");
}

function rejectInvalidOrigin(res: Response): void {
  res
    .status(403)
    .json(
      jsonRpcError(
        null,
        MCP_ERROR_ORIGIN_NOT_ALLOWED,
        "Origin is not allowed for this MCP endpoint",
      ),
    );
}

export function createMcpRouter({
  config,
  rateLimiter,
  sessions,
}: McpRouterOptions): Router {
  const router = Router();

  router.use((req, res, next) => {
    res.setHeader("mcp-protocol-version", LATEST_PROTOCOL_VERSION);

    if (!isAllowedOrigin(req, config.allowedOrigins)) {
      rejectInvalidOrigin(res);
      return;
    }

    applyCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    if (!hasSupportedProtocolVersion(req)) {
      rejectUnsupportedProtocolVersion(res);
      return;
    }

    next();
  });

  router.post(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = getSessionId(req);

      if (sessionId && await sessions.has(sessionId)) {
        await sessions.touch(sessionId);
        await sessions.get(sessionId)!.handlePost(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res
          .status(400)
          .json(
            jsonRpcError(
              req.body?.id,
              JSON_RPC_INVALID_REQUEST,
              "Must start with an initialize request",
            ),
          );
        return;
      }

      const clientHeaders = extractClientHeaders(req.headers);
      const newSessionId = createSessionId();
      const session = await createMcpServerSession({
        name: config.serverName,
        version: config.serverVersion,
        sessionId: newSessionId,
        clientHeaders,
        rateLimiter,
      });

      await sessions.register(newSessionId, session);
      await session.handlePost(req, res, req.body);
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = getSessionId(req);
      if (!sessionId || !await sessions.has(sessionId)) {
        rejectMissingSession(res);
        return;
      }

      await sessions.touch(sessionId);
      sessions.get(sessionId)!.handleGet(req, res);
    }),
  );

  router.delete(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = getSessionId(req);
      if (!sessionId || !await sessions.has(sessionId)) {
        rejectMissingSession(res);
        return;
      }

      await sessions.remove(sessionId, "terminated");
      res.status(202).end();
    }),
  );

  router.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(err);
        return;
      }

      if (err instanceof SyntaxError) {
        res
          .status(400)
          .json(jsonRpcError(null, JSON_RPC_PARSE_ERROR, "Parse error"));
        return;
      }

      logger.error("MCP request handling failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res
        .status(500)
        .json(jsonRpcError(null, JSON_RPC_INTERNAL_ERROR, "Internal error"));
    },
  );

  return router;
}
