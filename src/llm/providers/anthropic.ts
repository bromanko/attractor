/**
 * Anthropic Provider Adapter — implements ProviderAdapter for the
 * Anthropic Messages API (https://docs.anthropic.com/en/api/messages).
 *
 * Uses Node's built-in fetch — no external dependencies.
 */

import type {
  ProviderAdapter,
  Request,
  Response,
  StreamEvent,
  Message,
  ContentPart,
  Usage,
  FinishReason,
  ToolDefinition,
} from "../types.js";
import { errorFromStatusCode } from "../errors.js";
import {
  AuthenticationError,
  ConfigurationError,
  NetworkError,
} from "../types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type AnthropicConfig = {
  /** API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Base URL. Falls back to ANTHROPIC_BASE_URL or default. */
  baseUrl?: string;
  /** API version header. */
  apiVersion?: string;
  /** Default max_tokens when not specified in request. */
  defaultMaxTokens?: number;
};

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Anthropic API types (subset we need)
// ---------------------------------------------------------------------------

type AnthropicRole = "user" | "assistant";

type AnthropicTextBlock = {
  type: "text";
  text: string;
};

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
};

type AnthropicThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

type AnthropicRedactedThinkingBlock = {
  type: "redacted_thinking";
  data: string;
};

type AnthropicImageBlock = {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicImageBlock;

type AnthropicMessage = {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
};

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

type AnthropicRequest = {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  metadata?: Record<string, string>;
  thinking?: { type: "enabled"; budget_tokens: number };
};

type AnthropicResponse = {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

type AnthropicErrorResponse = {
  type: "error";
  error: {
    type: string;
    message: string;
  };
};

// ---------------------------------------------------------------------------
// Stream event types
// ---------------------------------------------------------------------------

type AnthropicStreamEvent =
  | { type: "message_start"; message: AnthropicResponse }
  | { type: "content_block_start"; index: number; content_block: AnthropicContentBlock }
  | { type: "content_block_delta"; index: number; delta: AnthropicStreamDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null; stop_sequence?: string }; usage: { output_tokens: number } }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

type AnthropicStreamDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string };

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function convertMessagesToAnthropic(messages: Message[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  let system: string | undefined;
  const converted: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      // Anthropic uses a top-level system param; concatenate if multiple.
      const text = msg.content
        .filter((p) => p.kind === "text" && p.text)
        .map((p) => p.text!)
        .join("\n");
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = convertPartsToAnthropic(msg.content);
      converted.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "tool") {
      // Tool results get merged into the preceding user turn or create one.
      const blocks = convertPartsToAnthropic(msg.content);
      // Anthropic requires tool_result in a user message.
      const last = converted[converted.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as AnthropicContentBlock[]).push(...blocks);
      } else {
        converted.push({ role: "user", content: blocks });
      }
      continue;
    }

    // user role
    const blocks = convertPartsToAnthropic(msg.content);
    // Merge consecutive user messages (Anthropic doesn't allow them).
    const last = converted[converted.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content)) {
      (last.content as AnthropicContentBlock[]).push(...blocks);
    } else {
      converted.push({ role: "user", content: blocks });
    }
  }

  return { system, messages: converted };
}

function convertPartsToAnthropic(parts: ContentPart[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  for (const part of parts) {
    switch (part.kind) {
      case "text":
        if (part.text) blocks.push({ type: "text", text: part.text });
        break;

      case "tool_call":
        if (part.tool_call) {
          blocks.push({
            type: "tool_use",
            id: part.tool_call.id,
            name: part.tool_call.name,
            input:
              typeof part.tool_call.arguments === "string"
                ? JSON.parse(part.tool_call.arguments)
                : part.tool_call.arguments,
          });
        }
        break;

      case "tool_result":
        if (part.tool_result) {
          const content =
            typeof part.tool_result.content === "string"
              ? part.tool_result.content
              : JSON.stringify(part.tool_result.content);
          blocks.push({
            type: "tool_result",
            tool_use_id: part.tool_result.tool_call_id,
            content,
            is_error: part.tool_result.is_error || undefined,
          });
        }
        break;

      case "thinking":
        if (part.thinking) {
          if (part.thinking.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: part.thinking.signature ?? "",
            });
          } else {
            blocks.push({
              type: "thinking",
              thinking: part.thinking.text,
              signature: part.thinking.signature,
            });
          }
        }
        break;

      case "image":
        if (part.image) {
          if (part.image.data) {
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: part.image.media_type ?? "image/png",
                data: Buffer.from(part.image.data).toString("base64"),
              },
            });
          } else if (part.image.url) {
            blocks.push({
              type: "image",
              source: { type: "url", url: part.image.url },
            });
          }
        }
        break;
    }
  }

  return blocks;
}

function convertToolDefs(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function convertToolChoice(
  choice: Request["tool_choice"],
): AnthropicToolChoice | undefined {
  if (!choice) return undefined;
  switch (choice.mode) {
    case "auto":
      return { type: "auto" };
    case "none":
      return { type: "none" };
    case "required":
      return { type: "any" };
    case "named":
      return choice.tool_name
        ? { type: "tool", name: choice.tool_name }
        : { type: "auto" };
    default:
      return undefined;
  }
}

function mapStopReason(
  stopReason: AnthropicResponse["stop_reason"],
): FinishReason {
  switch (stopReason) {
    case "end_turn":
      return { reason: "stop", raw: "end_turn" };
    case "max_tokens":
      return { reason: "length", raw: "max_tokens" };
    case "stop_sequence":
      return { reason: "stop", raw: "stop_sequence" };
    case "tool_use":
      return { reason: "tool_calls", raw: "tool_use" };
    default:
      return { reason: "other", raw: String(stopReason) };
  }
}

function convertAnthropicContent(
  blocks: AnthropicContentBlock[],
): ContentPart[] {
  return blocks.map((block): ContentPart => {
    switch (block.type) {
      case "text":
        return { kind: "text", text: block.text };
      case "tool_use":
        return {
          kind: "tool_call",
          tool_call: {
            id: block.id,
            name: block.name,
            arguments: block.input,
          },
        };
      case "thinking":
        return {
          kind: "thinking",
          thinking: {
            text: block.thinking,
            signature: block.signature,
            redacted: false,
          },
        };
      case "redacted_thinking":
        return {
          kind: "redacted_thinking",
          thinking: { text: "", signature: block.data, redacted: true },
        };
      default:
        return { kind: "text", text: "" };
    }
  });
}

function convertAnthropicUsage(
  usage: AnthropicResponse["usage"],
): Usage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens,
    cache_read_tokens: usage.cache_read_input_tokens,
    cache_write_tokens: usage.cache_creation_input_tokens,
  };
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";
  private _apiKey: string;
  private _baseUrl: string;
  private _apiVersion: string;
  private _defaultMaxTokens: number;

  constructor(config: AnthropicConfig = {}) {
    const apiKey =
      config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ConfigurationError(
        "Anthropic API key not provided. Set ANTHROPIC_API_KEY or pass apiKey in config.",
      );
    }
    this._apiKey = apiKey;
    this._baseUrl =
      config.baseUrl ??
      process.env.ANTHROPIC_BASE_URL ??
      DEFAULT_BASE_URL;
    this._apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this._defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(request: Request): Promise<Response> {
    const body = this.buildRequestBody(request);
    const raw = await this.post("/v1/messages", body);
    return this.convertResponse(raw);
  }

  async *stream(request: Request): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(request);
    body.stream = true;

    const res = await this.fetchRaw("/v1/messages", body);

    if (!res.ok) {
      const text = await res.text();
      throw errorFromStatusCode(res.status, text, "anthropic");
    }

    if (!res.body) {
      throw new NetworkError("No response body for streaming request");
    }

    let messageId = "";
    let model = request.model;
    let currentToolCall: { id: string; name: string; jsonChunks: string[] } | null = null;
    let totalUsage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (!data || data === "[DONE]") continue;

            let event: AnthropicStreamEvent;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }

            for (const streamEvent of this.processStreamEvent(
              event,
              { messageId, model, currentToolCall, totalUsage },
            )) {
              // Update state from returned events
              if (streamEvent.type === "stream_start" && streamEvent.response) {
                messageId = streamEvent.response.id;
                model = streamEvent.response.model;
              }
              if (streamEvent.usage) {
                totalUsage = streamEvent.usage;
              }
              if (streamEvent.type === "tool_call_start" && streamEvent.tool_call) {
                currentToolCall = {
                  id: streamEvent.tool_call.id,
                  name: streamEvent.tool_call.name,
                  jsonChunks: [],
                };
              }
              if (streamEvent.type === "tool_call_delta" && currentToolCall) {
                if (streamEvent.delta) {
                  currentToolCall.jsonChunks.push(streamEvent.delta);
                }
              }
              if (streamEvent.type === "tool_call_end") {
                currentToolCall = null;
              }
              yield streamEvent;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private buildRequestBody(request: Request): AnthropicRequest & { stream?: boolean } {
    const { system, messages } = convertMessagesToAnthropic(request.messages);

    const body: AnthropicRequest & { stream?: boolean } = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens ?? this._defaultMaxTokens,
    };

    if (system) body.system = system;

    if (request.tools && request.tools.length > 0) {
      body.tools = convertToolDefs(request.tools);
      const tc = convertToolChoice(request.tool_choice);
      if (tc) body.tool_choice = tc;
    }

    if (request.temperature != null) body.temperature = request.temperature;
    if (request.top_p != null) body.top_p = request.top_p;
    if (request.stop_sequences) body.stop_sequences = request.stop_sequences;
    if (request.metadata) body.metadata = request.metadata;

    // Extended thinking
    if (
      request.reasoning_effort &&
      request.reasoning_effort !== "none"
    ) {
      const budgetMap: Record<string, number> = {
        low: 2048,
        medium: 8192,
        high: 32768,
      };
      const parsed = parseInt(request.reasoning_effort, 10);
      const budget =
        budgetMap[request.reasoning_effort] ??
        (Number.isNaN(parsed) ? 8192 : parsed);
      body.thinking = { type: "enabled", budget_tokens: budget };
      // Anthropic requires max_tokens to be larger when thinking is on
      if (body.max_tokens < budget + 1024) {
        body.max_tokens = budget + 4096;
      }
    }

    // Forward provider-specific options
    if (request.provider_options?.anthropic) {
      Object.assign(body, request.provider_options.anthropic);
    }

    return body;
  }

  private async fetchRaw(
    path: string,
    body: unknown,
  ): Promise<globalThis.Response> {
    const url = `${this._baseUrl}${path}`;

    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this._apiKey,
          "anthropic-version": this._apiVersion,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (err instanceof TypeError && String(err).includes("fetch")) {
        throw new NetworkError(`Network error calling Anthropic: ${err}`);
      }
      throw err;
    }
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<AnthropicResponse> {
    const res = await this.fetchRaw(path, body);

    const text = await res.text();
    let parsed: AnthropicResponse | AnthropicErrorResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw errorFromStatusCode(
        res.status,
        `Invalid JSON from Anthropic: ${text.slice(0, 200)}`,
        "anthropic",
      );
    }

    if (!res.ok || (parsed as AnthropicErrorResponse).type === "error") {
      const errorBody = parsed as AnthropicErrorResponse;
      const message = errorBody.error?.message ?? text.slice(0, 500);
      throw errorFromStatusCode(res.status, message, "anthropic", {
        errorCode: errorBody.error?.type,
        raw: parsed as Record<string, unknown>,
      });
    }

    return parsed as AnthropicResponse;
  }

  private convertResponse(raw: AnthropicResponse): Response {
    return {
      id: raw.id,
      model: raw.model,
      provider: "anthropic",
      message: {
        role: "assistant",
        content: convertAnthropicContent(raw.content),
      },
      finish_reason: mapStopReason(raw.stop_reason),
      usage: convertAnthropicUsage(raw.usage),
      raw: raw as unknown as Record<string, unknown>,
    };
  }

  private *processStreamEvent(
    event: AnthropicStreamEvent,
    state: {
      messageId: string;
      model: string;
      currentToolCall: { id: string; name: string; jsonChunks: string[] } | null;
      totalUsage: Usage;
    },
  ): Generator<StreamEvent> {
    switch (event.type) {
      case "message_start": {
        const usage = convertAnthropicUsage(event.message.usage);
        yield {
          type: "stream_start",
          usage,
          response: {
            id: event.message.id,
            model: event.message.model,
            provider: "anthropic",
            message: { role: "assistant", content: [] },
            finish_reason: { reason: "other" },
            usage,
          },
        };
        break;
      }

      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "text") {
          yield { type: "text_start", text_id: String(event.index) };
        } else if (block.type === "thinking") {
          yield { type: "reasoning_start" };
        } else if (block.type === "tool_use") {
          yield {
            type: "tool_call_start",
            tool_call: {
              id: block.id,
              name: block.name,
              arguments: {},
            },
          };
        }
        break;
      }

      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          yield {
            type: "text_delta",
            delta: delta.text,
            text_id: String(event.index),
          };
        } else if (delta.type === "thinking_delta") {
          yield {
            type: "reasoning_delta",
            reasoning_delta: delta.thinking,
          };
        } else if (delta.type === "input_json_delta") {
          yield {
            type: "tool_call_delta",
            delta: delta.partial_json,
          };
        }
        break;
      }

      case "content_block_stop": {
        // We need to figure out what kind of block just ended.
        // Since we track tool calls in state, check if there's one active.
        if (state.currentToolCall) {
          try {
            const fullJson = state.currentToolCall.jsonChunks.join("");
            const args = fullJson ? JSON.parse(fullJson) : {};
            yield {
              type: "tool_call_end",
              tool_call: {
                id: state.currentToolCall.id,
                name: state.currentToolCall.name,
                arguments: args,
              },
            };
          } catch {
            yield {
              type: "tool_call_end",
              tool_call: {
                id: state.currentToolCall.id,
                name: state.currentToolCall.name,
                arguments: state.currentToolCall.jsonChunks.join(""),
              },
            };
          }
        } else {
          // Could be text_end or reasoning_end — we emit text_end as the
          // common case; reasoning blocks are less frequent.
          yield { type: "text_end", text_id: String(event.index) };
        }
        break;
      }

      case "message_delta": {
        const finishReason = mapStopReason(
          event.delta.stop_reason as AnthropicResponse["stop_reason"],
        );
        const usage: Usage = {
          input_tokens: state.totalUsage.input_tokens,
          output_tokens: event.usage.output_tokens,
          total_tokens:
            state.totalUsage.input_tokens + event.usage.output_tokens,
        };
        yield { type: "finish", finish_reason: finishReason, usage };
        break;
      }

      case "error": {
        yield {
          type: "error",
          error: errorFromStatusCode(
            500,
            event.error.message,
            "anthropic",
            { errorCode: event.error.type },
          ),
        };
        break;
      }

      // ping, message_stop — no events needed
    }
  }
}
