import type { ToolResult } from "../../types.js";

export function textResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

export function errorResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

export function resourceLinkResult(
  uri: string,
  name: string,
  description?: string,
): ToolResult {
  return {
    content: [
      {
        type: "resource_link",
        uri,
        name,
        ...(description && { description }),
      },
    ],
  };
}
