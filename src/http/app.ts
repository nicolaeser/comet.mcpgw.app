import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { RuntimeConfig } from "../config/environment.js";
import { ToolRateLimiter } from "../mcp/rate-limit.js";
import { McpSessionStore } from "../mcp/persistence/session-store.js";
import { jsonRpcError, JSON_RPC_PARSE_ERROR } from "../mcp/json-rpc.js";
import { logger } from "../runtime/logger.js";
import { createAuthMiddleware } from "./auth.js";
import { createMcpRouter } from "./mcp-routes.js";

interface HttpApp {
  app: Express;
  sessions: McpSessionStore;
}

export function createHttpApp(config: RuntimeConfig): HttpApp {
  const app = express();
  const sessions = new McpSessionStore(config.sessionTtlMs);
  const rateLimiter = new ToolRateLimiter(config.rateLimits);

  app.use(express.json());

  if (config.authMode === "none") {
    logger.info("MCP authentication intentionally disabled");
  } else {
    logger.info("MCP bearer authentication enabled");
  }

  app.use(
    "/mcp",
    createAuthMiddleware(config),
    createMcpRouter({ config, rateLimiter, sessions }),
  );

  app.get("/internal-api/heartbeat", (_req, res) => {
    res.json({ status: "ok", sessions: sessions.size });
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
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

    logger.error("HTTP request handling failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Internal server error" });
  });

  return { app, sessions };
}
