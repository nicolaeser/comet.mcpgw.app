import {
  getBrowserVersion,
  getCDPEndpoint,
  listAllTargets,
  taskRegistry,
} from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_status",
  title: "Comet bridge status",
  description: "First-call diagnostics. Reports whether the MCP server can reach the configured Comet CDP endpoint (COMET_CDP_URL), the browser version, every active task with its tab/url/age/keepAlive, and any other tabs open in the browser. Call this before comet_connect when troubleshooting; if Browser is UNREACHABLE, the rest of the API will fail.",
  rateLimit: { tool: { max: 60 } },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {},
  async execute() {
    const lines: string[] = [`CDP endpoint: ${getCDPEndpoint()}`];

    try {
      const version = await getBrowserVersion();
      lines.push(`Browser: ${version.Browser}`);
    } catch (err) {
      lines.push(
        `Browser: UNREACHABLE (${err instanceof Error ? err.message : String(err)})`,
      );
      lines.push("");
      lines.push(
        "Hint: ensure Comet is running on the host with --remote-debugging-port=9222",
      );
      lines.push(
        "and that the port is reachable from this container (host.docker.internal on Docker Desktop).",
      );
      return errorResult(lines.join("\n"));
    }

    const tasks = taskRegistry.list();
    lines.push("");
    lines.push(`Active tasks: ${tasks.length}`);
    for (const t of tasks) {
      const ageSec = Math.round((Date.now() - t.createdAt) / 1000);
      lines.push(
        `  • ${t.id}${t.label ? ` (${t.label})` : ""} — tab=${t.client.targetId ?? "?"} kind=${t.attachedKind} url=${t.client.currentState.currentUrl ?? "?"} age=${ageSec}s`,
      );
    }
    const pendingCount = taskRegistry.pendingCount();
    if (pendingCount > 0) {
      lines.push(`Pending task creations (tabs claimed but not yet registered): ${pendingCount}`);
    }

    try {
      const all = await listAllTargets();
      const ownedTabIds = new Set(tasks.map((t) => t.client.targetId).filter(Boolean) as string[]);
      const otherPages = all.filter(
        (t) => t.type === "page" && !ownedTabIds.has(t.id),
      );
      const sidecarTabs = otherPages.filter((t) => /perplexity\.ai\/sidecar(\b|\/|\?|$)/.test(t.url));
      const threadTabs = otherPages.filter(
        (t) => /(^|\.)perplexity\.ai\//.test(t.url) && !/\/sidecar(\b|\/|\?|$)/.test(t.url),
      );
      if (sidecarTabs.length > 0 || threadTabs.length > 0) {
        lines.push("");
        lines.push("Existing Perplexity surfaces (attachable via comet_connect attach=...):");
        for (const tab of sidecarTabs) {
          lines.push(`  • [sidecar] target_id=${tab.id} url=${tab.url}${tab.title ? ` title="${tab.title}"` : ""}`);
        }
        for (const tab of threadTabs) {
          lines.push(`  • [thread]  target_id=${tab.id} url=${tab.url}${tab.title ? ` title="${tab.title}"` : ""}`);
        }
        if (sidecarTabs.length > 1 || threadTabs.length > 1) {
          lines.push("");
          lines.push("Multiple tabs of the same kind detected — pass target_id (or url_contains / title_contains) to comet_connect to pick one.");
        }
      }
      const otherNonPplx = otherPages.filter(
        (t) => !sidecarTabs.includes(t) && !threadTabs.includes(t),
      );
      if (otherNonPplx.length > 0) {
        lines.push("");
        lines.push(`Other tabs in browser (${otherNonPplx.length}):`);
        for (const tab of otherNonPplx) lines.push(`  • ${tab.url}`);
      }
    } catch (err) {
      lines.push("");
      lines.push(
        `Tab list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return textResult(lines.join("\n"));
  },
});

export default tool;
