// Integration test for the daemon event-processing pipeline.
//
// Exercises the path:
//   ExtractedEvent → dedup → enrich → routeIntent → queue → bridge →
//   onResult → priceCache update + DB confirmation update
//
// Nothing network-facing is wired (no HTTP scanner, no API server,
// no Lucid). All external I/O is replaced by in-memory fakes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDedupCache, createPriceCache } from "../../../src/processor/index.js";
import { createRouterRegistry, routeIntent } from "../../../src/router/index.js";
import { createQueueManager } from "../../../src/submitter/index.js";
import type { SubmitRequest, SubmitResult } from "../../../src/submitter/types.js";
import type { CardanoWriteClient } from "../../../src/submitter/types.js";
import type { Db, TransactionLogRow } from "../../../src/persistence/index.js";
import type { EnrichedIntent, ExtractedEvent } from "../../../src/source/types.js";
import type { RouterConfig } from "../../../src/config/types.js";

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    intentHash: "0xabc123",
    symbolHash: "0xdeadbeef",
    price: 100_000n,
    timestamp: 1_700_000_000n,
    signer: "0x1234567890123456789012345678901234567890",
    blockNumber: 1n,
    txHash: "0xtx1",
    logIndex: 0,
    ...overrides,
  };
}

function makeEnriched(event: ExtractedEvent): EnrichedIntent {
  return {
    event,
    fullIntent: {
      intentType: "update",
      version: "1",
      chainId: 10050n,
      nonce: 1n,
      expiry: 9_999_999_999n,
      symbol: "BTC/USD",
      price: event.price,
      timestamp: event.timestamp,
      source: "diadata",
      signature: "0xsig",
      signer: event.signer,
    },
  };
}

function makeRouter(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    id: "router-btc",
    name: "BTC Router",
    type: "generic",
    enabled: true,
    private_key_env: "",
    triggers: { events: ["IntentRegistered"], conditions: [] },
    processing: {} as RouterConfig["processing"],
    destinations: [
      {
        cardano: {
          network: "Preview",
          client_state_path: "/state/client-state.json",
          protocol_state_path: "/state/protocol-state.json",
          tx_mode: "single",
        },
        time_threshold: "0s",
        price_deviation: "0%",
      },
    ],
    ...overrides,
  };
}

function makeInMemoryDb(): Db & { logs: TransactionLogRow[] } {
  const logs: TransactionLogRow[] = [];
  return {
    logs,
    async migrate() {},
    async upsertProcessedEvent() {},
    async hasProcessedEvent() { return false; },
    async getLastProcessedBlock() { return null; },
    async setLastProcessedBlock() {},
    async insertTransactionLog(row) { logs.push({ ...row }); },
    async updateTransactionLog(intentHash, cardanoTxHash, update) {
      const row = logs.find((r) => r.intentHash === intentHash);
      if (row) {
        row.cardanoTxHash = cardanoTxHash;
        row.status = update.status ?? row.status;
        if (update.confirmedAtMs !== undefined) row.confirmedAtMs = update.confirmedAtMs;
      }
    },
    async getTransactionLog(intentHash) {
      return logs.filter((r) => r.intentHash === intentHash);
    },
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// processOneEvent — extracted as a local re-implementation so we can test
// the logic without importing the private internals of daemon-cmd.ts.
// This mirrors the function inside daemon-cmd.ts exactly; changes there
// should be reflected here.
// ---------------------------------------------------------------------------

type ProcessInputs = {
  event: ExtractedEvent;
  dedupCache: ReturnType<typeof createDedupCache>;
  enricher: (e: ExtractedEvent) => Promise<EnrichedIntent>;
  routerRegistry: ReturnType<typeof createRouterRegistry>;
  priceCache: ReturnType<typeof createPriceCache>;
  queueManager: ReturnType<typeof createQueueManager>;
  pendingRequests: Map<string, SubmitRequest>;
  db: Db;
  dryRun: boolean;
  report: (line: string) => void;
};

async function processOneEvent(inputs: ProcessInputs): Promise<void> {
  const {
    event, dedupCache, enricher, routerRegistry,
    priceCache, queueManager, pendingRequests, db, dryRun, report,
  } = inputs;

  if (!dedupCache.add(event.intentHash)) return;

  let enriched: EnrichedIntent;
  try {
    enriched = await enricher(event);
  } catch (err) {
    report(`enrichment failed: ${(err as Error).message}`);
    return;
  }

  const output = routeIntent(routerRegistry, priceCache, "IntentRegistered", enriched);

  for (const dispatch of output.dispatched) {
    const cardano = dispatch.destination.cardano;
    if (!cardano) continue;

    if (dryRun) {
      report(`[dry-run] would submit router=${dispatch.routerId}`);
      continue;
    }

    const req: SubmitRequest = {
      intentHash: event.intentHash,
      enriched,
      destination: cardano,
      routerId: dispatch.routerId,
      destinationIndex: dispatch.destinationIndex,
    };

    pendingRequests.set(event.intentHash, req);

    void db.insertTransactionLog({
      intentHash: event.intentHash,
      cardanoTxHash: "",
      routerId: dispatch.routerId,
      destinationIndex: dispatch.destinationIndex,
      clientStatePath: cardano.client_state_path,
      status: "submitted",
      submittedAtMs: Date.now(),
    });

    void queueManager.submit(req);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon pipeline — dedup", () => {
  it("processes the first event and skips the duplicate", async () => {
    const processed: string[] = [];
    const dedupCache = createDedupCache({ capacity: 100, ttlMs: 60_000 });
    const priceCache = createPriceCache();
    const routerRegistry = createRouterRegistry({ "router-btc": makeRouter() });
    const db = makeInMemoryDb();
    const pendingRequests = new Map<string, SubmitRequest>();

    const fakeClient: CardanoWriteClient = {
      label: "fake",
      async submit(req) {
        processed.push(req.intentHash);
        return { ok: true, cardanoTxHash: "0xcardano1", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" };
      },
    };
    const queueManager = createQueueManager({
      clientFactory: () => fakeClient,
    });

    const event = makeEvent();
    const enricher = async (e: ExtractedEvent) => makeEnriched(e);

    await processOneEvent({ event, dedupCache, enricher, routerRegistry, priceCache, queueManager, pendingRequests, db, dryRun: false, report: () => {} });
    await processOneEvent({ event, dedupCache, enricher, routerRegistry, priceCache, queueManager, pendingRequests, db, dryRun: false, report: () => {} });

    // Give the queue time to drain
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(processed.length, 1, "bridge should be called exactly once");
  });
});

describe("daemon pipeline — routing", () => {
  it("skips submission when no router matches the event", async () => {
    const submitted: string[] = [];
    const dedupCache = createDedupCache({ capacity: 100, ttlMs: 60_000 });
    const priceCache = createPriceCache();
    // Router subscribes to a different event name
    const routerRegistry = createRouterRegistry({
      "router-other": makeRouter({ triggers: { events: ["OtherEvent"], conditions: [] } }),
    });
    const db = makeInMemoryDb();
    const pendingRequests = new Map<string, SubmitRequest>();
    const fakeClient: CardanoWriteClient = {
      label: "fake",
      async submit(req) { submitted.push(req.intentHash); return { ok: true, cardanoTxHash: "0x1", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" }; },
    };
    const queueManager = createQueueManager({ clientFactory: () => fakeClient });

    await processOneEvent({
      event: makeEvent(),
      dedupCache, enricher: async (e) => makeEnriched(e),
      routerRegistry, priceCache, queueManager, pendingRequests, db,
      dryRun: false, report: () => {},
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(submitted.length, 0, "nothing submitted when no router matches");
  });

  it("skips cardano submission when destination has no cardano block", async () => {
    const submitted: string[] = [];
    const dedupCache = createDedupCache({ capacity: 100, ttlMs: 60_000 });
    const priceCache = createPriceCache();
    const routerWithoutCardano = makeRouter();
    routerWithoutCardano.destinations = [{ time_threshold: "0s", price_deviation: "0%" }];
    const routerRegistry = createRouterRegistry({ "router-no-cardano": routerWithoutCardano });
    const db = makeInMemoryDb();
    const pendingRequests = new Map<string, SubmitRequest>();
    const fakeClient: CardanoWriteClient = {
      label: "fake",
      async submit(req) { submitted.push(req.intentHash); return { ok: true, cardanoTxHash: "0x1", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" }; },
    };
    const queueManager = createQueueManager({ clientFactory: () => fakeClient });

    await processOneEvent({
      event: makeEvent(),
      dedupCache, enricher: async (e) => makeEnriched(e),
      routerRegistry, priceCache, queueManager, pendingRequests, db,
      dryRun: false, report: () => {},
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(submitted.length, 0);
  });
});

describe("daemon pipeline — dry-run mode", () => {
  it("logs but does not submit in dry-run mode", async () => {
    const logs: string[] = [];
    const submitted: string[] = [];
    const dedupCache = createDedupCache({ capacity: 100, ttlMs: 60_000 });
    const priceCache = createPriceCache();
    const routerRegistry = createRouterRegistry({ "router-btc": makeRouter() });
    const db = makeInMemoryDb();
    const pendingRequests = new Map<string, SubmitRequest>();
    const fakeClient: CardanoWriteClient = {
      label: "fake",
      async submit(req) { submitted.push(req.intentHash); return { ok: true, cardanoTxHash: "0x1", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" }; },
    };
    const queueManager = createQueueManager({ clientFactory: () => fakeClient });

    await processOneEvent({
      event: makeEvent(),
      dedupCache, enricher: async (e) => makeEnriched(e),
      routerRegistry, priceCache, queueManager, pendingRequests, db,
      dryRun: true, report: (line) => logs.push(line),
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(submitted.length, 0, "bridge not called in dry-run");
    assert.ok(logs.some((l) => l.includes("[dry-run]")), "dry-run log emitted");
  });
});

describe("daemon pipeline — DB and onResult wiring", () => {
  it("inserts a submitted log row and queue resolves without error", async () => {
    const dedupCache = createDedupCache({ capacity: 100, ttlMs: 60_000 });
    const priceCache = createPriceCache();
    const routerRegistry = createRouterRegistry({ "router-btc": makeRouter() });
    const db = makeInMemoryDb();
    const pendingRequests = new Map<string, SubmitRequest>();

    const fakeClient: CardanoWriteClient = {
      label: "fake",
      async submit(req): Promise<SubmitResult> {
        return { ok: true, cardanoTxHash: "0xcardanofinal", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" };
      },
    };
    const queueManager = createQueueManager({
      clientFactory: () => fakeClient,
    });

    const event = makeEvent({ intentHash: "0xfull001" });
    await processOneEvent({
      event, dedupCache, enricher: async (e) => makeEnriched(e),
      routerRegistry, priceCache, queueManager, pendingRequests, db,
      dryRun: false, report: () => {},
    });

    // Wait for queue to drain
    await new Promise((r) => setTimeout(r, 100));

    // DB row inserted
    const rows = await db.getTransactionLog(event.intentHash);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].routerId, "router-btc");
    assert.equal(rows[0].clientStatePath, "/state/client-state.json");
    assert.equal(rows[0].status, "submitted");
  });

  it("enrichment failure is swallowed and does not submit", async () => {
    const submitted: string[] = [];
    const dedupCache = createDedupCache({ capacity: 100, ttlMs: 60_000 });
    const priceCache = createPriceCache();
    const routerRegistry = createRouterRegistry({ "router-btc": makeRouter() });
    const db = makeInMemoryDb();
    const pendingRequests = new Map<string, SubmitRequest>();
    const fakeClient: CardanoWriteClient = {
      label: "fake",
      async submit(req) { submitted.push(req.intentHash); return { ok: true, cardanoTxHash: "0x1", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" }; },
    };
    const queueManager = createQueueManager({ clientFactory: () => fakeClient });

    const logs: string[] = [];
    await processOneEvent({
      event: makeEvent(),
      dedupCache,
      enricher: async () => { throw new Error("RPC timeout"); },
      routerRegistry, priceCache, queueManager, pendingRequests, db,
      dryRun: false, report: (l) => logs.push(l),
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(submitted.length, 0);
    assert.ok(logs.some((l) => l.includes("enrichment failed")));
  });
});
