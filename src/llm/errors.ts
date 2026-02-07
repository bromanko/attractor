/**
 * Error handling utilities — Section 6 of the Unified LLM Client Spec.
 */

import {
  ProviderError,
  AuthenticationError,
  AccessDeniedError,
  NotFoundError,
  InvalidRequestError,
  RateLimitError,
  ServerError,
  ContextLengthError,
  ContentFilterError,
} from "./types.js";

/**
 * Map an HTTP status code to the appropriate error class.
 * Section 6.4.
 */
export function errorFromStatusCode(
  statusCode: number,
  message: string,
  provider: string,
  opts?: { errorCode?: string; raw?: Record<string, unknown>; retryAfter?: number },
): ProviderError {
  switch (statusCode) {
    case 400:
    case 422:
      return new InvalidRequestError(message, provider, statusCode);
    case 401:
      return new AuthenticationError(message, provider);
    case 403:
      return new AccessDeniedError(message, provider);
    case 404:
      return new NotFoundError(message, provider);
    case 413:
      return new ContextLengthError(message, provider);
    case 429:
      return new RateLimitError(message, provider, opts?.retryAfter);
    case 500:
    case 502:
    case 503:
    case 504:
      return new ServerError(message, provider, statusCode);
    default: {
      // Classify by message content (Section 6.5)
      const lower = message.toLowerCase();
      if (lower.includes("not found") || lower.includes("does not exist")) {
        return new NotFoundError(message, provider);
      }
      if (lower.includes("unauthorized") || lower.includes("invalid key")) {
        return new AuthenticationError(message, provider);
      }
      if (lower.includes("context length") || lower.includes("too many tokens")) {
        return new ContextLengthError(message, provider);
      }
      if (lower.includes("content filter") || lower.includes("safety")) {
        return new ContentFilterError(message, provider);
      }
      // Default to retryable (Section 6.3: unknown errors default to retryable)
      return new ProviderError(message, {
        provider,
        status_code: statusCode,
        error_code: opts?.errorCode,
        retryable: true,
        raw: opts?.raw,
      });
    }
  }
}
