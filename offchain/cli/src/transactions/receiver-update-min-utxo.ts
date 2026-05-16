import path from "node:path";
import { stepId } from "../core/config.js";
import { Constr } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";

import { spendingValidatorFromCompiledScript } from "../core/contracts.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  readClientState,
  readConfigState,
  type ClientStateArtifact,
} from "../core/state.js";
import { isAnyReferenceScriptMissing, loadReferenceScriptUtxos } from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  requireInlineDatum,
  toBigInt,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertConfigUtxoLivesAtValidatorAddress,
} from "../preflight/index.js";

export async function receiverUpdateMinUtxo(args: {
  newMinUtxoLovelace: string;
  protocolStatePath: string;
  clientStatePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
  reportProgress("Loading protocol and client state");
  const protocol = await readConfigState(path.resolve(args.protocolStatePath));
  const client = await readClientState(path.resolve(args.clientStatePath));

  if (!client.receiver) {
    throw new Error("Client state does not have a receiver. Run receiver:bootstrap first.");
  }

  const newMinUtxo = toBigInt(args.newMinUtxoLovelace, "newMinUtxoLovelace");
  if (newMinUtxo <= 0n) {
    throw new Error("Receiver min_utxo_lovelace must be greater than zero lovelace.");
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

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    protocol.configState.validConfigSigners,
    {
      unauthorizedMessage: "The configured wallet is not authorized as a config signer.",
    },
  );

  reportProgress("Finding Config UTxO");
  const configUtxo = await findSingleUtxoAtUnit(
    lucid,
    protocol.scripts.configValidatorAddress,
    protocol.scripts.configUnit,
    "config",
  );
  assertConfigUtxoLivesAtValidatorAddress(
    configUtxo.address,
    protocol.scripts.configValidatorAddress,
  );

  reportProgress("Finding Receiver UTxO");
  const receiverUnit = client.receiver.receiverUnit;
  const receiverValidatorAddress = client.receiver.receiverValidatorAddress;
  const currentReceiverUtxo = await findSingleUtxoAtUnit(
    lucid,
    receiverValidatorAddress,
    receiverUnit,
    "receiver",
  );

  const currentReceiverDatumCbor = requireInlineDatum(currentReceiverUtxo, "receiver");
  const currentReceiverState = decodeReceiverDatum(currentReceiverDatumCbor);

  reportProgress(`Updating Receiver min_utxo from ${currentReceiverState.minUtxoLovelace} to ${newMinUtxo}`);

  const nextReceiverState = {
    ...currentReceiverState,
    minUtxoLovelace: newMinUtxo.toString(),
  };

  const nextReceiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);

  // Build the UpdateMinUtxo redeemer
  // ReceiverRedeemer::UpdateMinUtxo { new_min_utxo_lovelace: Int }
  const updateMinUtxoRedeemer = Data.to(
    new Constr(4, [newMinUtxo]) // Index 4 = UpdateMinUtxo (after TopUp, AccrueFee, Settle, Withdraw)
  );

  reportProgress("Building Preview receiver update-min-utxo transaction");

  const { utxos: referenceScriptUtxos, missing: missingReferenceScript } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "receiver",
          label: "receiver",
          outRef: client.referenceScripts?.client?.receiver
            ? {
                txHash: client.referenceScripts.client.receiver.txHash,
                outputIndex: client.referenceScripts.client.receiver.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  if (!client.compiledScripts?.receiverValidator) {
    throw new Error("receiverValidator compiled script not found. Run receiver:parameterize first.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(
    client.compiledScripts.receiverValidator,
  );

  let txBuilder = lucid
    .newTx()
    .readFrom([configUtxo])
    .collectFrom([currentReceiverUtxo], updateMinUtxoRedeemer)
    .addSignerKey(walletDefaults.paymentKeyHash)
    .pay.ToContract(
      receiverValidatorAddress,
      { kind: "inline", value: nextReceiverDatumCbor },
      {
        lovelace: BigInt(nextReceiverState.minUtxoLovelace) + 
                 BigInt(nextReceiverState.balanceLovelace) + 
                 BigInt(nextReceiverState.accruedToHookLovelace),
        [receiverUnit]: 1n,
      },
    );

  if (isAnyReferenceScriptMissing(missingReferenceScript)) {
    reportProgress("Reference script for receiver is missing; attaching inline.");
    txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
  } else {
    txBuilder = txBuilder.readFrom(referenceScriptUtxos);
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
      label: "receiver update-min-utxo transaction",
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
      label: "receiver update-min-utxo",
      requireChangeWhenNoSpentUtxos: true,
    });

    await waitForUnitUtxoReplacement({
      lucid,
      address: receiverValidatorAddress,
      unit: receiverUnit,
      label: "receiver",
      previousOutRef: currentReceiverUtxo,
    });
  }

  const updatedClient: ClientStateArtifact = {
    ...client,
    wallet: {
      source,
      address: walletAddress,
    },
    receiver: {
      ...client.receiver,
      receiverState: nextReceiverState,
    },
    datum: {
      receiverCbor: nextReceiverDatumCbor,
    },
    transactions: appendTransactionRecord(client.transactions, {
      step: stepId("receiver:update-min-utxo"),
      submittedTxHash,
      confirmed,
    }),
  };

  return updatedClient;
}

function reportProgress(message: string): void {
  console.error(`[receiver:update-min-utxo] ${message}`);
}
