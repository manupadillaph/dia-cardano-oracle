import { readFile } from "node:fs/promises";
import path from "node:path";
import { Constr, type OutRef, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeReceiverMintingPolicy,
  makeReceiverValidator,
  makePairStateMintingPolicy,
  makePairStateValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
} from "../core/contracts.js";
import { normalizeHex } from "../core/dia-intent.js";
import { getDefaultConfigStatePath, readConfigState, type ConfigStateArtifact } from "../core/state.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import { findUtxoByOutRef, selectFundingUtxo } from "../core/chain-helpers.js";

type ReceiverBootstrapInput = {
  clientId: string;
  bootstrapRef?: {
    txHash: string;
    outputIndex: number;
  };
  receiverAssetName: string;
  initialBalanceLovelace: string;
  minUtxoLovelace: string;
};

export async function receiverBootstrap(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading receiver bootstrap input from ${path.resolve(args.inputPath)}`);
  const input = await readReceiverBootstrapInput(path.resolve(args.inputPath));

  const statePath = path.resolve(args.statePath ?? getDefaultConfigStatePath());
  reportProgress(`Loading config state from ${statePath}`);
  const state = await readConfigState(statePath);

  if (!state.configState.updateCoordinatorCredential || !state.configState.paymentHookRef) {
    throw new Error(
      "Receiver bootstrap requires a config state artifact produced after payment-hook bootstrap.",
    );
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  if (!state.configState.validConfigSigners.includes(walletDefaults.paymentKeyHash)) {
    throw new Error(
      "The configured wallet is not authorized as a config signer in the provided state file.",
    );
  }

  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    state.scripts.configUnit,
    "config",
  );
  const configuredBootstrapRef = input.bootstrapRef ?? state.receiver?.bootstrapRef;
  const receiverBootstrapUtxo = configuredBootstrapRef
    ? findUtxoByOutRef(walletUtxos, configuredBootstrapRef, "receiver bootstrap")
    : selectBootstrapUtxo(walletUtxos, [
        state.bootstrapRefs.config,
        state.bootstrapRefs.paymentHook!,
      ]);
  if (!receiverBootstrapUtxo) {
    throw new Error("No suitable wallet UTxO is available for receiver bootstrap.");
  }

  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const receiverAssetName = normalizeHex(input.receiverAssetName, "receiverAssetName");
  if (state.receiver && state.receiver.receiverAssetName !== receiverAssetName) {
    throw new Error("Receiver bootstrap input does not match the previously published Receiver reference script.");
  }
  const receiverBootstrapOutRef: OutRef = {
    txHash: receiverBootstrapUtxo.txHash,
    outputIndex: receiverBootstrapUtxo.outputIndex,
  };

  const receiverMintPolicy = await makeReceiverMintingPolicy({
    bootstrapOutRef: receiverBootstrapOutRef,
    assetName: receiverAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
  });
  const receiverPolicyId = policyIdFromMintingPolicy(receiverMintPolicy);
  const receiverUnit = `${receiverPolicyId}${receiverAssetName}`;

  const receiverValidator = await makeReceiverValidator({
    bootstrapOutRef: receiverBootstrapOutRef,
    assetName: receiverAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
  });
  const receiverValidatorHash = scriptHashFromValidator(receiverValidator);
  const receiverValidatorAddress = scriptAddressFromValidator(receiverValidator);

  const pairMintPolicy = await makePairStateMintingPolicy({
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    receiverHash: receiverValidatorHash,
  });
  const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
  const pairValidator = await makePairStateValidator({
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    receiverHash: receiverValidatorHash,
  });
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);

  const receiverState = {
    balanceLovelace: toBigInt(input.initialBalanceLovelace, "initialBalanceLovelace").toString(),
    minUtxoLovelace: toBigInt(input.minUtxoLovelace, "minUtxoLovelace").toString(),
  };
  const receiverOutputLovelace =
    BigInt(receiverState.minUtxoLovelace) + BigInt(receiverState.balanceLovelace);
  const fundingUtxos =
    (receiverBootstrapUtxo.assets.lovelace ?? 0n) >= receiverOutputLovelace + 2_000_000n
      ? []
      : [
          selectFundingUtxo(
            walletUtxos,
            [
              state.bootstrapRefs.config,
              state.bootstrapRefs.paymentHook!,
              receiverBootstrapOutRef,
            ],
            receiverOutputLovelace + 2_000_000n,
            "receiver bootstrap",
          ),
        ];
  const receiverDatumCbor = buildReceiverDatumCbor(receiverState);
  const mintRedeemer = Data.to(new Constr(0, []));

  reportProgress("Building Preview receiver bootstrap transaction");
  const txBuilder = lucid
    .newTx()
    .readFrom([currentConfigUtxo])
    .collectFrom([receiverBootstrapUtxo, ...fundingUtxos])
    .addSignerKey(walletDefaults.paymentKeyHash)
    .attach.MintingPolicy(receiverMintPolicy)
    .mintAssets({ [receiverUnit]: 1n }, mintRedeemer)
    .pay.ToContract(
      receiverValidatorAddress,
      { kind: "inline", value: receiverDatumCbor },
      {
        lovelace: receiverOutputLovelace,
        [receiverUnit]: 1n,
      },
    );

  const txSignBuilder = await txBuilder.complete();
  const unsignedHash = txSignBuilder.toHash();
  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(`Unsigned transaction ready: ${unsignedHash}`);
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await lucid.awaitTx(submittedTxHash, 3_000);
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }
  }

  const latestReceiverUtxo =
    args.buildOnly || !confirmed
      ? { txHash: "", outputIndex: 0 }
      : await findSingleUtxoAtUnit(lucid, receiverValidatorAddress, receiverUnit, "receiver");

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    scripts: {
      ...state.scripts,
      pairPolicyId,
      pairValidatorHash,
      pairValidatorAddress,
    },
    receiver: {
      clientId: input.clientId.trim(),
      bootstrapRef: receiverBootstrapOutRef,
      receiverAssetName,
      receiverPolicyId,
      receiverUnit,
      receiverValidatorHash,
      receiverValidatorAddress,
      receiverState,
      receiverUtxo: {
        current: {
          txHash: latestReceiverUtxo.txHash,
          outputIndex: latestReceiverUtxo.outputIndex,
        },
      },
    },
    datum: {
      ...state.datum,
      receiverCbor: receiverDatumCbor,
    },
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:receiver:bootstrap] ${message}`);
}

async function readReceiverBootstrapInput(inputPath: string): Promise<ReceiverBootstrapInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ReceiverBootstrapInput;
}

function buildReceiverDatumCbor(state: {
  balanceLovelace: string;
  minUtxoLovelace: string;
}): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      BigInt(state.balanceLovelace),
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

async function findSingleUtxoAtUnit(
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

function selectBootstrapUtxo(
  utxos: UTxO[],
  excludedOutRefs: Array<{ txHash: string; outputIndex: number }>,
): UTxO | null {
  return (
    utxos
      .filter(
        (utxo) =>
          !excludedOutRefs.some(
            (outRef) =>
              utxo.txHash === outRef.txHash && utxo.outputIndex === outRef.outputIndex,
          ),
      )
      .filter((utxo) => Object.keys(utxo.assets).length === 1)
      .sort((left, right) => {
        const leftValue = left.assets.lovelace ?? 0n;
        const rightValue = right.assets.lovelace ?? 0n;
        if (leftValue === rightValue) return 0;
        return leftValue > rightValue ? -1 : 1;
      })[0] ?? null
  );
}

function splitUnit(unit: string): { policyId: string; assetName: string } {
  const normalizedUnit = normalizeHex(unit, "unit");
  return {
    policyId: normalizedUnit.slice(0, 56),
    assetName: normalizedUnit.slice(56),
  };
}

function toBigInt(value: string | number, label: string): bigint {
  const normalized = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Expected ${label} to be an integer.`);
  }
  return BigInt(normalized);
}
