// Rollback-detection helper for post-confirmation UTxO wait loops.
//
// Context: after `awaitTxConfirmation` succeeds the chain-helpers wait loops
// poll Blockfrost / Koios for the indexer to surface the expected UTxO state.
// On congested networks the indexer can lag 30–120 s after block inclusion.
// Rather than fail at 30 s (the old default) the loops now wait up to ~20 min.
//
// The risk of a long ceiling is hanging forever on a genuine rollback. This
// module provides `assertTxStillOnChain` as a lightweight periodic check: the
// wait loops call it every ROLLBACK_CHECK_INTERVAL attempts (~90 s). If both
// Koios and Blockfrost REST independently report the transaction as absent, the
// `TxDroppedFromChainError` is thrown and the caller can surface a clean error
// instead of waiting out the full ceiling.
//
// Conservative two-provider strategy: a single transient HTTP error is never
// treated as "gone". Only a confident, agreeing "not found" from both providers
// triggers the error. This avoids false positives during brief provider outages.

import { getCliConfig } from "./config.js";

type FetchLike = typeof fetch;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a previously-confirmed transaction is no longer visible on
 * either Koios or Blockfrost REST, indicating a chain reorganisation.
 *
 * Callers should treat this as a terminal failure for the current submit
 * attempt and NOT silently retry — the intent should be re-queued so the
 * feeder applies its configured retry policy with fresh timing.
 */
export class TxDroppedFromChainError extends Error {
  constructor(public readonly txHash: string) {
    super(
      `Transaction ${txHash} is no longer present on-chain (possible rollback). Abandoning UTxO wait.`,
    );
    this.name = "TxDroppedFromChainError";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify that a previously-confirmed transaction is still included in the
 * chain. Queries Koios and Blockfrost REST **in parallel**; throws
 * `TxDroppedFromChainError` only when **both** providers report the
 * transaction as absent. Transient HTTP errors (5xx, timeouts, network
 * glitches) are treated as "unknown" and silently ignored — they do not
 * interrupt the caller's wait loop.
 *
 * Provider URLs and credentials default to `getCliConfig()` values; pass
 * explicit overrides when the calling context manages its own config (e.g.
 * the feeder bridge operating with a per-destination `CliConfig`).
 *
 * @throws {TxDroppedFromChainError} when both providers definitively report
 *   the transaction as absent.
 */
export async function assertTxStillOnChain(args: {
  txHash: string;
  koiosApiUrl?: string;
  blockfrostApiUrl?: string;
  blockfrostProjectId?: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const config = getCliConfig();
  const koiosApiUrl = args.koiosApiUrl ?? config.koiosApiUrl;
  const blockfrostApiUrl = args.blockfrostApiUrl ?? config.blockfrostApiUrl;
  const blockfrostProjectId =
    args.blockfrostProjectId ?? config.blockfrostProjectId;

  const [koiosResult, blockfrostResult] = await Promise.allSettled([
    fetchKoiosTxExists({ koiosApiUrl, txHash: args.txHash, fetchImpl }),
    fetchBlockfrostTxExists({
      blockfrostApiUrl,
      blockfrostProjectId,
      txHash: args.txHash,
      fetchImpl,
    }),
  ]);

  // Either provider confirming presence → tx is still on-chain, nothing to do.
  if (
    (koiosResult.status === "fulfilled" && koiosResult.value) ||
    (blockfrostResult.status === "fulfilled" && blockfrostResult.value)
  ) {
    return;
  }

  // Both providers confidently returning "not found" → rollback detected.
  const koiosDefinitivelyAbsent =
    koiosResult.status === "fulfilled" && !koiosResult.value;
  const blockfrostDefinitivelyAbsent =
    blockfrostResult.status === "fulfilled" && !blockfrostResult.value;

  if (koiosDefinitivelyAbsent && blockfrostDefinitivelyAbsent) {
    throw new TxDroppedFromChainError(args.txHash);
  }

  // At least one provider returned a transient error — be conservative and
  // let the caller's wait loop continue. The indexer may simply be lagging.
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function fetchKoiosTxExists(args: {
  koiosApiUrl: string;
  txHash: string;
  fetchImpl: FetchLike;
}): Promise<boolean> {
  const response = await args.fetchImpl(`${args.koiosApiUrl}/tx_info`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ _tx_hashes: [args.txHash] }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Koios tx_info check failed (${response.status} ${response.statusText}).`,
    );
  }

  const payload = (await response.json()) as Array<{ tx_hash: string }>;
  return payload.length > 0;
}

async function fetchBlockfrostTxExists(args: {
  blockfrostApiUrl: string;
  blockfrostProjectId: string;
  txHash: string;
  fetchImpl: FetchLike;
}): Promise<boolean> {
  const response = await args.fetchImpl(
    `${args.blockfrostApiUrl}/txs/${args.txHash}`,
    {
      headers: { project_id: args.blockfrostProjectId },
      signal: AbortSignal.timeout(15_000),
    },
  );

  // 404 is the only definitive "not found" — treat everything else as a
  // transient error so that Blockfrost rate-limits or brief outages don't
  // incorrectly trigger rollback detection.
  if (response.status === 404) return false;

  if (!response.ok) {
    throw new Error(
      `Blockfrost tx lookup failed (${response.status} ${response.statusText}).`,
    );
  }

  return true;
}
