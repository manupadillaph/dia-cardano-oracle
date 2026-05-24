// Canonical home for Cardano-side runtime helpers used by tx builders,
// deploys, init flows, and tests. Two rules apply here and only here:
//
// 1. Datum encoders (`build*DatumCbor`) and decoders mirror the field
//    order declared in `contracts/aiken/lib/dia_cardano_oracle/*.ak`. A
//    drift in field order or arity here silently corrupts every datum
//    we put on chain, so any change MUST be made in lockstep with the
//    on-chain types and asserted by the round-trip tests in
//    `__tests__/run-tests.ts`.
// 2. Every shared helper (datum codec, asset/UTxO selector, address
//    encoder, intent helper) lives here. `transactions/`, `deploys/`,
//    and `init/` MUST NOT redeclare these locally. Local copies were
//    the root cause of the receiver-datum and config-datum encoding
//    bugs found during the deduplication audit; that audit is the
//    archived `docs/_archived/offchain-helpers-catalog.md`.
//
// File-local helpers in other modules are allowed only when they are
// genuinely scoped to that module (e.g. a tx builder's per-call
// progress prefix). Anything reused in two places belongs here.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Constr, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import { type DiaOracleIntent } from "./dia-intent.js";
import { assertTxStillOnChain } from "./tx-onchain-check.js";
import { normalizeHex } from "./primitives.js";
import type {
  ConfigState,
  PairLiveState,
  PaymentHookState,
  ReceiverState,
} from "./state.js";
import { makeConfiguredLucid } from "./lucid.js";

// Re-export the primitives that on-chain / Lucid callers most often
// reach for through chain-helpers, so existing import sites keep
// working. Canonical implementations live in core/primitives.ts; these
// are re-exports, not duplicates.
export { splitUnit, toBigInt } from "./primitives.js";

// Re-export the rollback error so callers of the wait helpers can
// import everything they need from this one module.
export { TxDroppedFromChainError } from "./tx-onchain-check.js";

export const BOOTSTRAP_REF_MIN_LOVELACE = 1_000_000n;

// ---------------------------------------------------------------------------
// Wait helpers — three flavors for the three things we ever wait on.
//
// Every non-deploy tx in this codebase follows the same skeleton at the end:
//     wait 1  awaitTxConfirmation       (tx accepted into a block)
//     wait 2  waitForWalletSettlement   (wallet UTxOs reflect change/spent)
//     wait 3  one of the helpers below  (the script-side UTxO landed/moved)
//
// "wait 3" comes in three variants because the script-side outcome differs:
//
//   * Replacement (the unit lives on, at a NEW outRef) → waitForUnitUtxoReplacement
//     Used by every stateful update where the NFT-bearing UTxO is spent and
//     re-created with a new datum (oracle update, settle, top-up, etc.).
//
//   * Creation (a unit appears for the first time) → findSingleUtxoAtUnit
//     Used by bootstraps where the NFT is freshly minted at a script address.
//
//   * Creation of an output WITHOUT a unit (e.g. reference-script publishes,
//     which live at the reference-holder address with no NFT) → waitForOutRefAvailable
//
//   * Destruction (the previous outRef must disappear, with NO replacement —
//     burn, reclaim) → waitForOutRefGone
//
// Why both unit-based and outRef-based variants exist: the unit-based ones
// query `lucid.utxosAtWithUnit(address, unit)` and are the cheapest poll when
// an NFT marks the UTxO. The outRef-based ones use `lucid.utxosByOutRef(...)`
// and exist for UTxOs that carry no marker NFT (reference scripts) or whose
// unit no longer exists anywhere on chain after the tx (burns/reclaims).
//
// Default timeout ceilings (with delayMs = 1_500 ms per attempt):
//   waitForUnitUtxoReplacement / waitForOutRefAvailable / waitForOutRefGone:
//     800 attempts × 1.5 s ≈ 20 min — covers even the slowest Blockfrost
//     indexer lag observed in production (Koios confirms in <60 s; Blockfrost
//     can lag >30 s on Preview/Mainnet under load).
//   waitForWalletSettlement:
//     480 attempts × 1.5 s ≈ 12 min — wallet UTxO set typically settles in
//     <30 s; the 12-min ceiling is a conservative guard against provider lag.
//
// Rollback detection: the three "wait 3" helpers accept an optional `txHash`.
//   When provided, every ROLLBACK_CHECK_INTERVAL attempts (~90 s) they call
//   `assertTxStillOnChain`. If both Koios and Blockfrost REST agree the tx is
//   absent, `TxDroppedFromChainError` is thrown immediately so the caller
//   fails fast instead of waiting out the full 20-min ceiling.
// ---------------------------------------------------------------------------

// Interval at which the wait-3 helpers check for rollback (in loop iterations).
// 60 × 1_500 ms default delay ≈ 90 s between checks.
const ROLLBACK_CHECK_INTERVAL = 60;

/**
 * Resolve the single on-chain UTxO at `address` that carries `unit`.
 *
 * Polls `utxosAtWithUnit` up to 10 times (1.5s between attempts). Used both
 * as a pre-build lookup (locate the Config/Receiver/Pair/PaymentHook script
 * UTxO to spend) AND as the "wait 3" after **bootstrap** txs where the NFT
 * is being created for the first time. Not appropriate for replacement waits
 * — it cannot tell the new UTxO from the old one if both ever co-exist.
 *
 * @throws if no single UTxO with that unit is observed within the budget.
 */
export async function findSingleUtxoAtUnit(
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>,
  address: string,
  unit: string,
  label: string,
): Promise<UTxO> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const utxos = await lucid.utxosAtWithUnit(address, unit);
      if (utxos.length === 1) {
        return utxos[0];
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  const detail = lastError
    ? ` Last provider error: ${describeUnknownError(lastError)}.`
    : "";
  throw new Error(
    `Unable to observe a single ${label} UTxO at ${address} with unit ${unit}.${detail}`,
  );
}

/**
 * Wait until the unique UTxO carrying `unit` at `address` has been
 * **replaced** — i.e. exactly one UTxO is visible AND its outRef differs
 * from `previousOutRef`.
 *
 * This is the "wait 3" used after every stateful update where an NFT-bearing
 * script UTxO is spent and re-created (oracle update, settle, top-up,
 * receiver/payment-hook updates, withdraws that leave the NFT in place,
 * config-update, etc.). It ensures the indexer has caught up so the next
 * CLI step can resolve the new UTxO without retries.
 *
 * Default ceiling: 800 attempts × 1.5 s ≈ 20 min. Pass `maxAttempts` /
 * `delayMs` to override. Pass `txHash` (the hash of the submitted tx) to
 * enable rollback detection: every `ROLLBACK_CHECK_INTERVAL` attempts the
 * helper verifies the tx is still on-chain and throws `TxDroppedFromChainError`
 * if both Koios and Blockfrost REST independently report it absent.
 *
 * Not appropriate when the NFT is being created for the first time
 * (use `findSingleUtxoAtUnit`) or when the NFT is destroyed (use
 * `waitForOutRefGone`).
 */
export async function waitForUnitUtxoReplacement(args: {
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>;
  address: string;
  unit: string;
  label: string;
  previousOutRef?: OutRefLike;
  txHash?: string;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<UTxO> {
  const maxAttempts = args.maxAttempts ?? 800;
  const delayMs = args.delayMs ?? 1_500;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const utxos = await args.lucid.utxosAtWithUnit(args.address, args.unit);
      const replacement = utxos.find(
        (utxo) =>
          !args.previousOutRef ||
          utxo.txHash !== args.previousOutRef.txHash ||
          utxo.outputIndex !== args.previousOutRef.outputIndex,
      );

      if (utxos.length === 1 && replacement) {
        return replacement;
      }
    } catch (error) {
      lastError = error;
    }

    if (
      args.txHash &&
      attempt > 0 &&
      attempt % ROLLBACK_CHECK_INTERVAL === 0
    ) {
      await assertTxStillOnChain({ txHash: args.txHash });
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const previousSuffix = args.previousOutRef
    ? ` after consuming ${args.previousOutRef.txHash}#${args.previousOutRef.outputIndex}`
    : "";
  const detail = lastError
    ? ` Last provider error: ${describeUnknownError(lastError)}.`
    : "";
  throw new Error(
    `Transaction confirmation was observed, but the ${args.label} UTxO set did not refresh${previousSuffix}.${detail}`,
  );
}

// Require that a UTxO carry an inline datum (the format used by every
// stateful script in this protocol). Used by every tx builder that
// spends a state UTxO.
export function requireInlineDatum(
  utxo: { datum?: string | null },
  label: string,
): string {
  if (!utxo.datum) {
    throw new Error(`Current ${label} UTxO is missing its inline datum.`);
  }
  return utxo.datum;
}

export function findUtxoByOutRef(
  utxos: UTxO[],
  outRef: {
    txHash: string;
    outputIndex: number;
  },
  label: string,
): UTxO {
  const utxo = utxos.find(
    (candidate) =>
      candidate.txHash === outRef.txHash &&
      candidate.outputIndex === outRef.outputIndex,
  );

  if (!utxo) {
    throw new Error(
      `Unable to find ${label} UTxO ${outRef.txHash}#${outRef.outputIndex} in the configured wallet.`,
    );
  }

  return utxo;
}

export type OutRefLike = {
  txHash: string;
  outputIndex: number;
};

type WalletUtxoReader = {
  getUtxos(): Promise<UTxO[]>;
};

export function selectFundingUtxo(
  utxos: UTxO[],
  excludedOutRefs: OutRefLike[],
  minimumLovelace: bigint,
  label: string,
): UTxO {
  const utxo = selectablePureLovelaceUtxos(utxos, excludedOutRefs)
    .filter((candidate) => (candidate.assets.lovelace ?? 0n) >= minimumLovelace)
    .sort((left, right) => {
      const leftValue = left.assets.lovelace ?? 0n;
      const rightValue = right.assets.lovelace ?? 0n;
      if (leftValue === rightValue) return 0;
      return leftValue > rightValue ? -1 : 1;
    })[0];

  if (!utxo) {
    throw new Error(`No suitable wallet UTxO is available to fund ${label}.`);
  }

  return utxo;
}

export function selectBootstrapUtxo(
  utxos: UTxO[],
  minimumLovelace: bigint = 0n,
  excludedOutRefs: OutRefLike[] = [],
): UTxO | null {
  return selectablePureLovelaceUtxos(utxos, excludedOutRefs)
    .filter((candidate) => (candidate.assets.lovelace ?? 0n) >= minimumLovelace)
    .sort((left, right) => {
      const leftValue = left.assets.lovelace ?? 0n;
      const rightValue = right.assets.lovelace ?? 0n;
      if (leftValue === rightValue) return 0;
      return leftValue > rightValue ? -1 : 1;
    })[0] ?? null;
}

/**
 * Wait until a specific outRef (txHash + outputIndex) is visible at the
 * indexer.
 *
 * "wait 3" used by reference-script publishes
 * (`config-reference-scripts`, `payment-hook-reference-script`,
 * `client-reference-scripts`) where the new outputs live at the
 * reference-holder address **without** any NFT to key on. Polls
 * `lucid.utxosByOutRef([outRef])` and resolves when the outRef appears.
 *
 * Use this whenever a tx creates an output that the next CLI step will
 * read by outRef rather than by unit. For NFT-bearing outputs, prefer
 * `findSingleUtxoAtUnit` (first-time creation) or
 * `waitForUnitUtxoReplacement` (existing unit, new outRef).
 *
 * Default ceiling: 800 attempts × 1.5 s ≈ 20 min. Rollback detection runs
 * automatically every `ROLLBACK_CHECK_INTERVAL` attempts using
 * `args.outRef.txHash` as the submitted tx hash.
 */
export async function waitForOutRefAvailable(args: {
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>;
  outRef: OutRefLike;
  label: string;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<UTxO> {
  const maxAttempts = args.maxAttempts ?? 800;
  const delayMs = args.delayMs ?? 1_500;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const utxos = await args.lucid.utxosByOutRef([
        { txHash: args.outRef.txHash, outputIndex: args.outRef.outputIndex },
      ]);
      if (utxos.length === 1) {
        return utxos[0];
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt > 0 && attempt % ROLLBACK_CHECK_INTERVAL === 0) {
      await assertTxStillOnChain({ txHash: args.outRef.txHash });
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const detail = lastError
    ? ` Last provider error: ${describeUnknownError(lastError)}.`
    : "";
  throw new Error(
    `Transaction confirmation was observed, but the ${args.label} UTxO ${args.outRef.txHash}#${args.outRef.outputIndex} did not appear at the indexer.${detail}`,
  );
}

/**
 * Wait until a specific outRef is no longer visible at the indexer.
 *
 * "wait 3" used when a tx **destroys** an output with no replacement —
 * `pair-burn` (the Pair NFT is burned, so the unit will exist nowhere)
 * and `reclaim-reference-script` (the reference-holder UTxOs are spent
 * back to the wallet). Polls `lucid.utxosByOutRef([outRef])` and resolves
 * when the result is empty.
 *
 * Counterpart to `waitForOutRefAvailable`. Use this only when no
 * replacement UTxO is expected; for NFT-bearing replacements use
 * `waitForUnitUtxoReplacement`.
 *
 * Default ceiling: 800 attempts × 1.5 s ≈ 20 min. Pass `txHash` (the hash
 * of the submitted tx that burned/reclaimed `outRef`) to enable rollback
 * detection: every `ROLLBACK_CHECK_INTERVAL` attempts the helper verifies
 * the tx is still on-chain and throws `TxDroppedFromChainError` if both
 * Koios and Blockfrost REST independently report it absent.
 */
export async function waitForOutRefGone(args: {
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>;
  outRef: OutRefLike;
  label: string;
  txHash?: string;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<void> {
  const maxAttempts = args.maxAttempts ?? 800;
  const delayMs = args.delayMs ?? 1_500;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const utxos = await args.lucid.utxosByOutRef([
        { txHash: args.outRef.txHash, outputIndex: args.outRef.outputIndex },
      ]);
      if (utxos.length === 0) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    if (
      args.txHash &&
      attempt > 0 &&
      attempt % ROLLBACK_CHECK_INTERVAL === 0
    ) {
      await assertTxStillOnChain({ txHash: args.txHash });
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const detail = lastError
    ? ` Last provider error: ${describeUnknownError(lastError)}.`
    : "";
  throw new Error(
    `Transaction confirmation was observed, but the ${args.label} UTxO ${args.outRef.txHash}#${args.outRef.outputIndex} is still visible at the indexer.${detail}`,
  );
}

/**
 * "wait 2" — wait until the wallet's UTxO set reflects the submitted tx:
 * the spent inputs are no longer visible AND the wallet snapshot has
 * changed since `previousUtxos`. Used by every non-deploy and deploy tx
 * after `awaitTxConfirmation` and before any script-side wait.
 *
 * Default ceiling: 480 attempts × 1.5 s ≈ 12 min. The wallet UTxO set
 * typically settles within 30 s; the 12-min ceiling guards against slow
 * provider indexing without blocking indefinitely.
 *
 * Behavior knobs:
 *  - `spentUtxos: []` + `requireChangeWhenNoSpentUtxos: true` → wait
 *    purely on snapshot change (Lucid picked the inputs; we don't know
 *    which). This is the right shape when no explicit `.collectFrom` was
 *    used.
 *  - `spentUtxos: [...]` → also wait until each named outRef has left the
 *    wallet snapshot. Use when we explicitly collected from a known
 *    wallet UTxO (bootstrap seed inputs).
 *  - `spentUtxos: []` + `requireChangeWhenNoSpentUtxos: false` (default)
 *    → short-circuits and returns the current snapshot immediately. Only
 *    legitimate for the rare case where nothing in the wallet should
 *    change.
 */
export async function waitForWalletSettlement(args: {
  wallet: WalletUtxoReader;
  previousUtxos: UTxO[];
  spentUtxos: UTxO[];
  label: string;
  maxAttempts?: number;
  delayMs?: number;
  requireChangeWhenNoSpentUtxos?: boolean;
}): Promise<UTxO[]> {
  const spentOutRefs = args.spentUtxos.map((utxo) => outRefKey(utxo));
  if (spentOutRefs.length === 0 && !args.requireChangeWhenNoSpentUtxos) {
    return args.wallet.getUtxos();
  }

  const previousSnapshot = utxoSnapshot(args.previousUtxos);
  const maxAttempts = args.maxAttempts ?? 480;
  const delayMs = args.delayMs ?? 1_500;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const currentUtxos = await args.wallet.getUtxos();
      const currentSnapshot = utxoSnapshot(currentUtxos);
      const spentInputsStillVisible = spentOutRefs.some((outRef) => currentSnapshot.has(outRef));
      const walletChanged = !sameSnapshot(previousSnapshot, currentSnapshot);

      if (!spentInputsStillVisible && walletChanged) {
        return currentUtxos;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const detail = lastError
    ? ` Last provider error: ${describeUnknownError(lastError)}.`
    : "";
  throw new Error(
    `Transaction confirmation was observed, but the wallet UTxO set did not refresh after ${args.label}.${detail}`,
  );
}

function selectablePureLovelaceUtxos(
  utxos: UTxO[],
  excludedOutRefs: OutRefLike[],
): UTxO[] {
  return utxos.filter(
    (utxo) =>
      Object.keys(utxo.assets).length === 1 &&
      !excludedOutRefs.some(
        (outRef) =>
          utxo.txHash === outRef.txHash &&
          utxo.outputIndex === outRef.outputIndex,
      ),
  );
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function addressToPlutusData(address: string): Constr<PlutusData> {
  const details = getAddressDetails(address);
  if (!details.paymentCredential) {
    throw new Error("Address must contain a payment credential.");
  }

  const paymentCredential =
    details.paymentCredential.type === "Key"
      ? new Constr<PlutusData>(0, [details.paymentCredential.hash])
      : new Constr<PlutusData>(1, [details.paymentCredential.hash]);

  const stakeCredential = details.stakeCredential
    ? new Constr<PlutusData>(0, [
        new Constr<PlutusData>(0, [
          details.stakeCredential.type === "Key"
            ? new Constr<PlutusData>(0, [details.stakeCredential.hash])
            : new Constr<PlutusData>(1, [details.stakeCredential.hash]),
        ]),
      ])
    : new Constr<PlutusData>(1, []);

  return new Constr<PlutusData>(0, [paymentCredential, stakeCredential]);
}

export function buildConfigDatumCbor(state: ConfigState): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      state.validConfigSigners.map((value) => normalizeHex(value, "validConfigSigners[]")),
      state.authorizedDiaPublicKeys.map((value) =>
        normalizeHex(value, "authorizedDiaPublicKeys[]"),
      ),
      new Constr<PlutusData>(0, [
        Buffer.from(state.domain.name, "utf8").toString("hex"),
        Buffer.from(state.domain.version, "utf8").toString("hex"),
        BigInt(state.domain.sourceChainId),
        normalizeHex(state.domain.verifyingContract, "domain.verifyingContract"),
      ]),
      BigInt(state.baseFeeLovelace),
      BigInt(state.perPairFeeLovelace),
      state.paymentHookRef
        ? new Constr<PlutusData>(0, [
            new Constr<PlutusData>(0, [
              normalizeHex(state.paymentHookRef.policyId, "paymentHookRef.policyId"),
              normalizeHex(state.paymentHookRef.assetName, "paymentHookRef.assetName"),
            ]),
          ])
        : new Constr<PlutusData>(1, []),
      state.updateCoordinatorCredential
        ? new Constr<PlutusData>(0, [
            state.updateCoordinatorCredential.type === "Key"
              ? new Constr<PlutusData>(0, [
                  normalizeHex(state.updateCoordinatorCredential.hash, "updateCoordinatorCredential.hash"),
                ])
              : new Constr<PlutusData>(1, [
                  normalizeHex(state.updateCoordinatorCredential.hash, "updateCoordinatorCredential.hash"),
                ]),
          ])
        : new Constr<PlutusData>(1, []),
      BigInt(state.maxBootstrapDriftSeconds),
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

export function buildPaymentHookDatumCbor(state: PaymentHookState): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      addressToPlutusData(state.withdrawAddress),
      BigInt(state.accruedFeesLovelace),
      BigInt(state.lifetimeCollectedLovelace),
      BigInt(state.lifetimeWithdrawnLovelace),
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

export function buildReceiverDatumCbor(state: ReceiverState): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      BigInt(state.balanceLovelace),
      BigInt(state.accruedToHookLovelace),  // Pending fees field
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

export function decodeReceiverDatum(raw: string): ReceiverState {
  const datum = Data.from(raw) as Constr<PlutusData>;
  const [balanceLovelace, accruedToHookLovelace, minUtxoLovelace] = datum.fields;

  return {
    balanceLovelace: BigInt(balanceLovelace as bigint).toString(),
    accruedToHookLovelace: BigInt(accruedToHookLovelace as bigint).toString(),
    minUtxoLovelace: BigInt(minUtxoLovelace as bigint).toString(),
  };
}

export function decodePaymentHookDatum(
  raw: string,
  withdrawAddress: string,
): PaymentHookState {
  const datum = Data.from(raw) as Constr<PlutusData>;
  const [, accruedFeesLovelace, lifetimeCollectedLovelace, lifetimeWithdrawnLovelace, minUtxoLovelace] =
    datum.fields;

  return {
    withdrawAddress,
    accruedFeesLovelace: BigInt(accruedFeesLovelace as bigint).toString(),
    lifetimeCollectedLovelace: BigInt(lifetimeCollectedLovelace as bigint).toString(),
    lifetimeWithdrawnLovelace: BigInt(lifetimeWithdrawnLovelace as bigint).toString(),
    minUtxoLovelace: BigInt(minUtxoLovelace as bigint).toString(),
  };
}

export function buildPairDatumCbor(state: Omit<PairLiveState, "intent">): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      state.pairId,
      BigInt(state.price),
      BigInt(state.timestamp),
      BigInt(state.nonce),
      normalizeHex(state.intentHash, "intentHash"),
      normalizeHex(state.signer, "signer"),
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

export function decodePairDatum(raw: string): Omit<PairLiveState, "intent"> {
  const datum = Data.from(raw) as Constr<PlutusData>;
  const [pairId, price, timestamp, nonce, intentHash, signer, minUtxoLovelace] =
    datum.fields;

  return {
    pairId: normalizeHex(pairId as string, "pairId"),
    price: BigInt(price as bigint).toString(),
    timestamp: BigInt(timestamp as bigint).toString(),
    nonce: BigInt(nonce as bigint).toString(),
    intentHash: normalizeHex(intentHash as string, "intentHash"),
    signer: normalizeHex(signer as string, "signer"),
    minUtxoLovelace: BigInt(minUtxoLovelace as bigint).toString(),
  };
}

function outRefKey(outRef: OutRefLike): string {
  return `${outRef.txHash}#${outRef.outputIndex}`;
}

function utxoSnapshot(utxos: UTxO[]): Set<string> {
  return new Set(utxos.map((utxo) => outRefKey(utxo)));
}

function sameSnapshot(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

export function updateWitnessData(
  intent: DiaOracleIntent,
  receiverPolicyId: string,
  receiverAssetName: string,
  pairPolicyId: string,
  pairTokenName: string,
  signerPublicKey: string,
): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    normalizeHex(receiverPolicyId, "receiverPolicyId"),
    normalizeHex(receiverAssetName, "receiverAssetName"),
    normalizeHex(pairPolicyId, "pairPolicyId"),
    pairTokenName,
    diaIntentData(intent),
    normalizeHex(signerPublicKey, "signerPublicKey"),
  ]);
}

export async function writeJsonFile(outPath: string, value: unknown): Promise<void> {
  const resolvedPath = path.resolve(outPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(
    resolvedPath,
    JSON.stringify(
      value,
      (_key, currentValue) =>
        typeof currentValue === "bigint"
          ? currentValue.toString()
          : currentValue,
      2,
    ) + "\n",
    "utf8",
  );
}

// File-local: only used to assemble updateWitnessData here. Not exported
// because the wire shape is internal to the coordinator witness encoding;
// callers should always go through updateWitnessData.
function diaIntentData(intent: DiaOracleIntent): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    Buffer.from(intent.intentType, "utf8").toString("hex"),
    Buffer.from(intent.version, "utf8").toString("hex"),
    intent.chainId,
    intent.nonce,
    intent.expiry,
    Buffer.from(intent.symbol, "utf8").toString("hex"),
    intent.price,
    intent.timestamp,
    Buffer.from(intent.source, "utf8").toString("hex"),
    normalizeHex(intent.signature, "intent.signature"),
    normalizeHex(intent.signer, "intent.signer"),
  ]);
}
