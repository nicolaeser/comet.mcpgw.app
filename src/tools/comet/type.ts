import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_type",
  title: "Type text into a task's tab",
  description: "Type text into a focused element via CDP Input.insertText. If `selector` is provided, the matching element is focused first. Foreground-independent — works even when the task's tab is behind another. Useful for filling forms or pre-populating Perplexity's input before submitting via comet_ask.",
  rateLimit: { tool: { max: 120 } },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to operate on."),
    text: z.string().min(1).describe("Text to type into the focused element."),
    selector: z.string().optional().describe("Optional CSS selector to focus first."),
  },
  async execute({ task_id, text, selector }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        if (selector) {
          const r = await task.client.evaluate(`
            (() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return false;
              el.focus();
              return true;
            })()
          `);
          if (!r.result.value) {
            return errorResult(`No element matches selector "${selector}".`);
          }
        }
        await task.client.insertText(text);
        return textResult(`Typed ${text.length} char(s) into task ${task.id}.`);
      });
    } catch (err) {
      return errorResult(`comet_type failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
