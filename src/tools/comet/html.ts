import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_html",
  title: "Read task HTML",
  description: "Return the outerHTML of the task's tab — full document by default, or the first match of a CSS selector. Truncated by `maxBytes` (default 200_000) so the response stays manageable.",
  rateLimit: { tool: { max: 60 } },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to inspect."),
    selector: z.string().optional().describe("CSS selector. Omit for the full document."),
    maxBytes: z.number().int().min(1_000).max(1_000_000).default(200_000).describe("Truncate output to this many bytes."),
  },
  async execute({ task_id, selector, maxBytes }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const html = await task.client.getOuterHTML(selector);
        if (html === null) {
          return textResult(selector ? `No element matches selector "${selector}".` : "No HTML returned.");
        }
        const truncated = html.length > maxBytes
          ? `${html.slice(0, maxBytes)}\n…[truncated ${html.length - maxBytes} bytes]`
          : html;
        return textResult(truncated);
      });
    } catch (err) {
      return errorResult(`comet_html failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
