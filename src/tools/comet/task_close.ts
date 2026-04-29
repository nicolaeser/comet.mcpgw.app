import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_task_close",
  title: "Close a Comet task",
  description:
    "Tear down a task explicitly: waits for any in-flight tool call against it to finish, persists the latest visible result/status for `comet_results`, closes the underlying Perplexity tab plus any auxiliary tabs the agent opened during the task, then detaches the CDP socket.\n\n" +
    "When to call this:\n" +
    "  • You opened a multi-turn task with `closeAfter:false` (or `keepAlive:true`) and are now finished with that conversation — call this to close the tab.\n" +
    "  • You want to abandon a task that is stuck or no longer needed.\n" +
    "  • Pass `all:true` at the end of a workflow to close every active task at once.\n" +
    "  • You do NOT need to call this after a one-shot `comet_ask` — the tab and task auto-close when the answer is captured (unless `closeAfter:false` was set).\n\n" +
    "Idempotent — closing a non-existent `task_id` returns a notice, not an error.",
  rateLimit: { tool: { max: 30 } },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
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
