import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Constr, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import { normalizeHex, type DiaOracleIntent } from "./dia-intent.js";
import type {
  ConfigState,
  PairLiveState,
  PaymentHookState,
  ReceiverState,
} from "./state.js";
import { makeConfiguredLucid } from "./lucid.js";

export const BOOTSTRAP_REF_MIN_LOVELACE = 1_000_000n;

export async function findSingleUtxoAtUnit(
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>,
  address: string,
  unit: string,
  label: string,
): Promise<UTxO> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const utxos = await lucid.utxosAtWithUnit(address, unit);
    if (utxos.length === 1) {
      return utxos[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(`Unable to observe a single ${label} UTxO at ${address} with unit ${unit}.`);
}

export function splitUnit(
  unit: string,
): {
  policyId: string;
  assetName: string;
} {
  const normalizedUnit = normalizeHex(unit, "unit");
  return {
    policyId: normalizedUnit.slice(0, 56),
    assetName: normalizedUnit.slice(56),
  };
}

export function toBigInt(value: string | number, label: string): bigint {
  const normalized = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Expected ${label} to be an integer.`);
  }
  return BigInt(normalized);
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
}): Promise<UTxO[]> {
  const spentOutRefs = args.spentUtxos.map((utxo) => outRefKey(utxo));
  if (spentOutRefs.length === 0) {
    return args.wallet.getUtxos();
  }

  const previousSnapshot = utxoSnapshot(args.previousUtxos);
  const maxAttempts = args.maxAttempts ?? 12;
  const delayMs = args.delayMs ?? 1_500;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const currentUtxos = await args.wallet.getUtxos();
    const currentSnapshot = utxoSnapshot(currentUtxos);
    const spentInputsStillVisible = spentOutRefs.some((outRef) => currentSnapshot.has(outRef));
    const walletChanged = !sameSnapshot(previousSnapshot, currentSnapshot);

    if (!spentInputsStillVisible && walletChanged) {
      return currentUtxos;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(
    `Transaction confirmation was observed, but the wallet UTxO set did not refresh after ${args.label}.`,
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
      BigInt(state.protocolFeeLovelace),
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
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

export function decodeReceiverDatum(raw: string): ReceiverState {
  const datum = Data.from(raw) as Constr<PlutusData>;
  const [balanceLovelace, minUtxoLovelace] = datum.fields;

  return {
    balanceLovelace: BigInt(balanceLovelace as bigint).toString(),
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

export function buildPairDatumCbor(state: PairLiveState): string {
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
