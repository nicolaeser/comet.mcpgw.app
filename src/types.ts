import type { z, ZodRawShape } from "zod";

export interface Icon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "dark" | "light";
}

export interface Annotations {
  audience?: Array<"assistant" | "user">;
  priority?: number;
  lastModified?: string;
}

export type ContentBlock =
  | {
      type: "text";
      text: string;
      annotations?: Annotations;
      _meta?: Record<string, unknown>;
    }
  | {
      type: "image";
      data: string;
      mimeType: string;
      annotations?: Annotations;
      _meta?: Record<string, unknown>;
    }
  | {
      type: "audio";
      data: string;
      mimeType: string;
      annotations?: Annotations;
      _meta?: Record<string, unknown>;
    }
  | {
      type: "resource";
      resource: ResourceContent;
      annotations?: Annotations;
      _meta?: Record<string, unknown>;
    }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
      annotations?: Annotations;
      _meta?: Record<string, unknown>;
    };

export interface ToolResult extends Record<string, unknown> {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type SendProgress = (
  progress: number,
  total?: number,
  message?: string,
) => Promise<void>;

export type SamplingRequest = Record<string, unknown> & {
  messages: Array<{
    role: "assistant" | "user";
    content:
      | { type: "text"; text: string }
      | Array<{ type: "text"; text: string } | Record<string, unknown>>;
  }>;
  maxTokens: number;
};

export type ElicitationRequest =
  | (Record<string, unknown> & {
      mode?: "form";
      message: string;
      requestedSchema: Record<string, unknown>;
    })
  | (Record<string, unknown> & {
      mode: "url";
      elicitationId: string;
      url: string;
      message: string;
    });

export interface ToolContext {
  headers: Record<string, string>;
  sendProgress: SendProgress;
  abortSignal: AbortSignal;
  clientCapabilities: Record<string, unknown>;
  listRoots: () => Promise<unknown>;
  sample: (params: SamplingRequest) => Promise<unknown>;
  elicit: (params: ElicitationRequest) => Promise<unknown>;
}

export interface RateLimitRule {
  max: number;
  windowMs?: number;
}

export interface ClientRateLimitRule extends RateLimitRule {
  idHeader?: string;
}

export interface ToolRateLimit {
  tool?: RateLimitRule | false;
  client?: ClientRateLimitRule | false;
}

export interface ToolExecution {
  taskSupport?: "forbidden" | "optional" | "required";
}

export interface ToolMeta {
  ui?: {
    resourceUri?: string;
    visibility?: Array<"app" | "model">;
  };
  [key: string]: unknown;
}

export type ToolArguments<TSchema extends ZodRawShape> = z.infer<
  z.ZodObject<TSchema>
>;

export interface Tool<TSchema extends ZodRawShape = ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  icons?: Icon[];
  annotations?: ToolAnnotations;
  _meta?: ToolMeta;
  execution?: ToolExecution;
  rateLimit?: ToolRateLimit | false;
  inputSchema: TSchema;
  execute: (
    args: ToolArguments<TSchema>,
    context: ToolContext,
  ) => Promise<ToolResult>;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  annotations?: Annotations;
  _meta?: Record<string, unknown>;
}

export interface ResourceReadResult {
  contents: ResourceContent[];
}

export interface Resource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  icons?: Icon[];
  annotations?: Annotations;
  _meta?: Record<string, unknown>;
  read: () => Promise<ResourceReadResult>;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: Icon[];
  annotations?: Annotations;
  complete?: (argumentName: string, value: string) => Promise<string[]>;
  read?: (
    uri: string,
    variables: Record<string, string>,
  ) => Promise<ResourceReadResult>;
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptContent {
  type: "text";
  text: string;
  annotations?: Annotations;
}

export interface PromptMessage {
  role: "assistant" | "user";
  content: PromptContent;
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

export type PromptArguments<TSchema extends ZodRawShape> = z.infer<
  z.ZodObject<TSchema>
>;

export interface Prompt<TSchema extends ZodRawShape = ZodRawShape> {
  name: string;
  title?: string;
  description?: string;
  icons?: Icon[];
  arguments?: PromptArgument[];
  inputSchema: TSchema;
  complete?: (argumentName: string, value: string) => Promise<string[]>;
  get: (args: PromptArguments<TSchema>) => Promise<PromptResult>;
}
