import type { ToolResult } from "../../types.js";

export function textResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent && { structuredContent }),
  };
}

export function errorResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    ...(structuredContent && { structuredContent }),
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
