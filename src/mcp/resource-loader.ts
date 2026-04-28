import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../runtime/logger.js";
import type { Resource } from "../types.js";
import { findRuntimeModules } from "./module-loader.js";

function isResource(value: unknown): value is Resource {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<Resource>;
  return (
    typeof candidate.uri === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.read === "function"
  );
}

const cache = new Map<string, Promise<Resource[]>>();

export async function loadResources(
  resourcesDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../resources",
  ),
): Promise<Resource[]> {
  const cached = cache.get(resourcesDir);
  if (cached) return cached;

  const promise = loadResourcesUncached(resourcesDir);
  cache.set(resourcesDir, promise);
  return promise;
}

async function loadResourcesUncached(
  resourcesDir: string,
): Promise<Resource[]> {
  const resources: Resource[] = [];
  const uris = new Map<string, string>();

  for (const { file, displayPath } of findRuntimeModules(resourcesDir)) {
    const mod = await import(pathToFileURL(file).href);

    if (!isResource(mod.default)) {
      logger.warn(
        "Resource module ignored",
        { file: displayPath },
        { privacySafe: true },
      );
      continue;
    }

    const resource = mod.default;
    const existingPath = uris.get(resource.uri);
    if (existingPath) {
      logger.warn(
        "Resource URI already registered",
        {
          resource: resource.uri,
          file: displayPath,
          existingFile: existingPath,
        },
        { privacySafe: true },
      );
      continue;
    }

    uris.set(resource.uri, displayPath);
    resources.push(resource);
    logger.info(
      "Resource registered",
      { resource: resource.uri, file: displayPath },
      { privacySafe: true },
    );
  }

  return resources;
}
