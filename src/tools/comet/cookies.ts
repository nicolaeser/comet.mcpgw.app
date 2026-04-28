import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_cookies",
  title: "Get cookies for a task",
  description: "List cookies visible to the task's tab. If `urls` is provided, only cookies for those URLs are returned; otherwise all cookies on the browser are returned.",
  rateLimit: { tool: { max: 60 } },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to operate on."),
    urls: z.array(z.string().url()).optional().describe("Restrict to cookies for these URLs."),
  },
  async execute({ task_id, urls }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const cookies = await task.client.getCookies(urls);
        return textResult(JSON.stringify(cookies, null, 2));
      });
    } catch (err) {
      return errorResult(`comet_cookies failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
