import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_console",
  title: "Read task console logs",
  description: "Return buffered console.log/warn/error/info entries from the task's tab. Buffer holds the most recent COMET_MAX_CONSOLE entries (default 500). Pass clear=true to flush the buffer.",
  rateLimit: { tool: { max: 120 } },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to inspect."),
    limit: z.number().int().min(1).max(500).default(100).describe("Max entries to return (most recent)."),
    level: z.enum(["log", "info", "warn", "error", "debug", "trace"]).optional().describe("Filter by log level."),
    substring: z.string().optional().describe("Only entries whose text contains this substring."),
    clear: z.boolean().default(false).describe("Clear the buffer after returning entries."),
  },
  async execute({ task_id, limit, level, substring, clear }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const entries = task.client.getConsoleEntries({ limit, level, substring });
        if (clear) task.client.clearConsoleBuffer();
        if (entries.length === 0) {
          return textResult(`No console entries${level ? ` at level=${level}` : ""}${substring ? ` matching "${substring}"` : ""}.`);
        }
        const lines = entries.map((e) => {
          const t = new Date(e.ts).toISOString().split("T")[1].slice(0, 12);
          const where = e.url ? ` (${e.url}:${e.line ?? "?"})` : "";
          return `[${t}] ${e.level.toUpperCase().padEnd(5)} ${e.text}${where}`;
        });
        return textResult(lines.join("\n"));
      });
    } catch (err) {
      return errorResult(`comet_console failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
