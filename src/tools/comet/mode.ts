import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const MODE_DESCRIPTIONS: Record<string, string> = {
  search: "Basic web search",
  research: "Deep research with comprehensive analysis",
  labs: "Analytics, visualizations, and coding",
  learn: "Educational content and explanations",
};

const tool = defineTool({
  name: "comet_mode",
  title: "Switch Comet mode",
  description: "Switch the Perplexity answer mode for a task BEFORE calling comet_ask. Modes: search (basic web search, fast), research (multi-step deep research, best for thorough answers), labs (analytics/visualization/coding), learn (educational explanations). Mode is scoped per task — switching here does not affect other parallel tasks. Call without `mode` to read the current mode. Soft-fails when the requested mode is not exposed in the current Perplexity build (returns a notice instead of erroring).",
  rateLimit: { tool: { max: 30 } },
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
    mode: z
      .enum(["search", "research", "labs", "learn"])
      .optional()
      .describe("Mode to switch to. Omit to read the current mode."),
  },
  async execute({ task_id, mode }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const { ai } = task;

        if (!mode) {
          const current = await ai.getCurrentMode();
          const lines: string[] = [
            `Task ${task.id}`,
            `Current mode: ${current}`,
            "",
            "Available modes:",
          ];
          for (const [name, description] of Object.entries(MODE_DESCRIPTIONS)) {
            const marker = name === current ? "→" : " ";
            lines.push(`${marker} ${name}: ${description}`);
          }
          return textResult(lines.join("\n"));
        }

        const result = await ai.setMode(mode);
        if (!result.success) {
          return textResult(
            `Mode "${mode}" could not be applied to task ${task.id} (${result.error ?? "unknown"}). Continuing with current mode.`,
          );
        }
        return textResult(`Switched task ${task.id} to ${mode} mode`);
      });
    } catch (err) {
      return errorResult(
        `comet_mode failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
