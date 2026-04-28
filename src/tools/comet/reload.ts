import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_reload",
  title: "Reload the task tab",
  description: "Reload the task's tab. Pass `ignoreCache=true` for a hard reload.",
  rateLimit: { tool: { max: 60 } },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to operate on."),
    ignoreCache: z.boolean().default(false).describe("Bypass cache when reloading."),
  },
  async execute({ task_id, ignoreCache }, ctx) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        await ctx.sendProgress(0, 2, ignoreCache ? "hard-reloading (cache bypassed)" : "reloading");
        await task.client.reload(ignoreCache);
        task.ai.resetStabilityTracking();
        await ctx.sendProgress(2, 2, "reload complete");
        return textResult(`Task ${task.id} reloaded${ignoreCache ? " (cache bypassed)" : ""}.`);
      });
    } catch (err) {
      return errorResult(`comet_reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
