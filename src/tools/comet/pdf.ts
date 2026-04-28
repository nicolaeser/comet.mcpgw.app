import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult } from "../_shared/tool-result.js";
import type { ToolResult } from "../../types.js";

const tool = defineTool({
  name: "comet_pdf",
  title: "Print task tab to PDF",
  description: "Capture the task's tab as a PDF (Page.printToPDF). Returned as a base64 PDF resource.",
  rateLimit: { tool: { max: 30 } },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to capture."),
    landscape: z.boolean().default(false),
    printBackground: z.boolean().default(true),
    paperWidthInches: z.number().min(1).max(50).optional(),
    paperHeightInches: z.number().min(1).max(50).optional(),
  },
  async execute({ task_id, landscape, printBackground, paperWidthInches, paperHeightInches }, ctx): Promise<ToolResult> {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const opts: Record<string, unknown> = {
          landscape,
          printBackground,
          transferMode: "ReturnAsBase64",
        };
        if (paperWidthInches) opts.paperWidth = paperWidthInches;
        if (paperHeightInches) opts.paperHeight = paperHeightInches;
        await ctx.sendProgress(0, 2, "rendering PDF (Page.printToPDF)");
        const r = await task.client.printPDF(opts);
        await ctx.sendProgress(2, 2, "captured");
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `comet://task/${task.id}/snapshot.pdf`,
                mimeType: "application/pdf",
                blob: r.data,
              },
            },
          ],
        };
      });
    } catch (err) {
      return errorResult(`comet_pdf failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
