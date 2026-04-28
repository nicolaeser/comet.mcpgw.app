import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Tool } from "../types.js";
import { logger } from "../runtime/logger.js";
import { findRuntimeModules } from "./module-loader.js";

function isTool(value: unknown): value is Tool {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<Tool>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.inputSchema === "object" &&
    typeof candidate.execute === "function"
  );
}

const cache = new Map<string, Promise<Tool[]>>();

export async function loadTools(
  toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../tools"),
): Promise<Tool[]> {
  const cached = cache.get(toolsDir);
  if (cached) return cached;

  const promise = loadToolsUncached(toolsDir);
  cache.set(toolsDir, promise);
  return promise;
}

async function loadToolsUncached(toolsDir: string): Promise<Tool[]> {
  const tools: Tool[] = [];
  const names = new Map<string, string>();

  for (const { file, displayPath } of findRuntimeModules(toolsDir)) {
    const mod = await import(pathToFileURL(file).href);

    if (!isTool(mod.default)) {
      logger.warn(
        "Tool module ignored",
        { file: displayPath },
        { privacySafe: true },
      );
      continue;
    }

    const tool = mod.default;
    const existingPath = names.get(tool.name);
    if (existingPath) {
      logger.warn(
        "Tool name already registered",
        {
          tool: tool.name,
          file: displayPath,
          existingFile: existingPath,
        },
        { privacySafe: true },
      );
      continue;
    }

    names.set(tool.name, displayPath);
    tools.push(tool);
    logger.info(
      "Tool registered",
      { tool: tool.name, file: displayPath },
      { privacySafe: true },
    );
  }

  return tools;
}
