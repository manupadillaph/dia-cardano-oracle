// `daemon` command implementation — long-running feeder process.
//
// Composes every subsystem in order:
//
//   config load + validate
//     ↓
//   API server    (health / readyz / metrics / prices)
//     ↓
//   router registry + price cache
//     ↓
//   queue manager  (one serial queue per Cardano destination)
//     ↓
//   scan pipeline  (scanner → dedup → enricher → router → queue)
//
// The write client is dependency-injected via `OracleIntentBridge`.
// In dry-run mode the bridge is a no-op stub so the full routing
// pipeline can be exercised without touching Cardano.
//
// env vars consumed:
//   CARDANO_NETWORK          resolved before this function is called.
//   DRY_RUN                  skip actual Cardano submissions.
//   DATABASE_DRIVER          sqlite (default) | postgres
//   DATABASE_PATH_TESTNET    SQLite file path for Preview network.
//   DATABASE_PATH_MAINNET    SQLite file path for Mainnet network.
//   DATABASE_DSN_TESTNET     Postgres DSN for Preview.
//   DATABASE_DSN_MAINNET     Postgres DSN for Mainnet.
//   API_LISTEN_ADDR          host:port — default ":8080".
//   METRICS_ENABLED          "true" to enable prom-client metrics.
//   METRICS_NAMESPACE        metric name prefix — default "dia_feeder".

import { rm, glob } from "node:fs/promises";

import { createPublicClient, http, type PublicClient } from "viem";

import {
  loadModularConfig,
  validateModularConfig,
  type ModularConfig,
  type InfrastructureConfig,
  type ValidationIssue,
} from "../../src/config/index.js";
import { createRegistryEnricher, identityTransformer } from "../../src/pipeline/index.js";
import {
  createDedupCache,
  createPriceCache,
} from "../../src/processor/index.js";
import {
  composeAuthenticatedWsUrl,
  createHttpRegistryClient,
  createJsonCheckpoint,
  defaultCheckpointPath,
  resolveSourceFromConfig,
  runHttpScanner,
  runWsScanner,
  type CardanoNetwork,
  type Checkpoint,
  type EnrichedIntent,
  type ExtractedEvent,
  type RegistryClient,
  type ResolvedSource,
  type ScannedBatch,
} from "../../src/source/index.js";
import {
  createRouterRegistry,
  routeIntent,
} from "../../src/router/index.js";
import {
  createQueueManager,
  createCoalescerManager,
  type CoalescerManager,
} from "../../src/submitter/index.js";
import type { SubmitRequest, SubmitResult } from "../../src/submitter/types.js";
import type { OracleIntentBridge } from "../../src/lib-bridge/index.js";
import { createRealOracleIntentBridge } from "../../src/lib-bridge/index.js";
import { reconcileAllDestinations } from "../../src/lib-bridge/reconcile.js";
import { createCardanoWriteClient } from "../../src/submitter/cardano-write-client.js";
import {
  createApiServer,
  createMetrics,
  noopMetrics,
  type HealthState,
} from "../../src/api/index.js";
import { createDb, type DbConfig } from "../../src/persistence/index.js";
import { createFileLogger, type FileLogger } from "../../src/logger/file-logger.js";
import { runPreflight } from "../../src/submitter/preflight.js";
import { createDefaultRetryPolicy } from "../../src/submitter/retry-policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DaemonCmdOptions = {
  network: CardanoNetwork;
  configPath: string;
  transport: "http" | "ws";
  dryRun: boolean;
  cleanState: boolean;
  logLevel: string;
  report: (line: string) => void;
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Duration parser  "10s" | "5m" | "1h" → milliseconds
// ---------------------------------------------------------------------------
function parseDurationMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  const num = parseFloat(trimmed);
  if (isNaN(num)) return fallback;
  if (trimmed.endsWith("ms")) return Math.round(num);
  if (trimmed.endsWith("s"))  return Math.round(num * 1_000);
  if (trimmed.endsWith("m"))  return Math.round(num * 60_000);
  if (trimmed.endsWith("h"))  return Math.round(num * 3_600_000);
  return Math.round(num * 1_000); // bare number → seconds
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Delete all feeder-generated state for the given network so the next
 * run starts clean.  Never touches CLI bootstrap artifacts:
 *   config-bootstrap.json, clients/<name>.json.
 *
 * Deleted:
 *   state/<network>/logs/                    (all log streams)
 *   state/<network>/feeder-checkpoint.json   (block scanner position)
 *   state/<network>/feeder.sqlite*           (SQLite DB + WAL files)
 *   state/<network>/clients/*\/pairs/*.json  (feeder-written pair state)
 */
// ---------------------------------------------------------------------------
// Log-level filter
// ---------------------------------------------------------------------------

type LogLevelStr = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevelStr, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

/**
 * Wrap a base reporter so only messages at or above `minLevel` reach it.
 *
 * Messages may carry an explicit level prefix — `[debug]`, `[info]`,
 * `[warn]`, `[error]` — that is stripped before forwarding so the output
 * stays clean.  Messages with no prefix are treated as `info`.
 *
 * Scanner block-delivery lines (`scanner-ws:`, `scanner-http:`) are
 * automatically treated as `debug` regardless of any prefix.
 *
 * The file logger always receives the raw (prefixed) line so the full
 * record is preserved for post-hoc analysis.
 */
function createLeveledReport(
  base: (line: string) => void,
  minLevel: LogLevelStr,
): (line: string) => void {
  const min = LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.info;
  return (line: string) => {
    let msgLevel: LogLevelStr = "info";
    let stripped = line;
    for (const lv of Object.keys(LEVEL_ORDER) as LogLevelStr[]) {
      const tag = `[${lv}] `;
      if (line.startsWith(tag)) {
        msgLevel = lv;
        stripped = line.slice(tag.length);
        break;
      }
    }
    if (stripped.startsWith("scanner-ws:") || stripped.startsWith("scanner-http:")) {
      msgLevel = "debug";
    }
    if (LEVEL_ORDER[msgLevel] >= min) {
      base(stripped);
    }
  };
}

async function cleanFeederState(network: string, report: (line: string) => void): Promise<void> {
  const base = `state/${network.toLowerCase()}`;

  const targets: Array<{ path: string; isGlob?: boolean }> = [
    { path: `${base}/logs` },
    { path: `${base}/feeder-checkpoint.json` },
    { path: `${base}/feeder.sqlite` },
    { path: `${base}/feeder.sqlite-shm` },
    { path: `${base}/feeder.sqlite-wal` },
  ];

  // Pair state files: state/<network>/clients/*/pairs/*.json
  for await (const pairFile of glob(`${base}/clients/*/pairs/*.json`)) {
    targets.push({ path: pairFile });
  }

  for (const { path } of targets) {
    try {
      await rm(path, { recursive: true, force: true });
      report(`clean: removed ${path}`);
    } catch (err) {
      report(`clean: could not remove ${path} — ${(err as Error).message}`);
    }
  }
}

export async function runDaemon(options: DaemonCmdOptions): Promise<number> {
  const { network, configPath, transport, report: reportToConsole, signal } = options;

  const logLevel = (options.logLevel in LEVEL_ORDER
    ? options.logLevel as LogLevelStr
    : "info");
  const leveledConsole = createLeveledReport(reportToConsole, logLevel);

  if (options.cleanState) {
    leveledConsole(`daemon: --clean requested — deleting feeder state for network=${network}`);
    await cleanFeederState(network, leveledConsole);
    leveledConsole(`daemon: clean complete`);
  }

  // Mutable report — starts as leveled console, gets wrapped after fileLogger ready.
  // File always receives the full line (with level prefix intact for analysis).
  let report = leveledConsole;

  // ------------------------------------------------------------------
  // 1. Load + validate config.
  // ------------------------------------------------------------------
  report(`daemon: loading config at ${configPath} for network=${network}`);
  let config: ModularConfig;
  try {
    config = await loadModularConfig({ baseDir: configPath, network });
  } catch (err) {
    report(`daemon: config load failed — ${(err as Error).message}`);
    return 1;
  }

  const issues = validateModularConfig(config);
  if (countErrors(issues, report) > 0) {
    report("daemon: refusing to start — fix config errors above.");
    return 1;
  }

  // dry_run: YAML true || CLI --dry-run flag || DRY_RUN=true env var.
  const dryRun =
    config.infrastructure?.dry_run === true ||
    options.dryRun ||
    process.env.DRY_RUN?.trim().toLowerCase() === "true";

  let source: ResolvedSource;
  try {
    source = resolveSourceFromConfig(config);
  } catch (err) {
    report(`daemon: source resolution failed — ${(err as Error).message}`);
    return 1;
  }

  // ------------------------------------------------------------------
  // 2. Database.
  // ------------------------------------------------------------------
  const dbConfig = resolveDbConfig(network);
  const db = await createDb(dbConfig);
  await db.migrate();
  report(`daemon: database driver=${dbConfig.driver} ready`);

  // ------------------------------------------------------------------
  // 2b. File logger — structured JSON logs per intent/transaction.
  // ------------------------------------------------------------------
  const logDir = process.env.FEEDER_LOG_DIR?.trim() ?? `state/${network.toLowerCase()}/logs`;
  const fileLogger: FileLogger = await createFileLogger(logDir);
  
  // After fileLogger is ready, wrap so the file gets all lines (unfiltered)
  // while the console keeps the level filter applied above.
  report = fileLogger.getReportingFn(leveledConsole);
  
  report(`daemon: file logger ready at ${logDir}`);

  // ------------------------------------------------------------------
  // 3. Metrics — YAML wins over env, env is fallback.
  // ------------------------------------------------------------------
  const metricsEnabledYaml = config.infrastructure?.metrics?.enabled;
  const metricsEnabled =
    metricsEnabledYaml !== undefined
      ? metricsEnabledYaml
      : process.env.METRICS_ENABLED?.trim().toLowerCase() === "true";
  const metricsNamespace =
    config.infrastructure?.metrics?.namespace ??
    process.env.METRICS_NAMESPACE?.trim() ??
    "dia_feeder";
  const metrics = metricsEnabled
    ? await createMetrics({ namespace: metricsNamespace, defaultLabels: { network } })
    : noopMetrics;

  // ------------------------------------------------------------------
  // 4. Health state (mutated by the pipeline as it runs).
  // ------------------------------------------------------------------
  const healthState: HealthState = {
    lastRegistryPollMs: 0,
    lastSubmitMs: 0,
    maxStalenessMs: 5 * 60_000, // overwritten below after infra config is resolved
  };

  // ------------------------------------------------------------------
  // 5. Price cache.
  // ------------------------------------------------------------------
  const priceCache = createPriceCache();

  // ------------------------------------------------------------------
  // 6. HTTP API server — YAML wins over env, env is fallback.
  // ------------------------------------------------------------------
  const { host: apiHost, port: apiPort } = resolveApiAddr(config.infrastructure?.api?.listen_addr);
  const apiServer = createApiServer({
    host: apiHost,
    port: apiPort,
    metrics,
    priceCache,
    healthState,
  });
  await apiServer.start();
  report(`daemon: API server listening on ${apiHost}:${apiPort}`);

  // ------------------------------------------------------------------
  // 7. Resolve all YAML knobs before any subsystem that needs them.
  // ------------------------------------------------------------------
  const infra: InfrastructureConfig =
    config.infrastructure ?? ({} as InfrastructureConfig);
  const scanIntervalMs   = parseDurationMs(infra.block_scanner?.scan_interval,   10_000);
  const blockRange       = BigInt(infra.block_scanner?.block_range               ?? 500);
  const startBlock       = BigInt(infra.source?.start_block                      ?? 0);
  const confirmations    = 6n; // not in Spectra schema — keep fixed
  const dedupCapacity    = infra.event_processor?.dedup_cache_size               ?? 4096;
  const dedupTtlMs       = parseDurationMs(infra.event_processor?.dedup_cache_ttl, 60 * 60_000);
  const reconnectMs      = parseDurationMs(infra.event_monitor?.reconnect_interval, 5_000);
  const maxReconnects    = infra.event_monitor?.max_reconnect_attempts           ?? 60;
  const maxStalenessMs   = parseDurationMs(infra.health_check?.max_processing_lag, 5 * 60_000);
  const taskTimeoutMs    = parseDurationMs(infra.worker_pool?.task_timeout,         60_000);
  const retryDelayMs     = parseDurationMs(infra.worker_pool?.retry_delay,           5_000);
  const maxRetries       = infra.worker_pool?.max_retries                           ?? 3;

  healthState.maxStalenessMs = maxStalenessMs;

  // ------------------------------------------------------------------
  // 8. Router registry.
  // ------------------------------------------------------------------
  const routerRegistry = createRouterRegistry(config.routers);
  report(`daemon: router registry loaded (${routerRegistry.all.length} router(s))`);

  // ------------------------------------------------------------------
  // 9. Oracle intent bridge + queue manager.
  // ------------------------------------------------------------------
  // Bridge internals (UTxO fetches, Lucid calls) and write-client step
  // logs are debug-level — too verbose for normal operation.
  const debugReport = (line: string) => report(`[debug] ${line}`);

  const bridge: OracleIntentBridge = dryRun
    ? makeDryRunBridge(report)
    : createRealOracleIntentBridge({ log: debugReport });

  const retryPolicy = createDefaultRetryPolicy({ maxRetries, delayMs: retryDelayMs });

  const queueManager = createQueueManager({
    clientFactory: (clientStatePath, protocolStatePath) =>
      createCardanoWriteClient(clientStatePath, protocolStatePath, {
        bridge,
        log: debugReport,
        onStep: (intentHash, symbol, step, txHash) => {
          if (step !== "tx_start") {
            void fileLogger.logIntentStep({
              ts: new Date().toISOString(), level: "info",
              intentHash, symbol, step, message: step,
              meta: txHash ? { txHash } : undefined,
            });
          }
          void fileLogger.logTransactionEvent({
            ts: new Date().toISOString(),
            event: step, intentHash, symbol,
            txHash,
          });
        },
        onTransaction: async (entry) => {
          await fileLogger.logTransactionEvent({
            ts: entry.ts,
            event: entry.status === "confirmed" ? "tx_confirmed" : "tx_failed",
            intentHash: entry.intentHash,
            symbol: entry.symbol,
            txHash: entry.txHash || undefined,
            isCreate: entry.isCreate,
            total_ms: entry.total_ms,
            errorCode: entry.errorCode,
            errorMessage: entry.errorMessage,
          });
          await fileLogger.logTransaction(entry);
        },
      }),
    taskTimeoutMs,
    retryPolicy,
  });

  const coalesceWindowMs = parseDurationMs(infra.event_processor?.coalesce_window, 2_000);
  const maxIntentAgeRaw  = infra.event_processor?.max_intent_age;
  const maxIntentAgeMs   = maxIntentAgeRaw ? parseDurationMs(maxIntentAgeRaw, 0) || undefined : undefined;

  const coalescerManager = createCoalescerManager({
    queueManager,
    coalesceWindowMs,
    maxIntentAgeMs,
    onResult: async (result: SubmitResult, req: SubmitRequest) => {
      if (result.ok) {
        healthState.lastSubmitMs = Date.now();
        metrics.cardanoTxSubmitted.inc({ network });
        const { routerId, destinationIndex, enriched } = req;
        const { symbol, price, timestamp } = enriched.fullIntent;
        priceCache.set(
          { routerId, destinationIndex, symbol },
          {
            symbol,
            price,
            timestamp,
            intentHash: result.intentHash,
            cardanoTxHash: result.cardanoTxHash,
            updatedAtMs: Date.now(),
          },
        );
        void db.insertTransactionLog({
          intentHash: result.intentHash,
          cardanoTxHash: result.cardanoTxHash,
          routerId,
          destinationIndex,
          clientStatePath: req.destination.client_state_path,
          status: "confirmed",
          submittedAtMs: Date.now(),
          confirmedAtMs: Date.now(),
        });
        await fileLogger.logIntentStep({
          ts: new Date().toISOString(),
          level: "info",
          intentHash: result.intentHash,
          symbol,
          step: "confirm",
          message: `Cardano transaction confirmed`,
          meta: { cardanoTxHash: result.cardanoTxHash },
        });
      } else {
        metrics.cardanoTxFailed.inc({ network });
        const symbol = req.enriched.fullIntent.symbol;
        report(
          `[error] daemon: TRANSACTION FAILED — code=${result.code} intentHash=${result.intentHash} ` +
          `symbol=${symbol} error="${result.error.message}"`,
        );
        report(`[warn] daemon: REMEDIATION — ${result.remediation}`);
        void db.insertTransactionLog({
          intentHash: result.intentHash,
          cardanoTxHash: "",
          routerId: req.routerId,
          destinationIndex: req.destinationIndex,
          clientStatePath: req.destination.client_state_path,
          status: "failed",
          submittedAtMs: Date.now(),
        });
        await fileLogger.logIntentStep({
          ts: new Date().toISOString(),
          level: "error",
          intentHash: result.intentHash,
          symbol,
          step: "failed",
          message: `Cardano transaction failed: ${result.error.message}`,
          meta: { code: result.code, remediation: result.remediation, error: result.error.message },
        });
      }
    },
    onSupersede: async (superseded: SubmitRequest, by: SubmitRequest) => {
      await fileLogger.logIntentStep({
        ts: new Date().toISOString(), level: "info",
        intentHash: superseded.intentHash,
        symbol: superseded.enriched.fullIntent.symbol,
        step: "superseded",
        message: `Superseded by newer intent`,
        meta: { supersededByHash: by.intentHash },
      });
    },
    onLaneEvent: async (event) => {
      await fileLogger.logLaneEvent({
        ts: new Date().toISOString(),
        lane: event.lane,
        event: event.kind,
        symbol: event.symbol,
        intentHash: event.intentHash,
        supersededByHash: event.supersededByHash,
        bufferSize: event.bufferSize,
        fromState: event.fromState,
        toState: event.toState,
      });
    },
  });

  // ------------------------------------------------------------------
  // 9.5. Startup reconciliation — sync local pair-state files with the
  //      live on-chain pair UTxOs for every Cardano destination. Runs
  //      once before the scan pipeline starts. Failures are logged as
  //      warnings; they do not abort startup.
  // ------------------------------------------------------------------
  if (!dryRun) {
    await reconcileAllDestinations({ config, log: report });
  }

  // ------------------------------------------------------------------
  // 10. Source pipeline.
  // ------------------------------------------------------------------
  const checkpointPath = defaultCheckpointPath(network);
  const checkpoint = createJsonCheckpoint({ filePath: checkpointPath });
  const dedupCache = createDedupCache({
    capacity: dedupCapacity,
    ttlMs: dedupTtlMs,
  });

  const enricherClient = createPublicClient({ transport: http(source.rpcUrls[0]) });
  const enricher = createRegistryEnricher({
    client: enricherClient as PublicClient,
    registryAddress: source.registryAddress,
    enrichmentAbi: source.enrichmentAbi,
  });

  const handleBatch = async (batch: ScannedBatch): Promise<void> => {
    healthState.lastRegistryPollMs = Date.now();
    metrics.eventsScanned.inc({ chain_id: String(source.chainId) });

    for (const event of batch.events) {
      await processOneEvent({
        event,
        dedupCache,
        enricher,
        routerRegistry,
        priceCache,
        coalescerManager,
        fileLogger,
        network,
        dryRun,
        report,
        metrics,
      });
    }
  };

  report(
    `daemon: starting scan pipeline transport=${transport} chain_id=${source.chainId} ` +
    `registry=${source.registryAddress} dry_run=${dryRun} ` +
    `blockRange=${blockRange} scanIntervalMs=${scanIntervalMs} dedupCapacity=${dedupCapacity} ` +
    `reconnectMs=${reconnectMs} maxReconnects=${maxReconnects}`,
  );

  try {
    switch (transport) {
      case "http":
        await runHttpTransport({ source, checkpoint, handleBatch, signal, report,
          startBlock, blockRange, scanIntervalMs, confirmations });
        break;
      case "ws":
        await runWsTransport({ source, checkpoint, handleBatch, network, signal, report,
          reconnectIntervalMs: reconnectMs, maxReconnects });
        break;
    }
    report("daemon: scan pipeline exited cleanly.");
    return 0;
  } catch (err) {
    report(`daemon: scan pipeline failed — ${(err as Error).message}`);
    return 1;
  } finally {
    await apiServer.stop();
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// Per-event processing
// ---------------------------------------------------------------------------

type ProcessOneEventInputs = {
  event: ExtractedEvent;
  dedupCache: ReturnType<typeof createDedupCache>;
  enricher: (event: ExtractedEvent) => Promise<EnrichedIntent>;
  routerRegistry: ReturnType<typeof createRouterRegistry>;
  priceCache: ReturnType<typeof createPriceCache>;
  coalescerManager: CoalescerManager;
  fileLogger: FileLogger;
  network: string;
  dryRun: boolean;
  report: (line: string) => void;
  metrics: typeof noopMetrics;
};

async function processOneEvent(inputs: ProcessOneEventInputs): Promise<void> {
  const {
    event, dedupCache, enricher, routerRegistry,
    priceCache, coalescerManager, fileLogger, dryRun, report, metrics,
  } = inputs;

  if (!dedupCache.add(event.intentHash)) {
    metrics.eventsDedupHit.inc({ chain_id: String(event.blockNumber) });
    return;
  }

  let enriched: EnrichedIntent;
  try {
    enriched = await enricher(event);
  } catch (err) {
    report(`daemon: enrichment failed for ${event.intentHash}: ${(err as Error).message}`);
    return;
  }

  const transformed = identityTransformer(enriched);
  const output = routeIntent(routerRegistry, priceCache, "IntentRegistered", transformed);

  for (const { routerId, reason } of output.conditionFiltered) {
    metrics.intentsFiltered.inc({ router_id: routerId, reason: "condition" });
    report(`[debug] daemon: condition-filtered router=${routerId} reason="${reason}"`);
  }
  for (const { routerId, destinationIndex } of output.policyFiltered) {
    metrics.intentsFiltered.inc({ router_id: routerId, reason: "policy" });
    report(`[debug] daemon: policy-filtered router=${routerId} dest=${destinationIndex}`);
  }

  for (const dispatch of output.dispatched) {
    metrics.intentsRouted.inc({ router_id: dispatch.routerId });

    const cardano = dispatch.destination.cardano;
    if (!cardano) {
      report(
        `[warn] daemon: skipping router=${dispatch.routerId} dest=${dispatch.destinationIndex} — no cardano block in destination config`,
      );
      continue;
    }

    // Log intent lifecycle start (only for intents that pass filters)
    const now = new Date().toISOString();
    
    // 1. enriched (await to ensure order)
    await fileLogger.logIntentStep({
      ts: now,
      level: "info",
      intentHash: event.intentHash,
      symbol: enriched.fullIntent.symbol,
      step: "enriched",
      message: `Intent enriched: ${enriched.fullIntent.symbol} @ ${enriched.fullIntent.price.toString()}`,
      meta: { 
        price: enriched.fullIntent.price.toString(), 
        timestamp: enriched.fullIntent.timestamp.toString(),
        expiry: enriched.fullIntent.expiry.toString(),
        blockNumber: Number(event.blockNumber),
      },
    });
    
    // 2. routed (passed filters)
    await fileLogger.logIntentStep({
      ts: now,
      level: "info",
      intentHash: event.intentHash,
      symbol: enriched.fullIntent.symbol,
      step: "routed",
      message: `Intent passed all filters`,
      meta: { routerId: dispatch.routerId, destinationIndex: dispatch.destinationIndex },
    });

    // 3. preflight — fast checks before the intent occupies a queue slot
    const preflight = runPreflight({ enriched, intentHash: event.intentHash });
    if (!preflight.ok) {
      report(
        `[warn] daemon: preflight rejected router=${dispatch.routerId} ` +
        `code=${preflight.code} intentHash=${event.intentHash} reason="${preflight.reason}"`,
      );
      await fileLogger.logIntentStep({
        ts: new Date().toISOString(),
        level: "warn",
        intentHash: event.intentHash,
        symbol: enriched.fullIntent.symbol,
        step: "preflight_rejected",
        message: preflight.reason,
        meta: { code: preflight.code, remediation: preflight.remediation },
      });
      metrics.intentsFiltered.inc({ router_id: dispatch.routerId, reason: preflight.code });
      continue;
    }

    if (dryRun) {
      report(
        `daemon: [dry-run] would submit router=${dispatch.routerId} dest=${dispatch.destinationIndex} ` +
        `symbol=${enriched.fullIntent.symbol} price=${enriched.fullIntent.price} intentHash=${event.intentHash}`,
      );
      continue;
    }

    const req: SubmitRequest = {
      intentHash: event.intentHash,
      enriched: transformed,
      destination: cardano,
      routerId: dispatch.routerId,
      destinationIndex: dispatch.destinationIndex,
    };

    // 3. hand off to coalescer (supersession + accumulation window)
    await fileLogger.logIntentStep({
      ts: new Date().toISOString(),
      level: "info",
      intentHash: event.intentHash,
      symbol: enriched.fullIntent.symbol,
      step: "queued",
      message: `Intent accepted by coalescer`,
      meta: { routerId: dispatch.routerId, destinationIndex: dispatch.destinationIndex, clientStatePath: cardano.client_state_path },
    });

    coalescerManager.accept(req);
  }
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

type TransportInputs = {
  source: ResolvedSource;
  checkpoint: Checkpoint;
  handleBatch: (batch: ScannedBatch) => Promise<void>;
  signal?: AbortSignal;
  report: (line: string) => void;
  network?: CardanoNetwork;
  // HTTP
  startBlock?: bigint;
  blockRange?: bigint;
  scanIntervalMs?: number;
  confirmations?: bigint;
  // WS
  reconnectIntervalMs?: number;
  maxReconnects?: number;
};

async function runHttpTransport(inputs: TransportInputs): Promise<void> {
  const client: RegistryClient = createHttpRegistryClient(inputs.source);
  try {
    await runHttpScanner({
      client,
      eventAbi: inputs.source.eventAbi,
      checkpoint: inputs.checkpoint,
      startBlock: inputs.startBlock ?? 0n,
      blockRange: inputs.blockRange ?? 500n,
      scanIntervalMs: inputs.scanIntervalMs ?? 10_000,
      confirmations: inputs.confirmations ?? 6n,
      onBatch: inputs.handleBatch,
      log: inputs.report,
      signal: inputs.signal,
    });
  } finally {
    await client.close();
  }
}

async function runWsTransport(inputs: TransportInputs & { network: CardanoNetwork }): Promise<void> {
  if (!inputs.source.wsUrl) {
    throw new Error(
      "infrastructure.source.ws_url not set — use --transport http or add ws_url to the infrastructure YAML.",
    );
  }
  const wsUrl = composeAuthenticatedWsUrl(inputs.source.wsUrl, inputs.network);
  await runWsScanner({
    wsUrl,
    registryAddress: inputs.source.registryAddress,
    eventAbi: inputs.source.eventAbi,
    checkpoint: inputs.checkpoint,
    onBatch: inputs.handleBatch,
    reconnectIntervalMs: inputs.reconnectIntervalMs ?? 5_000,
    maxReconnects: inputs.maxReconnects ?? 60,
    log: inputs.report,
    signal: inputs.signal,
  });
}

// ---------------------------------------------------------------------------
// Bridge stubs
// ---------------------------------------------------------------------------

function makeDryRunBridge(report: (line: string) => void): OracleIntentBridge {
  return {
    async submitOracleUpdate(params) {
      report(
        `daemon: [dry-run bridge] submitOracleUpdate intentHash=${params.intentHash} ` +
        `client=${params.clientStatePath}`,
      );
      return {
        txHash: "dry-run-tx-hash",
        receiverUnit: "dry-run-receiver-unit",
        pairUnit: "dry-run-pair-unit",
        isCreate: false,
      };
    },
  };
}


// ---------------------------------------------------------------------------
// Config + env helpers
// ---------------------------------------------------------------------------

function resolveDbConfig(network: CardanoNetwork): DbConfig {
  const driver = (process.env.DATABASE_DRIVER?.trim() ?? "sqlite") as "sqlite" | "postgres";
  const suffix = network === "Mainnet" ? "MAINNET" : "TESTNET";

  if (driver === "postgres") {
    const dsn = process.env[`DATABASE_DSN_${suffix}`]?.trim();
    if (!dsn) {
      throw new Error(
        `DATABASE_DSN_${suffix} is required when DATABASE_DRIVER=postgres.`,
      );
    }
    return { driver: "postgres", dsn };
  }

  const defaultPath = `state/${network.toLowerCase()}/feeder.sqlite`;
  const filePath = process.env[`DATABASE_PATH_${suffix}`]?.trim() ?? defaultPath;
  return { driver: "sqlite", path: filePath };
}

/**
 * Resolve the API listen address. Priority (highest first):
 *   1. `infrastructure.api.listen_addr` in the network YAML
 *   2. `API_LISTEN_ADDR` env var
 *   3. hard default ":8080"
 */
function resolveApiAddr(yamlAddr?: string): { host: string; port: number } {
  const raw = yamlAddr?.trim() ?? process.env.API_LISTEN_ADDR?.trim() ?? ":8080";
  const colonIdx = raw.lastIndexOf(":");
  const host = colonIdx > 0 ? raw.slice(0, colonIdx) : "0.0.0.0";
  const port = parseInt(raw.slice(colonIdx + 1), 10) || 8080;
  return { host, port };
}

function countErrors(issues: ValidationIssue[], report: (line: string) => void): number {
  let n = 0;
  for (const issue of issues) {
    const tag = issue.severity === "error" ? "ERROR" : "WARN ";
    report(`[${tag}] ${issue.path || "(root)"}: ${issue.message}`);
    if (issue.severity === "error") n++;
  }
  return n;
}
