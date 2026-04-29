import { z } from "zod";
import { saveCometStatusResult } from "../../comet/result-capture.js";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";
import { cometStatusStructured } from "./_structured.js";

const tool = defineTool({
  name: "comet_get_response",
  title: "Peek at a task's current response",
  description:
    "Return whatever response text is currently visible on the task's tab, even if the agent is still streaming. Unlike comet_poll, this never waits — it just grabs the latest snapshot and updates the retained result record. Useful for incremental UIs that want partial output.\n\n" +
    "WARNING for agents: this tool is for INCREMENTAL/PARTIAL output only. Unless `structuredContent.status:\"completed\"` AND `completed:true`, the returned text is partial and may be cut mid-sentence — never present it to the user as a final answer. To get the final answer, prefer `comet_ask` (which waits) or `comet_poll` until `completed:true`, or `comet_results` after the task ended.",
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
      .describe("Task to inspect. Required when more than one task is active."),
  },
  async execute({ task_id }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const status = await task.ai.getAgentStatus();
        await saveCometStatusResult(task, status, "comet_get_response");
        const lines: string[] = [
          `Task: ${task.id}`,
          `Status: ${status.status.toUpperCase()}${status.hasStopButton ? " (streaming)" : ""}`,
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
        if (status.currentStep) lines.push(`Current step: ${status.currentStep}`);
        lines.push("");
        if (status.response) {
          lines.push(status.response);
        } else {
          lines.push("(no response text yet)");
        }
        return textResult(
          lines.join("\n"),
          cometStatusStructured(task, status, {
            status: status.awaitingInput ? "input_required" : status.status,
            result_delivery: status.status === "completed" ? "direct" : "async",
            partial: status.status !== "completed",
          }),
        );
      });
    } catch (err) {
      return errorResult(
        `comet_get_response failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
