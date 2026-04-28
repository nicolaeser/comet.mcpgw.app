import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

function isIgnoredEntry(name: string): boolean {
  return (
    name.startsWith("_") ||
    name === "index.js" ||
    name === "index.ts" ||
    name.endsWith(".test.js") ||
    name.endsWith(".spec.js") ||
    name.endsWith(".test.ts") ||
    name.endsWith(".spec.ts") ||
    name.endsWith(".d.ts")
  );
}

function findModuleFiles(rootDir: string, currentDir = rootDir): string[] {
  if (!existsSync(currentDir)) return [];

  const entries = readdirSync(currentDir, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const files: string[] = [];

  for (const entry of entries) {
    if (isIgnoredEntry(entry.name)) {
      continue;
    }

    const entryPath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findModuleFiles(rootDir, entryPath));
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".ts"))) {
      files.push(entryPath);
    }
  }

  return files;
}

export interface ModuleFile {
  file: string;
  displayPath: string;
}

export function findRuntimeModules(rootDir: string): ModuleFile[] {
  return findModuleFiles(rootDir).map((file) => ({
    file,
    displayPath: relative(rootDir, file),
  }));
}
