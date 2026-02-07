/**
 * Unified LLM Client — public API.
 */

// Types
export type {
  Role, ContentKind, ContentPart, Message, ImageData, AudioData, DocumentData,
  ToolCallData, ToolResultData, ThinkingData, FinishReason, Usage, Warning,
  RateLimitInfo, Request, Response, ResponseFormat, StreamEventType, StreamEvent,
  ToolDefinition, ToolChoice, ToolCall, ToolResult, RetryPolicy, ProviderAdapter,
  ModelInfo,
} from "./types.js";

export {
  Msg, messageText, addUsage, emptyUsage, responseText, responseToolCalls, responseReasoning,
  SDKError, ProviderError, AuthenticationError, AccessDeniedError, NotFoundError,
  InvalidRequestError, RateLimitError, ServerError, ContextLengthError, ContentFilterError,
  RequestTimeoutError, AbortError, NetworkError, ConfigurationError,
  DEFAULT_RETRY_POLICY,
} from "./types.js";

// Client
export { Client, generate } from "./client.js";
export type { ClientConfig, Middleware, GenerateOptions, GenerateResult, StepResult } from "./client.js";

// Errors
export { errorFromStatusCode } from "./errors.js";

// Retry
export { retry } from "./retry.js";

// Catalog
export { MODEL_CATALOG, getModelInfo, listModels, getLatestModel } from "./catalog.js";

// Providers
export { AnthropicAdapter } from "./providers/index.js";
export type { AnthropicConfig } from "./providers/index.js";
