import path from "node:path";
import { Constr, type UTxO } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";

import {
  makeReceiverValidator,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  type ClientStateArtifact,
} from "../core/state.js";
import {
  isAnyReferenceScriptMissing,
  loadReferenceScriptUtxos,
} from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  splitUnit,
  toBigInt,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";
import { assertReceiverTopUpAmountPositive } from "../preflight/index.js";

export async function receiverTopUp(args: {
  amountLovelace: string;
  statePath?: string;
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
  reportProgress(`Using amountLovelace=${args.amountLovelace} for receiver top-up`);
  const statePath = path.resolve(args.statePath ?? "state/preview/clients/client-a.json");
  reportProgress(`Loading client state from ${statePath}`);
  const { client: state, protocol } = await readClientContext({
    clientStatePath: statePath,
    protocolStatePath: args.protocolStatePath,
  });

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
  const configAssetName = splitUnit(protocol.scripts.configUnit).assetName;
  const receiverValidator = state.compiledScripts?.receiverValidator
    ? spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator)
    : await makeReceiverValidator({
        bootstrapOutRef: state.receiver.bootstrapRef,
        assetName: state.receiver.receiverAssetName,
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
      });

  const amountLovelace = toBigInt(args.amountLovelace, "amountLovelace");
  assertReceiverTopUpAmountPositive(amountLovelace);
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
  const { utxos: referenceScriptUtxos, missing: missingReferenceScript } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "receiver",
          label: "receiver",
          outRef: state.referenceScripts?.client?.receiver
            ? {
                txHash: state.referenceScripts.client.receiver.txHash,
                outputIndex: state.referenceScripts.client.receiver.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  let txBuilder = lucid
    .newTx()
    .readFrom(referenceScriptUtxos)
    .collectFrom([currentReceiverUtxo], topUpRedeemer)
    .pay.ToContract(
      state.receiver.receiverValidatorAddress,
      { kind: "inline", value: receiverDatumCbor },
      {
        lovelace:
          BigInt(nextReceiverState.minUtxoLovelace) +
          BigInt(nextReceiverState.balanceLovelace) +
          BigInt(nextReceiverState.accruedToHookLovelace),
        [state.receiver.receiverUnit]: 1n,
      },
    );

  if (isAnyReferenceScriptMissing(missingReferenceScript)) {
    reportProgress(
      "Reference script for receiver is missing on-chain; attaching the receiver validator inline.",
    );
    txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
  }

  const txSignBuilder = await txBuilder.complete();
  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
  const unsignedHash = txSignBuilder.toHash();
  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(`Unsigned transaction ready: ${unsignedHash}`);
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await awaitTxConfirmation({
      lucid,
      txHash: submittedTxHash,
      reportProgress,
      label: "receiver top-up transaction",
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }
  }

  const latestReceiverUtxo =
    args.buildOnly || !confirmed
      ? state.receiver.receiverUtxo.current
      : await waitForUnitUtxoReplacement({
          lucid,
          address: state.receiver.receiverValidatorAddress,
          unit: state.receiver.receiverUnit,
          label: "receiver",
          previousOutRef: currentReceiverUtxo,
        });

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
    transactions: appendTransactionRecord(state.transactions, {
      step: "preview:receiver:top-up",
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:receiver:top-up] ${message}`);
}
