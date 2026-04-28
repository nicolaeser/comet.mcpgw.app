import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_forward",
  title: "Navigate forward",
  description: "Navigate the task's tab forward one entry in its history (no-op if at the end).",
  rateLimit: { tool: { max: 60 } },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: { task_id: z.string().optional().describe("Task to operate on.") },
  async execute({ task_id }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const moved = await task.client.historyForward();
        return textResult(moved ? `Task ${task.id}: navigated forward.` : `Task ${task.id}: at history end, nothing to do.`);
      });
    } catch (err) {
      return errorResult(`comet_forward failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
