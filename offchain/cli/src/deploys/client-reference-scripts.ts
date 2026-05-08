import path from "node:path";

import {
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
  type ReceiverArtifact,
} from "../core/state.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  computeMinUtxoForScriptOutput,
  logEffectiveOutputs,
} from "../core/output-logging.js";
import {
  buildReceiverDatumCbor,
  selectFundingUtxo,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";

export async function publishClientReferenceScripts(args: {
  statePath?: string;
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
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
  if (!protocol.scripts.referenceHolderAddress) {
    throw new Error(
      "Client reference-script publish requires config parameterization first (run preview:config:parameterize).",
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

  const referenceAddress = protocol.scripts.referenceHolderAddress;
  if (!state.receiver) {
    throw new Error(
      "Client reference-script publish requires a client artifact produced by preview:receiver:parameterize.",
    );
  }
  const latestWalletUtxos = walletUtxos;
  const receiver = await resolveReceiverArtifact(state);
  if (!state.compiledScripts?.receiverValidator) {
    throw new Error("receiverValidator compiled script not found. Run preview:receiver:parameterize first.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator);
  if (!state.compiledScripts?.pairValidator) {
    throw new Error("pairValidator compiled script not found. Run preview:receiver:parameterize first.");
  }
  const pairValidator = spendingValidatorFromCompiledScript(state.compiledScripts.pairValidator);
  if (!state.compiledScripts?.pairMintPolicy) {
    throw new Error("pairMintPolicy compiled script not found. Run preview:receiver:parameterize first.");
  }
  const pairMintPolicy = mintingPolicyFromCompiledScript(state.compiledScripts.pairMintPolicy);

  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (!coinsPerUtxoByte) {
    throw new Error("Lucid protocol parameters did not expose coinsPerUtxoByte.");
  }
  const receiverMinLovelace = computeMinUtxoForScriptOutput({
    coinsPerUtxoByte,
    address: referenceAddress,
    scriptRef: receiverValidator,
  });
  const pairMinLovelace = computeMinUtxoForScriptOutput({
    coinsPerUtxoByte,
    address: referenceAddress,
    scriptRef: pairValidator,
  });
  const pairMintMinLovelace = computeMinUtxoForScriptOutput({
    coinsPerUtxoByte,
    address: referenceAddress,
    scriptRef: pairMintPolicy,
  });
  reportProgress(
    `Computed min lovelace for reference-script outputs: receiverValidator=${receiverMinLovelace}, pairValidator=${pairMinLovelace}, pairMintPolicy=${pairMintMinLovelace}`,
  );

  reportProgress("Building Preview client reference-script publish transaction");
  const fundingUtxo = selectFundingUtxo(
    latestWalletUtxos,
    [receiver.bootstrapRef],
    receiverMinLovelace + pairMinLovelace + pairMintMinLovelace,
    "client reference-script publish",
  );
  const txBuilder = lucid
    .newTx()
    .collectFrom([fundingUtxo])
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: receiverMinLovelace }, receiverValidator)
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: pairMinLovelace }, pairValidator)
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: pairMintMinLovelace }, pairMintPolicy);

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
      label: "client reference-script publish transaction",
    });
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
        pairMint: {
          txHash: submittedTxHash ?? "",
          outputIndex: 2,
          scriptHash: policyIdFromMintingPolicy(pairMintPolicy),
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

  if (!state.compiledScripts?.pairValidator) {
    throw new Error("pairValidator compiled script not found. Run preview:receiver:parameterize first.");
  }
  const pairValidator = spendingValidatorFromCompiledScript(state.compiledScripts.pairValidator);
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);
  if (!state.compiledScripts?.pairMintPolicy) {
    throw new Error("pairMintPolicy compiled script not found. Run preview:receiver:parameterize first.");
  }
  const pairPolicyId =
    state.scripts.pairPolicyId ||
    policyIdFromMintingPolicy(mintingPolicyFromCompiledScript(state.compiledScripts.pairMintPolicy));

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
