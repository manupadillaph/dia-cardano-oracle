// Retry policy for the serial submission queue.
//
// The queue calls `RetryPolicy.decide()` after each failed submit attempt
// to determine whether to wait and try again. The policy is error-code-aware:
// deterministic failures (expired intent, stale nonce, missing authorization)
// are never retried — they would produce the same outcome on every attempt.
// Transient failures (provider lag, tx rollback, unknown builder errors) are
// retried up to `maxRetries` times with a fixed inter-attempt delay.
//
// Usage: construct once per destination lane and pass to `createSubmissionQueue`
// via `QueueOptions.retryPolicy`. The `createQueueManager` factory accepts a
// pre-built policy via `QueueManagerOptions.retryPolicy` so the daemon can
// wire YAML config values into the policy without the queue manager needing
// to know the knob names.

import type { SubmitResultErr } from "./types.js";
import type { FeederErrorCode } from "../errors/codes.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 5_000;

/**
 * Codes that represent deterministic failures — the same error will
 * occur on every retry so retrying wastes time without benefit.
 *
 * Everything NOT in this set is considered potentially transient and
 * eligible for retry up to `maxRetries` times.
 */
export const NON_RETRIABLE_CODES: ReadonlySet<FeederErrorCode> = new Set<FeederErrorCode>([
  "IntentExpired",
  "NonMonotonicNonce",
  "IntentAgedOut",
  "SignerNotAuthorizedToMint",
  "WalletInsufficientFunds",
  "ReceiverInsufficientFunds",
  "BatchSizeExceeded",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetryDecision =
  | { shouldRetry: false }
  | { shouldRetry: true; delayMs: number };

/**
 * Decides whether to retry a failed submission and how long to wait.
 *
 * `attempt` is 0-based: 0 on the first failure, 1 after the first
 * retry, and so on.
 */
export type RetryPolicy = {
  decide(result: SubmitResultErr, attempt: number): RetryDecision;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the default retry policy.
 *
 * @param options.maxRetries  - Maximum number of retries after the first
 *   attempt (default 3). A value of 0 means no retries.
 * @param options.delayMs     - Fixed wait between attempts in ms (default 5 s).
 * @param options.nonRetriableCodes - Override the non-retriable code set.
 *   Defaults to `NON_RETRIABLE_CODES` when omitted.
 */
export function createDefaultRetryPolicy(options: {
  maxRetries?: number;
  delayMs?: number;
  nonRetriableCodes?: ReadonlySet<FeederErrorCode>;
} = {}): RetryPolicy {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delayMs = options.delayMs ?? DEFAULT_RETRY_DELAY_MS;
  const nonRetriable = options.nonRetriableCodes ?? NON_RETRIABLE_CODES;

  return {
    decide(result: SubmitResultErr, attempt: number): RetryDecision {
      if (attempt >= maxRetries) return { shouldRetry: false };
      if (nonRetriable.has(result.code)) return { shouldRetry: false };
      return { shouldRetry: true, delayMs };
    },
  };
}
