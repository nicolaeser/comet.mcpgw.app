import { z } from "zod";
import { cometResultStore } from "../../comet/result-store.js";
import {
  isCompletedCometStatus,
  saveCometStatusResult,
  saveSubmittedCometResult,
} from "../../comet/result-capture.js";
import { ensureCometResultWatcher } from "../../comet/result-watcher.js";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";
import { cometStatusStructured, cometTaskStructured } from "./_structured.js";

const POLL_INTERVAL_MS = 1_500;
const IDLE_TIMEOUT_MS = 6_000;
const MAX_CONSECUTIVE_ERRORS = 5;
const AWAITING_INPUT_GRACE_MS = 8_000;

function wantsCloseAfterCompleted(
  closeAfter: boolean | undefined,
  keepAlive: boolean,
): boolean {
  if (closeAfter === true) return true;
  if (closeAfter === false) return false;
  return !keepAlive;
}

function normalizePrompt(raw: string): string {
  return raw
    .replace(/^[-*•]\s*/gm, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function transformForAgentic(prompt: string): string {
  const hasUrl = /https?:\/\/[^\s]+/.test(prompt);
  const hasWebsiteRef =
    /\b(go to|visit|navigate|open|browse|check|look at|read from|click|fill|submit|login|sign in|download from)\b/i.test(prompt);
  const hasSiteNames = /\b(\.com|\.org|\.io|\.net|\.ai|website|webpage|page|site)\b/i.test(prompt);
  if (!(hasUrl || hasWebsiteRef || hasSiteNames)) return prompt;

  const alreadyAgentic = /^(use your browser|using your browser|open a browser|navigate to|browse to|take control)/i.test(prompt);
  if (alreadyAgentic) return prompt;

  if (hasUrl) {
    const m = prompt.match(/https?:\/\/[^\s]+/);
    if (m) {
      const url = m[0];
      const rest = prompt.replace(url, "").trim();
      return `Use your browser to navigate to ${url} and ${rest || "tell me what you find there"}`;
    }
  }
  return `Use your browser to ${prompt.toLowerCase().startsWith("go") ? "" : "go and "}${prompt}`;
}

function asyncHandoffText(
  taskId: string,
  heading: string,
  extraLines: string[] = [],
): string {
  return [
    `Task ${taskId}: ${heading}`,
    "",
    `Poll: comet_poll task_id=${taskId}`,
    `Result: comet_results task_id=${taskId}`,
    `Partial: comet_get_response task_id=${taskId}`,
    `Cancel: comet_stop task_id=${taskId}`,
    ...extraLines,
  ].join("\n");
}

const tool = defineTool({
  name: "comet_ask",
  title: "Ask Comet",
  description: "Send a prompt to Comet/Perplexity and wait for the response. If `task_id` is omitted, reuses the most-recently-used task or auto-creates one (so you do NOT need to call comet_connect first — just call comet_ask). Multiple comet_ask calls can run in parallel as long as each targets a different task_id. By default, completed one-shot tasks auto-close their task tab; pass `closeAfter=false` to keep the tab for follow-up work or inspection. The tab is kept open when Comet is still working or waiting for user/agent confirmation. Use comet_task_close to stop a multi-step task explicitly.",
  rateLimit: { tool: { max: 30 }, client: { max: 10 } },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    prompt: z.string().min(1).describe("Question or task for Comet"),
    task_id: z
      .string()
      .optional()
      .describe("Task to operate on. Required when more than one task is active."),
    context: z
      .string()
      .optional()
      .describe("Optional context to prepend (file contents, codebase info, guidelines)"),
    newChat: z
      .boolean()
      .default(false)
      .describe("Start a fresh conversation by navigating this task's tab to Perplexity home"),
    timeout: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(120_000)
      .describe("Max wait time in ms (safety net; idle-detection usually returns sooner)"),
    closeAfter: z
      .boolean()
      .optional()
      .describe(
        "Whether to close the task (and its tab) after a completed response. " +
          "Defaults to auto-close for completed one-shot work. Set false to keep " +
          "the tab open for follow-up prompts or inspection. The bridge never " +
          "auto-closes while Comet is still working or awaiting confirmation.",
      ),
    closeTimeout: z
      .number()
      .int()
      .min(0)
      .max(3_600_000)
      .default(0)
      .describe(
        "Milliseconds to wait after a completed response before auto-closing " +
          "the task's tab. 0 (default) closes immediately. Useful when downstream " +
          "tools (comet_screenshot, comet_html, comet_console, etc.) need a brief " +
          "window to inspect the tab before it goes away. Ignored when closeAfter=false " +
          "or when Comet is still working/awaiting confirmation. The close runs in " +
          "the background — comet_ask returns as soon as the response is ready.",
      ),
    wait: z
      .boolean()
      .default(true)
      .describe(
        "If false, submit the prompt and return immediately with the task_id instead " +
          "of holding the MCP request open. The server keeps a background watcher " +
          "running and retains the final result for comet_results. This is the safer " +
          "mode for n8n and other workflow runners with short tool-call timeouts.",
      ),
  },
  async execute({ prompt, task_id, context, newChat, timeout, closeAfter, closeTimeout, wait }, ctx) {
    let finalPrompt = prompt;
    if (context && context.trim().length > 0) {
      finalPrompt =
        `Context for this task:\n\`\`\`\n${context.trim()}\n\`\`\`\n\nBased on the above context, ` +
        prompt;
    }
    finalPrompt = normalizePrompt(finalPrompt);
    if (!finalPrompt) return errorResult("Prompt cannot be empty");
    finalPrompt = transformForAgentic(finalPrompt);

    let resolvedTaskId: string | null = null;
    let effectiveTaskId = task_id;
    let shouldCloseResolvedTask = false;
    const markCloseAfterCompleted = (keepAlive: boolean) => {
      if (wantsCloseAfterCompleted(closeAfter, keepAlive)) {
        shouldCloseResolvedTask = true;
      }
    };
    const closeAfterCompleted = (keepAlive: boolean) =>
      wantsCloseAfterCompleted(closeAfter, keepAlive);
    try {
      if (!effectiveTaskId) {
        const existing = taskRegistry.resolveOrNull();
        if (!existing) {
          await ctx.sendProgress(0, 5, "no active task — auto-creating one");
          const created = await taskRegistry.create(undefined, {
            keepAlive: false,
            attach: "auto",
            onProgress: (step, total, message) => ctx.sendProgress(step, total, message),
          });
          effectiveTaskId = created.id;
        } else {
          effectiveTaskId = existing.id;
        }
      }

      const result = await taskRegistry.withTask(effectiveTaskId, async (task) => {
        resolvedTaskId = task.id;
        const { client, ai } = task;
        task.autoCloseOnCompletion = wantsCloseAfterCompleted(closeAfter, task.keepAlive);

        if (!client.isConnected) {
          await client.ensureConnection();
        }

        try {
          await client.preOperationCheck();
        } catch {
          await client.ensureOnOwnedTab();
        }

        if (newChat) {
          await client.navigate("https://www.perplexity.ai/", true);
          await new Promise((r) => setTimeout(r, 2_000));
        } else {
          await client.ensureOnOwnedTab();
          const urlResult = await client.evaluate("window.location.href");
          const currentUrl = (urlResult.result.value as string | undefined) ?? "";
          if (!currentUrl.includes("perplexity.ai")) {
            await client.navigate("https://www.perplexity.ai/", true);
            await new Promise((r) => setTimeout(r, 2_000));
          }
        }

        ai.resetStabilityTracking();
        client.clearProtocolBuffers();

        const before = await ai.getAnswerSnapshot();
        const beforeKey = `${before.count}|${before.lastLength}|${before.lastText}`;

        await ai.sendPrompt(finalPrompt);
        await saveSubmittedCometResult(
          task,
          finalPrompt,
          wait ? "comet_ask" : "comet_ask_async",
        );

        try {
          await ai.acceptBrowserControlBanner();
        } catch {

        }

        const startResultWatcher = () => {
          ensureCometResultWatcher(task.id, {
            timeoutMs: timeout,
            closeTimeoutMs: closeTimeout,
          });
        };

        if (!wait) {
          startResultWatcher();
          return textResult(
            asyncHandoffText(task.id, "prompt submitted and running.", [
              "",
              task.autoCloseOnCompletion
                ? "Auto-close: yes, after completion is captured."
                : "Auto-close: no, task will stay open after completion.",
            ]),
            cometTaskStructured(task, {
              status: "working",
              submitted: true,
              result_delivery: "async",
            }),
          );
        }

        const start = Date.now();
        const collectedSteps: string[] = [];
        let sawNewResponse = false;
        let lastActivityTime = Date.now();
        let previousResponse = "";
        let consecutiveErrors = 0;
        let bannerAccepted = false;
        let awaitingInputSince: number | null = null;
        let lastConfirmationPrompt = "";
        let previousAwaiting = false;

        const stopOnAbort = async () => {
          try { await ai.stopAgent(); } catch {}
        };

        while (Date.now() - start < timeout) {
          if (ctx.abortSignal.aborted) {
            await stopOnAbort();
            await cometResultStore.save({
              taskId: task.id,
              label: task.label,
              status: "failed",
              error: "comet_ask was cancelled.",
              source: "comet_ask",
            });
            return errorResult(
              `comet_ask was cancelled (task ${task.id})`,
              cometTaskStructured(task, {
                status: "failed",
                error: "comet_ask was cancelled.",
              }),
            );
          }

          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

          try {
            const onPerplexity = await client.isOnPerplexityTab();
            if (!onPerplexity) {
              const switched = await client.ensureOnOwnedTab();
              if (!switched) {
                consecutiveErrors += 1;
                continue;
              }
            }

            if (!bannerAccepted) {
              try {
                if (await ai.acceptBrowserControlBanner()) {
                  bannerAccepted = true;
                  lastActivityTime = Date.now();
                }
              } catch {

              }
            }

            if (previousAwaiting) {
              try {
                const auto = await ai.acceptInFlowConfirmation({ allowDestructive: false });
                if (auto.clicked) {
                  lastActivityTime = Date.now();
                  awaitingInputSince = null;
                }
              } catch {

              }
            }

            const status = await client.withAutoReconnect(async () => ai.getAgentStatus());
            consecutiveErrors = 0;
            previousAwaiting = status.awaitingInput;

            if (!sawNewResponse) {
              const currentKey = `${status.response ? 1 : 0}|${status.response.length}|${status.response.substring(0, 100)}`;
              if (status.response.length > 0 && currentKey !== beforeKey) {
                sawNewResponse = true;
              }
            }

            if (status.response !== previousResponse) {
              lastActivityTime = Date.now();
              previousResponse = status.response;
            }
            for (const step of status.steps) {
              if (!collectedSteps.includes(step)) {
                collectedSteps.push(step);
                lastActivityTime = Date.now();
              }
            }

            if (status.awaitingInput) {
              if (awaitingInputSince === null) awaitingInputSince = Date.now();
              if (status.confirmationPrompt && status.confirmationPrompt !== lastConfirmationPrompt) {
                lastConfirmationPrompt = status.confirmationPrompt;
                lastActivityTime = Date.now();
              }
            } else {
              awaitingInputSince = null;
            }

            const progressMessage = status.awaitingInput
              ? `awaiting confirmation${status.confirmationKind ? ` (${status.confirmationKind})` : ""}`
              : status.currentStep || status.stream.currentStep || status.status;
            await ctx.sendProgress(
              Math.min(Date.now() - start, timeout),
              timeout,
              progressMessage,
            );

            if (status.status === "completed" && sawNewResponse && status.response) {
              await saveCometStatusResult(
                task,
                status,
                "comet_ask",
                "completed",
                closeAfterCompleted(task.keepAlive),
              );
              markCloseAfterCompleted(task.keepAlive);
              return textResult(
                status.response,
                cometStatusStructured(task, status, {
                  status: "completed",
                  completed: true,
                  result_delivery: "direct",
                }),
              );
            }
            if (
              status.isStable &&
              sawNewResponse &&
              status.response &&
              !status.hasStopButton &&
              !status.awaitingInput
            ) {
              await saveCometStatusResult(
                task,
                status,
                "comet_ask",
                "completed",
                closeAfterCompleted(task.keepAlive),
              );
              markCloseAfterCompleted(task.keepAlive);
              return textResult(
                status.response,
                cometStatusStructured(task, status, {
                  status: "completed",
                  completed: true,
                  result_delivery: "direct",
                }),
              );
            }
            if (
              awaitingInputSince !== null &&
              Date.now() - awaitingInputSince > AWAITING_INPUT_GRACE_MS
            ) {
              const lines: string[] = [
                `Task ${task.id}: paused — Comet is waiting for confirmation in the browser.`,
                status.confirmationKind ? `Kind: ${status.confirmationKind}` : null,
                status.confirmationPrompt ? `Prompt: ${status.confirmationPrompt}` : null,
                "",
                `Approve manually in the Comet sidecar, or call comet_accept_banner task_id=${task.id} ` +
                  `(safe confirmations only). Then call comet_poll task_id=${task.id} to resume.`,
              ].filter(Boolean) as string[];
              await saveCometStatusResult(task, status, "comet_ask");
              startResultWatcher();
              return textResult(
                lines.join("\n"),
                cometStatusStructured(task, status, {
                  status: "input_required",
                  result_delivery: "async",
                  requires_user_action: true,
                }),
              );
            }
            const idleMs = Date.now() - lastActivityTime;
            if (
              idleMs > IDLE_TIMEOUT_MS &&
              sawNewResponse &&
              status.response &&
              !status.hasStopButton &&
              !status.awaitingInput
            ) {
              await saveCometStatusResult(
                task,
                status,
                "comet_ask",
                "completed",
                closeAfterCompleted(task.keepAlive),
              );
              markCloseAfterCompleted(task.keepAlive);
              return textResult(
                status.response,
                cometStatusStructured(task, status, {
                  status: "completed",
                  completed: true,
                  result_delivery: "direct",
                }),
              );
            }
          } catch (err) {
            consecutiveErrors += 1;
            try {
              if (await client.ensureOnOwnedTab()) {
                consecutiveErrors = Math.max(0, consecutiveErrors - 1);
                continue;
              }
            } catch {

            }
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              try {
                await client.ensureConnection();
                await client.ensureOnOwnedTab();
                consecutiveErrors = 0;
              } catch {
                await cometResultStore.save({
                  taskId: task.id,
                  label: task.label,
                  status: "failed",
                  error: err instanceof Error ? err.message : String(err),
                  source: "comet_ask",
                });
                return errorResult(
                  `comet_ask aborted after repeated errors (task ${task.id}): ${err instanceof Error ? err.message : String(err)}`,
                  cometTaskStructured(task, {
                    status: "failed",
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              }
            }
          }
        }

        const finalStatus = await ai.getAgentStatus();
        const completed = isCompletedCometStatus(finalStatus);
        if (completed && finalStatus.response && !finalStatus.awaitingInput) {
          const shouldClose = closeAfterCompleted(task.keepAlive);
          await saveCometStatusResult(
            task,
            finalStatus,
            "comet_ask",
            "completed",
            shouldClose,
          );
          if (shouldClose) {
            markCloseAfterCompleted(task.keepAlive);
          }
          return textResult(
            finalStatus.response,
            cometStatusStructured(task, finalStatus, {
              status: "completed",
              completed: true,
              result_delivery: "direct",
            }),
          );
        }

        startResultWatcher();
        const lines: string[] = [
          `Task ${task.id}: still running after ${timeout}ms.`,
          `Status: ${finalStatus.status.toUpperCase()}`,
        ];
        if (finalStatus.stream.sawSse) {
          lines.push(
            `Stream: ${finalStatus.stream.status.toUpperCase()} ` +
              `(requests=${finalStatus.stream.streamRequestCount}, chunks=${finalStatus.stream.sseChunkCount}, ` +
              `bytes=${finalStatus.stream.sseBytes}, events=${finalStatus.stream.eventCount}, ` +
              `textCompleted=${finalStatus.stream.textCompleted ? "yes" : "no"}, ` +
              `active=${finalStatus.stream.sseActive ? "yes" : "no"})`,
          );
        } else if (finalStatus.stream.sawAgent) {
          lines.push("Stream: AGENT CHANNEL ACTIVE");
        } else if (finalStatus.stream.sawWebSocket) {
          lines.push("WebSocket: active (non-agent)");
        }
        if (finalStatus.awaitingInput && finalStatus.confirmationPrompt) {
          lines.push(`Awaiting: ${finalStatus.confirmationPrompt}`);
        }
        if (finalStatus.currentStep) lines.push(`Current: ${finalStatus.currentStep}`);
        if (finalStatus.agentBrowsingUrl) lines.push(`Browsing: ${finalStatus.agentBrowsingUrl}`);
        if (finalStatus.response) {
          lines.push("");
          lines.push("Partial response:");
          lines.push(finalStatus.response);
        }
        if (collectedSteps.length > 0) {
          lines.push("");
          lines.push("Steps:");
          for (const step of collectedSteps) lines.push(`  • ${step}`);
        }
        lines.push("");
        lines.push(`The server is still watching this task. Use comet_results task_id=${task.id} for the retained final result.`);
        await saveCometStatusResult(
          task,
          finalStatus,
          "comet_ask_handoff",
          finalStatus.awaitingInput ? "input_required" : "working",
        );
        return textResult(
          lines.join("\n"),
          cometStatusStructured(task, finalStatus, {
            status: finalStatus.awaitingInput ? "input_required" : "working",
            result_delivery: "async",
            timeout_ms: timeout,
            partial: Boolean(finalStatus.response),
          }),
        );
      });
      return result;
    } catch (err) {
      if (resolvedTaskId) {
        await cometResultStore.save({
          taskId: resolvedTaskId,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          source: "comet_ask",
        });
      }
      return errorResult(
        `comet_ask failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          ...(resolvedTaskId ? { task_id: resolvedTaskId } : {}),
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        },
      );
    } finally {
      if (wait && shouldCloseResolvedTask && resolvedTaskId) {
        const id = resolvedTaskId;
        const fire = () => {
          void taskRegistry.close(id).catch(() => {});
        };
        if (closeTimeout > 0) {
          const t = setTimeout(fire, closeTimeout);
          t.unref?.();
        } else {
          setImmediate(fire);
        }
      }
    }
  },
});

export default tool;
