import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_clear_cache",
  title: "Clear browser cache",
  description: "Clear the browser cache (Network.clearBrowserCache). Affects all tabs in this browser instance.",
  rateLimit: { tool: { max: 10 } },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { task_id: z.string().optional().describe("Task to operate on (the cache is browser-wide).") },
  async execute({ task_id }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        await task.client.clearCache();
        return textResult(`Browser cache cleared (via task ${task.id}).`);
      });
    } catch (err) {
      return errorResult(`comet_clear_cache failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
