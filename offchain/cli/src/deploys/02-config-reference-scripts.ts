import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  makeConfigStateValidator,
  makeCoordinatorValidator,
  makeReferenceHolderValidator,
  scriptAddressFromValidator,
  scriptHashFromValidator,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { readConfigState, type ConfigStateArtifact } from "../core/state.js";
import {
  selectFundingUtxo,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";

type ConfigReferenceScriptsInput = {
  lovelacePerOutput: string;
};

export async function publishConfigReferenceScripts(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading config reference-script input from ${path.resolve(args.inputPath)}`);
  const input = await readInput(path.resolve(args.inputPath));
  const state = await readConfigState(path.resolve(args.statePath ?? "state/preview/config-bootstrap.json"));

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const [configValidator, coordinatorValidator] = await Promise.all([
    makeConfigStateValidator({
      bootstrapOutRef: state.bootstrapRefs.config,
      assetName: configAssetName,
    }),
    makeCoordinatorValidator({
      configPolicyId: state.scripts.configPolicyId,
      configAssetName,
    }),
  ]);
  const lovelacePerOutput = toBigInt(input.lovelacePerOutput, "lovelacePerOutput");
  const referenceAddress = scriptAddressFromValidator(await makeReferenceHolderValidator());
  const fundingUtxo = selectFundingUtxo(
    walletUtxos,
    [state.bootstrapRefs.config],
    lovelacePerOutput * 2n,
    "config reference-script publish",
  );

  reportProgress("Building Preview config reference-script publish transaction");
  const txSignBuilder = await lucid
    .newTx()
    .collectFrom([fundingUtxo])
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: lovelacePerOutput }, configValidator)
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: lovelacePerOutput }, coordinatorValidator)
    .complete();
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
    referenceScripts: {
      ...state.referenceScripts,
      global: {
        ...state.referenceScripts?.global,
        config: {
          txHash: submittedTxHash ?? "",
          outputIndex: 0,
          scriptHash: scriptHashFromValidator(configValidator),
        },
        coordinator: {
          txHash: submittedTxHash ?? "",
          outputIndex: 1,
          scriptHash: scriptHashFromValidator(coordinatorValidator),
        },
        paymentHook: state.referenceScripts?.global?.paymentHook ?? {
          txHash: "",
          outputIndex: 0,
          scriptHash: "",
        },
      },
    },
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

async function readInput(inputPath: string): Promise<ConfigReferenceScriptsInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ConfigReferenceScriptsInput;
}

function reportProgress(message: string): void {
  console.error(`[preview:config:reference-scripts] ${message}`);
}
