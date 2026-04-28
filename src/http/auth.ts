import type { RequestHandler } from "express";
import type { RuntimeConfig } from "../config/environment.js";
import { jsonRpcError, MCP_ERROR_UNAUTHORIZED } from "../mcp/json-rpc.js";

export function createAuthMiddleware(config: RuntimeConfig): RequestHandler {
  return (req, res, next) => {
    if (req.method === "OPTIONS") {
      next();
      return;
    }

    if (config.authMode === "none") {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    const isValidToken = Boolean(
      config.apiKey && token && token === config.apiKey,
    );
    if (!isValidToken) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res
        .status(401)
        .json(
          jsonRpcError(
            null,
            MCP_ERROR_UNAUTHORIZED,
            "Unauthorized: missing or invalid bearer token",
          ),
        );
      return;
    }

    next();
  };
}
