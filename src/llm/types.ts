/**
 * Unified LLM Client — Core type definitions.
 * Implements Section 3 of the Unified LLM Client Specification.
 */

// ---------------------------------------------------------------------------
// 3.2 Role
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool" | "developer";

// ---------------------------------------------------------------------------
// 3.4 ContentKind
// ---------------------------------------------------------------------------

export type ContentKind =
  | "text"
  | "image"
  | "audio"
  | "document"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "redacted_thinking";

// ---------------------------------------------------------------------------
// 3.5 Content data structures
// ---------------------------------------------------------------------------

export type ImageData = {
  url?: string;
  data?: Uint8Array;
  media_type?: string;
  detail?: "auto" | "low" | "high";
};

export type AudioData = {
  url?: string;
  data?: Uint8Array;
  media_type?: string;
};

export type DocumentData = {
  url?: string;
  data?: Uint8Array;
  media_type?: string;
  file_name?: string;
};

export type ToolCallData = {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  type?: string;
};

export type ToolResultData = {
  tool_call_id: string;
  content: string | Record<string, unknown>;
  is_error: boolean;
  image_data?: Uint8Array;
  image_media_type?: string;
};

export type ThinkingData = {
  text: string;
  signature?: string;
  redacted: boolean;
};

// ---------------------------------------------------------------------------
// 3.3 ContentPart (tagged union)
// ---------------------------------------------------------------------------

export type ContentPart = {
  kind: ContentKind | string;
  text?: string;
  image?: ImageData;
  audio?: AudioData;
  document?: DocumentData;
  tool_call?: ToolCallData;
  tool_result?: ToolResultData;
  thinking?: ThinkingData;
};

// ---------------------------------------------------------------------------
// 3.1 Message
// ---------------------------------------------------------------------------

export type Message = {
  role: Role;
  content: ContentPart[];
  name?: string;
  tool_call_id?: string;
};

/** Convenience constructors */
export const Msg = {
  system(text: string): Message {
    return { role: "system", content: [{ kind: "text", text }] };
  },
  user(text: string): Message {
    return { role: "user", content: [{ kind: "text", text }] };
  },
  assistant(text: string): Message {
    return { role: "assistant", content: [{ kind: "text", text }] };
  },
  toolResult(toolCallId: string, content: string, isError = false): Message {
    return {
      role: "tool",
      content: [{ kind: "tool_result", tool_result: { tool_call_id: toolCallId, content, is_error: isError } }],
      tool_call_id: toolCallId,
    };
  },
};

/** Get concatenated text from all text parts. */
export function messageText(msg: Message): string {
  return msg.content.filter((p) => p.kind === "text" && p.text).map((p) => p.text!).join("");
}

// ---------------------------------------------------------------------------
// 3.8 FinishReason
// ---------------------------------------------------------------------------

export type FinishReason = {
  reason: "stop" | "length" | "tool_calls" | "content_filter" | "error" | "other";
  raw?: string;
};

// ---------------------------------------------------------------------------
// 3.9 Usage
// ---------------------------------------------------------------------------

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  raw?: Record<string, unknown>;
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    reasoning_tokens:
      a.reasoning_tokens != null || b.reasoning_tokens != null
        ? (a.reasoning_tokens ?? 0) + (b.reasoning_tokens ?? 0)
        : undefined,
    cache_read_tokens:
      a.cache_read_tokens != null || b.cache_read_tokens != null
        ? (a.cache_read_tokens ?? 0) + (b.cache_read_tokens ?? 0)
        : undefined,
    cache_write_tokens:
      a.cache_write_tokens != null || b.cache_write_tokens != null
        ? (a.cache_write_tokens ?? 0) + (b.cache_write_tokens ?? 0)
        : undefined,
  };
}

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

// ---------------------------------------------------------------------------
// 3.10 ResponseFormat
// ---------------------------------------------------------------------------

export type ResponseFormat = {
  type: "text" | "json" | "json_schema";
  json_schema?: Record<string, unknown>;
  strict?: boolean;
};

// ---------------------------------------------------------------------------
// 3.11 Warning, 3.12 RateLimitInfo
// ---------------------------------------------------------------------------

export type Warning = { message: string; code?: string };

export type RateLimitInfo = {
  requests_remaining?: number;
  requests_limit?: number;
  tokens_remaining?: number;
  tokens_limit?: number;
  reset_at?: string;
};

// ---------------------------------------------------------------------------
// 3.6 Request
// ---------------------------------------------------------------------------

export type Request = {
  model: string;
  messages: Message[];
  provider?: string;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop_sequences?: string[];
  reasoning_effort?: "none" | "low" | "medium" | "high" | string;
  metadata?: Record<string, string>;
  provider_options?: Record<string, Record<string, unknown>>;
};

// ---------------------------------------------------------------------------
// 3.7 Response
// ---------------------------------------------------------------------------

export type Response = {
  id: string;
  model: string;
  provider: string;
  message: Message;
  finish_reason: FinishReason;
  usage: Usage;
  raw?: Record<string, unknown>;
  warnings?: Warning[];
  rate_limit?: RateLimitInfo;
};

/** Convenience accessors. */
export function responseText(res: Response): string {
  return messageText(res.message);
}

export function responseToolCalls(res: Response): ToolCallData[] {
  return res.message.content.filter((p) => p.kind === "tool_call" && p.tool_call).map((p) => p.tool_call!);
}

export function responseReasoning(res: Response): string | undefined {
  const parts = res.message.content.filter((p) => p.kind === "thinking" && p.thinking);
  return parts.length > 0 ? parts.map((p) => p.thinking!.text).join("") : undefined;
}

// ---------------------------------------------------------------------------
// 3.13-3.14 StreamEvent
// ---------------------------------------------------------------------------

export type StreamEventType =
  | "stream_start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool_call_start"
  | "tool_call_delta"
  | "tool_call_end"
  | "finish"
  | "error"
  | "provider_event";

export type StreamEvent = {
  type: StreamEventType | string;
  delta?: string;
  text_id?: string;
  reasoning_delta?: string;
  tool_call?: ToolCallData;
  finish_reason?: FinishReason;
  usage?: Usage;
  response?: Response;
  error?: SDKError;
  raw?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// 5.1 Tool Definition, 5.3 ToolChoice, 5.4 ToolCall/ToolResult
// ---------------------------------------------------------------------------

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute?: (args: Record<string, unknown>) => Promise<string | Record<string, unknown>>;
};

export type ToolChoice = {
  mode: "auto" | "none" | "required" | "named";
  tool_name?: string;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw_arguments?: string;
};

export type ToolResult = {
  tool_call_id: string;
  content: string | Record<string, unknown>;
  is_error: boolean;
};

// ---------------------------------------------------------------------------
// 6.1 Error hierarchy
// ---------------------------------------------------------------------------

export class SDKError extends Error {
  cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "SDKError";
    this.cause = cause;
  }
}

export class ProviderError extends SDKError {
  provider: string;
  status_code?: number;
  error_code?: string;
  retryable: boolean;
  retry_after?: number;
  raw?: Record<string, unknown>;

  constructor(
    message: string,
    opts: {
      provider: string;
      status_code?: number;
      error_code?: string;
      retryable: boolean;
      retry_after?: number;
      raw?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = opts.provider;
    this.status_code = opts.status_code;
    this.error_code = opts.error_code;
    this.retryable = opts.retryable;
    this.retry_after = opts.retry_after;
    this.raw = opts.raw;
  }
}

export class AuthenticationError extends ProviderError {
  constructor(msg: string, provider: string) {
    super(msg, { provider, status_code: 401, retryable: false });
    this.name = "AuthenticationError";
  }
}
export class AccessDeniedError extends ProviderError {
  constructor(msg: string, provider: string) {
    super(msg, { provider, status_code: 403, retryable: false });
    this.name = "AccessDeniedError";
  }
}
export class NotFoundError extends ProviderError {
  constructor(msg: string, provider: string) {
    super(msg, { provider, status_code: 404, retryable: false });
    this.name = "NotFoundError";
  }
}
export class InvalidRequestError extends ProviderError {
  constructor(msg: string, provider: string, statusCode = 400) {
    super(msg, { provider, status_code: statusCode, retryable: false });
    this.name = "InvalidRequestError";
  }
}
export class RateLimitError extends ProviderError {
  constructor(msg: string, provider: string, retryAfter?: number) {
    super(msg, { provider, status_code: 429, retryable: true, retry_after: retryAfter });
    this.name = "RateLimitError";
  }
}
export class ServerError extends ProviderError {
  constructor(msg: string, provider: string, statusCode = 500) {
    super(msg, { provider, status_code: statusCode, retryable: true });
    this.name = "ServerError";
  }
}
export class ContextLengthError extends ProviderError {
  constructor(msg: string, provider: string) {
    super(msg, { provider, status_code: 413, retryable: false });
    this.name = "ContextLengthError";
  }
}
export class ContentFilterError extends ProviderError {
  constructor(msg: string, provider: string) {
    super(msg, { provider, retryable: false });
    this.name = "ContentFilterError";
  }
}
export class RequestTimeoutError extends SDKError {
  constructor(msg: string) { super(msg); this.name = "RequestTimeoutError"; }
}
export class AbortError extends SDKError {
  constructor(msg: string) { super(msg); this.name = "AbortError"; }
}
export class NetworkError extends SDKError {
  constructor(msg: string) { super(msg); this.name = "NetworkError"; }
}
export class ConfigurationError extends SDKError {
  constructor(msg: string) { super(msg); this.name = "ConfigurationError"; }
}

// ---------------------------------------------------------------------------
// 6.6 Retry policy
// ---------------------------------------------------------------------------

export type RetryPolicy = {
  max_retries: number;
  base_delay: number;
  max_delay: number;
  backoff_multiplier: number;
  jitter: boolean;
  on_retry?: (error: SDKError, attempt: number, delay: number) => void;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_retries: 2,
  base_delay: 1.0,
  max_delay: 60.0,
  backoff_multiplier: 2.0,
  jitter: true,
};

// ---------------------------------------------------------------------------
// 2.4 ProviderAdapter interface
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  readonly name: string;
  complete(request: Request): Promise<Response>;
  stream(request: Request): AsyncIterable<StreamEvent>;
  close?(): Promise<void>;
  initialize?(): Promise<void>;
  supports_tool_choice?(mode: string): boolean;
}

// ---------------------------------------------------------------------------
// 2.9 Model catalog types
// ---------------------------------------------------------------------------

export type ModelInfo = {
  id: string;
  provider: string;
  display_name: string;
  context_window: number;
  max_output?: number;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_reasoning: boolean;
  input_cost_per_million?: number;
  output_cost_per_million?: number;
  aliases?: string[];
};
