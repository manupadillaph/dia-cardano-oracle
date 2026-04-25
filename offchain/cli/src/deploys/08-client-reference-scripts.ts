import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  makePairStateMintingPolicy,
  makePairStateValidator,
  makeReferenceHolderValidator,
  makeReceiverValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import {
  getDefaultConfigStatePath,
  readConfigState,
  type ConfigStateArtifact,
  type ReceiverArtifact,
} from "../core/state.js";
import {
  buildReceiverDatumCbor,
  selectFundingUtxo,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";

type ClientReferenceScriptsInput = {
  clientId?: string;
  lovelacePerOutput: string;
  receiverBootstrapRef?: {
    txHash: string;
    outputIndex: number;
  };
  receiverAssetName?: string;
  initialBalanceLovelace?: string;
  minUtxoLovelace?: string;
};

export async function publishClientReferenceScripts(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading client reference-script input from ${path.resolve(args.inputPath)}`);
  const input = await readClientReferenceScriptsInput(path.resolve(args.inputPath));
  const statePath = path.resolve(args.statePath ?? getDefaultConfigStatePath());
  reportProgress(`Loading client state from ${statePath}`);
  const state = await readConfigState(statePath);

  if (!state.configState.paymentHookRef || !state.configState.updateCoordinatorCredential) {
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

  const lovelacePerOutput = toBigInt(input.lovelacePerOutput, "lovelacePerOutput");
  const referenceAddress = scriptAddressFromValidator(await makeReferenceHolderValidator());

  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  if (!state.receiver) {
    throw new Error(
      "Client reference-script publish requires a client artifact produced by preview:receiver:parameterize.",
    );
  }
  const latestWalletUtxos = walletUtxos;
  const receiver = await resolveReceiverArtifact(state, configAssetName);
  const [receiverValidator, pairValidator] = await Promise.all([
    makeReceiverValidator({
      bootstrapOutRef: receiver.bootstrapRef,
      assetName: receiver.receiverAssetName,
      configPolicyId: state.scripts.configPolicyId,
      configAssetName,
    }),
    makePairStateValidator({
      configPolicyId: state.scripts.configPolicyId,
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
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

async function resolveReceiverArtifact(
  state: ConfigStateArtifact,
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

  const pairValidator = await makePairStateValidator({
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    receiverHash: state.receiver.receiverValidatorHash,
  });
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);
  const pairPolicyId =
    state.scripts.pairPolicyId ??
    policyIdFromMintingPolicy(
      await makePairStateMintingPolicy({
        configPolicyId: state.scripts.configPolicyId,
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

async function readClientReferenceScriptsInput(
  inputPath: string,
): Promise<ClientReferenceScriptsInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ClientReferenceScriptsInput;
}
