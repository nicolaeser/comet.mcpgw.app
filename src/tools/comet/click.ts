import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_click",
  title: "Click an element by selector",
  description: "Click the first element matching a CSS selector in the task's tab. Scrolls the element into view first, then dispatches a real DOM click() (which fires React/Vue handlers). Use to script interactions without invoking the Perplexity agent and without enabling comet_eval. Pair with comet_dom_query first to verify the selector resolves to exactly the element you expect.",
  rateLimit: { tool: { max: 120 } },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to operate on."),
    selector: z.string().describe("CSS selector for the element to click."),
  },
  async execute({ task_id, selector }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const r = await task.client.clickSelector(selector);
        if (!r.success) {
          return errorResult(`Click failed: ${r.error ?? "unknown"}`);
        }
        return textResult(`Clicked ${selector} on task ${task.id}.`);
      });
    } catch (err) {
      return errorResult(`comet_click failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
