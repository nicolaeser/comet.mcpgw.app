import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_block_urls",
  title: "Block URL patterns",
  description: "Block matching URL patterns for the task's tab via Network.setBlockedURLs. Patterns support wildcards (e.g. '*://*.doubleclick.net/*'). Pass an empty array to clear all blocks.",
  rateLimit: { tool: { max: 30 } },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to operate on."),
    patterns: z.array(z.string().min(1)).describe("URL patterns to block. Empty array clears all blocks."),
  },
  async execute({ task_id, patterns }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        await task.client.setBlockedURLs(patterns);
        return textResult(
          patterns.length === 0
            ? `Task ${task.id}: URL blocks cleared.`
            : `Task ${task.id}: blocking ${patterns.length} pattern(s).`,
        );
      });
    } catch (err) {
      return errorResult(`comet_block_urls failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
