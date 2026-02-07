/**
 * Retry utility — Section 6.6 of the Unified LLM Client Spec.
 * Exponential backoff with jitter.
 */

import { type RetryPolicy, type SDKError, DEFAULT_RETRY_POLICY, ProviderError } from "./types.js";

function delayForAttempt(attempt: number, policy: RetryPolicy): number {
  let delay = policy.base_delay * Math.pow(policy.backoff_multiplier, attempt) * 1000;
  delay = Math.min(delay, policy.max_delay * 1000);
  if (policy.jitter) {
    delay = delay * (0.5 + Math.random());
  }
  return delay;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry on retryable errors.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  let lastError: SDKError | undefined;

  for (let attempt = 0; attempt <= policy.max_retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const sdkErr = err as SDKError;
      lastError = sdkErr;

      // Check retryability
      if (err instanceof ProviderError && !err.retryable) {
        throw err;
      }

      if (attempt >= policy.max_retries) {
        throw err;
      }

      // Compute delay
      let delay: number;
      if (err instanceof ProviderError && err.retry_after != null) {
        const retryAfterMs = err.retry_after * 1000;
        if (retryAfterMs > policy.max_delay * 1000) {
          throw err; // Don't wait excessively long
        }
        delay = retryAfterMs;
      } else {
        delay = delayForAttempt(attempt, policy);
      }

      policy.on_retry?.(sdkErr, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}
