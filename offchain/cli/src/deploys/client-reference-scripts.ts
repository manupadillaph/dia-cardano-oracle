import path from "node:path";

import {
  makePairStateMintingPolicy,
  makePairStateValidator,
  makeReferenceHolderValidator,
  makeReceiverValidator,
  mintingPolicyFromCompiledScript,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import {
  appendTransactionRecord,
  type ClientStateArtifact,
  type ConfigStateArtifact,
  type ReceiverArtifact,
} from "../core/state.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  buildReceiverDatumCbor,
  selectFundingUtxo,
  splitUnit,
  toBigInt,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";

export async function publishClientReferenceScripts(args: {
  lovelacePerOutput: string;
  statePath?: string;
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
  reportProgress(`Using lovelacePerOutput=${args.lovelacePerOutput} for client reference scripts`);
  const statePath = path.resolve(args.statePath ?? "state/preview/clients/client-a.json");
  reportProgress(`Loading client state from ${statePath}`);
  const { client: state, protocol } = await readClientContext({
    clientStatePath: statePath,
    protocolStatePath: args.protocolStatePath,
  });

  if (!protocol.configState.paymentHookRef || !protocol.configState.updateCoordinatorCredential) {
    throw new Error(
      "Client reference-script publish requires a protocol state artifact produced after payment-hook bootstrap.",
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

  const lovelacePerOutput = toBigInt(args.lovelacePerOutput, "lovelacePerOutput");
  const referenceAddress = scriptAddressFromValidator(await makeReferenceHolderValidator());

  const configAssetName = splitUnit(protocol.scripts.configUnit).assetName;
  if (!state.receiver) {
    throw new Error(
      "Client reference-script publish requires a client artifact produced by preview:receiver:parameterize.",
    );
  }
  const latestWalletUtxos = walletUtxos;
  const receiver = await resolveReceiverArtifact(state, protocol, configAssetName);
  const [receiverValidator, pairValidator] = await Promise.all([
    state.compiledScripts?.receiverValidator
      ? Promise.resolve(
          spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator),
        )
      : makeReceiverValidator({
          bootstrapOutRef: receiver.bootstrapRef,
          assetName: receiver.receiverAssetName,
          configPolicyId: protocol.scripts.configPolicyId,
          configAssetName,
        }),
    state.compiledScripts?.pairValidator
      ? Promise.resolve(
          spendingValidatorFromCompiledScript(state.compiledScripts.pairValidator),
        )
      : makePairStateValidator({
          configPolicyId: protocol.scripts.configPolicyId,
          configAssetName,
          receiverHash: receiver.receiverValidatorHash,
        }),
  ]);

  reportProgress("Building Preview client reference-script publish transaction");
  const fundingUtxo = selectFundingUtxo(
    latestWalletUtxos,
    [receiver.bootstrapRef],
    lovelacePerOutput * 2n,
    "client reference-script publish",
  );
  const txBuilder = lucid
    .newTx()
    .collectFrom([fundingUtxo])
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: lovelacePerOutput }, receiverValidator)
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: lovelacePerOutput }, pairValidator);

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
    confirmed = await lucid.awaitTx(submittedTxHash, 3_000);
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      spentUtxos: [fundingUtxo],
      label: "client reference-script publish",
    });
  }

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    scripts: {
      ...state.scripts,
      pairPolicyId: state.scripts.pairPolicyId ?? receiver.pairPolicyId,
      pairValidatorHash: state.scripts.pairValidatorHash ?? receiver.pairValidatorHash,
      pairValidatorAddress:
        state.scripts.pairValidatorAddress ?? receiver.pairValidatorAddress,
    },
    referenceScripts: {
      ...state.referenceScripts,
      client: {
        receiver: {
          txHash: submittedTxHash ?? "",
          outputIndex: 0,
          scriptHash: scriptHashFromValidator(receiverValidator),
        },
        pair: {
          txHash: submittedTxHash ?? "",
          outputIndex: 1,
          scriptHash: scriptHashFromValidator(pairValidator),
        },
      },
    },
    receiver: {
      clientId: receiver.clientId,
      bootstrapRef: receiver.bootstrapRef,
      receiverAssetName: receiver.receiverAssetName,
      receiverPolicyId: receiver.receiverPolicyId,
      receiverUnit: receiver.receiverUnit,
      receiverValidatorHash: receiver.receiverValidatorHash,
      receiverValidatorAddress: receiver.receiverValidatorAddress,
      receiverState: receiver.receiverState,
      receiverUtxo: receiver.receiverUtxo,
    },
    datum: {
      ...state.datum,
      receiverCbor: receiver.receiverCbor,
    },
    transactions: appendTransactionRecord(state.transactions, {
      step: "preview:reference-scripts:publish-client",
      submittedTxHash,
      confirmed,
    }),
  };
}

async function resolveReceiverArtifact(
  state: ClientStateArtifact,
  protocol: ConfigStateArtifact,
  configAssetName: string,
): Promise<
  ReceiverArtifact & {
    pairPolicyId: string;
    pairValidatorHash: string;
    pairValidatorAddress: string;
    receiverCbor: string;
  }
> {
  if (!state.receiver) {
    throw new Error(
      "Client reference-script publish requires a client artifact produced by preview:receiver:parameterize.",
    );
  }

  const pairValidator = state.compiledScripts?.pairValidator
    ? spendingValidatorFromCompiledScript(state.compiledScripts.pairValidator)
    : await makePairStateValidator({
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
        receiverHash: state.receiver.receiverValidatorHash,
      });
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);
  const pairPolicyId =
    state.scripts.pairPolicyId ??
    policyIdFromMintingPolicy(
      state.compiledScripts?.pairMintPolicy
        ? mintingPolicyFromCompiledScript(state.compiledScripts.pairMintPolicy)
        : await makePairStateMintingPolicy({
          configPolicyId: protocol.scripts.configPolicyId,
            configAssetName,
            receiverHash: state.receiver.receiverValidatorHash,
          }),
    );

  return {
    ...state.receiver,
    pairPolicyId,
    pairValidatorHash,
    pairValidatorAddress,
    receiverCbor: buildReceiverDatumCbor(state.receiver.receiverState),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:reference-scripts:publish-client] ${message}`);
}
