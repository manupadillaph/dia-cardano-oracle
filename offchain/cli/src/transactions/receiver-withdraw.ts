import path from "node:path";
import { stepId, networkTag , getCliConfig} from "../core/config.js";
import { Constr, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
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
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { readClientContext } from "../core/artifact-context.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  addressToPlutusData,
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  toBigInt,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertReceiverWithdrawAmountPositive,
  assertReceiverWithdrawAmountValid,
} from "../preflight/index.js";

export { assertReceiverWithdrawAmountValid } from "../preflight/index.js";

export async function receiverWithdraw(args: {
  amountLovelace: string;
  recipientAddress?: string;
  statePath?: string;
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
  reportProgress(`Using amountLovelace=${args.amountLovelace} for receiver withdraw`);
  const statePath = path.resolve(args.statePath ?? `state/${networkTag()}/clients/client-a.json`);
  reportProgress(`Loading client state from ${statePath}`);
  const { client: state, protocol } = await readClientContext({
    clientStatePath: statePath,
    protocolStatePath: args.protocolStatePath,
  });

  if (!state.receiver) {
    throw new Error("Receiver withdraw requires a client state artifact produced by receiver bootstrap.");
  }

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    protocol.configState.validConfigSigners,
  );

  const [currentConfigUtxo, currentReceiverUtxo] = await Promise.all([
    findSingleUtxoAtUnit(
      lucid,
      protocol.scripts.configValidatorAddress,
      protocol.scripts.configUnit,
      "config",
    ),
    findSingleUtxoAtUnit(
      lucid,
      state.receiver.receiverValidatorAddress,
      state.receiver.receiverUnit,
      "receiver",
    ),
  ]);
  if (!state.compiledScripts?.receiverValidator) {
    throw new Error("receiverValidator compiled script not found. Run receiver:parameterize first.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator);

  const amountLovelace = toBigInt(args.amountLovelace, "amountLovelace");
  assertReceiverWithdrawAmountPositive(amountLovelace);
  const recipientAddress = args.recipientAddress?.trim().length
    ? args.recipientAddress.trim()
    : walletAddress;
  const currentReceiverState =
    currentReceiverUtxo.datum
      ? decodeReceiverDatum(currentReceiverUtxo.datum)
      : state.receiver.receiverState;
  assertReceiverWithdrawAmountValid(
    amountLovelace,
    BigInt(currentReceiverState.balanceLovelace),
  );

  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) - amountLovelace
    ).toString(),
  };

  const receiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);
  const withdrawRedeemer = Data.to(
    new Constr<PlutusData>(3, [
      amountLovelace,
      addressToPlutusData(recipientAddress),
    ]),
  );

  reportProgress(`Building ${getCliConfig().cardanoNetwork} receiver withdraw transaction`);
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
    .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
    .collectFrom([currentReceiverUtxo], withdrawRedeemer)
    .addSignerKey(walletDefaults.paymentKeyHash)
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
    )
    .pay.ToAddress(recipientAddress, { lovelace: amountLovelace });

  if (isAnyReferenceScriptMissing(missingReferenceScript)) {
    reportProgress(
      "Reference script for receiver is missing on-chain; attaching the receiver validator inline.",
    );
    txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
  }

  const txSignBuilder = await txBuilder.complete();
  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
  logEffectiveOutputs(txSignBuilder, reportProgress);
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
      label: "receiver withdraw transaction",
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      spentUtxos: [],
      label: "receiver withdraw",
      requireChangeWhenNoSpentUtxos: true,
    });
  }

  if (!args.buildOnly && confirmed) {
    await waitForUnitUtxoReplacement({
      lucid,
      address: state.receiver.receiverValidatorAddress,
      unit: state.receiver.receiverUnit,
      label: "receiver",
      previousOutRef: currentReceiverUtxo,
    });
  }

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    receiver: {
      ...state.receiver,
      receiverState: nextReceiverState,
    },
    datum: {
      ...state.datum,
      receiverCbor: receiverDatumCbor,
    },
    transactions: appendTransactionRecord(state.transactions, {
      step: stepId("receiver:withdraw"),
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[receiver:withdraw] ${message}`);
}
