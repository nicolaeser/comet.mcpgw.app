import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_stop",
  title: "Stop Comet agent",
  description: "Click the Perplexity 'Stop' button in a task's tab to interrupt the agent without closing the tab itself. Use when an agentic comet_ask is going off track. Safe to call when no agent is active (returns 'No active agent to stop'). To free the tab too, follow up with comet_task_close.",
  rateLimit: { tool: { max: 60 } },
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    task_id: z
      .string()
      .optional()
      .describe("Task to stop. Required when more than one task is active."),
  },
  async execute({ task_id }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const stopped = await task.ai.stopAgent();
        return textResult(
          stopped
            ? `Agent stopped (task ${task.id})`
            : `No active agent to stop (task ${task.id})`,
        );
      });
    } catch (err) {
      return errorResult(
        `comet_stop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
