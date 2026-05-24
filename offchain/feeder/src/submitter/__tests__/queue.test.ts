import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSubmissionQueue } from "../queue.js";
import { createInflightTable } from "../inflight.js";
import type { CardanoWriteClient, SubmitRequest, SubmitResult } from "../types.js";
import type { EnrichedIntent } from "../../source/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNER = "0xf64D333c19B007519C7B9316680ED26578f98C08" as `0x${string}`;

function makeEnriched(symbol = "BTC/USD"): EnrichedIntent {
  return {
    event: {
      intentHash: `0x${"ab".repeat(32)}` as `0x${string}`,
      symbolHash: `0x${"cc".repeat(32)}` as `0x${string}`,
      price: 100_000n,
      timestamp: 1_700_000_000n,
      signer: SIGNER,
      blockNumber: 1n,
      txHash: `0x${"dd".repeat(32)}` as `0x${string}`,
      logIndex: 0,
    },
    fullIntent: {
      intentType: "OracleUpdate",
      version: "1.0",
      chainId: 10050n,
      nonce: 1n,
      expiry: 9_999_999_999n,
      symbol,
      price: 100_000n,
      timestamp: 1_700_000_000n,
      source: "DIA Oracle",
      signature: "0xsig",
      signer: SIGNER,
    },
  };
}

function makeRequest(intentHash = "0xhash"): SubmitRequest {
  return {
    intentHash,
    enriched: makeEnriched(),
    destination: {
      network: "Preview",
      client_state_path: "state/preview/clients/client-a.json",
      protocol_state_path: "state/preview/config-bootstrap.json",
      tx_mode: "single",
    },
    routerId: "r1",
    destinationIndex: 0,
  };
}

function makeOkClient(txHash = "cardano-tx-abc"): CardanoWriteClient {
  return {
    label: "test-client",
    async submit(req) {
      return {
        ok: true,
        cardanoTxHash: txHash,
        intentHash: req.intentHash,
        receiverUnit: "receiver-unit-test",
        pairUnit: "pair-unit-test",
      };
    },
  };
}

function makeFailClient(message = "submit failed"): CardanoWriteClient {
  return {
    label: "fail-client",
    async submit(req) {
      return {
        ok: false,
        intentHash: req.intentHash,
        error: new Error(message),
        code: "Unknown",
        remediation: "",
      };
    },
  };
}

function makeThrowClient(): CardanoWriteClient {
  return {
    label: "throw-client",
    async submit(_req) {
      throw new Error("unexpected throw");
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSubmissionQueue", () => {
  it("resolves with ok result from client", async () => {
    const q = createSubmissionQueue({
      client: makeOkClient("tx-ok-1"),
      inflight: createInflightTable(),
    });
    const result = await q.enqueue(makeRequest("h1"));
    assert.equal(result.ok, true);
    assert.equal("cardanoTxHash" in result && result.cardanoTxHash, "tx-ok-1");
    assert.equal(result.intentHash, "h1");
  });

  it("resolves with err result when client returns error", async () => {
    const q = createSubmissionQueue({
      client: makeFailClient("rpc down"),
      inflight: createInflightTable(),
    });
    const result = await q.enqueue(makeRequest("h2"));
    assert.equal(result.ok, false);
    assert.equal("error" in result && result.error.message, "rpc down");
  });

  it("catches thrown errors and wraps them as SubmitResultErr", async () => {
    const q = createSubmissionQueue({
      client: makeThrowClient(),
      inflight: createInflightTable(),
    });
    const result = await q.enqueue(makeRequest("h3"));
    assert.equal(result.ok, false);
    assert.equal("error" in result && result.error.message, "unexpected throw");
  });

  it("processes requests serially — order is preserved", async () => {
    const order: string[] = [];
    const client: CardanoWriteClient = {
      label: "ordered",
      async submit(req) {
        order.push(req.intentHash);
        return { ok: true, cardanoTxHash: `tx-${req.intentHash}`, intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" };
      },
    };
    const q = createSubmissionQueue({ client, inflight: createInflightTable() });
    const [r1, r2, r3] = await Promise.all([
      q.enqueue(makeRequest("a")),
      q.enqueue(makeRequest("b")),
      q.enqueue(makeRequest("c")),
    ]);
    assert.deepEqual(order, ["a", "b", "c"]);
    assert.equal(r1.intentHash, "a");
    assert.equal(r2.intentHash, "b");
    assert.equal(r3.intentHash, "c");
  });

  it("calls onResult callback for each processed item", async () => {
    const results: SubmitResult[] = [];
    const q = createSubmissionQueue({
      client: makeOkClient(),
      inflight: createInflightTable(),
      onResult: (r) => results.push(r),
    });
    await q.enqueue(makeRequest("x1"));
    await q.enqueue(makeRequest("x2"));
    assert.equal(results.length, 2);
    assert.equal(results[0].intentHash, "x1");
    assert.equal(results[1].intentHash, "x2");
  });

  it("pending count decrements after processing", async () => {
    let resolveSubmit!: () => void;
    const blocker = new Promise<void>((res) => { resolveSubmit = res; });

    const client: CardanoWriteClient = {
      label: "slow",
      async submit(req) {
        await blocker;
        return { ok: true, cardanoTxHash: "tx-slow", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" };
      },
    };
    const q = createSubmissionQueue({ client, inflight: createInflightTable() });

    const p1 = q.enqueue(makeRequest("s1"));
    q.enqueue(makeRequest("s2")); // not awaited — stays pending
    // Give the drain loop a tick to start processing s1
    await new Promise((r) => setImmediate(r));
    assert.equal(q.pending, 1); // s2 is still queued
    resolveSubmit();
    await p1;
    // After s1 resolves, drain picks up s2
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(q.pending, 0);
  });
});
