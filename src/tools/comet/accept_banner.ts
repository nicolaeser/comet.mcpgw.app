import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_accept_banner",
  title: "Accept Comet's browser-control banner",
  description:
    'Manually accept Perplexity\'s "Allow assistant to control your browser?" banner ' +
    "for a task. comet_ask already auto-accepts in a loop, so call this only when " +
    "you see the agent stuck waiting for permission (e.g. the banner appeared mid-task " +
    "and the auto-accept missed it). Returns whether a banner was actually clicked.",
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
  },
  async execute({ task_id }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const accepted = await task.ai.acceptBrowserControlBanner();
        return textResult(
          accepted
            ? `Banner accepted on task ${task.id}.`
            : `No browser-control banner visible on task ${task.id}.`,
        );
      });
    } catch (err) {
      return errorResult(
        `comet_accept_banner failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
