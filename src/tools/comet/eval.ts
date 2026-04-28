import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const ENABLED = (() => {
  const raw = (process.env.COMET_ENABLE_EVAL ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
})();

const tool = defineTool({
  name: "comet_eval",
  title: "Evaluate JS in a task's tab",
  description: "Run an arbitrary JavaScript expression in the task's tab and return the JSON-serializable result. The expression is wrapped in `(async () => (<expression>))()`, so you can use top-level `await`. Use cases: structured scraping with cross-element traversal, reading window/storage state, patching window.fetch for instrumentation, async polling waits, DOM mutation, or aggregate computations that would otherwise need many round-trips. Prefer comet_dom_query / comet_html / comet_click for read-only or single-action work — those don't need eval. DISABLED BY DEFAULT — start the server with COMET_ENABLE_EVAL=true. Security: this is XSS-equivalent inside the tab; only enable on trusted installs.",
  rateLimit: { tool: { max: 60 } },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    task_id: z
      .string()
      .optional()
      .describe("Task to operate on. Required when more than one task is active."),
    expression: z
      .string()
      .min(1)
      .max(20_000)
      .describe(
        "JavaScript expression. Wrapped in `(async () => (<expression>))()`, so the " +
          "expression's value is awaited and returned. Returned value must be JSON-serializable.",
      ),
  },
  async execute({ task_id, expression }) {
    if (!ENABLED) {
      return errorResult(
        "comet_eval is disabled. Start the server with COMET_ENABLE_EVAL=true to enable it.",
      );
    }
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const wrapped = `(async () => (${expression}))()`;
        const result = await task.client.evaluate(wrapped);
        const value = result.result?.value;
        let rendered: string;
        try {
          rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        } catch {
          rendered = String(value);
        }
        return textResult(rendered ?? "(undefined)");
      });
    } catch (err) {
      return errorResult(
        `comet_eval failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
