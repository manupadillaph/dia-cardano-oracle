import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  makePaymentHookValidator,
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

type PaymentHookReferenceScriptInput = {
  lovelacePerOutput: string;
};

export async function publishPaymentHookReferenceScript(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading payment-hook reference-script input from ${path.resolve(args.inputPath)}`);
  const input = await readInput(path.resolve(args.inputPath));
  const state = await readConfigState(path.resolve(args.statePath ?? "state/preview/config-bootstrap.json"));

  if (!state.bootstrapRefs.paymentHook || !state.scripts.paymentHookUnit) {
    throw new Error("PaymentHook reference-script publish requires the PaymentHook one-shot parameterization reference.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const paymentHookAssetName = splitUnit(state.scripts.paymentHookUnit).assetName;
  const paymentHookValidator = await makePaymentHookValidator({
    bootstrapOutRef: state.bootstrapRefs.paymentHook,
    assetName: paymentHookAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    coordinatorCredentialHash: state.scripts.coordinatorHash,
  });
  const lovelacePerOutput = toBigInt(input.lovelacePerOutput, "lovelacePerOutput");
  const referenceAddress = scriptAddressFromValidator(await makeReferenceHolderValidator());
  const fundingUtxo = selectFundingUtxo(
    walletUtxos,
    [state.bootstrapRefs.config, state.bootstrapRefs.paymentHook],
    lovelacePerOutput,
    "payment-hook reference-script publish",
  );

  reportProgress("Building Preview payment-hook reference-script publish transaction");
  const txSignBuilder = await lucid
    .newTx()
    .collectFrom([fundingUtxo])
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: lovelacePerOutput }, paymentHookValidator)
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
        config: state.referenceScripts?.global?.config ?? {
          txHash: "",
          outputIndex: 0,
          scriptHash: "",
        },
        coordinator: state.referenceScripts?.global?.coordinator ?? {
          txHash: "",
          outputIndex: 0,
          scriptHash: "",
        },
        paymentHook: {
          txHash: submittedTxHash ?? "",
          outputIndex: 0,
          scriptHash: scriptHashFromValidator(paymentHookValidator),
        },
      },
    },
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

async function readInput(inputPath: string): Promise<PaymentHookReferenceScriptInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as PaymentHookReferenceScriptInput;
}

function reportProgress(message: string): void {
  console.error(`[preview:payment-hook:reference-script] ${message}`);
}
