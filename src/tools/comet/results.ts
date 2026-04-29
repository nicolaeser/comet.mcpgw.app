import { z } from "zod";
import {
  cometResultStore,
  type CometResultRecord,
  type CometResultStatus,
} from "../../comet/result-store.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult } from "../_shared/tool-result.js";

const statusSchema = z.enum([
  "closed",
  "completed",
  "failed",
  "input_required",
  "timeout",
  "working",
]);

function parseSince(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function preview(value: string, max = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function formatRecord(record: CometResultRecord, includeResponse: boolean): string {
  const lines = [
    `Task: ${record.taskId}`,
    `Status: ${record.status.toUpperCase()}`,
    record.label ? `Label: ${record.label}` : null,
    `Updated: ${record.updatedAt}`,
    record.completedAt ? `Completed: ${record.completedAt}` : null,
    `Expires: ${record.expiresAt}`,
    record.source ? `Source: ${record.source}` : null,
    record.autoCloseOnCompletion !== undefined
      ? `Auto-close: ${record.autoCloseOnCompletion ? "yes" : "no"}`
      : null,
    record.closedAfterCompletion !== undefined
      ? `Closed after completion: ${record.closedAfterCompletion ? "yes" : "no"}`
      : null,
    record.currentStep ? `Current: ${record.currentStep}` : null,
    record.agentBrowsingUrl ? `Browsing: ${record.agentBrowsingUrl}` : null,
    record.confirmationPrompt ? `Awaiting: ${record.confirmationPrompt}` : null,
    record.error ? `Error: ${record.error}` : null,
  ].filter(Boolean) as string[];

  if (record.stream) {
    lines.push(
      `Stream: ${record.stream.status.toUpperCase()} ` +
        `(requests=${record.stream.streamRequestCount}, chunks=${record.stream.sseChunkCount}, ` +
        `bytes=${record.stream.sseBytes}, events=${record.stream.eventCount}, ` +
        `active=${record.stream.sseActive ? "yes" : "no"})`,
    );
  }

  if (includeResponse && record.response) {
    lines.push("");
    lines.push(record.response);
    if (record.responseTruncated) {
      lines.push("");
      lines.push("Result was truncated by COMET_RESULT_MAX_TEXT.");
    }
  }

  return lines.join("\n");
}

const tool = defineTool({
  name: "comet_results",
  title: "Read retained Comet results",
  description:
    "Read Comet task results retained by the server. Use task_id to fetch one full result after its tab was auto-closed, or omit task_id to list recent retained results. Results are kept in Redis when REDIS_URL is configured and fall back to process memory otherwise.\n\n" +
    "When to call this (for agents):\n" +
    "  • After `comet_ask` returned `result_delivery:\"async\"` (timeout, wait=false, or input_required) — call this with the same `task_id` to fetch the retained final answer once the background watcher saves it.\n" +
    "  • Reading the response: in `structuredContent.result`, when `status:\"completed\"` the `response` field is the final answer. `status:\"working\"` means the watcher has not yet captured a completed run — try again later or use `comet_poll` if the task is still active. `status:\"failed\"` / `\"timeout\"` → read `error`.",
  rateLimit: { tool: { max: 120 } },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    task_id: z
      .string()
      .optional()
      .describe("Retained task result to read. Omit to list recent results."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe("Maximum number of results when listing."),
    since: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Only list results updated after this ISO timestamp or epoch milliseconds."),
    status: statusSchema
      .optional()
      .describe("Optional status filter when listing."),
    include_response: z
      .boolean()
      .default(false)
      .describe("When listing, include retained response bodies instead of summaries only."),
  },
  async execute({ task_id, limit, since, status, include_response }) {
    try {
      if (task_id) {
        const record = await cometResultStore.get(task_id);
        if (!record) return errorResult(`No retained Comet result for task_id=${task_id}`);
        return {
          content: [{ type: "text" as const, text: formatRecord(record, true) }],
          structuredContent: { result: record },
        };
      }

      const sinceMs = parseSince(since);
      if (since !== undefined && sinceMs === undefined) {
        return errorResult("since must be an ISO timestamp or epoch milliseconds");
      }

      const records = await cometResultStore.list({
        limit,
        since: sinceMs,
        status: status as CometResultStatus | undefined,
      });

      if (records.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No retained Comet results matched." }],
          structuredContent: { results: [] },
        };
      }

      const lines = [`Retained Comet results: ${records.length}`, ""];
      for (const record of records) {
        lines.push(`• ${record.taskId}`);
        lines.push(`    status:  ${record.status}`);
        if (record.label) lines.push(`    label:   ${record.label}`);
        lines.push(`    updated: ${record.updatedAt}`);
        lines.push(`    expires: ${record.expiresAt}`);
        if (record.response) {
          lines.push(
            `    result:  ${include_response ? record.response : preview(record.response)}`,
          );
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: { results: records },
      };
    } catch (err) {
      return errorResult(
        `comet_results failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
