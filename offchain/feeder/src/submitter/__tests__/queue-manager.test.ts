import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createQueueManager } from "../queue-manager.js";
import type { CardanoWriteClient, SubmitRequest } from "../types.js";
import type { EnrichedIntent } from "../../source/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNER = "0xf64D333c19B007519C7B9316680ED26578f98C08" as `0x${string}`;

function makeEnriched(): EnrichedIntent {
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
      symbol: "BTC/USD",
      price: 100_000n,
      timestamp: 1_700_000_000n,
      source: "DIA Oracle",
      signature: "0xsig",
      signer: SIGNER,
    },
  };
}

function makeRequest(
  clientStatePath: string,
  protocolStatePath: string,
  intentHash = "0xhash",
): SubmitRequest {
  return {
    intentHash,
    enriched: makeEnriched(),
    destination: {
      network: "Preview",
      client_state_path: clientStatePath,
      protocol_state_path: protocolStatePath,
      tx_mode: "single",
    },
    routerId: "r1",
    destinationIndex: 0,
  };
}

function makeOkClient(label: string): CardanoWriteClient {
  return {
    label,
    async submit(req) {
      return {
        ok: true,
        cardanoTxHash: `tx-${req.intentHash}`,
        intentHash: req.intentHash,
        receiverUnit: "receiver-unit-test",
        pairUnit: "pair-unit-test",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createQueueManager", () => {
  it("routes requests to correct client", async () => {
    const created: string[] = [];
    const mgr = createQueueManager({
      clientFactory: (csp, psp) => {
        created.push(`${csp}::${psp}`);
        return makeOkClient(`${csp}::${psp}`);
      },
    });

    await mgr.submit(makeRequest("client-a.json", "protocol.json", "h1"));
    await mgr.submit(makeRequest("client-b.json", "protocol.json", "h2"));

    assert.equal(created.length, 2);
    assert.equal(created[0], "client-a.json::protocol.json");
    assert.equal(created[1], "client-b.json::protocol.json");
  });

  it("reuses the same queue for identical (clientState, protocolState)", async () => {
    let factoryCalls = 0;
    const mgr = createQueueManager({
      clientFactory: (_csp, _psp) => {
        factoryCalls++;
        return makeOkClient("shared");
      },
    });

    await mgr.submit(makeRequest("c.json", "p.json", "h1"));
    await mgr.submit(makeRequest("c.json", "p.json", "h2"));
    await mgr.submit(makeRequest("c.json", "p.json", "h3"));

    assert.equal(factoryCalls, 1);
    assert.equal(mgr.queueKeys().length, 1);
  });

  it("queueKeys returns one key per distinct destination", async () => {
    const mgr = createQueueManager({
      clientFactory: (csp, psp) => makeOkClient(`${csp}::${psp}`),
    });
    await mgr.submit(makeRequest("c1.json", "p.json", "h1"));
    await mgr.submit(makeRequest("c2.json", "p.json", "h2"));
    await mgr.submit(makeRequest("c1.json", "p.json", "h3")); // reuses c1

    assert.equal(mgr.queueKeys().length, 2);
  });

  it("totalPending returns 0 after all settle", async () => {
    const mgr = createQueueManager({
      clientFactory: () => makeOkClient("fast"),
    });
    await Promise.all([
      mgr.submit(makeRequest("c.json", "p.json", "x1")),
      mgr.submit(makeRequest("c.json", "p.json", "x2")),
    ]);
    assert.equal(mgr.totalPending(), 0);
  });

  it("propagates submit errors without crashing the manager", async () => {
    const mgr = createQueueManager({
      clientFactory: () => ({
        label: "err-client",
        async submit(req) {
          return {
            ok: false,
            intentHash: req.intentHash,
            error: new Error("fail"),
            code: "Unknown" as const,
            remediation: "",
          };
        },
      }),
    });
    const result = await mgr.submit(makeRequest("c.json", "p.json", "e1"));
    assert.equal(result.ok, false);
    // Can still submit after a failure
    const result2 = await mgr.submit(makeRequest("c.json", "p.json", "e2"));
    assert.equal(result2.ok, false);
  });
});
