import { taskRegistry } from "./comet/task-registry.js";
import { loadRuntimeConfig } from "./config/environment.js";
import { createHttpApp } from "./http/app.js";
import { configureLogger, logger } from "./runtime/logger.js";
import { closeRedisClient, initializeRedis } from "./runtime/redis.js";

const config = loadRuntimeConfig();
configureLogger({
  level: config.logLevel ?? undefined,
  format: config.logFormat,
  redactSensitive: config.logRedact,
  legacyMode: config.loggingMode,
  serviceName: config.serverName,
  serviceVersion: config.serverVersion,
});
await initializeRedis(config);
const { app, sessions } = createHttpApp(config);

sessions.startCleanup();
taskRegistry.startCleanup();

const server = app.listen(config.port, () => {
  logger.info(
    "HTTP server listening",
    {
      name: config.serverName,
      version: config.serverVersion,
      url: `http://0.0.0.0:${config.port}/mcp`,
      sessionTtlSeconds: config.sessionTtlMs / 1000,
      loggingMode: config.loggingMode,
    },
    { privacySafe: true },
  );
});

server.on("error", (err) => {
  logger.error("HTTP server startup failed", { error: err.message });
  sessions.stopCleanup();
  sessions.closeAll("startup-error");
  void closeRedisClient().finally(() => {
    process.exit(1);
  });
});

let isShuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info("Shutdown initiated", { signal });
  sessions.stopCleanup();
  sessions.closeAll("shutdown");
  taskRegistry.stopCleanup();
  void taskRegistry.closeAll();

  server.close((err) => {
    if (err) {
      logger.error("HTTP server close failed", { error: err.message });
      void closeRedisClient().finally(() => {
        process.exit(1);
      });
      return;
    }

    void closeRedisClient().finally(() => {
      logger.info("Shutdown completed");
      process.exit(0);
    });
  });

  setTimeout(() => {
    logger.error("Shutdown timeout exceeded");
    process.exit(1);
  }, 10_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
