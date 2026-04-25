import { readFile } from "node:fs/promises";
import path from "node:path";
import { Constr } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import { makeReceiverValidator } from "../core/contracts.js";
import {
  makeConfiguredLucid,
  makeConfiguredProvider,
  selectConfiguredWallet,
} from "../core/lucid.js";
import { getDefaultConfigStatePath, readConfigState, type ConfigStateArtifact } from "../core/state.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  addressToPlutusData,
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";

type ReceiverWithdrawInput = {
  amountLovelace: string;
  recipientAddress?: string;
};

export async function receiverWithdraw(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading receiver withdraw input from ${path.resolve(args.inputPath)}`);
  const input = await readReceiverWithdrawInput(path.resolve(args.inputPath));
  const statePath = path.resolve(args.statePath ?? getDefaultConfigStatePath());
  reportProgress(`Loading client state from ${statePath}`);
  const state = await readConfigState(statePath);

  if (!state.receiver) {
    throw new Error("Receiver withdraw requires a client state artifact produced by receiver bootstrap.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const walletAddress = await wallet.address();
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  if (!state.configState.validConfigSigners.includes(walletDefaults.paymentKeyHash)) {
    throw new Error("The configured wallet is not authorized as a config signer.");
  }

  const [currentConfigUtxo, currentReceiverUtxo] = await Promise.all([
    findSingleUtxoAtUnit(
      lucid,
      state.scripts.configValidatorAddress,
      state.scripts.configUnit,
      "config",
    ),
    findSingleUtxoAtUnit(
      lucid,
      state.receiver.receiverValidatorAddress,
      state.receiver.receiverUnit,
      "receiver",
    ),
  ]);
  const referenceScriptUtxos = await loadReceiverReferenceScriptUtxos(state);

  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const receiverValidator = await makeReceiverValidator({
    bootstrapOutRef: state.receiver.bootstrapRef,
    assetName: state.receiver.receiverAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
  });

  const amountLovelace = toBigInt(input.amountLovelace, "amountLovelace");
  const recipientAddress = input.recipientAddress?.trim().length
    ? input.recipientAddress.trim()
    : walletAddress;
  const currentReceiverState =
    currentReceiverUtxo.datum
      ? decodeReceiverDatum(currentReceiverUtxo.datum)
      : state.receiver.receiverState;
  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) - amountLovelace
    ).toString(),
  };

  if (BigInt(nextReceiverState.balanceLovelace) < 0n) {
    throw new Error("Receiver balance is not sufficient for the requested withdrawal.");
  }

  const receiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);
  const withdrawRedeemer = Data.to(
    new Constr<PlutusData>(2, [
      amountLovelace,
      addressToPlutusData(recipientAddress),
    ]),
  );

  reportProgress("Building Preview receiver withdraw transaction");
  let txBuilder = lucid
    .newTx()
    .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
    .collectFrom([currentReceiverUtxo], withdrawRedeemer)
    .addSignerKey(walletDefaults.paymentKeyHash)
    .pay.ToContract(
      state.receiver.receiverValidatorAddress,
      { kind: "inline", value: receiverDatumCbor },
      {
        lovelace:
          BigInt(nextReceiverState.minUtxoLovelace) +
          BigInt(nextReceiverState.balanceLovelace),
        [state.receiver.receiverUnit]: 1n,
      },
    )
    .pay.ToAddress(recipientAddress, { lovelace: amountLovelace });

  if (referenceScriptUtxos.length === 0) {
    txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
  }

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
      ? state.receiver.receiverUtxo.current
      : await findSingleUtxoAtUnit(
          lucid,
          state.receiver.receiverValidatorAddress,
          state.receiver.receiverUnit,
          "receiver",
        );

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    configUtxo: {
      current: {
        txHash: currentConfigUtxo.txHash,
        outputIndex: currentConfigUtxo.outputIndex,
      },
    },
    receiver: {
      ...state.receiver,
      receiverState: nextReceiverState,
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
  console.error(`[preview:receiver:withdraw] ${message}`);
}

async function readReceiverWithdrawInput(inputPath: string): Promise<ReceiverWithdrawInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ReceiverWithdrawInput;
}

async function loadReceiverReferenceScriptUtxos(
  state: ConfigStateArtifact,
) {
  const receiverRef = state.referenceScripts?.client?.receiver;
  if (!receiverRef) {
    return [];
  }

  const provider = await makeConfiguredProvider();
  return provider.getUtxosByOutRef([
    {
      txHash: receiverRef.txHash,
      outputIndex: receiverRef.outputIndex,
    },
  ]);
}
