import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../runtime/logger.js";
import type { ResourceTemplate } from "../types.js";
import { findRuntimeModules } from "./module-loader.js";

function isResourceTemplate(value: unknown): value is ResourceTemplate {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<ResourceTemplate>;
  return (
    typeof candidate.uriTemplate === "string" &&
    typeof candidate.name === "string"
  );
}

const cache = new Map<string, Promise<ResourceTemplate[]>>();

export async function loadResourceTemplates(
  templatesDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../resource-templates",
  ),
): Promise<ResourceTemplate[]> {
  const cached = cache.get(templatesDir);
  if (cached) return cached;

  const promise = loadResourceTemplatesUncached(templatesDir);
  cache.set(templatesDir, promise);
  return promise;
}

async function loadResourceTemplatesUncached(
  templatesDir: string,
): Promise<ResourceTemplate[]> {
  const templates: ResourceTemplate[] = [];
  const uris = new Map<string, string>();

  for (const { file, displayPath } of findRuntimeModules(templatesDir)) {
    const mod = await import(pathToFileURL(file).href);

    if (!isResourceTemplate(mod.default)) {
      logger.warn(
        "Resource template module ignored",
        { file: displayPath },
        { privacySafe: true },
      );
      continue;
    }

    const template = mod.default;
    const existingPath = uris.get(template.uriTemplate);
    if (existingPath) {
      logger.warn(
        "Resource template URI already registered",
        {
          resourceTemplate: template.uriTemplate,
          file: displayPath,
          existingFile: existingPath,
        },
        { privacySafe: true },
      );
      continue;
    }

    uris.set(template.uriTemplate, displayPath);
    templates.push(template);
    logger.info(
      "Resource template registered",
      { resourceTemplate: template.uriTemplate, file: displayPath },
      { privacySafe: true },
    );
  }

  return templates;
}
