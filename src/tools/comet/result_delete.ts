import { z } from "zod";
import {
  cometResultStore,
  type CometResultStatus,
} from "../../comet/result-store.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const statusSchema = z.enum([
  "closed",
  "completed",
  "failed",
  "input_required",
  "timeout",
  "working",
]);

function parseBefore(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const tool = defineTool({
  name: "comet_result_delete",
  title: "Delete retained Comet results",
  description: "Delete retained Comet result records from Redis/process memory. Pass task_id to delete one result, or all=true with optional status/before filters for cleanup.",
  rateLimit: { tool: { max: 30 } },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    task_id: z
      .string()
      .optional()
      .describe("Specific retained result to delete."),
    all: z
      .boolean()
      .default(false)
      .describe("Delete all retained results matching the optional filters."),
    status: statusSchema
      .optional()
      .describe("Optional status filter for bulk deletion."),
    before: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Optional ISO timestamp or epoch milliseconds. Bulk deletion removes results updated before this time."),
  },
  async execute({ task_id, all, status, before }) {
    try {
      if (task_id) {
        const deleted = await cometResultStore.delete(task_id);
        return textResult(
          deleted
            ? `Deleted retained Comet result ${task_id}.`
            : `No retained Comet result existed for ${task_id}.`,
        );
      }

      if (!all) {
        return errorResult("Pass task_id to delete one result, or all=true for bulk cleanup.");
      }

      const beforeMs = parseBefore(before);
      if (before !== undefined && beforeMs === undefined) {
        return errorResult("before must be an ISO timestamp or epoch milliseconds.");
      }

      const deleted = await cometResultStore.deleteMatching({
        before: beforeMs,
        status: status as CometResultStatus | undefined,
      });
      return textResult(`Deleted ${deleted} retained Comet result${deleted === 1 ? "" : "s"}.`);
    } catch (err) {
      return errorResult(
        `comet_result_delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
