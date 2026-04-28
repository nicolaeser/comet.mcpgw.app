import type { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../runtime/logger.js";
import type {
  ElicitationRequest,
  Prompt,
  Resource,
  ResourceTemplate,
  SamplingRequest,
  Tool,
  ToolContext,
  ToolResult,
} from "../types.js";
import {
  isJsonRpcClientResponse,
  isJsonRpcMessage,
  jsonRpcError,
  jsonRpcSuccess,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  MCP_ERROR_RESOURCE_NOT_FOUND,
  McpJsonRpcError,
  parseJsonRpcId,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./json-rpc.js";
import {
  LATEST_PROTOCOL_VERSION,
  isSupportedProtocolVersion,
  supportsTasks,
  supportsJsonRpcBatching,
  supportsStructuredToolOutput,
  type McpProtocolVersion,
} from "./protocol.js";
import { loadPrompts } from "./prompt-loader.js";
import type { ToolRateLimiter } from "./rate-limit.js";
import { loadResources } from "./resource-loader.js";
import { loadResourceTemplates } from "./resource-template-loader.js";
import { TaskStore } from "./persistence/task-store.js";
import { loadTools } from "./tool-loader.js";

interface McpServerOptions {
  name: string;
  version: string;
  sessionId: string;
  clientHeaders: Record<string, string>;
  rateLimiter: ToolRateLimiter;
}

interface ProgressMetadata {
  progressToken?: string | number;
}

const LOGGING_LEVELS = new Set([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
]);

interface ResolvedToolCall {
  tool: Tool;
  args: Record<string, unknown>;
  progressMeta: ProgressMetadata;
  abortSignal: AbortSignal;
}

interface PendingClientRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ActiveRequest {
  abortController: AbortController;
  reason?: string;
}

interface ResourceTemplateMatch {
  template: ResourceTemplate;
  variables: Record<string, string>;
}

export function isInitializeRequest(body: unknown): boolean {
  if (!isJsonRpcMessage(body)) return false;
  return body.method === "initialize";
}

export async function createMcpServerSession(
  options: McpServerOptions,
): Promise<McpServerSession> {
  const [tools, resources, resourceTemplates, prompts] = await Promise.all([
    loadTools(),
    loadResources(),
    loadResourceTemplates(),
    loadPrompts(),
  ]);
  return new McpServerSession(
    options,
    tools,
    resources,
    resourceTemplates,
    prompts,
  );
}

export class McpServerSession {
  private readonly toolByName: Map<string, Tool>;
  private readonly resourceByUri: Map<string, Resource>;
  private readonly resourceTemplates: ResourceTemplate[];
  private readonly promptByName: Map<string, Prompt>;
  private readonly subscribedResourceUris = new Set<string>();
  private readonly tasks = new TaskStore();
  private readonly pendingClientRequests = new Map<
    string,
    PendingClientRequest
  >();
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private readonly streams = new Set<Response>();
  private initialized = false;
  private closed = false;
  private protocolVersion: McpProtocolVersion = LATEST_PROTOCOL_VERSION;
  private loggingLevel = "info";
  private clientCapabilities: Record<string, unknown> = {};
  private nextClientRequestId = 1;

  constructor(
    private readonly options: McpServerOptions,
    tools: Tool[],
    resources: Resource[],
    resourceTemplates: ResourceTemplate[],
    prompts: Prompt[],
  ) {
    this.toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    this.resourceByUri = new Map(
      resources.map((resource) => [resource.uri, resource]),
    );
    this.resourceTemplates = resourceTemplates;
    this.promptByName = new Map(prompts.map((prompt) => [prompt.name, prompt]));
  }

  async handlePost(req: Request, res: Response, body: unknown): Promise<void> {
    if (this.closed) {
      const id = isJsonRpcMessage(body) ? body.id : null;
      res
        .status(404)
        .json(jsonRpcError(id, JSON_RPC_INVALID_REQUEST, "Session is closed"));
      return;
    }

    const result = await this.handleBody(body);
    res.setHeader("mcp-session-id", this.options.sessionId);
    res.setHeader("mcp-protocol-version", this.protocolVersion);

    if (result === undefined) {
      res.status(202).end();
      return;
    }

    res.json(result);
  }

  handleGet(req: Request, res: Response): void {
    if (this.closed) {
      res.status(404).json({ error: "MCP session is closed" });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("mcp-session-id", this.options.sessionId);
    res.setHeader("mcp-protocol-version", this.protocolVersion);
    res.flushHeaders();
    res.write(": connected\n\n");

    this.streams.add(res);

    req.on("close", () => {
      this.streams.delete(res);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const stream of this.streams) {
      stream.end();
    }

    this.streams.clear();
  }

  private async handleBody(
    body: unknown,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (Array.isArray(body)) {
      if (!supportsJsonRpcBatching(this.protocolVersion)) {
        return jsonRpcError(
          null,
          JSON_RPC_INVALID_REQUEST,
          "JSON-RPC batching is not supported for this MCP protocol version",
        );
      }

      if (body.length === 0) {
        return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid request");
      }

      const responses = await Promise.all(
        body.map((message) => this.handleMessage(message)),
      );
      const visibleResponses = responses.filter(
        (response): response is JsonRpcResponse => response !== undefined,
      );
      return visibleResponses.length > 0 ? visibleResponses : undefined;
    }

    return this.handleMessage(body);
  }

  private async handleMessage(
    message: unknown,
  ): Promise<JsonRpcResponse | undefined> {
    if (isJsonRpcClientResponse(message)) {
      this.handleClientResponse(message.id, message);
      return undefined;
    }

    const request = this.parseRequest(message);
    if (!request.ok) return request.response;

    const requestKey =
      request.value.id === undefined ? undefined : String(request.value.id);
    const activeRequest =
      requestKey === undefined
        ? undefined
        : {
            abortController: new AbortController(),
          };
    if (requestKey && activeRequest) {
      this.activeRequests.set(requestKey, activeRequest);
    }

    try {
      const result = await this.dispatch(request.value, activeRequest);
      if (request.value.id === undefined) return undefined;
      return jsonRpcSuccess(request.value.id, result);
    } catch (err) {
      if (request.value.id === undefined) return undefined;

      if (err instanceof McpJsonRpcError) {
        return jsonRpcError(request.value.id, err.code, err.message, err.data);
      }

      logger.error("MCP method handling failed", {
        method: request.value.method,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonRpcError(
        request.value.id,
        JSON_RPC_INTERNAL_ERROR,
        "Internal error",
      );
    } finally {
      if (requestKey) {
        this.activeRequests.delete(requestKey);
      }
    }
  }

  private parseRequest(
    message: unknown,
  ):
    | { ok: true; value: JsonRpcRequest }
    | { ok: false; response: JsonRpcFailure } {
    if (!isJsonRpcMessage(message)) {
      return {
        ok: false,
        response: jsonRpcError(
          null,
          JSON_RPC_INVALID_REQUEST,
          "Invalid request",
        ),
      };
    }

    const id = parseJsonRpcId(message.id);
    if (!id.ok) {
      return {
        ok: false,
        response: jsonRpcError(
          null,
          JSON_RPC_INVALID_REQUEST,
          "Invalid request",
        ),
      };
    }

    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return {
        ok: false,
        response: jsonRpcError(
          id.value,
          JSON_RPC_INVALID_REQUEST,
          "Invalid request",
        ),
      };
    }

    return {
      ok: true,
      value: {
        jsonrpc: "2.0",
        ...(message.id !== undefined && { id: id.value }),
        method: message.method,
        params: message.params,
      },
    };
  }

  private async dispatch(
    request: JsonRpcRequest,
    activeRequest?: ActiveRequest,
  ): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return this.initialize(request.params);
      case "notifications/initialized":
        this.initialized = true;
        return {};
      case "notifications/cancelled":
        this.cancelRequest(request);
        return {};
      case "ping":
        return {};
      case "tools/list":
        this.assertInitialized(request.method);
        return this.listTools(request);
      case "tools/call":
        this.assertInitialized(request.method);
        return this.callTool(request, activeRequest?.abortController.signal);
      case "resources/list":
        this.assertInitialized(request.method);
        return this.listResources(request);
      case "resources/read":
        this.assertInitialized(request.method);
        return this.readResource(request);
      case "resources/subscribe":
        this.assertInitialized(request.method);
        return this.subscribeResource(request);
      case "resources/unsubscribe":
        this.assertInitialized(request.method);
        return this.unsubscribeResource(request);
      case "resources/templates/list":
        this.assertInitialized(request.method);
        return this.listResourceTemplates(request);
      case "prompts/list":
        this.assertInitialized(request.method);
        return this.listPrompts(request);
      case "prompts/get":
        this.assertInitialized(request.method);
        return this.getPrompt(request);
      case "completion/complete":
        this.assertInitialized(request.method);
        return this.complete(request);
      case "logging/setLevel":
        this.assertInitialized(request.method);
        return this.setLoggingLevel(request);
      case "tasks/list":
        this.assertInitialized(request.method);
        this.assertTasksSupported();
        return { tasks: await this.tasks.list() };
      case "tasks/get":
        this.assertInitialized(request.method);
        this.assertTasksSupported();
        return this.getTask(request);
      case "tasks/cancel":
        this.assertInitialized(request.method);
        this.assertTasksSupported();
        return this.cancelTask(request);
      case "tasks/result":
        this.assertInitialized(request.method);
        this.assertTasksSupported();
        return this.getTaskResult(request);
      default:
        throw new McpJsonRpcError(
          JSON_RPC_METHOD_NOT_FOUND,
          `Method not found: ${request.method}`,
        );
    }
  }

  private initialize(params: unknown): unknown {
    const requestedVersion = getStringParam(params, "protocolVersion");
    const protocolVersion =
      requestedVersion && isSupportedProtocolVersion(requestedVersion)
        ? requestedVersion
        : LATEST_PROTOCOL_VERSION;

    this.clientCapabilities = parseRecord(parseRecord(params).capabilities);
    this.protocolVersion = protocolVersion;
    this.initialized = true;

    return {
      protocolVersion,
      capabilities: this.serverCapabilities(),
      serverInfo: {
        name: this.options.name,
        version: this.options.version,
      },
    };
  }

  private serverCapabilities(): Record<string, unknown> {
    return {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      completions: {},
      logging: {},
      experimental: {
        extensions: {},
      },
      ...(supportsTasks(this.protocolVersion) && {
        tasks: {
          list: {},
          cancel: {},
          requests: {
            tools: {
              call: {},
            },
          },
        },
      }),
    };
  }

  private listTools(request: JsonRpcRequest): unknown {
    const page = paginate(
      [...this.toolByName.values()],
      getStringParam(request.params, "cursor"),
    );
    return {
      tools: page.items.map((tool) => ({
        name: tool.name,
        ...(tool.title && { title: tool.title }),
        description: tool.description,
        ...(tool.icons && { icons: tool.icons }),
        inputSchema: z.toJSONSchema(z.object(tool.inputSchema), {
          io: "input",
        }),
        ...(tool.annotations && { annotations: tool.annotations }),
        ...(tool._meta && { _meta: tool._meta }),
        ...(supportsTasks(this.protocolVersion) && {
          execution: tool.execution ?? { taskSupport: "optional" },
        }),
      })),
      ...(page.nextCursor && { nextCursor: page.nextCursor }),
    };
  }

  private listResources(request: JsonRpcRequest): unknown {
    const page = paginate(
      [...this.resourceByUri.values()],
      getStringParam(request.params, "cursor"),
    );
    return {
      resources: page.items.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        ...(resource.title && { title: resource.title }),
        ...(resource.description && { description: resource.description }),
        ...(resource.mimeType && { mimeType: resource.mimeType }),
        ...(resource.size !== undefined && { size: resource.size }),
        ...(resource.icons && { icons: resource.icons }),
        ...(resource.annotations && { annotations: resource.annotations }),
        ...(resource._meta && { _meta: resource._meta }),
      })),
      ...(page.nextCursor && { nextCursor: page.nextCursor }),
    };
  }

  private async readResource(request: JsonRpcRequest): Promise<unknown> {
    const params = parseRecord(request.params);
    const uri = typeof params.uri === "string" ? params.uri : undefined;
    if (!uri) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        "Missing resource URI",
      );
    }

    const resource = this.resourceByUri.get(uri);
    if (resource) {
      logger.info(
        "MCP resource read",
        { resource: resource.uri },
        { privacySafe: true },
      );
      return resource.read();
    }

    const templateMatch = this.findResourceTemplate(uri);
    if (templateMatch?.template.read) {
      logger.info(
        "MCP resource template read",
        { resourceTemplate: templateMatch.template.uriTemplate },
        { privacySafe: true },
      );
      return templateMatch.template.read(uri, templateMatch.variables);
    }

    if (!templateMatch) {
      throw new McpJsonRpcError(
        MCP_ERROR_RESOURCE_NOT_FOUND,
        "Resource not found",
        { uri },
      );
    }

    throw new McpJsonRpcError(
      MCP_ERROR_RESOURCE_NOT_FOUND,
      "Resource template cannot be read",
      { uri },
    );
  }

  private subscribeResource(request: JsonRpcRequest): unknown {
    const params = parseRecord(request.params);
    const uri = typeof params.uri === "string" ? params.uri : undefined;
    if (!uri) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        "Missing resource URI",
      );
    }

    if (!this.resourceByUri.has(uri)) {
      throw new McpJsonRpcError(
        MCP_ERROR_RESOURCE_NOT_FOUND,
        "Resource not found",
        { uri },
      );
    }

    this.subscribedResourceUris.add(uri);
    return {};
  }

  private unsubscribeResource(request: JsonRpcRequest): unknown {
    const params = parseRecord(request.params);
    const uri = typeof params.uri === "string" ? params.uri : undefined;
    if (!uri) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        "Missing resource URI",
      );
    }

    this.subscribedResourceUris.delete(uri);
    return {};
  }

  private listResourceTemplates(request: JsonRpcRequest): unknown {
    const page = paginate(
      this.resourceTemplates,
      getStringParam(request.params, "cursor"),
    );
    return {
      resourceTemplates: page.items.map((template) => ({
        uriTemplate: template.uriTemplate,
        name: template.name,
        ...(template.title && { title: template.title }),
        ...(template.description && { description: template.description }),
        ...(template.mimeType && { mimeType: template.mimeType }),
        ...(template.icons && { icons: template.icons }),
        ...(template.annotations && { annotations: template.annotations }),
      })),
      ...(page.nextCursor && { nextCursor: page.nextCursor }),
    };
  }

  private listPrompts(request: JsonRpcRequest): unknown {
    const page = paginate(
      [...this.promptByName.values()],
      getStringParam(request.params, "cursor"),
    );
    return {
      prompts: page.items.map((prompt) => ({
        name: prompt.name,
        ...(prompt.title && { title: prompt.title }),
        ...(prompt.description && { description: prompt.description }),
        ...(prompt.arguments && { arguments: prompt.arguments }),
        ...(prompt.icons && { icons: prompt.icons }),
      })),
      ...(page.nextCursor && { nextCursor: page.nextCursor }),
    };
  }

  private async getPrompt(request: JsonRpcRequest): Promise<unknown> {
    const params = parseRecord(request.params);
    const name = typeof params.name === "string" ? params.name : undefined;
    if (!name) {
      throw new McpJsonRpcError(JSON_RPC_INVALID_PARAMS, "Missing prompt name");
    }

    const prompt = this.promptByName.get(name);
    if (!prompt) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        `Unknown prompt: ${name}`,
      );
    }

    const args = parseRecord(params.arguments);
    const schema = z.object(prompt.inputSchema);
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        "Invalid prompt arguments",
        z.treeifyError(parsed.error),
      );
    }

    logger.info(
      "MCP prompt requested",
      { prompt: prompt.name },
      { privacySafe: true },
    );
    return prompt.get(parsed.data);
  }

  private async complete(request: JsonRpcRequest): Promise<unknown> {
    const params = parseRecord(request.params);
    const ref = parseRecord(params.ref);
    const argument = parseRecord(params.argument);
    const argumentName =
      typeof argument.name === "string" ? argument.name : undefined;
    const value = typeof argument.value === "string" ? argument.value : "";

    if (!argumentName) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        "Missing completion argument name",
      );
    }

    const values = await this.resolveCompletionValues(ref, argumentName, value);
    return {
      completion: {
        values,
        total: values.length,
        hasMore: false,
      },
    };
  }

  private async resolveCompletionValues(
    ref: Record<string, unknown>,
    argumentName: string,
    value: string,
  ): Promise<string[]> {
    const type = typeof ref.type === "string" ? ref.type : undefined;

    if (type === "ref/prompt") {
      const name = typeof ref.name === "string" ? ref.name : undefined;
      const prompt = name ? this.promptByName.get(name) : undefined;
      return prompt?.complete ? prompt.complete(argumentName, value) : [];
    }

    if (type === "ref/resource") {
      const uri = typeof ref.uri === "string" ? ref.uri : undefined;
      const match = uri ? this.findResourceTemplate(uri) : undefined;
      return match?.template.complete
        ? match.template.complete(argumentName, value)
        : [];
    }

    if (type === "ref/resourceTemplate") {
      const uriTemplate =
        typeof ref.uriTemplate === "string" ? ref.uriTemplate : undefined;
      const template = this.resourceTemplates.find(
        (entry) => entry.uriTemplate === uriTemplate,
      );
      return template?.complete ? template.complete(argumentName, value) : [];
    }

    return [];
  }

  private async callTool(
    request: JsonRpcRequest,
    abortSignal: AbortSignal = new AbortController().signal,
  ): Promise<unknown> {
    const params = parseRecord(request.params);
    const taskRequest = parseRecord(params.task);
    if (params.task !== undefined) {
      return this.createToolTask(request, taskRequest);
    }

    const call = this.resolveToolCall(request, abortSignal);
    return this.executeToolCall(call);
  }

  private async createToolTask(
    request: JsonRpcRequest,
    taskRequest: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const abortController = new AbortController();
    const call = this.resolveToolCall(request, abortController.signal);
    const taskSupport = call.tool.execution?.taskSupport ?? "optional";
    if (taskSupport === "forbidden") {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        "Tool does not support task execution",
      );
    }

    const task = await this.tasks.create(
      typeof taskRequest.ttl === "number" && taskRequest.ttl > 0
        ? taskRequest.ttl
        : undefined,
    );

    this.tasks.registerAbort(task.taskId, abortController);

    void this.executeToolCall(call)
      .then(async (result) => {
        const updatedTask = result.isError
          ? await this.tasks.completeWithErrorResult(
              task.taskId,
              result,
              "Tool execution returned an error result.",
            )
          : await this.tasks.complete(task.taskId, result);
        if (updatedTask) {
          this.sendTaskStatus(updatedTask);
        }
      })
      .catch(async (err) => {
        const updatedTask = await this.tasks.fail(task.taskId, err);
        if (updatedTask) {
          this.sendTaskStatus(updatedTask);
        }
      })
      .finally(() => {
        this.tasks.releaseAbort(task.taskId);
      });

    this.sendTaskStatus(task);

    return {
      _meta: {
        "io.modelcontextprotocol/related-task": {
          taskId: task.taskId,
        },
        "io.modelcontextprotocol/model-immediate-response":
          "The task is running. Poll tasks/get or tasks/result for the final result.",
      },
      task,
    };
  }

  private resolveToolCall(
    request: JsonRpcRequest,
    abortSignal: AbortSignal,
  ): ResolvedToolCall {
    const params = parseRecord(request.params);
    const name = typeof params.name === "string" ? params.name : undefined;
    if (!name) {
      throw new McpJsonRpcError(JSON_RPC_INVALID_PARAMS, "Missing tool name");
    }

    const tool = this.toolByName.get(name);
    if (!tool) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        `Unknown tool: ${name}`,
      );
    }

    const args = parseRecord(params.arguments);
    const schema = z.object(tool.inputSchema);
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        "Invalid tool arguments",
        z.treeifyError(parsed.error),
      );
    }

    logger.info("MCP tool invoked", { tool: tool.name }, { privacySafe: true });
    return {
      tool,
      args: parsed.data,
      progressMeta: parseRecord(params._meta) as ProgressMetadata,
      abortSignal,
    };
  }

  private async executeToolCall({
    tool,
    args,
    progressMeta,
    abortSignal,
  }: ResolvedToolCall): Promise<ToolResult> {
    const rateLimit = await this.options.rateLimiter.check({
      tool,
      sessionId: this.options.sessionId,
      clientHeaders: this.options.clientHeaders,
    });

    if (!rateLimit.allowed) {
      const retryAfterSeconds = Math.max(
        Math.ceil((rateLimit.retryAfterMs ?? 0) / 1000),
        1,
      );

      logger.warn(
        "MCP tool rate limit exceeded",
        { tool: tool.name, scope: rateLimit.scope },
        { privacySafe: true },
      );

      return {
        content: [
          {
            type: "text",
            text: `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
          },
        ],
        isError: true,
      };
    }

    const sendProgress = async (
      progress: number,
      total?: number,
      message?: string,
    ) => {
      const token = progressMeta.progressToken;
      if (token === undefined) return;

      this.sendNotification({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          ...(total !== undefined && { total }),
          ...(message !== undefined && { message }),
        },
      });
    };

    const context: ToolContext = {
      headers: this.options.clientHeaders,
      sendProgress,
      abortSignal,
      clientCapabilities: this.clientCapabilities,
      listRoots: () => this.listRoots(),
      sample: (params) => this.sample(params),
      elicit: (params) => this.elicit(params),
    };

    const startedAt = Date.now();
    try {
      const result = await tool.execute(args, context);
      const normalized = normalizeToolResult(result, this.protocolVersion);
      logger.info(
        "MCP tool completed",
        {
          tool: tool.name,
          durationMs: Date.now() - startedAt,
          isError: Boolean(normalized.isError),
        },
        { privacySafe: true },
      );
      return normalized;
    } catch (err) {
      logger.warn(
        "MCP tool threw",
        {
          tool: tool.name,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        },
        { privacySafe: true },
      );
      throw err;
    }
  }

  private listRoots(): Promise<unknown> {
    if (!hasCapability(this.clientCapabilities, "roots")) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_REQUEST,
        "Client does not support roots",
      );
    }

    return this.sendClientRequest("roots/list", {});
  }

  private sample(params: SamplingRequest): Promise<unknown> {
    if (!hasCapability(this.clientCapabilities, "sampling")) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_REQUEST,
        "Client does not support sampling",
      );
    }

    return this.sendClientRequest("sampling/createMessage", params);
  }

  private elicit(params: ElicitationRequest): Promise<unknown> {
    if (!hasCapability(this.clientCapabilities, "elicitation")) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_REQUEST,
        "Client does not support elicitation",
      );
    }

    return this.sendClientRequest("elicitation/create", params);
  }

  private async getTask(request: JsonRpcRequest): Promise<unknown> {
    const taskId = getStringParam(request.params, "taskId");
    if (!taskId) {
      throw new McpJsonRpcError(JSON_RPC_INVALID_PARAMS, "Missing task ID");
    }

    return this.tasks.get(taskId);
  }

  private async cancelTask(request: JsonRpcRequest): Promise<unknown> {
    const taskId = getStringParam(request.params, "taskId");
    if (!taskId) {
      throw new McpJsonRpcError(JSON_RPC_INVALID_PARAMS, "Missing task ID");
    }

    const task = await this.tasks.cancel(taskId);
    this.sendTaskStatus(task);
    return task;
  }

  private async getTaskResult(request: JsonRpcRequest): Promise<unknown> {
    const taskId = getStringParam(request.params, "taskId");
    if (!taskId) {
      throw new McpJsonRpcError(JSON_RPC_INVALID_PARAMS, "Missing task ID");
    }

    const result = await this.tasks.result(taskId);
    return attachRelatedTask(result, taskId);
  }

  private setLoggingLevel(request: JsonRpcRequest): unknown {
    const level = getStringParam(request.params, "level");
    if (!level || !LOGGING_LEVELS.has(level)) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        "Invalid logging level",
      );
    }

    this.loggingLevel = level;
    return {};
  }

  private cancelRequest(request: JsonRpcRequest): void {
    const params = parseRecord(request.params);
    const requestId = params.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      return;
    }

    const activeRequest = this.activeRequests.get(String(requestId));
    if (!activeRequest) return;

    activeRequest.reason =
      typeof params.reason === "string" ? params.reason : undefined;
    activeRequest.abortController.abort(activeRequest.reason);
  }

  private assertInitialized(method: string): void {
    if (!this.initialized) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_REQUEST,
        `Method requires initialized session: ${method}`,
      );
    }
  }

  private assertTasksSupported(): void {
    if (supportsTasks(this.protocolVersion)) return;

    throw new McpJsonRpcError(
      JSON_RPC_METHOD_NOT_FOUND,
      `Method not found for protocol version: ${this.protocolVersion}`,
    );
  }

  private sendNotification(message: unknown): void {
    if (this.streams.size === 0) return;

    const payload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    for (const stream of this.streams) {
      stream.write(payload);
    }
  }

  private sendClientRequest(method: string, params: unknown): Promise<unknown> {
    if (this.streams.size === 0) {
      throw new McpJsonRpcError(
        JSON_RPC_INVALID_REQUEST,
        "Client request stream is not connected",
      );
    }

    const id = `server-request-${this.nextClientRequestId}`;
    this.nextClientRequestId += 1;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingClientRequests.delete(id);
        reject(
          new McpJsonRpcError(
            JSON_RPC_INTERNAL_ERROR,
            "Client request timed out",
          ),
        );
      }, 60_000);

      this.pendingClientRequests.set(id, { resolve, reject, timeout });
      this.sendNotification({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  private handleClientResponse(id: JsonRpcId, response: JsonRpcResponse): void {
    if (typeof id !== "string") return;

    const pending = this.pendingClientRequests.get(id);
    if (!pending) return;

    this.pendingClientRequests.delete(id);
    clearTimeout(pending.timeout);

    if ("error" in response) {
      pending.reject(
        new McpJsonRpcError(
          response.error.code,
          response.error.message,
          response.error.data,
        ),
      );
      return;
    }

    pending.resolve(response.result);
  }

  private sendTaskStatus(task: unknown): void {
    this.sendNotification({
      jsonrpc: "2.0",
      method: "notifications/tasks/status",
      params: task,
    });
  }

  notifyResourceListChanged(): void {
    this.sendNotification({
      jsonrpc: "2.0",
      method: "notifications/resources/list_changed",
    });
  }

  notifyPromptListChanged(): void {
    this.sendNotification({
      jsonrpc: "2.0",
      method: "notifications/prompts/list_changed",
    });
  }

  notifyToolListChanged(): void {
    this.sendNotification({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
  }

  notifyResourceUpdated(uri: string): void {
    if (!this.subscribedResourceUris.has(uri)) return;

    this.sendNotification({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri },
    });
  }

  private findResourceTemplate(uri: string): ResourceTemplateMatch | undefined {
    for (const template of this.resourceTemplates) {
      const variables = matchUriTemplate(template.uriTemplate, uri);
      if (variables) {
        return { template, variables };
      }
    }

    return undefined;
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function getStringParam(params: unknown, key: string): string | undefined {
  const value = parseRecord(params)[key];
  return typeof value === "string" ? value : undefined;
}

function hasCapability(
  capabilities: Record<string, unknown>,
  capability: string,
): boolean {
  const value = capabilities[capability];
  return value !== null && typeof value === "object";
}

const PAGE_SIZE = 50;

function paginate<T>(
  items: T[],
  cursor: string | undefined,
): { items: T[]; nextCursor?: string } {
  const offset = cursor ? decodeCursor(cursor) : 0;
  const pageItems = items.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + pageItems.length;

  return {
    items: pageItems,
    ...(nextOffset < items.length && { nextCursor: encodeCursor(nextOffset) }),
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { offset?: unknown };

    if (
      typeof parsed.offset === "number" &&
      Number.isSafeInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return parsed.offset;
    }
  } catch {}

  throw new McpJsonRpcError(JSON_RPC_INVALID_PARAMS, "Invalid cursor");
}

function matchUriTemplate(
  uriTemplate: string,
  uri: string,
): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = uriTemplate.replace(
    /\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => {
      names.push(name);
      return "([^/]+)";
    },
  );

  const match = new RegExp(`^${pattern}$`).exec(uri);
  if (!match) return undefined;

  return Object.fromEntries(
    names.map((name, index) => [
      name,
      decodeURIComponent(match[index + 1] ?? ""),
    ]),
  );
}

function attachRelatedTask(result: unknown, taskId: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  const record = result as Record<string, unknown>;
  const meta =
    record._meta &&
    typeof record._meta === "object" &&
    !Array.isArray(record._meta)
      ? (record._meta as Record<string, unknown>)
      : {};

  return {
    ...record,
    _meta: {
      ...meta,
      "io.modelcontextprotocol/related-task": {
        taskId,
      },
    },
  };
}

function normalizeToolResult(
  result: ToolResult,
  protocolVersion: McpProtocolVersion,
): ToolResult {
  if (supportsStructuredToolOutput(protocolVersion)) return result;

  const content = result.content.flatMap((item) => {
    if (item.type === "text") return [item];
    if (item.type === "resource_link") {
      return [
        {
          type: "text" as const,
          text: `${item.name}: ${item.uri}`,
          ...(item.annotations && { annotations: item.annotations }),
          ...(item._meta && { _meta: item._meta }),
        },
      ];
    }

    return [
      {
        type: "text" as const,
        text: `[${item.type} content omitted for protocol ${protocolVersion}]`,
        ...(item.annotations && { annotations: item.annotations }),
        ...(item._meta && { _meta: item._meta }),
      },
    ];
  });

  const { structuredContent: _structuredContent, ...rest } = result;
  return {
    ...rest,
    content,
  };
}
