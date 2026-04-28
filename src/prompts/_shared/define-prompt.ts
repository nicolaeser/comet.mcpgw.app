import type { ZodRawShape } from "zod";
import type { Prompt } from "../../types.js";

export function definePrompt<const TSchema extends ZodRawShape>(
  prompt: Prompt<TSchema>,
): Prompt<TSchema> {
  return prompt;
}
