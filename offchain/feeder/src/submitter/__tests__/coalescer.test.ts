import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCoalescerManager } from "../coalescer.js";
import type { QueueManager } from "../queue-manager.js";
import type { SubmitRequest, SubmitResult } from "../types.js";
import type { EnrichedIntent } from "../../source/types.js";

const SIGNER = "0xf64D333c19B007519C7B9316680ED26578f98C08" as `0x${string}`;

function makeEnriched(symbol: string, timestamp = 1_700_000_000n): EnrichedIntent {
  return {
    event: {
      intentHash: `0x${"ab".repeat(32)}` as `0x${string}`,
      symbolHash: `0x${"cc".repeat(32)}` as `0x${string}`,
      price: 100_000n,
      timestamp,
      signer: SIGNER,
      blockNumber: 1n,
      txHash: `0x${"dd".repeat(32)}` as `0x${string}`,
      logIndex: 0,
    },
    fullIntent: {
      intentType: "OracleUpdate",
      version: "1.0",
      chainId: 10050n,
      nonce: timestamp,
      expiry: 9_999_999_999n,
      symbol,
      price: 100_000n,
      timestamp,
      source: "DIA Oracle",
      signature: "0xsig",
      signer: SIGNER,
    },
  };
}

function makeRequest(intentHash: string, symbol: string): SubmitRequest {
  return {
    intentHash,
    enriched: makeEnriched(symbol),
    destination: {
      network: "Preview",
      client_state_path: "state/preview/clients/client-a.json",
      protocol_state_path: "state/preview/config-bootstrap.json",
    },
    routerId: "router-a",
    destinationIndex: 0,
  };
}

function okResult(request: SubmitRequest, txHash = "batch-tx"): SubmitResult {
  return {
    ok: true,
    cardanoTxHash: txHash,
    intentHash: request.intentHash,
    receiverUnit: "receiver-unit",
    pairUnit: `pair-${request.enriched.fullIntent.symbol}`,
  };
}

function batchSizeError(request: SubmitRequest): SubmitResult {
  return {
    ok: false,
    intentHash: request.intentHash,
    error: new Error("batch size exceeded"),
    code: "BatchSizeExceeded",
    remediation: "split the batch",
  };
}

function waitForFlush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createCoalescerManager", () => {
  it("flushes multiple buffered symbols through one queueManager.submitBatch call", async () => {
    const batchCalls: string[][] = [];
    const results: string[] = [];

    const queueManager: QueueManager = {
      async submit(request) {
        return okResult(request, "single-tx");
      },
      async submitBatch(requests) {
        batchCalls.push(requests.map((request) => request.intentHash));
        return requests.map((request) => okResult(request));
      },
      queueKeys() {
        return [];
      },
      totalPending() {
        return 0;
      },
    };

    const coalescer = createCoalescerManager({
      queueManager,
      coalesceWindowMs: 0,
      onResult: async (result) => {
        results.push(result.intentHash);
      },
    });

    coalescer.accept(makeRequest("h1", "BTC/USD"));
    coalescer.accept(makeRequest("h2", "ETH/USD"));
    coalescer.accept(makeRequest("h3", "SOL/USD"));

    await waitForFlush();

    assert.deepEqual(batchCalls, [["h1", "h2", "h3"]]);
    assert.deepEqual(results, ["h1", "h2", "h3"]);
  });

  it("splits an oversized batch when size fallback is enabled", async () => {
    const batchCalls: string[][] = [];
    const results: Array<{ intentHash: string; ok: boolean }> = [];

    const queueManager: QueueManager = {
      async submit(request) {
        return okResult(request, "single-tx");
      },
      async submitBatch(requests) {
        batchCalls.push(requests.map((request) => request.intentHash));
        if (requests.length === 3) {
          return requests.map((request) => batchSizeError(request));
        }
        return requests.map((request) => okResult(request));
      },
      queueKeys() {
        return [];
      },
      totalPending() {
        return 0;
      },
    };

    const coalescer = createCoalescerManager({
      queueManager,
      coalesceWindowMs: 0,
      sizeFallbackEnabled: true,
      onResult: async (result) => {
        results.push({ intentHash: result.intentHash, ok: result.ok });
      },
    });

    coalescer.accept(makeRequest("h1", "BTC/USD"));
    coalescer.accept(makeRequest("h2", "ETH/USD"));
    coalescer.accept(makeRequest("h3", "SOL/USD"));

    await waitForFlush();

    assert.deepEqual(batchCalls, [["h1", "h2", "h3"], ["h1", "h2"], ["h3"]]);
    assert.deepEqual(results, [
      { intentHash: "h1", ok: true },
      { intentHash: "h2", ok: true },
      { intentHash: "h3", ok: true },
    ]);
  });

  it("respects maxBatchSize by splitting one flush into multiple queue batches", async () => {
    const batchCalls: string[][] = [];

    const queueManager: QueueManager = {
      async submit(request) {
        return okResult(request, "single-tx");
      },
      async submitBatch(requests) {
        batchCalls.push(requests.map((request) => request.intentHash));
        return requests.map((request) => okResult(request));
      },
      queueKeys() {
        return [];
      },
      totalPending() {
        return 0;
      },
    };

    const coalescer = createCoalescerManager({
      queueManager,
      coalesceWindowMs: 0,
      maxBatchSize: 2,
    });

    coalescer.accept(makeRequest("h1", "BTC/USD"));
    coalescer.accept(makeRequest("h2", "ETH/USD"));
    coalescer.accept(makeRequest("h3", "SOL/USD"));
    coalescer.accept(makeRequest("h4", "ADA/USD"));
    coalescer.accept(makeRequest("h5", "DOT/USD"));

    await waitForFlush();

    assert.deepEqual(batchCalls, [
      ["h1", "h2"],
      ["h3", "h4"],
      ["h5"],
    ]);
  });

  it("includes intent and current timestamps when a buffered intent ages out", async () => {
    const results: SubmitResult[] = [];
    const queueManager: QueueManager = {
      async submit(request) {
        return okResult(request, "single-tx");
      },
      async submitBatch(requests) {
        return requests.map((request) => okResult(request));
      },
      queueKeys() {
        return [];
      },
      totalPending() {
        return 0;
      },
    };

    const nowMs = Date.parse("2026-05-27T06:13:57.000Z");
    const intentTimestampMs = Date.parse("2026-05-27T05:57:52.000Z");
    const intentTimestampSec = BigInt(Math.floor(intentTimestampMs / 1_000));

    const coalescer = createCoalescerManager({
      queueManager,
      coalesceWindowMs: 0,
      maxIntentAgeMs: 15 * 60 * 1_000,
      now: () => nowMs,
      onResult: async (result) => {
        results.push(result);
      },
    });

    const agedRequest: SubmitRequest = {
      ...makeRequest("old-intent", "BTC/USD"),
      enriched: makeEnriched("BTC/USD", intentTimestampSec),
    };

    coalescer.accept(agedRequest);

    await waitForFlush();

    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, false);
    assert.equal(results[0]?.code, "IntentAgedOut");
    assert.match(
      results[0]!.error.message,
      /intent_time=2026-05-27T05:57:52\.000Z now=2026-05-27T06:13:57\.000Z intent_age=16m 5s max_intent_age=15m exceeds_by=1m 5s\./,
    );
    assert.match(
      results[0]!.remediation,
      /restart with --clean --from-latest for new-only flow, or reseed with --from-block for a controlled backfill\./,
    );
  });
});
