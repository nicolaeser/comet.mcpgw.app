import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_set_viewport",
  title: "Override the task's viewport",
  description: "Set device metrics for the task's tab via Emulation.setDeviceMetricsOverride. Pass width=0 and height=0 to clear the override and return to the real viewport.",
  rateLimit: { tool: { max: 30 } },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to operate on."),
    width: z.number().int().min(0).max(10_000).describe("Viewport width in CSS px (0 to clear)."),
    height: z.number().int().min(0).max(10_000).describe("Viewport height in CSS px (0 to clear)."),
    deviceScaleFactor: z.number().min(0).max(5).default(1).describe("DPR override (default 1)."),
    mobile: z.boolean().default(false).describe("Emulate a mobile device."),
  },
  async execute({ task_id, width, height, deviceScaleFactor, mobile }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        if (width === 0 && height === 0) {
          await task.client.clearViewport();
          return textResult(`Task ${task.id}: viewport override cleared.`);
        }
        await task.client.setViewport({ width, height, deviceScaleFactor, mobile });
        return textResult(
          `Task ${task.id}: viewport set to ${width}x${height} (DPR=${deviceScaleFactor}, mobile=${mobile}).`,
        );
      });
    } catch (err) {
      return errorResult(`comet_set_viewport failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
