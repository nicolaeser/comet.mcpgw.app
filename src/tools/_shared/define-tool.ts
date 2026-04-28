import type { ZodRawShape } from "zod";
import type { Tool } from "../../types.js";

export function defineTool<const TSchema extends ZodRawShape>(
  tool: Tool<TSchema>,
): Tool<TSchema> {
  return tool;
}
