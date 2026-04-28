import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_poll",
  title: "Poll Comet status",
  description: "Non-blocking status check for a task. Returns IDLE | WORKING | COMPLETED, any visible step list, and the agent's browsing URL if it spawned a child tab. When status is COMPLETED, returns the response text directly. Call this in a loop (~3s) after a comet_ask that returned 'still in progress', or use comet_get_response if you only want the partial text right now.",
  rateLimit: { tool: { max: 120 } },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    task_id: z
      .string()
      .optional()
      .describe("Task to poll. Required when more than one task is active."),
  },
  async execute({ task_id }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const status = await task.ai.getAgentStatus();

        if (status.status === "completed" && status.response && !status.awaitingInput) {
          return textResult(status.response);
        }

        const lines: string[] = [
          `Task: ${task.id}`,
          `Status: ${status.status.toUpperCase()}`,
        ];
        if (status.stream.sawSse) {
          lines.push(
            `Stream: ${status.stream.status.toUpperCase()} ` +
              `(events=${status.stream.eventCount}, textCompleted=${status.stream.textCompleted ? "yes" : "no"})`,
          );
        } else if (status.stream.sawAgent) {
          lines.push("Stream: AGENT CHANNEL ACTIVE");
        }
        if (status.stream.error) lines.push(`Stream error: ${status.stream.error}`);
        if (status.awaitingInput) {
          if (status.confirmationKind) lines.push(`Awaiting: ${status.confirmationKind}`);
          if (status.confirmationPrompt) lines.push(`Prompt: ${status.confirmationPrompt}`);
        }
        if (status.agentBrowsingUrl) lines.push(`Browsing: ${status.agentBrowsingUrl}`);
        if (status.currentStep) lines.push(`Current: ${status.currentStep}`);

        if (status.steps.length > 0) {
          lines.push("");
          lines.push("Steps:");
          for (const step of status.steps) lines.push(`  • ${step}`);
        }

        if (status.awaitingInput) {
          lines.push("");
          lines.push(
            `Comet is paused for confirmation. Approve manually in the browser or call ` +
              `comet_accept_banner task_id=${task.id} (safe confirmations only).`,
          );
        } else if (status.status === "working") {
          lines.push("");
          lines.push(`Use comet_stop task_id=${task.id} to interrupt or comet_screenshot task_id=${task.id} to inspect.`);
        }

        return textResult(lines.join("\n"));
      });
    } catch (err) {
      return errorResult(
        `comet_poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
