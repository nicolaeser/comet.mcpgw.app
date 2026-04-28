import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_inspect",
  title: "Inspect a Comet task's tab",
  description: "Return a quick snapshot of where a task's tab is right now: current URL, page title, owned target id, label, age/idle. Useful between multi-step prompts to verify the agent didn't drift and to confirm what page it's on.",
  rateLimit: { tool: { max: 120 } },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    task_id: z
      .string()
      .optional()
      .describe("Task to inspect. Required when more than one task is active."),
  },
  async execute({ task_id }) {
    try {
      return await taskRegistry.withTask(task_id, async (task) => {
        const probe = await task.client.evaluate(`
          (() => ({
            url: location.href,
            title: document.title || '',
            readyState: document.readyState,
          }))()
        `);
        const info = probe.result.value as { url: string; title: string; readyState: string };
        const ageSec = Math.round((Date.now() - task.createdAt) / 1000);
        const idleSec = Math.round((Date.now() - task.lastUsedAt) / 1000);

        const agentTab = await task.client.findOwnAgentBrowsingTab();

        const lines = [
          `Task:        ${task.id}`,
          task.label ? `Label:       ${task.label}` : null,
          `Tab:         ${task.client.targetId ?? "?"}`,
          `URL:         ${info.url}`,
          `Title:       ${info.title || "(none)"}`,
          `Ready:       ${info.readyState}`,
          `Keep-alive:  ${task.keepAlive ? "yes" : "no"}`,
          `Age:         ${ageSec}s`,
          `Idle:        ${idleSec}s`,
          agentTab ? `Agent browsing: ${agentTab.url}` : null,
        ].filter(Boolean) as string[];
        return textResult(lines.join("\n"));
      });
    } catch (err) {
      return errorResult(
        `comet_inspect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export default tool;
