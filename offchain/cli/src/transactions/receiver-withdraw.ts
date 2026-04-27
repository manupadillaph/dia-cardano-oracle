import path from "node:path";
import { Constr } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeReceiverValidator,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  makeConfiguredLucid,
  makeConfiguredProvider,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  type ClientStateArtifact,
} from "../core/state.js";
import { readClientContext } from "../core/artifact-context.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  addressToPlutusData,
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";

export async function receiverWithdraw(args: {
  amountLovelace: string;
  recipientAddress?: string;
  statePath?: string;
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
  reportProgress(`Using amountLovelace=${args.amountLovelace} for receiver withdraw`);
  const statePath = path.resolve(args.statePath ?? "state/preview/clients/client-a.json");
  reportProgress(`Loading client state from ${statePath}`);
  const { client: state, protocol } = await readClientContext({
    clientStatePath: statePath,
    protocolStatePath: args.protocolStatePath,
  });

  if (!state.receiver) {
    throw new Error("Receiver withdraw requires a client state artifact produced by receiver bootstrap.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const walletAddress = await wallet.address();
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  if (!protocol.configState.validConfigSigners.includes(walletDefaults.paymentKeyHash)) {
    throw new Error("The configured wallet is not authorized as a config signer.");
  }

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
  const referenceScriptUtxos = await loadReceiverReferenceScriptUtxos(state);

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
  const recipientAddress = args.recipientAddress?.trim().length
    ? args.recipientAddress.trim()
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
      step: "preview:receiver:withdraw",
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:receiver:withdraw] ${message}`);
}

async function loadReceiverReferenceScriptUtxos(
  state: ClientStateArtifact,
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
