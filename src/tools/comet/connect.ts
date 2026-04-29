import { z } from "zod";
import {
  getBrowserVersion,
  getCDPEndpoint,
  taskRegistry,
} from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_connect",
  title: "Create a Comet task",
  description:
    "Create a new isolated Comet task. One task = one Perplexity tab = one conversation thread. By default each call opens a fresh perplexity.ai tab with its own CDP attachment and AI state, so parallel tasks cannot stomp on each other.\n\n" +
    "When to call this:\n" +
    "  • You usually do NOT need to call comet_connect first — `comet_ask` auto-creates a task if none exists. Call this explicitly only when you want a labeled task, want `keepAlive:true`, or want to attach to an existing Perplexity surface.\n" +
    "  • Pass `attach='sidecar'|'thread'|'auto'` only when you want to ADD a follow-up to an existing Perplexity surface (inheriting its conversation history). For a brand-new question, leave the default `'new'`.\n\n" +
    "Tab lifecycle:\n" +
    "  • Tabs the task itself opened (`attach:'new'`) are closed when the task closes (auto-close after a one-shot `comet_ask`, or explicit `comet_task_close`).\n" +
    "  • Tabs the task only attached to (`sidecar`/`thread`/`auto`) are LEFT OPEN on close.\n" +
    "  • Use the same `task_id` across multiple `comet_ask` calls (with `closeAfter:false`) to continue the same Perplexity chat history in the same tab.\n\n" +
    "Returns a `task_id` that all subsequent `comet_*` tools accept. Comet must already be running on the host with `--remote-debugging-port` enabled; endpoint is configured via `COMET_CDP_URL`.",
  rateLimit: { tool: { max: 30 } },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    label: z
      .string()
      .max(80)
      .optional()
      .describe("Optional human-readable label so you can recognize the task in comet_tasks."),
    keepAlive: z
      .boolean()
      .default(false)
      .describe(
        "If true, the task is exempt from the idle-TTL sweeper and will not be " +
          "auto-closed for inactivity. Use for long-lived multi-step workflows.",
      ),
    attach: z
      .enum(["new", "sidecar", "thread", "auto"])
      .default("new")
      .describe(
        "Where to attach: 'new' (default) opens a fresh perplexity.ai tab so each task gets " +
          "its own isolated conversation context — use this for any new question. " +
          "'sidecar' / 'thread' / 'auto' attach to an *existing* Perplexity surface and inherit " +
          "its conversation history (followup mode); only use these when you explicitly want " +
          "to add a follow-up to an ongoing task. Tabs not opened by the task are left open on " +
          "close. Tabs already owned by another active task are skipped.",
      ),
    target_id: z
      .string()
      .optional()
      .describe(
        "Optional CDP target id to attach to (from comet_status). Required when multiple " +
          "tabs of the same kind are open and url_contains/title_contains do not narrow it down.",
      ),
    url_contains: z
      .string()
      .optional()
      .describe(
        "Optional substring filter on the target tab's URL — useful to disambiguate when " +
          "multiple sidecar/thread tabs are open (e.g. url_contains=\"claude.ai\" to attach " +
          "to the sidecar of the Claude tab).",
      ),
    title_contains: z
      .string()
      .optional()
      .describe(
        "Optional substring filter on the target tab's title. Combined AND with url_contains.",
      ),
  },
  async execute({ label, keepAlive, attach, target_id, url_contains, title_contains }, ctx) {
    try {
      await ctx.sendProgress(0, 5, "checking CDP endpoint");
      await getBrowserVersion();
      const task = await taskRegistry.create(label, {
        keepAlive,
        attach,
        targetId: target_id,
        urlContains: url_contains,
        titleContains: title_contains,
        onProgress: (step, total, message) => ctx.sendProgress(step, total, message),
      });
      const lines = [
        `Task created: ${task.id}`,
        label ? `Label: ${label}` : null,
        `Endpoint: ${getCDPEndpoint()}`,
        `Tab: ${task.client.targetId ?? "unknown"}`,
        `Attached: ${task.attachedKind}${task.attachedKind === "new" ? " (will close on task close)" : " (left open on task close)"}`,
        keepAlive ? "Keep-alive: enabled (idle TTL skipped)" : null,
        "",
        "Pass `task_id` to comet_ask / comet_poll / comet_screenshot / comet_stop / comet_mode",
        "to operate on this task. Use comet_tasks to list active tasks.",
      ].filter(Boolean) as string[];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(
        `Failed to create Comet task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
