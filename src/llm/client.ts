/**
 * Core Client — Section 2 of the Unified LLM Client Spec.
 * Routes requests to provider adapters, applies middleware.
 */

import type {
  ProviderAdapter,
  Request,
  Response,
  StreamEvent,
  ToolDefinition,
  ToolChoice,
  Usage,
  ToolResult,
  ToolCallData,
} from "./types.js";
import { ConfigurationError, SDKError, addUsage, emptyUsage, Msg, messageText } from "./types.js";
import { retry } from "./retry.js";
import type { RetryPolicy } from "./types.js";

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export type Middleware = (
  request: Request,
  next: (request: Request) => Promise<Response>,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type ClientConfig = {
  providers: Record<string, ProviderAdapter>;
  default_provider?: string;
  middleware?: Middleware[];
};

export class Client {
  private _providers: Record<string, ProviderAdapter>;
  private _defaultProvider?: string;
  private _middleware: Middleware[];

  constructor(config: ClientConfig) {
    this._providers = config.providers;
    this._defaultProvider = config.default_provider ?? Object.keys(config.providers)[0];
    this._middleware = config.middleware ?? [];
  }

  /**
   * Create a client from environment variables (Section 2.2).
   * Only providers whose API keys are present are registered.
   */
  static fromEnv(adapters?: Record<string, ProviderAdapter>): Client {
    const providers: Record<string, ProviderAdapter> = {};
    if (adapters) {
      Object.assign(providers, adapters);
    }
    return new Client({ providers });
  }

  private resolveProvider(request: Request): ProviderAdapter {
    const providerName = request.provider ?? this._defaultProvider;
    if (!providerName) {
      throw new ConfigurationError(
        "No provider specified and no default provider configured.",
      );
    }
    const adapter = this._providers[providerName];
    if (!adapter) {
      throw new ConfigurationError(
        `Provider "${providerName}" is not registered. Available: ${Object.keys(this._providers).join(", ")}`,
      );
    }
    return adapter;
  }

  /**
   * Send a request and block until the model finishes (Section 4.1).
   * Does NOT retry automatically — use generate() for retries.
   */
  async complete(request: Request): Promise<Response> {
    const adapter = this.resolveProvider(request);

    // Build middleware chain
    const handler = async (req: Request): Promise<Response> => adapter.complete(req);
    let chain = handler;
    for (let i = this._middleware.length - 1; i >= 0; i--) {
      const mw = this._middleware[i];
      const next = chain;
      chain = (req) => mw(req, next);
    }

    return chain(request);
  }

  /**
   * Streaming call (Section 4.2). Returns an async iterable.
   */
  async *stream(request: Request): AsyncIterable<StreamEvent> {
    const adapter = this.resolveProvider(request);
    yield* adapter.stream(request);
  }

  async close(): Promise<void> {
    for (const adapter of Object.values(this._providers)) {
      await adapter.close?.();
    }
  }
}

// ---------------------------------------------------------------------------
// High-level API: generate() — Section 4.3
// ---------------------------------------------------------------------------

export type StepResult = {
  text: string;
  reasoning?: string;
  tool_calls: ToolCallData[];
  tool_results: ToolResult[];
  finish_reason: Response["finish_reason"];
  usage: Usage;
  response: Response;
};

export type GenerateResult = {
  text: string;
  reasoning?: string;
  tool_calls: ToolCallData[];
  tool_results: ToolResult[];
  finish_reason: Response["finish_reason"];
  usage: Usage;
  total_usage: Usage;
  steps: StepResult[];
  response: Response;
};

export type GenerateOptions = {
  model: string;
  prompt?: string;
  messages?: Request["messages"];
  system?: string;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  max_tool_rounds?: number;
  response_format?: Request["response_format"];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop_sequences?: string[];
  reasoning_effort?: string;
  provider?: string;
  provider_options?: Record<string, Record<string, unknown>>;
  max_retries?: number;
  client?: Client;
};

/**
 * High-level blocking generation with automatic tool execution loop.
 * Section 4.3.
 */
export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const client = opts.client;
  if (!client) {
    throw new ConfigurationError("A client must be provided to generate().");
  }

  // Build initial messages
  const messages: Request["messages"] = [];
  if (opts.system) {
    messages.push(Msg.system(opts.system));
  }
  if (opts.messages) {
    messages.push(...opts.messages);
  } else if (opts.prompt) {
    messages.push(Msg.user(opts.prompt));
  }

  const maxToolRounds = opts.max_tool_rounds ?? 1;
  const steps: StepResult[] = [];
  let totalUsage = emptyUsage();

  const retryPolicy: RetryPolicy = {
    max_retries: opts.max_retries ?? 2,
    base_delay: 1.0,
    max_delay: 60.0,
    backoff_multiplier: 2.0,
    jitter: true,
  };

  // Build tool definitions (without execute handlers for the request)
  const toolDefs = opts.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const toolMap = new Map(opts.tools?.map((t) => [t.name, t]) ?? []);

  for (let round = 0; round <= maxToolRounds; round++) {
    const request: Request = {
      model: opts.model,
      messages: [...messages],
      provider: opts.provider,
      tools: toolDefs,
      tool_choice: opts.tool_choice,
      response_format: opts.response_format,
      temperature: opts.temperature,
      top_p: opts.top_p,
      max_tokens: opts.max_tokens,
      stop_sequences: opts.stop_sequences,
      reasoning_effort: opts.reasoning_effort,
      provider_options: opts.provider_options,
    };

    // Retry individual LLM calls
    const response = await retry(() => client.complete(request), retryPolicy);

    // Extract tool calls
    const toolCalls = response.message.content
      .filter((p) => p.kind === "tool_call" && p.tool_call)
      .map((p) => p.tool_call!);

    // Execute active tools
    let toolResults: ToolResult[] = [];
    if (toolCalls.length > 0 && response.finish_reason.reason === "tool_calls") {
      const results = await Promise.all(
        toolCalls.map(async (tc) => {
          const tool = toolMap.get(tc.name);
          if (!tool?.execute) {
            return { tool_call_id: tc.id, content: `Unknown tool: ${tc.name}`, is_error: true };
          }
          try {
            const args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments;
            const output = await tool.execute(args);
            return { tool_call_id: tc.id, content: typeof output === "string" ? output : JSON.stringify(output), is_error: false };
          } catch (err) {
            return { tool_call_id: tc.id, content: `Tool error: ${err}`, is_error: true };
          }
        }),
      );
      toolResults = results;
    }

    const step: StepResult = {
      text: messageText(response.message),
      reasoning: response.message.content
        .filter((p) => p.kind === "thinking" && p.thinking)
        .map((p) => p.thinking!.text)
        .join("") || undefined,
      tool_calls: toolCalls,
      tool_results: toolResults,
      finish_reason: response.finish_reason,
      usage: response.usage,
      response,
    };

    steps.push(step);
    totalUsage = addUsage(totalUsage, response.usage);

    // If no tool calls or not tool_calls finish reason, we're done
    if (toolCalls.length === 0 || response.finish_reason.reason !== "tool_calls") {
      break;
    }

    // If we've hit the round limit, stop
    if (round >= maxToolRounds) break;

    // If tools have no execute handlers (passive), stop
    if (toolResults.length === 0) break;

    // Append assistant message with tool calls and tool results
    messages.push(response.message);
    for (const result of toolResults) {
      messages.push(Msg.toolResult(result.tool_call_id, typeof result.content === "string" ? result.content : JSON.stringify(result.content), result.is_error));
    }
  }

  const lastStep = steps[steps.length - 1];
  return {
    text: lastStep.text,
    reasoning: lastStep.reasoning,
    tool_calls: lastStep.tool_calls,
    tool_results: lastStep.tool_results,
    finish_reason: lastStep.finish_reason,
    usage: lastStep.usage,
    total_usage: totalUsage,
    steps,
    response: lastStep.response,
  };
}
