import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

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
          "of holding the MCP request open. This is the safer mode for n8n and other " +
          "workflow runners with short tool-call timeouts; poll with comet_poll.",
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

        try {
          await ai.acceptBrowserControlBanner();
        } catch {

        }

        if (!wait) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Task ${task.id}: prompt submitted.`,
                  "Status: WORKING",
                  "",
                  `Poll with comet_poll task_id=${task.id}.`,
                  task.autoCloseOnCompletion
                    ? "The task will auto-close when comet_poll observes completion."
                    : "The task will stay open after completion.",
                  `Peek partial text with comet_get_response task_id=${task.id}.`,
                ].join("\n"),
              },
            ],
            structuredContent: {
              task_id: task.id,
              status: "working",
              submitted: true,
              auto_close_on_completion: task.autoCloseOnCompletion,
            },
          };
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
            return errorResult(`comet_ask was cancelled (task ${task.id})`);
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
              markCloseAfterCompleted(task.keepAlive);
              return textResult(status.response);
            }
            if (
              status.isStable &&
              sawNewResponse &&
              status.response &&
              !status.hasStopButton &&
              !status.awaitingInput
            ) {
              markCloseAfterCompleted(task.keepAlive);
              return textResult(status.response);
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
              return textResult(lines.join("\n"));
            }
            const idleMs = Date.now() - lastActivityTime;
            if (
              idleMs > IDLE_TIMEOUT_MS &&
              sawNewResponse &&
              status.response &&
              !status.hasStopButton &&
              !status.awaitingInput
            ) {
              markCloseAfterCompleted(task.keepAlive);
              return textResult(status.response);
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
                return errorResult(
                  `comet_ask aborted after repeated errors (task ${task.id}): ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
        }

        const finalStatus = await ai.getAgentStatus();
        if (finalStatus.response && !finalStatus.awaitingInput) {
          if (finalStatus.status === "completed" && !finalStatus.hasStopButton) {
            markCloseAfterCompleted(task.keepAlive);
          }
          return textResult(finalStatus.response);
        }

        const lines: string[] = [
          `Task ${task.id}: still in progress (timeout=${timeout}ms reached).`,
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
        if (collectedSteps.length > 0) {
          lines.push("");
          lines.push("Steps:");
          for (const step of collectedSteps) lines.push(`  • ${step}`);
        }
        lines.push("");
        lines.push(`Use comet_poll task_id=${task.id} to check progress, comet_stop task_id=${task.id} to cancel.`);
        return textResult(lines.join("\n"));
      });
      return result;
    } catch (err) {
      return errorResult(
        `comet_ask failed: ${err instanceof Error ? err.message : String(err)}`,
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
