import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_rename_task",
  title: "Rename a Comet task",
  description: "Change a task's human-readable label (or clear it by passing an empty string). Labels show up in comet_tasks and comet_status output.",
  rateLimit: { tool: { max: 60 } },
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    task_id: z.string().describe("Task to rename."),
    label: z
      .string()
      .max(80)
      .describe("New label. Pass an empty string to clear the label."),
  },
  async execute({ task_id, label }) {
    try {
      const newLabel = label.trim() === "" ? undefined : label;
      const task = taskRegistry.rename(task_id, newLabel);
      if (!task) {
        return errorResult(`No task with id "${task_id}".`);
      }
      return textResult(
        newLabel
          ? `Task ${task.id} relabelled to "${newLabel}".`
          : `Task ${task.id} label cleared.`,
      );
    } catch (err) {
      return errorResult(
        `comet_rename_task failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
