import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_back",
  title: "Navigate back",
  description: "Navigate the task's tab back one entry in its history (no-op if at the start).",
  rateLimit: { tool: { max: 60 } },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: { task_id: z.string().optional().describe("Task to operate on.") },
  async execute({ task_id }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const moved = await task.client.historyBack();
        return textResult(moved ? `Task ${task.id}: navigated back.` : `Task ${task.id}: at history start, nothing to do.`);
      });
    } catch (err) {
      return errorResult(`comet_back failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
