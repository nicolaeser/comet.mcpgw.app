import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult } from "../_shared/tool-result.js";
import type { ToolResult } from "../../types.js";

const tool = defineTool({
  name: "comet_full_screenshot",
  title: "Capture a full-page screenshot",
  description: "Capture a screenshot of the entire scrollable page (Page.captureScreenshot with captureBeyondViewport=true), not just the visible viewport.",
  rateLimit: { tool: { max: 30 } },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to capture."),
    format: z.enum(["png", "jpeg"]).default("png").describe("Image format."),
    quality: z.number().int().min(1).max(100).optional().describe("JPEG quality (only for jpeg)."),
  },
  async execute({ task_id, format, quality }, ctx): Promise<ToolResult> {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        await ctx.sendProgress(0, 2, `capturing full page (${format})`);
        const r = await task.client.screenshot(format, { fullPage: true, quality });
        await ctx.sendProgress(2, 2, "captured");
        return {
          content: [
            {
              type: "image",
              data: r.data,
              mimeType: format === "png" ? "image/png" : "image/jpeg",
            },
          ],
        };
      });
    } catch (err) {
      return errorResult(`comet_full_screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
