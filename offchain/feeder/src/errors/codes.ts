// Error taxonomy for the Cardano oracle feeder.
//
// Every `SubmitResultErr` carries a `FeederErrorCode` so the daemon can:
//   - emit structured log entries (step="failed", meta.code=<code>)
//   - present an actionable `remediation` string in terminal output
//   - increment the right Prometheus counter (future: label by code)
//
// `classifyError` maps arbitrary thrown values to a `{code, remediation}`
// pair by pattern-matching on the error name and message. It is intentionally
// conservative: when nothing matches it falls back to `BuilderError`, which
// asks the operator to check the logs rather than masking the real error.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Canonical error categories for the feeder submission pipeline.
 *
 * Use the narrowest code that applies. If the error does not fit any
 * category, use `"BuilderError"` (tx construction or signing failed) or
 * `"Unknown"` (non-Error or completely unrecognised value was thrown).
 */
export type FeederErrorCode =
  /** Updater wallet has insufficient ADA to pay tx fees. */
  | "WalletInsufficientFunds"
  /** Receiver script UTxO has insufficient ADA to cover fees + min-UTxO. */
  | "ReceiverInsufficientFunds"
  /** Wallet payment key is not in the config's `validConfigSigners` list
   *  — required for pair creation (first update for a symbol). */
  | "SignerNotAuthorizedToMint"
  /** The DIA intent's `expiry` timestamp has already passed. */
  | "IntentExpired"
  /** Intent `timestamp` or `nonce` is not strictly greater than the
   *  current on-chain pair state — the on-chain monotonicity invariant
   *  would be violated. */
  | "NonMonotonicNonce"
  /** Blockfrost / Koios indexer did not surface the expected UTxO state
   *  within the wait ceiling (~20 min). Likely a transient provider issue. */
  | "ProviderLag"
  /** A required script UTxO (config, pair, receiver) could not be found
   *  on-chain. The chain state may need reconciliation. */
  | "UtxoNotFound"
  /** A previously-confirmed transaction was rolled back by a chain
   *  reorganisation (`TxDroppedFromChainError`). */
  | "TxDroppedFromChain"
  /** The batch would exceed the Cardano tx size or the configured
   *  `max_batch_size` limit. */
  | "BatchSizeExceeded"
  /** The intent was still in the feeder queue when it became too old to
   *  be worth submitting (> `max_intent_age_at_flush`). */
  | "IntentAgedOut"
  /** Lucid tx builder or signing failed for a reason not covered above. */
  | "BuilderError"
  /** A non-Error value was thrown or no pattern matched. */
  | "Unknown";

/** Pair of error code + human-readable fix hint. */
export type ClassifiedError = {
  code: FeederErrorCode;
  remediation: string;
};

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Map an arbitrary thrown value to a `{code, remediation}` pair.
 *
 * Checks `err.name` first (catches typed error classes like
 * `TxDroppedFromChainError`), then pattern-matches on lowercased
 * `err.message`. Falls back to `BuilderError` when the message is
 * recognisable as a tx-construction failure, and `Unknown` when the
 * thrown value is not even an `Error` instance.
 */
export function classifyError(err: unknown): ClassifiedError {
  if (!(err instanceof Error)) {
    return {
      code: "Unknown",
      remediation:
        "An unexpected non-Error value was thrown. Check feeder logs for raw output.",
    };
  }

  // Named error types take precedence over message pattern matching.
  if (err.name === "TxDroppedFromChainError") {
    return {
      code: "TxDroppedFromChain",
      remediation:
        "The submitted transaction was rolled back by a chain reorganisation. " +
        "The intent will be re-queued on the next incoming event.",
    };
  }

  const msg = err.message.toLowerCase();

  if (msg.includes("expir")) {
    return {
      code: "IntentExpired",
      remediation:
        "The DIA intent expired before the Cardano tx could be submitted. " +
        "The feeder will process the next fresh intent automatically.",
    };
  }

  if (msg.includes("monoton") || msg.includes("nonce is not")) {
    return {
      code: "NonMonotonicNonce",
      remediation:
        "A newer intent for this pair is already on-chain. " +
        "The stale intent was discarded; no operator action is needed.",
    };
  }

  if (
    msg.includes("config admin") ||
    msg.includes("config signer") ||
    msg.includes("not authorized to mint")
  ) {
    return {
      code: "SignerNotAuthorizedToMint",
      remediation:
        "The updater wallet is not a config admin. " +
        "Run `npm run cli config:update` to add the wallet as a valid signer.",
    };
  }

  if (
    msg.includes("utxo set did not refresh") ||
    msg.includes("did not appear at the indexer") ||
    msg.includes("still visible at the indexer")
  ) {
    return {
      code: "ProviderLag",
      remediation:
        "The chain indexer is lagging behind block inclusion. " +
        "If this persists beyond 20 min, check Blockfrost / Koios health.",
    };
  }

  if (msg.includes("unable to observe") || (msg.includes("utxo") && msg.includes("missing"))) {
    return {
      code: "UtxoNotFound",
      remediation:
        "A required script UTxO could not be found on-chain. " +
        "The chain state may need reconciliation — run the feeder's reconcile step.",
    };
  }

  if (msg.includes("insufficient funds") || msg.includes("not enough ada")) {
    return {
      code: "WalletInsufficientFunds",
      remediation: "Top up the updater wallet with ADA and restart the feeder.",
    };
  }

  if (msg.includes("receiver") && (msg.includes("balance") || msg.includes("lovelace"))) {
    return {
      code: "ReceiverInsufficientFunds",
      remediation:
        "The receiver UTxO has insufficient ADA. " +
        "Run `npm run cli receiver:top-up` to add ADA to the receiver.",
    };
  }

  if (
    msg.includes("batch") &&
    (msg.includes("size") || msg.includes("limit") || msg.includes("exceed"))
  ) {
    return {
      code: "BatchSizeExceeded",
      remediation:
        "The batch exceeds the configured or protocol limit. " +
        "Reduce `max_batch_size` in the router YAML or split the intent set.",
    };
  }

  return {
    code: "BuilderError",
    remediation:
      "A Cardano tx builder or signing error occurred. " +
      "Check the feeder logs for the full stack trace.",
  };
}
