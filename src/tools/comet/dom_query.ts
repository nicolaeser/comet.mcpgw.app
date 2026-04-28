import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_dom_query",
  title: "Query DOM elements",
  description: "querySelectorAll a CSS selector and return a structured summary of each match (tag, id, class, attributes, trimmed text, visible flag). Safer than comet_eval for read-only inspection because no arbitrary JS is sent.",
  rateLimit: { tool: { max: 120 } },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to inspect."),
    selector: z.string().describe("CSS selector to query."),
    limit: z.number().int().min(1).max(100).default(20).describe("Max number of matches to return."),
  },
  async execute({ task_id, selector, limit }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const wrapped = await task.client.domQuery(selector, limit);
        const result = wrapped[0] as { total: number; items: Record<string, unknown>[] };
        return textResult(
          JSON.stringify(
            { selector, total: result.total, returned: result.items.length, items: result.items },
            null,
            2,
          ),
        );
      });
    } catch (err) {
      return errorResult(`comet_dom_query failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
