import { readFile } from "node:fs/promises";
import path from "node:path";
import { Constr } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";

import { makeReceiverValidator } from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { getDefaultConfigStatePath, readConfigState, type ConfigStateArtifact } from "../core/state.js";
import {
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";

type ReceiverTopUpInput = {
  amountLovelace: string;
};

export async function receiverTopUp(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading receiver top-up input from ${path.resolve(args.inputPath)}`);
  const input = await readReceiverTopUpInput(path.resolve(args.inputPath));
  const statePath = path.resolve(args.statePath ?? getDefaultConfigStatePath());
  reportProgress(`Loading client state from ${statePath}`);
  const state = await readConfigState(statePath);

  if (!state.receiver) {
    throw new Error("Receiver top-up requires a client state artifact produced by receiver bootstrap.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const walletAddress = await lucid.wallet().address();

  const currentReceiverUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.receiver.receiverValidatorAddress,
    state.receiver.receiverUnit,
    "receiver",
  );

  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const receiverValidator = await makeReceiverValidator({
    bootstrapOutRef: state.receiver.bootstrapRef,
    assetName: state.receiver.receiverAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
  });

  const amountLovelace = toBigInt(input.amountLovelace, "amountLovelace");
  const currentReceiverState =
    currentReceiverUtxo.datum
      ? decodeReceiverDatum(currentReceiverUtxo.datum)
      : state.receiver.receiverState;
  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) + amountLovelace
    ).toString(),
  };
  const receiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);
  const topUpRedeemer = Data.to(new Constr(0, []));

  reportProgress("Building Preview receiver top-up transaction");
  const txBuilder = lucid
    .newTx()
    .collectFrom([currentReceiverUtxo], topUpRedeemer)
    .attach.SpendingValidator(receiverValidator)
    .pay.ToContract(
      state.receiver.receiverValidatorAddress,
      { kind: "inline", value: receiverDatumCbor },
      {
        lovelace:
          BigInt(nextReceiverState.minUtxoLovelace) +
          BigInt(nextReceiverState.balanceLovelace),
        [state.receiver.receiverUnit]: 1n,
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
  console.error(`[preview:receiver:top-up] ${message}`);
}

async function readReceiverTopUpInput(inputPath: string): Promise<ReceiverTopUpInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ReceiverTopUpInput;
}
