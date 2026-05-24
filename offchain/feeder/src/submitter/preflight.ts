// Fast pre-submission checks that run before an intent enters the queue.
//
// The goal is to surface knowable failures immediately — without a chain
// query — so the queue is not blocked by work that will definitely fail.
// Checks that require on-chain state (balance, UTxO presence, nonce
// monotonicity) are handled inside the bridge during submission.
//
// The preflight is called in `processOneEvent` after routing and before
// `queueManager.submit()`. A `PreflightResult` with `ok: false` causes
// the intent to be discarded with a structured log entry rather than
// being enqueued.

import type { EnrichedIntent } from "../source/types.js";
import type { FeederErrorCode } from "../errors/codes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreflightResult =
  | { ok: true }
  | { ok: false; code: FeederErrorCode; reason: string; remediation: string };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Run all fast pre-submission checks against the enriched intent.
 *
 * Currently checks:
 *  - `IntentExpired`: the intent's `expiry` has already passed at arrival
 *    time, meaning no Cardano tx could possibly be built within the validity
 *    window. Comparing against wall clock — no network call needed.
 *
 * @param args.nowSec - Injectable clock (seconds). Defaults to `Date.now()/1000`.
 */
export function runPreflight(args: {
  enriched: EnrichedIntent;
  intentHash: string;
  nowSec?: () => number;
}): PreflightResult {
  const nowSec = args.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const { fullIntent } = args.enriched;
  const now = nowSec();

  // Expiry check: on-chain tx validity requires expiry * 1000 ≥ tx upper bound.
  // If the intent has already expired when it arrives at the feeder, no valid
  // tx can be built — discard early rather than occupying a queue slot.
  if (Number(fullIntent.expiry) <= now) {
    return {
      ok: false,
      code: "IntentExpired",
      reason:
        `Intent ${args.intentHash} arrived already-expired ` +
        `(expiry=${fullIntent.expiry}, now=${now}, symbol=${fullIntent.symbol}).`,
      remediation:
        "This intent expired before reaching the feeder. " +
        "Wait for a fresh intent from the DIA oracle.",
    };
  }

  return { ok: true };
}
