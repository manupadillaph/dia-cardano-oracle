// Lane coalescer — intent supersession + accumulation window.
//
// Problem: a Cardano tx takes 30 s – 2 min to confirm. If DIA emits one
// intent per second for the same symbol, a naïve FIFO queue accumulates
// unbounded lag: the tx at the front of the queue carries a price that is
// already stale by the time it confirms.
//
// Solution: the lane buffer is not a FIFO — it is a Map<symbol, newest>.
// A newer intent (strictly greater timestamp or nonce) supersedes the
// buffered one immediately. The lane has a three-state machine that decides
// WHEN to flush the buffer:
//
//   idle          no buffered intents, no in-flight tx.
//   accumulating  at least one buffered intent; timer is running.
//   in-flight     a flush batch is being submitted to the queue; new intents
//                 accumulate freely without restarting the timer.
//
// State transitions:
//
//   idle + intent arrives          → accumulating (start coalesce_window timer)
//   accumulating + intent arrives  → accumulating (supersede in buffer)
//   accumulating + timer fires     → in-flight    (flush buffer → queue)
//   in-flight + intent arrives     → in-flight    (supersede in buffer, no timer)
//   in-flight + batch confirms,
//     buffer empty                 → idle
//   in-flight + batch confirms,
//     buffer non-empty             → in-flight    (flush immediately, no extra window)
//
// The coalesce_window applies ONLY on the idle→accumulating edge. After an
// in-flight cycle the lane has already been accumulating naturally for as long
// as the chain took — imposing another wait would add pure latency.
//
// Spectra equivalent:
//   there is no direct equivalent — Spectra's EVM destinations do not require
//   serial-UTxO coordination, so per-lane accumulation is Cardano-specific.

import type { EnrichedIntent } from "../source/types.js";
import type { QueueManager } from "./queue-manager.js";
import type { SubmitRequest, SubmitResult } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CoalescerOptions = {
  /** Queue manager that actually performs Cardano submissions. */
  queueManager: QueueManager;
  /**
   * Wall-clock ms to wait on the idle→accumulating edge before flushing.
   * Default: 2 000 ms.
   */
  coalesceWindowMs?: number;
  /**
   * Drop buffered intents older than this many ms at flush time.
   * 0 or undefined = no limit.
   */
  maxIntentAgeMs?: number;
  /**
   * Called once per submitted request, after the queue resolves (ok or error).
   * Receives both the result AND the originating SubmitRequest.
   */
  onResult?: (result: SubmitResult, req: SubmitRequest) => void | Promise<void>;
  /**
   * Called when an incoming intent supersedes a buffered one for the same symbol.
   * `superseded` is the old request being dropped; `by` is the newer one.
   */
  onSupersede?: (superseded: SubmitRequest, by: SubmitRequest) => void | Promise<void>;
  /**
   * Called on lane state transitions and key buffer events.
   * Drives the lane.jsonl log stream.
   */
  onLaneEvent?: (event: {
    lane: string;
    kind: import("../logger/file-logger.js").LaneEventKind;
    symbol?: string;
    intentHash?: string;
    supersededByHash?: string;
    bufferSize?: number;
    fromState?: string;
    toState?: string;
  }) => void | Promise<void>;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type CoalescerManager = {
  /**
   * Accept an intent for buffering. Returns immediately; the state machine
   * drives actual submission.
   *
   * If an intent for the same symbol is already in the buffer and the incoming
   * intent is not strictly newer (timestamp, nonce), the incoming intent is
   * silently discarded.
   */
  accept(req: SubmitRequest): void;
  /** Total intents currently buffered across all lanes (diagnostic). */
  totalBuffered(): number;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type LaneState = "idle" | "accumulating" | "in-flight";

type Lane = {
  state: LaneState;
  buffer: Map<string, SubmitRequest>;
  timer: ReturnType<typeof setTimeout> | null;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCoalescerManager(options: CoalescerOptions): CoalescerManager {
  const {
    queueManager,
    coalesceWindowMs = 2_000,
    maxIntentAgeMs,
    onResult,
    onSupersede,
    onLaneEvent,
  } = options;
  const clock = options.now ?? Date.now;

  const lanes = new Map<string, Lane>();

  // Lane key matches the queue manager's lane key so the coalescer and the
  // queue are always aligned on the same (clientState, protocolState) pair.
  function laneKey(req: SubmitRequest): string {
    return `${req.destination.client_state_path}::${req.destination.protocol_state_path}`;
  }

  function getOrCreateLane(key: string): Lane {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { state: "idle", buffer: new Map(), timer: null };
      lanes.set(key, lane);
    }
    return lane;
  }

  // Returns true when `incoming` should replace `existing` in the buffer.
  // Supersession is unconditional on strictly greater (timestamp, nonce) —
  // mirrors the on-chain monotonicity invariant in oracle_logic.ak.
  function isNewer(incoming: EnrichedIntent, existing: EnrichedIntent): boolean {
    const { timestamp: newTs, nonce: newNonce } = incoming.fullIntent;
    const { timestamp: oldTs, nonce: oldNonce } = existing.fullIntent;
    if (newTs > oldTs) return true;
    if (newTs === oldTs && newNonce > oldNonce) return true;
    return false;
  }

  async function flush(lane: Lane, laneKey: string): Promise<void> {
    // Cancel any pending timer (defensive — should only be set in accumulating).
    if (lane.timer) {
      clearTimeout(lane.timer);
      lane.timer = null;
    }

    const entries = Array.from(lane.buffer.values());
    lane.buffer.clear();

    if (entries.length === 0) {
      lane.state = "idle";
      void onLaneEvent?.({ lane: laneKey, kind: "flush_empty", fromState: "accumulating", toState: "idle" });
      void onLaneEvent?.({ lane: laneKey, kind: "lane_idle" });
      return;
    }

    void onLaneEvent?.({ lane: laneKey, kind: "flush_triggered", bufferSize: entries.length, fromState: lane.state, toState: "in-flight" });
    lane.state = "in-flight";

    // Age filter: drop intents whose timestamp is too old to be worth submitting.
    const nowSec = clock() / 1_000;
    const eligible = maxIntentAgeMs
      ? entries.filter((req) => {
          const intentAgeSec = nowSec - Number(req.enriched.fullIntent.timestamp);
          return intentAgeSec * 1_000 < maxIntentAgeMs;
        })
      : entries;

    // Submit each eligible entry serially. The queue enforces the Cardano
    // UTxO ordering constraint (one tx at a time per lane); we wait for each
    // result before sending the next so the coalescer can react correctly.
    for (const req of eligible) {
      const result = await queueManager.submit(req);
      await onResult?.(result, req);
    }

    // Check whether intents accumulated while we were in-flight.
    if (lane.buffer.size > 0) {
      void onLaneEvent?.({ lane: laneKey, kind: "tx_confirmed_reflush", bufferSize: lane.buffer.size });
      // Flush immediately — no extra accumulation window after a confirm.
      await flush(lane, laneKey);
    } else {
      lane.state = "idle";
      void onLaneEvent?.({ lane: laneKey, kind: "lane_idle", fromState: "in-flight", toState: "idle" });
    }
  }

  return {
    accept(req: SubmitRequest): void {
      const key = laneKey(req);
      const lane = getOrCreateLane(key);
      const symbol = req.enriched.fullIntent.symbol;

      // Supersession check — discard stale intents before buffering.
      const existing = lane.buffer.get(symbol);
      if (existing) {
        if (!isNewer(req.enriched, existing.enriched)) {
          return;
        }
        void onSupersede?.(existing, req);
        void onLaneEvent?.({
          lane: key, kind: "intent_superseded", symbol,
          intentHash: existing.intentHash, supersededByHash: req.intentHash,
        });
      }
      lane.buffer.set(symbol, req);

      void onLaneEvent?.({
        lane: key, kind: "intent_buffered", symbol,
        intentHash: req.intentHash, bufferSize: lane.buffer.size,
        fromState: lane.state,
        toState: lane.state === "idle" ? "accumulating" : lane.state,
      });

      if (lane.state === "idle") {
        lane.state = "accumulating";
        lane.timer = setTimeout(() => { void flush(lane, key); }, coalesceWindowMs);
      }
      // accumulating → timer already running; buffer updated above.
      // in-flight    → no timer; buffer updated; flush triggers on confirm.
    },

    totalBuffered(): number {
      let n = 0;
      for (const lane of lanes.values()) n += lane.buffer.size;
      return n;
    },
  };
}
