import type { CometTask } from "./task-registry.js";
import {
  cometResultStore,
  type CometResultStatus,
} from "./result-store.js";

export type CometAgentStatus = Awaited<ReturnType<CometTask["ai"]["getAgentStatus"]>>;

export function isCompletedCometStatus(status: CometAgentStatus): boolean {
  return Boolean(
    status.response &&
      !status.awaitingInput &&
      (
        status.status === "completed" ||
        (
          status.isStable &&
          !status.hasStopButton
        ) ||
        (
          status.stream.status === "completed" &&
          !status.hasStopButton
        )
      ),
  );
}

export function cometResultStatus(status: CometAgentStatus): CometResultStatus {
  if (isCompletedCometStatus(status)) return "completed";
  if (status.awaitingInput) return "input_required";
  if (status.status === "awaiting_input") return "input_required";
  return status.status === "idle" ? "working" : status.status;
}

export async function saveSubmittedCometResult(
  task: CometTask,
  prompt: string,
  source: string,
): Promise<void> {
  await cometResultStore.save({
    taskId: task.id,
    label: task.label,
    prompt,
    status: "working",
    keepAlive: task.keepAlive,
    autoCloseOnCompletion: task.autoCloseOnCompletion,
    source,
  });
}

export async function saveCometStatusResult(
  task: CometTask,
  status: CometAgentStatus,
  source: string,
  overrideStatus?: CometResultStatus,
  closedAfterCompletion?: boolean,
): Promise<void> {
  await cometResultStore.save({
    taskId: task.id,
    label: task.label,
    status: overrideStatus ?? cometResultStatus(status),
    response: status.response || undefined,
    currentStep: status.currentStep || status.stream.currentStep || undefined,
    steps: status.steps,
    stream: {
      status: status.stream.status,
      sawSse: status.stream.sawSse,
      sawAgent: status.stream.sawAgent,
      sawWebSocket: status.stream.sawWebSocket,
      textCompleted: status.stream.textCompleted,
      sseClosed: status.stream.sseClosed,
      sseActive: status.stream.sseActive,
      streamRequestCount: status.stream.streamRequestCount,
      sseChunkCount: status.stream.sseChunkCount,
      sseBytes: status.stream.sseBytes,
      eventCount: status.stream.eventCount,
    },
    awaitingInput: status.awaitingInput,
    confirmationKind: status.confirmationKind || undefined,
    confirmationPrompt: status.confirmationPrompt || undefined,
    agentBrowsingUrl: status.agentBrowsingUrl || undefined,
    keepAlive: task.keepAlive,
    autoCloseOnCompletion: task.autoCloseOnCompletion,
    closedAfterCompletion,
    source,
  });
}
