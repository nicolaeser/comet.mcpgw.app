import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_network",
  title: "Read task network requests",
  description: "Return buffered network requests/responses from the task's tab. Buffer holds the most recent COMET_MAX_NETWORK entries (default 500). Pass urlSubstring/onlyFailed/minStatus to filter.",
  rateLimit: { tool: { max: 120 } },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to inspect."),
    limit: z.number().int().min(1).max(500).default(50).describe("Max entries to return (most recent)."),
    urlSubstring: z.string().optional().describe("Only entries whose URL contains this substring."),
    onlyFailed: z.boolean().default(false).describe("Only failed requests or status >= 400."),
    minStatus: z.number().int().min(100).max(599).optional().describe("Only responses with status >= this."),
    clear: z.boolean().default(false).describe("Clear the buffer after returning entries."),
  },
  async execute({ task_id, limit, urlSubstring, onlyFailed, minStatus, clear }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const entries = task.client.getNetworkEntries({ limit, urlSubstring, onlyFailed, minStatus });
        if (clear) task.client.clearNetworkBuffer();
        if (entries.length === 0) {
          return textResult("No network entries match the filter.");
        }
        const lines = entries.map((e) => {
          const t = new Date(e.ts).toISOString().split("T")[1].slice(0, 12);
          const status = e.failed
            ? `FAIL(${e.failureReason ?? "?"})`
            : e.status !== undefined
            ? `${e.status}`
            : "...";
          const size = e.encodedDataLength !== undefined ? `${e.encodedDataLength}b` : "-";
          const dur = e.durationMs !== undefined ? `${e.durationMs}ms` : "-";
          return `[${t}] ${e.method.padEnd(6)} ${status.padEnd(8)} ${size.padStart(8)} ${dur.padStart(7)} [${e.resourceType}] ${e.url}`;
        });
        return textResult(lines.join("\n"));
      });
    } catch (err) {
      return errorResult(`comet_network failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
