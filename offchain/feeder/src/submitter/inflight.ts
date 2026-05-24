// In-flight tx table.
//
// Tracks Cardano transactions that have been submitted but not yet
// confirmed. The main purpose is to prevent a second update from being
// queued for the same `receiverUnit` before the first one confirms,
// which would produce a UTxO conflict.
//
// Spectra equivalent:
//   `pkg/submitter/inflight.go` — the per-(wallet, chainID) in-flight
//   map with timeout-based cleanup.
//
// NOTE: in-memory only — these are receiver-UTxO exclusive locks held during
// active submission, not persistent records. Completed submissions are recorded
// in the SQLite transaction_log table. If the feeder restarts mid-submission,
// the lock is gone but the write client re-reads UTxO state from chain.

export type InflightEntry = {
  /** Cardano tx hash, once submitted. Empty string if only building. */
  txHash: string;
  /** Intent hash that triggered this submission. */
  intentHash: string;
  /** Receiver unit NFT (`<policyId><assetName>`) this tx touches.
   *  Used as the exclusive-lock key. */
  receiverUnit: string;
  /** Wall-clock time the entry was created (ms since epoch). */
  createdAtMs: number;
  /** Timeout after which a non-confirmed tx is considered stuck and
   *  the lock is released (ms since epoch). */
  timeoutAtMs: number;
};

export type InflightTable = {
  /** Mark a (intentHash, receiverUnit) pair as in-flight. */
  add(entry: InflightEntry): void;
  /** Returns `true` if a non-expired entry exists for `receiverUnit`. */
  isLocked(receiverUnit: string): boolean;
  /** Remove the in-flight entry for `txHash` (call on confirmation or failure). */
  remove(txHash: string): void;
  /** All current in-flight entries (snapshot). */
  all(): InflightEntry[];
  /** Expire entries whose `timeoutAtMs` has passed. Returns the count
   *  of entries that were evicted. */
  evictExpired(): number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15 * 60_000; // 15 minutes

export type InflightTableOptions = {
  /** Injectable clock for tests. */
  now?: () => number;
};

export function createInflightTable(options: InflightTableOptions = {}): InflightTable {
  const clock = options.now ?? Date.now;

  // Keyed by txHash for O(1) remove.
  const byTxHash = new Map<string, InflightEntry>();
  // Keyed by receiverUnit for O(1) isLocked.
  const byReceiverUnit = new Map<string, InflightEntry>();

  return {
    add(entry) {
      byTxHash.set(entry.txHash, entry);
      byReceiverUnit.set(entry.receiverUnit, entry);
    },

    isLocked(receiverUnit) {
      const entry = byReceiverUnit.get(receiverUnit);
      if (!entry) return false;
      if (clock() >= entry.timeoutAtMs) {
        byTxHash.delete(entry.txHash);
        byReceiverUnit.delete(receiverUnit);
        return false;
      }
      return true;
    },

    remove(txHash) {
      const entry = byTxHash.get(txHash);
      if (entry) {
        byTxHash.delete(txHash);
        // Only clear the receiver-unit lock if it still points to THIS
        // txHash. A second add() for the same receiverUnit overwrites
        // byReceiverUnit with the newer entry; removing the old txHash
        // must not evict the lock held by the newer tx.
        const unitEntry = byReceiverUnit.get(entry.receiverUnit);
        if (unitEntry?.txHash === txHash) {
          byReceiverUnit.delete(entry.receiverUnit);
        }
      }
    },

    all() {
      return Array.from(byTxHash.values());
    },

    evictExpired() {
      const now = clock();
      let count = 0;
      for (const [txHash, entry] of byTxHash) {
        if (now >= entry.timeoutAtMs) {
          byTxHash.delete(txHash);
          byReceiverUnit.delete(entry.receiverUnit);
          count++;
        }
      }
      return count;
    },
  };
}

/** Build an `InflightEntry` with the default timeout. */
export function makeInflightEntry(
  txHash: string,
  intentHash: string,
  receiverUnit: string,
  options: { timeoutMs?: number; now?: () => number } = {},
): InflightEntry {
  const now = (options.now ?? Date.now)();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    txHash,
    intentHash,
    receiverUnit,
    createdAtMs: now,
    timeoutAtMs: now + timeoutMs,
  };
}
