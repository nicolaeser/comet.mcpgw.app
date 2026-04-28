import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_accept_banner",
  title: "Accept a Comet confirmation",
  description:
    "Manually approve a Comet confirmation prompt — both the initial \"Allow assistant " +
    "to control your browser?\" banner and in-flow safe-confirm cards (Continue / Proceed / Allow / OK). " +
    "comet_ask auto-accepts safe confirmations in its poll loop, so call this only when the agent " +
    "is stuck and the auto-accept missed it. By default destructive actions (Send / Submit / Pay / " +
    "Confirm / Sign in / Delete) are NEVER auto-clicked — pass allow_destructive=true to override " +
    "(use with extreme caution).",
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
      .describe("Task to operate on. Required when more than one task is active."),
    allow_destructive: z
      .boolean()
      .default(false)
      .describe(
        "If true, also click destructive confirmation buttons (Send / Submit / Pay / Confirm / " +
          "Sign in / Delete). Disabled by default to avoid irreversible actions without explicit consent.",
      ),
  },
  async execute({ task_id, allow_destructive }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const bannerClicked = await task.ai.acceptBrowserControlBanner();
        const inFlow = await task.ai.acceptInFlowConfirmation({ allowDestructive: allow_destructive });
        if (bannerClicked || inFlow.clicked) {
          const parts: string[] = [];
          if (bannerClicked) parts.push("browser-control banner");
          if (inFlow.clicked) parts.push(`in-flow ${inFlow.kind}`);
          return textResult(
            `Accepted on task ${task.id}: ${parts.join(", ")}` +
              (inFlow.text ? `\nPrompt: ${inFlow.text}` : ""),
          );
        }
        return textResult(`No confirmation visible on task ${task.id}.`);
      });
    } catch (err) {
      return errorResult(
        `comet_accept_banner failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
