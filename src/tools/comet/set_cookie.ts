import { z } from "zod";
import { taskRegistry } from "../../comet/task-registry.js";
import { defineTool } from "../_shared/define-tool.js";
import { errorResult, textResult } from "../_shared/tool-result.js";

const tool = defineTool({
  name: "comet_set_cookie",
  title: "Set a cookie",
  description: "Set a cookie via CDP Network.setCookie. Useful for seeding auth state. Either provide `url` (cookie attributes are inferred) or `domain` + `path` explicitly.",
  rateLimit: { tool: { max: 30 } },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    task_id: z.string().optional().describe("Task to operate on."),
    name: z.string().min(1).describe("Cookie name."),
    value: z.string().describe("Cookie value."),
    url: z.string().url().optional().describe("URL the cookie applies to (preferred)."),
    domain: z.string().optional().describe("Cookie domain (use if `url` not provided)."),
    path: z.string().optional().describe("Cookie path (default '/')."),
    secure: z.boolean().optional(),
    httpOnly: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
    expires: z.number().optional().describe("Unix epoch seconds when the cookie expires."),
  },
  async execute({ task_id, name, value, url, domain, path, secure, httpOnly, sameSite, expires }) {
    try {
      if (!url && !domain) {
        return errorResult("Provide either `url` or `domain` for the cookie.");
      }
      return await taskRegistry.withTask(task_id, async (task) => {
        const params: Record<string, unknown> = { name, value };
        if (url) params.url = url;
        if (domain) params.domain = domain;
        if (path) params.path = path;
        if (typeof secure === "boolean") params.secure = secure;
        if (typeof httpOnly === "boolean") params.httpOnly = httpOnly;
        if (sameSite) params.sameSite = sameSite;
        if (typeof expires === "number") params.expires = expires;
        const ok = await task.client.setCookie(params);
        return textResult(ok ? `Cookie "${name}" set on task ${task.id}.` : `Failed to set cookie "${name}".`);
      });
    } catch (err) {
      return errorResult(`comet_set_cookie failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export default tool;
