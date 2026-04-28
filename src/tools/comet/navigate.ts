import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_navigate",
  title: "Navigate a Comet task tab",
  description: "Navigate the task's tab to a URL. Use this to set up state before asking (e.g. open a logged-in dashboard or a specific Perplexity thread) or to recover if the agent wandered somewhere unexpected. Resets stability tracking so the next comet_ask sees a clean baseline.",
  rateLimit: { tool: { max: 30 } },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    task_id: z
      .string()
      .optional()
      .describe("Task to operate on. Required when more than one task is active."),
    url: z.string().url().describe("Absolute URL to navigate the task's tab to."),
    waitForLoad: z
      .boolean()
      .default(true)
      .describe("Wait for the page load event (with a 15s safety cap)."),
  },
  async execute({ task_id, url, waitForLoad }, ctx) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        await ctx.sendProgress(0, 2, `navigating to ${url}`);
        await task.client.navigate(url, waitForLoad);
        await ctx.sendProgress(1, 2, "page loaded, resetting stability tracking");
        task.ai.resetStabilityTracking();
        await ctx.sendProgress(2, 2, "done");
        return textResult(`Navigated task ${task.id} to ${url}`);
      });
    } catch (err) {
      return errorResult(
        `comet_navigate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
