// Orchestrator that drives the same protocol flow as
// `offchain/cli/scripts/run-all-cli.sh`, but against an in-memory Lucid
// Emulator. Reuses the existing CLI builders verbatim — every step
// here is a direct call into `src/init`, `src/deploys`,
// `src/transactions`, or `src/oracle`. The only adaptation is
// `installEmulatorLucid` in `src/emulator/lucid-injection.ts`, which
// redirects `makeConfiguredLucid` / `selectConfiguredWallet` at the
// emulator before this orchestrator runs.
//
// State is threaded through a temporary working directory exactly the
// way the bash script threads state through `state/preview_*`. Each
// builder reads its previous state from a JSON file and writes the
// updated state back to the same path. This mirrors what
// `src/index.ts` does at the CLI command layer, so the emulator
// orchestrator works without any builder-signature changes.

import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Emulator } from "@lucid-evolution/lucid";

import {
  installEmulatorLucid,
  uninstallEmulatorLucid,
} from "./lucid-injection.js";
import { writeStateJsonFile } from "../core/state.js";
import { setTxMetricsObserver } from "../core/tx-metrics.js";
import type { TxResourceMetrics } from "../core/tx-metrics.js";
import type { LucidInstance } from "../core/lucid.js";
import { getNetworkNow } from "../core/network-time.js";

const CLIENT_ID = "client-a";
const DOMAIN_NAME = "DIA Oracle";
const RECEIVER_TOP_UP_1_LOVELACE = "30000000";
const RECEIVER_TOP_UP_2_LOVELACE = "30000000";
const RECEIVER_WITHDRAW_LOVELACE = "5000000";
const PAYMENT_HOOK_WITHDRAW_LOVELACE = "10000000";

// Same pairs and prices as `run-all-cli.sh`. The 11-pair bootstrap covers
// USDC/USD first (the receiver-bootstrap pair) and then 10 batch-eligible
// pairs (btc-usd through dot-usd) that the batch tests draw from.
const PAIR_CATALOG = [
  { slug: "usdc-usd",  symbol: "USDC/USD",  bootstrapPrice: "100045678",     batchPrice: null              },
  { slug: "btc-usd",   symbol: "BTC/USD",   bootstrapPrice: "6000000000000", batchPrice: "6001000000000"  },
  { slug: "eth-usd",   symbol: "ETH/USD",   bootstrapPrice: "250000000000",  batchPrice: "250100000000"   },
  { slug: "ada-usd",   symbol: "ADA/USD",   bootstrapPrice: "750000000",     batchPrice: "751000000"      },
  { slug: "usdt-usd",  symbol: "USDT/USD",  bootstrapPrice: "100001234",     batchPrice: "100101234"      },
  { slug: "dai-usd",   symbol: "DAI/USD",   bootstrapPrice: "100000345",     batchPrice: "100100345"      },
  { slug: "sol-usd",   symbol: "SOL/USD",   bootstrapPrice: "18500000000",   batchPrice: "18510000000"    },
  { slug: "bnb-usd",   symbol: "BNB/USD",   bootstrapPrice: "61500000000",   batchPrice: "61510000000"    },
  { slug: "xrp-usd",   symbol: "XRP/USD",   bootstrapPrice: "520000000",     batchPrice: "521000000"      },
  { slug: "matic-usd", symbol: "MATIC/USD", bootstrapPrice: "980000000",     batchPrice: "981000000"      },
  { slug: "dot-usd",   symbol: "DOT/USD",   bootstrapPrice: "420000000",     batchPrice: "421000000"      },
] as const;

const BATCH_PAIRS = PAIR_CATALOG.slice(1); // 10 batch-eligible pairs (excludes usdc-usd)

export type EmulatorProtocolFlowArgs = {
  lucid: LucidInstance;
  emulator: Emulator;
  walletSeedPhrase: string;
  workDir?: string;
  keepWorkDir?: boolean;
  reportProgress?: (message: string) => void;
  // Batch sizes (in pairs) to attempt after the 11 singles complete.
  // Each one is built with `submitBatchOracleUpdate` against a fresh
  // manifest. The orchestrator submits in descending order (matching
  // `run-all-cli.sh`'s strategy of trying 10/9/8/7/6/5 and stopping at
  // the first success), but the report captures every attempt with its
  // exec-units + outcome. Default: [10, 9, 8, 7, 6, 5].
  batchSizes?: number[];
};

export type EmulatorStepReport = {
  label: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  metrics?: TxResourceMetrics;
};

export type EmulatorProtocolFlowReport = {
  workDir: string;
  workDirCleanedUp: boolean;
  steps: EmulatorStepReport[];
  batchAttempts: Array<{
    size: number;
    ok: boolean;
    metrics?: TxResourceMetrics;
    error?: string;
  }>;
};

export async function runEmulatorProtocolFlow(
  args: EmulatorProtocolFlowArgs,
): Promise<EmulatorProtocolFlowReport> {
  const reportProgress = args.reportProgress ?? (() => undefined);
  const workDir =
    args.workDir ??
    (await mkdtemp(path.join(os.tmpdir(), "dia-emulator-flow-")));
  const protocolStatePath = path.join(workDir, "config-bootstrap.json");
  const clientsDir = path.join(workDir, "clients");
  const clientStatePath = path.join(clientsDir, `${CLIENT_ID}.json`);
  const pairsDir = path.join(clientsDir, CLIENT_ID, "pairs");
  const intentsDir = path.join(workDir, "intents");
  const manifestsDir = path.join(workDir, "update-batches");
  await mkdir(clientsDir, { recursive: true });
  await mkdir(pairsDir, { recursive: true });
  await mkdir(intentsDir, { recursive: true });
  await mkdir(manifestsDir, { recursive: true });

  const steps: EmulatorStepReport[] = [];
  const batchAttempts: EmulatorProtocolFlowReport["batchAttempts"] = [];
  const batchSizes = (args.batchSizes ?? [10, 9, 8, 7, 6, 5]).slice();

  installEmulatorLucid({
    lucid: args.lucid,
    emulator: args.emulator,
    walletSeedPhrase: args.walletSeedPhrase,
  });

  try {
    // ── Protocol bootstrap ──────────────────────────────────────────
    await runStep(steps, "protocol:init", reportProgress, async () => {
      const { initializeProtocolState } = await import("../init/protocol-init.js");
      const state = await initializeProtocolState({ useDefaults: true });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runStep(steps, "config:parameterize", reportProgress, async () => {
      const { parameterizeConfigScripts } = await import(
        "../deploys/config-parameterize.js"
      );
      const state = await parameterizeConfigScripts({ statePath: protocolStatePath });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "config:bootstrap", reportProgress, async () => {
      const { configBootstrap } = await import("../deploys/config-bootstrap.js");
      const state = await configBootstrap({ statePath: protocolStatePath, buildOnly: false });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "config:reference-scripts", reportProgress, async () => {
      const { publishConfigReferenceScripts } = await import(
        "../deploys/config-reference-scripts.js"
      );
      const state = await publishConfigReferenceScripts({
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runStep(steps, "payment-hook:parameterize", reportProgress, async () => {
      const { parameterizePaymentHookScripts } = await import(
        "../deploys/payment-hook-parameterize.js"
      );
      const state = await parameterizePaymentHookScripts({ statePath: protocolStatePath });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "payment-hook:bootstrap", reportProgress, async () => {
      const { paymentHookBootstrap } = await import(
        "../deploys/payment-hook-bootstrap.js"
      );
      const state = await paymentHookBootstrap({ statePath: protocolStatePath, buildOnly: false });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "payment-hook:reference-script", reportProgress, async () => {
      const { publishPaymentHookReferenceScript } = await import(
        "../deploys/payment-hook-reference-script.js"
      );
      const state = await publishPaymentHookReferenceScript({
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    // ── Client onboarding ───────────────────────────────────────────
    await runStep(steps, "client:init", reportProgress, async () => {
      const { initializeClientState } = await import("../init/client-init.js");
      const state = await initializeClientState({
        statePath: protocolStatePath,
        clientId: CLIENT_ID,
        useDefaults: true,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    await runStep(steps, "receiver:parameterize", reportProgress, async () => {
      const { parameterizeReceiverScripts } = await import(
        "../deploys/receiver-parameterize.js"
      );
      const state = await parameterizeReceiverScripts({
        statePath: clientStatePath,
        protocolStatePath,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    await runTxStep(steps, "receiver:bootstrap", reportProgress, async () => {
      const { receiverBootstrap } = await import("../deploys/receiver-bootstrap.js");
      const state = await receiverBootstrap({
        statePath: clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    await runTxStep(steps, "reference-scripts:publish-client", reportProgress, async () => {
      const { publishClientReferenceScripts } = await import(
        "../deploys/client-reference-scripts.js"
      );
      const state = await publishClientReferenceScripts({
        statePath: clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    await runTxStep(steps, "receiver:top-up:1", reportProgress, async () => {
      const { receiverTopUp } = await import("../transactions/receiver-top-up.js");
      const state = await receiverTopUp({
        amountLovelace: RECEIVER_TOP_UP_1_LOVELACE,
        statePath: clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    // ── 11 single oracle updates (one per pair in the catalog) ──────
    for (const pair of PAIR_CATALOG) {
      const intentPath = path.join(intentsDir, `${pair.slug}.signed.json`);
      const pairStatePath = path.join(pairsDir, `${pair.slug}.json`);

      await runStep(steps, `intent:create-and-sign:${pair.slug}`, reportProgress, async () => {
        const { createAndSignPreviewOracleIntent } = await import(
          "../oracle/intent-create.js"
        );
        const signed = await createAndSignPreviewOracleIntent({
          statePath: protocolStatePath,
          intentType: "OracleUpdate",
          symbol: pair.symbol,
          price: pair.bootstrapPrice,
          source: DOMAIN_NAME,
        });
        await writeStateJsonFile(intentPath, signed);
      });

      await runTxStep(steps, `update:${pair.slug}`, reportProgress, async () => {
        const { submitOracleUpdate } = await import("../transactions/update.js");
        const state = await submitOracleUpdate({
          intentPath,
          statePath: pairStatePath,
          clientStatePath,
          protocolStatePath,
          buildOnly: false,
        });
        await writeStateJsonFile(pairStatePath, state);
      });
    }

    // ── Second top-up before the batch attempts ────────────────────
    await runTxStep(steps, "receiver:top-up:2", reportProgress, async () => {
      const { receiverTopUp } = await import("../transactions/receiver-top-up.js");
      const state = await receiverTopUp({
        amountLovelace: RECEIVER_TOP_UP_2_LOVELACE,
        statePath: clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    // ── Fresh batch-signed intents (separate from bootstrap intents) ─
    // The bootstrap intents already committed monotone (timestamp,
    // nonce). The batch attempts need newer intents. The emulator can
    // execute many CLI steps in the same second, so pin the batch intent
    // clock forward explicitly instead of relying on wall-clock drift.
    const batchIntentNow = await getNetworkNow(args.lucid);
    let batchIntentOffset = 60n;
    for (const pair of BATCH_PAIRS) {
      if (!pair.batchPrice) continue;
      const intentPath = path.join(intentsDir, `${pair.slug}-batch.signed.json`);
      await runStep(steps, `intent:create-and-sign:${pair.slug}:batch`, reportProgress, async () => {
        const { createAndSignPreviewOracleIntent } = await import(
          "../oracle/intent-create.js"
        );
        const timestamp = batchIntentNow.unixTimeSec + batchIntentOffset;
        const nonce = BigInt(batchIntentNow.unixTimeMs) + batchIntentOffset * 1000n;
        batchIntentOffset += 1n;
        const signed = await createAndSignPreviewOracleIntent({
          statePath: protocolStatePath,
          intentType: "OracleUpdate",
          timestamp: timestamp.toString(),
          nonce: nonce.toString(),
          expiry: (timestamp + 3600n).toString(),
          symbol: pair.symbol,
          price: pair.batchPrice,
          source: DOMAIN_NAME,
        });
        await writeStateJsonFile(intentPath, signed);
      });
    }

    // ── Batch attempts (descending, stop at first success) ─────────
    let firstBatchSuccessSize: number | null = null;
    for (const size of batchSizes.sort((a, b) => b - a)) {
      const manifestPath = path.join(manifestsDir, `batch-${size}.manifest.json`);
      const resultPath = path.join(manifestsDir, `batch-${size}.result.json`);

      // Build the manifest in memory (same format as
      // `init/batch-update-create.ts`, but skips the interactive prompt).
      const updates = BATCH_PAIRS.slice(0, size).map((pair) => ({
        statePath: path.join(pairsDir, `${pair.slug}.json`),
        intentPath: path.join(intentsDir, `${pair.slug}-batch.signed.json`),
      }));
      await writeFile(
        manifestPath,
        JSON.stringify({ updates }, null, 2) + "\n",
        "utf8",
      );

      let attemptOk = false;
      let attemptMetrics: TxResourceMetrics | undefined;
      let attemptError: string | undefined;

      try {
        await runTxStep(
          steps,
          `update:batch:${size}`,
          reportProgress,
          async () => {
            const { submitBatchOracleUpdate } = await import(
              "../transactions/update-batch.js"
            );
            const result = await submitBatchOracleUpdate({
              manifestPath,
              clientStatePath,
              protocolStatePath,
              buildOnly: false,
            });
            await writeStateJsonFile(resultPath, result);
            attemptOk = true;
          },
          (m) => {
            attemptMetrics = m;
          },
        );
        if (firstBatchSuccessSize === null) firstBatchSuccessSize = size;
      } catch (error) {
        attemptError = error instanceof Error ? error.message : String(error);
      }

      batchAttempts.push({
        size,
        ok: attemptOk,
        metrics: attemptMetrics,
        error: attemptError,
      });

      if (firstBatchSuccessSize !== null) break;
    }

    if (firstBatchSuccessSize === null) {
      // No batch size succeeded. The flow returns here without running
      // settle / withdraws / reclaim because they depend on receiver
      // accrued fees produced by a successful batch (matches
      // `run-all-cli.sh` semantics).
      return finalize();
    }

    // ── Settle, withdraws, reclaim + republish ─────────────────────
    await runTxStep(steps, "settle", reportProgress, async () => {
      const { settleAccruedFees } = await import("../transactions/settle.js");
      await settleAccruedFees({
        protocolStatePath,
        clientStatePath,
        buildOnly: false,
      });
    });

    await runTxStep(steps, "receiver:withdraw", reportProgress, async () => {
      const { receiverWithdraw } = await import("../transactions/receiver-withdraw.js");
      const state = await receiverWithdraw({
        amountLovelace: RECEIVER_WITHDRAW_LOVELACE,
        statePath: clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    await runTxStep(steps, "payment-hook:withdraw", reportProgress, async () => {
      const { paymentHookWithdraw } = await import(
        "../transactions/payment-hook-withdraw.js"
      );
      const state = await paymentHookWithdraw({
        amountLovelace: PAYMENT_HOOK_WITHDRAW_LOVELACE,
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "reclaim:payment-hook-reference-script", reportProgress, async () => {
      const { reclaimProtocolReferenceScript } = await import(
        "../transactions/reclaim-reference-script.js"
      );
      const state = await reclaimProtocolReferenceScript({
        script: "payment-hook",
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "republish:payment-hook-reference-script", reportProgress, async () => {
      const { publishPaymentHookReferenceScript } = await import(
        "../deploys/payment-hook-reference-script.js"
      );
      const state = await publishPaymentHookReferenceScript({
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    return finalize();
  } finally {
    uninstallEmulatorLucid();
    if (!args.keepWorkDir && !args.workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  function finalize(): EmulatorProtocolFlowReport {
    return {
      workDir,
      workDirCleanedUp: !args.keepWorkDir && !args.workDir,
      steps,
      batchAttempts,
    };
  }
}

// Step variants — non-tx steps (init / parameterize / intent signing).
async function runStep(
  steps: EmulatorStepReport[],
  label: string,
  reportProgress: (message: string) => void,
  body: () => Promise<void>,
): Promise<void> {
  reportProgress(`[emulator-flow] ${label} start`);
  const startedAt = Date.now();
  try {
    await body();
    const durationMs = Date.now() - startedAt;
    steps.push({ label, durationMs, ok: true });
    reportProgress(`[emulator-flow] ${label} ok (${durationMs}ms)`);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ label, durationMs, ok: false, error: message });
    reportProgress(`[emulator-flow] ${label} FAILED (${durationMs}ms): ${message}`);
    throw error;
  }
}

// Step variant for tx-submitting builders — captures exec-units via
// the `setTxMetricsObserver` hook. The observer fires synchronously
// inside `reportTxSignBuilderMetrics`, so we install it before the
// builder runs and clear it after, even on failure.
async function runTxStep(
  steps: EmulatorStepReport[],
  label: string,
  reportProgress: (message: string) => void,
  body: () => Promise<void>,
  metricsHook?: (metrics: TxResourceMetrics) => void,
): Promise<void> {
  reportProgress(`[emulator-flow] ${label} start`);
  const startedAt = Date.now();
  let captured: TxResourceMetrics | undefined;
  setTxMetricsObserver((m) => {
    captured = m;
    metricsHook?.(m);
  });
  try {
    await body();
    const durationMs = Date.now() - startedAt;
    steps.push({ label, durationMs, ok: true, metrics: captured });
    if (captured) {
      reportProgress(
        `[emulator-flow] ${label} ok (${durationMs}ms) fee=${captured.feeAda} ADA cpu=${captured.exUnits.cpu} mem=${captured.exUnits.mem}`,
      );
    } else {
      reportProgress(`[emulator-flow] ${label} ok (${durationMs}ms)`);
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ label, durationMs, ok: false, error: message, metrics: captured });
    reportProgress(`[emulator-flow] ${label} FAILED (${durationMs}ms): ${message}`);
    throw error;
  } finally {
    setTxMetricsObserver(null);
  }
}
