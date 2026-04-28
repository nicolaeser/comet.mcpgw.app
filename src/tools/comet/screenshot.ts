import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult } from "../_shared/tool-result.js";
import type { ToolResult } from "../../types.js";

const tool = defineTool({
  name: "comet_screenshot",
  title: "Capture Comet screenshot",
  description: "Capture a viewport-sized PNG of a task's Comet tab. For the full scrollable page use comet_full_screenshot. Returns an image content block (base64-encoded PNG).",
  rateLimit: { tool: { max: 30 } },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    task_id: z
      .string()
      .optional()
      .describe("Task whose tab to screenshot. Required when more than one task is active."),
  },
  async execute({ task_id }): Promise<ToolResult> {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const result = await task.client.screenshot("png");
        return {
          content: [
            {
              type: "image",
              data: result.data,
              mimeType: "image/png",
            },
          ],
        };
      });
    } catch (err) {
      return errorResult(
        `comet_screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
