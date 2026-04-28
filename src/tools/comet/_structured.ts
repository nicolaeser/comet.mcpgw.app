import type { CometAgentStatus } from "../../comet/result-capture.js";
import type { CometTask } from "../../comet/task-registry.js";

export function cometTaskStructured(
  task: CometTask,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    task_id: task.id,
    ...(task.label && { label: task.label }),
    keep_alive: task.keepAlive,
    ...(task.autoCloseOnCompletion !== undefined && {
      auto_close_on_completion: task.autoCloseOnCompletion,
    }),
    next: {
      poll: {
        tool: "comet_poll",
        arguments: { task_id: task.id },
      },
      partial: {
        tool: "comet_get_response",
        arguments: { task_id: task.id },
      },
      result: {
        tool: "comet_results",
        arguments: { task_id: task.id },
      },
      stop: {
        tool: "comet_stop",
        arguments: { task_id: task.id },
      },
    },
    ...extra,
  };
}

export function cometStatusStructured(
  task: CometTask,
  status: CometAgentStatus,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const completed =
    extra.completed === true ||
    (
      status.status === "completed" &&
      Boolean(status.response) &&
      !status.awaitingInput
    );
  return cometTaskStructured(task, {
    status: status.awaitingInput ? "input_required" : status.status,
    completed,
    input_required: status.awaitingInput,
    ...(status.response &&
      (completed
        ? { response: status.response }
        : { partial_response: status.response })),
    ...(status.currentStep && { current_step: status.currentStep }),
    ...(status.stream.currentStep && { stream_current_step: status.stream.currentStep }),
    ...(status.steps.length > 0 && { steps: status.steps }),
    ...(status.agentBrowsingUrl && { agent_browsing_url: status.agentBrowsingUrl }),
    ...(status.confirmationKind && { confirmation_kind: status.confirmationKind }),
    ...(status.confirmationPrompt && {
      confirmation_prompt: status.confirmationPrompt,
    }),
    stream: {
      status: status.stream.status,
      saw_sse: status.stream.sawSse,
      saw_event_source: status.stream.sawEventSource,
      saw_agent: status.stream.sawAgent,
      saw_websocket: status.stream.sawWebSocket,
      text_completed: status.stream.textCompleted,
      sse_closed: status.stream.sseClosed,
      sse_active: status.stream.sseActive,
      event_count: status.stream.eventCount,
      request_count: status.stream.streamRequestCount,
      chunk_count: status.stream.sseChunkCount,
      byte_count: status.stream.sseBytes,
      text_length: status.stream.sseTextLength,
      response_length: status.stream.responseLength,
      ...(status.stream.lastEventAt && { last_event_at: status.stream.lastEventAt }),
      ...(status.stream.lastByteAt && { last_byte_at: status.stream.lastByteAt }),
      ...(status.stream.error && { error: status.stream.error }),
    },
    ...extra,
  });
}
