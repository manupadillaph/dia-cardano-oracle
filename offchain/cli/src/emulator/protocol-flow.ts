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

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
// Single, generous top-up. Sized to cover up to PAIR_CATALOG.length (20)
// probe iterations: each iteration is one create (`base + per_pair`) plus one
// batch-N (`base + N*per_pair`). With base=0.6 / per_pair=0.4, the worst-case
// probe burn is ~136 ADA; 200 ADA leaves room for the final withdraw step.
const RECEIVER_TOP_UP_LOVELACE = "200000000";
const RECEIVER_WITHDRAW_LOVELACE = "5000000";
const PAYMENT_HOOK_WITHDRAW_LOVELACE = "10000000";

// The probe doesn't use a hardcoded pair list. Each iteration mints a fresh
// pair `pair-N` on the fly: the slug and symbol come from the counter, and
// prices are derived numerically so every intent is unique. The probe keeps
// going until a batch tx fails (over-budget exec-units, validator
// rejection, …) or — as a defensive guard — until `PROBE_SAFETY_CAP` is hit.
// The cap is set generously above any plausible Plutus V3 ceiling so a
// healthy run never bumps into it; it exists only so a regression in
// failure detection cannot turn the probe into an infinite loop.
const PROBE_SAFETY_CAP = 100;

type ProbePair = {
  slug: string;
  symbol: string;
  bootstrapPrice: string;
  batchPrice: string;
};

function makeProbePair(index1: number): ProbePair {
  // `index1` is 1-based ("pair-1" for the first probe iteration). Prices are
  // separated by 1 so create→update has a strictly-greater value on each
  // pair without colliding across pairs.
  const base = 1_000_000n + BigInt(index1) * 1_000n;
  return {
    slug: `pair-${index1}`,
    symbol: `PAIR${index1}/USD`,
    bootstrapPrice: base.toString(),
    batchPrice: (base + 1n).toString(),
  };
}

export type EmulatorProtocolFlowArgs = {
  lucid: LucidInstance;
  emulator: Emulator;
  walletSeedPhrase: string;
  workDir?: string;
  keepWorkDir?: boolean;
  reportProgress?: (message: string) => void;
  // When `undefined`, the orchestrator runs in **probe mode**: it grows the
  // pair set by one in lockstep with the batch size, attempting batch-1 →
  // batch-2 → … and stops at the first batch that fails. The report keeps
  // every attempt's exec-units so callers can see the cliff.
  // When set to N, the orchestrator runs in **single-shot mode**: it seeds
  // exactly N pairs (via single updates) and runs one batch-N. No probe,
  // no fallback. If batch-N fails the run reports failure for that size.
  batchSize?: number;
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
  // Mode: probe (default) walks N=1,2,3,…; single-shot uses exactly N.
  const fixedBatchSize = args.batchSize;
  if (fixedBatchSize !== undefined) {
    if (!Number.isInteger(fixedBatchSize) || fixedBatchSize < 1) {
      throw new Error(`batchSize must be a positive integer (got: ${fixedBatchSize})`);
    }
    if (fixedBatchSize > PROBE_SAFETY_CAP) {
      throw new Error(
        `batchSize ${fixedBatchSize} exceeds PROBE_SAFETY_CAP (${PROBE_SAFETY_CAP}); raise the cap if you really need this size.`,
      );
    }
  }
  // Track which pairs were actually created so we can:
  //   - generate batch intents for them (and only them) at each step;
  //   - pick the burn target at the end of the run as the last live pair.
  const createdPairs: ProbePair[] = [];

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

    await runTxStep(steps, "receiver:top-up", reportProgress, async () => {
      const { receiverTopUp } = await import("../transactions/receiver-top-up.js");
      const state = await receiverTopUp({
        amountLovelace: RECEIVER_TOP_UP_LOVELACE,
        statePath: clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    // ── Probe / single-shot phase ───────────────────────────────────
    // Default (probe): walk N = 1, 2, 3, … Each iteration:
    //   1. Generate + sign a bootstrap intent for `PAIR_CATALOG[N-1]`.
    //   2. Run `preview:update` to create that Pair UTxO.
    //   3. Generate fresh batch intents for ALL N created pairs (using
    //      monotone (timestamp, nonce) so the on-chain freshness check
    //      passes regardless of how fast the emulator runs).
    //   4. Attempt batch-N. Record exec-units. On failure → break;
    //      `maxBatch` is the last successful N.
    //
    // Single-shot (`args.batchSize = N`): pre-seed N pairs without
    // probing in between, then run batch-N once. The pre-seed creates
    // are recorded as `update:<slug>:seed` steps (not probed individually),
    // and a single `update:batch:N` step captures the actual attempt.
    const ceilingForProbe = fixedBatchSize ?? PROBE_SAFETY_CAP;
    let maxBatch = 0;
    let probeFailedAt: number | null = null;

    for (let i = 0; i < ceilingForProbe; i++) {
      const pair = makeProbePair(i + 1);
      const size = i + 1;
      const intentPath = path.join(intentsDir, `${pair.slug}.signed.json`);
      const pairStatePath = path.join(pairsDir, `${pair.slug}.json`);

      // (1) bootstrap intent → (2) create the pair
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
      createdPairs.push(pair);

      // In single-shot mode we only run batch-N at the very end, not at
      // every intermediate size — those creates are "seeding".
      const runBatchHere = fixedBatchSize === undefined || size === fixedBatchSize;
      if (!runBatchHere) continue;

      // (3) fresh batch intents for every pair created so far, with
      // strictly-monotone (timestamp, nonce). One sub-step per intent.
      const batchIntentNow = await getNetworkNow(args.lucid);
      let batchIntentOffset = 60n + BigInt(size) * 10n;
      for (const created of createdPairs) {
        const batchIntentPath = path.join(intentsDir, `${created.slug}-batch-${size}.signed.json`);
        await runStep(
          steps,
          `intent:create-and-sign:${created.slug}:batch-${size}`,
          reportProgress,
          async () => {
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
              symbol: created.symbol,
              price: created.batchPrice,
              source: DOMAIN_NAME,
            });
            await writeStateJsonFile(batchIntentPath, signed);
          },
        );
      }

      // (4) attempt batch-N
      const manifestPath = path.join(manifestsDir, `batch-${size}.manifest.json`);
      const resultPath = path.join(manifestsDir, `batch-${size}.result.json`);
      const updates = createdPairs.map((created) => ({
        statePath: path.join(pairsDir, `${created.slug}.json`),
        intentPath: path.join(intentsDir, `${created.slug}-batch-${size}.signed.json`),
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
      } catch (error) {
        attemptError = error instanceof Error ? error.message : String(error);
      }

      batchAttempts.push({
        size,
        ok: attemptOk,
        metrics: attemptMetrics,
        error: attemptError,
      });

      if (attemptOk) {
        maxBatch = size;
      } else {
        probeFailedAt = size;
        break;
      }
    }

    if (maxBatch === 0) {
      // Either probe failed at size 1, or single-shot batch-N failed. The
      // settle/withdraw/reclaim/republish/burn cluster needs accrued fees
      // from a successful batch, so we short-circuit and let the report
      // explain what happened.
      reportProgress(
        `[emulator-flow] no batch succeeded${
          probeFailedAt ? ` (failed at batch-${probeFailedAt})` : ""
        }; skipping settle + downstream steps`,
      );
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

    // Withdraw amounts must respect what's actually available on-chain:
    //   - receiver: amount ≤ receiver.balance_lovelace
    //   - payment-hook: amount ≤ payment_hook.accrued_fees_lovelace
    // The constants above are "preferred" upper bounds. Clamp down to what
    // settle just deposited so this flow works for any batchSize (the smoke
    // test calls with batchSize: 1 which only accrues ~2 ADA, while a full
    // probe accrues much more). A 1 ADA buffer is kept to avoid bumping
    // into edge cases where the protocol leaves dust.
    const clampWithdraw = (preferred: string, availableLovelace: bigint): bigint => {
      const pref = BigInt(preferred);
      const buffer = 1_000_000n;
      const cap = availableLovelace > buffer ? availableLovelace - buffer : 0n;
      return pref < cap ? pref : cap;
    };

    const clientStateAfterSettle = JSON.parse(
      await readFile(clientStatePath, "utf8"),
    );
    const receiverBalance = BigInt(
      clientStateAfterSettle?.receiver?.receiverState?.balanceLovelace ?? 0,
    );
    const receiverWithdrawAmount = clampWithdraw(RECEIVER_WITHDRAW_LOVELACE, receiverBalance);
    if (receiverWithdrawAmount > 0n) {
      await runTxStep(steps, "receiver:withdraw", reportProgress, async () => {
        const { receiverWithdraw } = await import("../transactions/receiver-withdraw.js");
        const state = await receiverWithdraw({
          amountLovelace: receiverWithdrawAmount.toString(),
          statePath: clientStatePath,
          protocolStatePath,
          buildOnly: false,
        });
        await writeStateJsonFile(clientStatePath, state);
      });
    } else {
      reportProgress("[emulator-flow] receiver:withdraw skipped (insufficient balance)");
    }

    const protocolStateAfterSettle = JSON.parse(
      await readFile(protocolStatePath, "utf8"),
    );
    const hookAccrued = BigInt(
      protocolStateAfterSettle?.paymentHookState?.accruedFeesLovelace ?? 0,
    );
    const hookWithdrawAmount = clampWithdraw(PAYMENT_HOOK_WITHDRAW_LOVELACE, hookAccrued);
    if (hookWithdrawAmount > 0n) {
      await runTxStep(steps, "payment-hook:withdraw", reportProgress, async () => {
        const { paymentHookWithdraw } = await import(
          "../transactions/payment-hook-withdraw.js"
        );
        const state = await paymentHookWithdraw({
          amountLovelace: hookWithdrawAmount.toString(),
          statePath: protocolStatePath,
          buildOnly: false,
        });
        await writeStateJsonFile(protocolStatePath, state);
      });
    } else {
      reportProgress("[emulator-flow] payment-hook:withdraw skipped (insufficient accrued)");
    }

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

    // ── Final step: admin-gated pair burn ─────────────────────────────
    // Mirrors step 31 of run-all-cli.sh. Burns the LAST pair the probe
    // created (or, in single-shot mode, the last seeded pair), so the
    // run always has something to retire regardless of where the probe
    // stopped. The single tx fires:
    //   - pair_state.spend.BurnPair  (consumes the Pair UTxO, no continuation)
    //   - pair_state.mint.BurnPairs  (burns the matching Pair NFT, qty -1)
    // Both validators require a config_admins signature.
    const burnSlug = createdPairs[createdPairs.length - 1]?.slug;
    if (burnSlug) {
      await runTxStep(steps, `pair:burn:${burnSlug}`, reportProgress, async () => {
        const { pairBurn } = await import("../transactions/pair-burn.js");
        const pairStatePath = path.join(pairsDir, `${burnSlug}.json`);
        const state = await pairBurn({
          protocolStatePath,
          clientStatePath,
          pairStatePath,
          buildOnly: false,
        });
        await writeStateJsonFile(pairStatePath, state);
      });
    }

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
