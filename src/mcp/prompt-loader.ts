import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../runtime/logger.js";
import type { Prompt } from "../types.js";
import { findRuntimeModules } from "./module-loader.js";

function isPrompt(value: unknown): value is Prompt {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<Prompt>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.inputSchema === "object" &&
    typeof candidate.get === "function"
  );
}

const cache = new Map<string, Promise<Prompt[]>>();

export async function loadPrompts(
  promptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../prompts"),
): Promise<Prompt[]> {
  const cached = cache.get(promptsDir);
  if (cached) return cached;

  const promise = loadPromptsUncached(promptsDir);
  cache.set(promptsDir, promise);
  return promise;
}

async function loadPromptsUncached(promptsDir: string): Promise<Prompt[]> {
  const prompts: Prompt[] = [];
  const names = new Map<string, string>();

  for (const { file, displayPath } of findRuntimeModules(promptsDir)) {
    const mod = await import(pathToFileURL(file).href);

    if (!isPrompt(mod.default)) {
      logger.warn(
        "Prompt module ignored",
        { file: displayPath },
        { privacySafe: true },
      );
      continue;
    }

    const prompt = mod.default;
    const existingPath = names.get(prompt.name);
    if (existingPath) {
      logger.warn(
        "Prompt name already registered",
        {
          prompt: prompt.name,
          file: displayPath,
          existingFile: existingPath,
        },
        { privacySafe: true },
      );
      continue;
    }

    names.set(prompt.name, displayPath);
    prompts.push(prompt);
    logger.info(
      "Prompt registered",
      { prompt: prompt.name, file: displayPath },
      { privacySafe: true },
    );
  }

  return prompts;
}
