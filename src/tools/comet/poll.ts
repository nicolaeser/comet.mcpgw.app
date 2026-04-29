import { z } from "zod";
import { saveCometStatusResult } from "../../comet/result-capture.js";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";
import { cometStatusStructured } from "./_structured.js";

const tool = defineTool({
  name: "comet_poll",
  title: "Poll Comet status",
  description:
    "Non-blocking status check for a task. Returns IDLE | WORKING | COMPLETED, any visible step list, and the agent's browsing URL if it spawned a child tab. When status is COMPLETED, returns the response text directly and retains it for comet_results before any auto-close. Use comet_get_response for partial text.\n\n" +
    "How to read the result (IMPORTANT for agents):\n" +
    "  • `structuredContent.completed:true` with `result_delivery:\"direct\"` → `response` IS the final answer. STOP polling and present it.\n" +
    "  • `result_delivery:\"async\"` and `status:\"working\"` → still running. `partial_response` is incomplete — keep polling, do NOT present it as final.\n" +
    "  • `status:\"input_required\"` → Comet is paused on a confirmation dialog. Either call `comet_accept_banner` (safe confirmations only) or instruct the user to approve manually, then poll again.\n" +
    "  • `status:\"idle\"` after a prompt was sent → likely auto-closed already; call `comet_results` for the retained final result.",
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
    closeAfter: z
      .boolean()
      .optional()
      .describe(
        "Whether to close the task after this poll observes a completed response. " +
          "Defaults to the preference set by comet_ask; otherwise completed tasks " +
          "auto-close unless the task was created with keepAlive=true.",
      ),
  },
  async execute({ task_id, closeAfter }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const status = await task.ai.getAgentStatus();

        if (status.status === "completed" && status.response && !status.awaitingInput) {
          const shouldClose =
            closeAfter === true ||
            (closeAfter === undefined &&
              (task.autoCloseOnCompletion ?? !task.keepAlive));
          await saveCometStatusResult(
            task,
            status,
            "comet_poll",
            "completed",
            shouldClose,
          );
          if (shouldClose) {
            const id = task.id;
            setImmediate(() => {
              void taskRegistry.close(id).catch(() => {});
            });
          }
          return textResult(
            status.response,
            cometStatusStructured(task, status, {
              status: "completed",
              completed: true,
              result_delivery: "direct",
            }),
          );
        }

        await saveCometStatusResult(task, status, "comet_poll");

        const lines: string[] = [
          `Task: ${task.id}`,
          `Status: ${status.status.toUpperCase()}`,
        ];
        if (status.stream.sawSse) {
          lines.push(
            `Stream: ${status.stream.status.toUpperCase()} ` +
              `(requests=${status.stream.streamRequestCount}, chunks=${status.stream.sseChunkCount}, ` +
              `bytes=${status.stream.sseBytes}, events=${status.stream.eventCount}, ` +
              `textCompleted=${status.stream.textCompleted ? "yes" : "no"}, ` +
              `active=${status.stream.sseActive ? "yes" : "no"})`,
          );
        } else if (status.stream.sawAgent) {
          lines.push("Stream: AGENT CHANNEL ACTIVE");
        } else if (status.stream.sawWebSocket) {
          lines.push("WebSocket: active (non-agent)");
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

        return textResult(
          lines.join("\n"),
          cometStatusStructured(task, status, {
            status: status.awaitingInput ? "input_required" : status.status,
            result_delivery:
              status.status === "completed" && status.response
                ? "direct"
                : "async",
          }),
        );
      });
    } catch (err) {
      return errorResult(
        `comet_poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
