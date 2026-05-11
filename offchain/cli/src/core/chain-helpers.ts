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
import {
  normalizeHex,
  splitUnit,
  toBigInt,
} from "./primitives.js";
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

export const BOOTSTRAP_REF_MIN_LOVELACE = 1_000_000n;

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

export async function waitForUnitUtxoReplacement(args: {
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>;
  address: string;
  unit: string;
  label: string;
  previousOutRef?: OutRefLike;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<UTxO> {
  const maxAttempts = args.maxAttempts ?? 20;
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
  const maxAttempts = args.maxAttempts ?? 12;
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
