import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_tasks",
  title: "List Comet tasks",
  description: "List every active Comet task: id, label, owned tab id, current URL, age, idle time, and keepAlive flag. Use the printed task_id with any task-scoped tool (comet_ask, comet_poll, comet_screenshot, comet_navigate, etc.). Returns 'No active tasks' if you haven't called comet_connect yet.",
  rateLimit: { tool: { max: 60 } },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {},
  async execute() {
    const tasks = taskRegistry.list();
    if (tasks.length === 0) {
      return textResult("No active tasks. Call comet_connect to create one.");
    }
    const lines: string[] = [`Active tasks: ${tasks.length}`, ""];
    for (const t of tasks) {
      const ageSec = Math.round((Date.now() - t.createdAt) / 1000);
      const idleSec = Math.round((Date.now() - t.lastUsedAt) / 1000);
      lines.push(`• ${t.id}`);
      if (t.label) lines.push(`    label: ${t.label}`);
      lines.push(`    tab:   ${t.client.targetId ?? "?"} (${t.attachedKind})`);
      lines.push(`    url:   ${t.client.currentState.currentUrl ?? "?"}`);
      lines.push(`    age:   ${ageSec}s   idle: ${idleSec}s   keepAlive: ${t.keepAlive ? "yes" : "no"}`);
    }
    return textResult(lines.join("\n"));
  },
});

export default tool;
