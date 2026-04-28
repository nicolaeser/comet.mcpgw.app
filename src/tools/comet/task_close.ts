import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_task_close",
  title: "Close a Comet task",
  description: "Tear down a task: waits for any in-flight tool call against it to finish, then detaches the CDP socket and closes the underlying Comet tab. Pass `all=true` to close every active task at once. Idempotent — closing a non-existent task_id returns a notice, not an error. Equivalent to setting closeAfter=true on the previous comet_ask, but explicit.",
  rateLimit: { tool: { max: 30 } },
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    task_id: z.string().optional().describe("Task to close. Required unless `all=true`."),
    all: z.boolean().default(false).describe("If true, close every active task."),
  },
  async execute({ task_id, all }) {
    try {
      if (all) {
        const ids = taskRegistry.list().map((t) => t.id);
        await taskRegistry.closeAll();
        return textResult(
          ids.length === 0
            ? "No active tasks to close."
            : `Closed ${ids.length} task(s): ${ids.join(", ")}`,
        );
      }
      if (!task_id) {
        return errorResult("Provide task_id, or pass all=true to close every task.");
      }
      const ok = await taskRegistry.close(task_id);
      return textResult(ok ? `Task ${task_id} closed.` : `No task with id "${task_id}".`);
    } catch (err) {
      return errorResult(
        `comet_task_close failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
