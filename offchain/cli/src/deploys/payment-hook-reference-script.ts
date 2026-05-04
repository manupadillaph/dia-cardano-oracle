import path from "node:path";

import {
  makePaymentHookValidator,
  makeReferenceHolderValidator,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import {
  appendTransactionRecord,
  readConfigState,
  type ConfigStateArtifact,
} from "../core/state.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import {
  selectFundingUtxo,
  splitUnit,
  toBigInt,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";

export async function publishPaymentHookReferenceScript(args: {
  lovelacePerOutput: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Using lovelacePerOutput=${args.lovelacePerOutput} for payment-hook reference script`);
  const state = await readConfigState(path.resolve(args.statePath ?? "state/preview/config-bootstrap.json"));

  if (!state.bootstrapRefs.paymentHook || !state.scripts.paymentHookUnit) {
    throw new Error("PaymentHook reference-script publish requires the selected PaymentHook bootstrap reference.");
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
  const paymentHookValidator = state.compiledScripts?.paymentHookValidator
    ? spendingValidatorFromCompiledScript(state.compiledScripts.paymentHookValidator)
    : await makePaymentHookValidator({
        bootstrapOutRef: state.bootstrapRefs.paymentHook,
        assetName: paymentHookAssetName,
        configPolicyId: state.scripts.configPolicyId,
        configAssetName,
        coordinatorCredentialHash: state.scripts.coordinatorHash,
      });
  const lovelacePerOutput = toBigInt(args.lovelacePerOutput, "lovelacePerOutput");
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
      label: "payment-hook reference-script publish transaction",
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
      label: "payment-hook reference-script publish",
    });
  }

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    referenceHolderAddress: referenceAddress,
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
    transactions: appendTransactionRecord(state.transactions, {
      step: "preview:payment-hook:reference-script",
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:payment-hook:reference-script] ${message}`);
}
