// Cardano write client — builds, signs, submits, and confirms one
// oracle-update tx per `SubmitRequest`.
//
// This module is the Cardano-side analogue of Spectra's EVM tx sender.
// It is a thin orchestrator: the heavy lifting (UTxO selection, datum
// encoding, script attachment) is done by `buildOracleUpdateTx` from
// `lib-bridge`, which re-uses the same builder the CLI uses.
//
// Design choices:
//
//   - The client is stateless: it reads the Cardano chain every time
//     it needs a UTxO instead of maintaining local state. Robust to
//     feeder restarts at the cost of an extra chain read per submission.
//     NOTE: add a UTxO cache here if chain-read latency becomes a bottleneck.
//
//   - All Lucid / Cardano types are hidden behind the interfaces
//     declared in `types.ts`. The feeder process that imports this
//     module only sees those interfaces; the actual
//     `@lucid-evolution/lucid` types live in the `lib-bridge` layer.
//
//   - `createCardanoWriteClient` takes a `CardanoWriteClientDeps`
//     bundle so tests can inject a fake Lucid + fake builder without
//     pulling in Lucid itself.

import type { CardanoWriteClient, SubmitRequest, SubmitResult } from "./types.js";
import type { OracleIntentBridge } from "../lib-bridge/index.js";
import type { TransactionLogEntry } from "../logger/file-logger.js";
import { classifyError } from "../errors/index.js";

// ---------------------------------------------------------------------------
// Dependency-injection bundle.
// ---------------------------------------------------------------------------

/**
 * Everything the write client needs that it cannot construct itself.
 *
 * - `bridge`         — wired by the feeder entry-point from `lib-bridge`;
 *                       in tests, a fake that returns canned results.
 * - `log`            — simple line emitter so the client stays decoupled
 *                       from any particular logger.
 * - `onStep`         — called at each Cardano pipeline step. Steps in order:
 *                       tx_start, connecting, building, signing, submitting,
 *                       submitted (carries txHash), waiting_confirm,
 *                       waiting_utxo, writing_state.
 * - `onTransaction`  — called once per submit attempt (ok or failed) with
 *                       step timings; drives the summary entry in transactions.jsonl.
 */
export type CardanoWriteClientDeps = {
  bridge: OracleIntentBridge;
  log?: (line: string) => void;
  onStep?: (intentHash: string, symbol: string, step: string, txHash?: string) => void;
  onTransaction?: (entry: TransactionLogEntry) => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a write client for the given destination files. The same
 * `CardanoWriteClientDeps` can be shared across multiple clients since
 * the bridge is stateless.
 *
 * @param clientStatePath    — absolute or relative path to the
 *   `client-state.json` produced by the CLI's `receiver:bootstrap`.
 * @param protocolStatePath  — absolute path to the
 *   `config-bootstrap.json` produced by `config:bootstrap`.
 * @param deps               — injected Lucid + builder bundle.
 */
export function createCardanoWriteClient(
  clientStatePath: string,
  protocolStatePath: string,
  deps: CardanoWriteClientDeps,
): CardanoWriteClient {
  const { bridge, log = () => {} } = deps;
  const label = `${clientStatePath.split("/").slice(-2).join("/")}`;

  return {
    label,

    async submit(request: SubmitRequest): Promise<SubmitResult> {
      const { intentHash, enriched } = request;
      const symbol = enriched.fullIntent.symbol;
      log(`[${label}] submit: intentHash=${intentHash} symbol=${symbol}`);

      const startMs = Date.now();
      const stepStartMs: Record<string, number> = {};

      deps.onStep?.(intentHash, symbol, "tx_start");

      function trackStep(step: string, meta?: { txHash?: string }): void {
        stepStartMs[step] = Date.now();
        deps.onStep?.(intentHash, symbol, step, meta?.txHash);
      }

      function stepsElapsed(): TransactionLogEntry["steps"] {
        function elapsed(from: string, to: string): number | undefined {
          return stepStartMs[from] !== undefined && stepStartMs[to] !== undefined
            ? stepStartMs[to] - stepStartMs[from]
            : undefined;
        }
        return {
          connecting_ms:      elapsed("connecting",     "building"),
          building_ms:        elapsed("building",       "signing"),
          signing_ms:         elapsed("signing",        "submitting"),
          submitting_ms:      elapsed("submitting",     "submitted"),
          waiting_confirm_ms: elapsed("waiting_confirm", "waiting_utxo"),
          waiting_utxo_ms:    elapsed("waiting_utxo",   "writing_state"),
        };
      }

      try {
        const result = await bridge.submitOracleUpdate({
          clientStatePath,
          protocolStatePath,
          enriched,
          intentHash,
          onStep: trackStep,
        });

        const total_ms = Date.now() - startMs;
        await deps.onTransaction?.({
          ts: new Date().toISOString(),
          txHash: result.txHash,
          symbol,
          intentHash,
          isCreate: result.isCreate,
          status: "confirmed",
          steps: stepsElapsed(),
          total_ms,
        });

        log(`[${label}] confirmed: txHash=${result.txHash} intentHash=${intentHash} receiverUnit=${result.receiverUnit}`);
        return { ok: true, cardanoTxHash: result.txHash, intentHash, receiverUnit: result.receiverUnit, pairUnit: result.pairUnit };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const { code, remediation } = classifyError(err);
        const total_ms = Date.now() - startMs;
        await deps.onTransaction?.({
          ts: new Date().toISOString(),
          txHash: "",
          symbol,
          intentHash,
          isCreate: false,
          status: "failed",
          errorCode: code,
          errorMessage: error.message,
          steps: stepsElapsed(),
          total_ms,
        });
        log(`[${label}] submit failed: intentHash=${intentHash} code=${code} error=${error.message}`);
        return { ok: false, intentHash, error, code, remediation };
      }
    },
  };
}
