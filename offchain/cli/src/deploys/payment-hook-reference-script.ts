import path from "node:path";

import {
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
  computeMinUtxoForScriptOutput,
  logEffectiveOutputs,
} from "../core/output-logging.js";
import {
  selectFundingUtxo,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";

export async function publishPaymentHookReferenceScript(args: {
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  const state = await readConfigState(path.resolve(args.statePath ?? "state/preview/config-bootstrap.json"));

  if (!state.bootstrapRefs.paymentHook || !state.scripts.paymentHookUnit) {
    throw new Error("PaymentHook reference-script publish requires the selected PaymentHook bootstrap reference.");
  }
  if (!state.scripts.referenceHolderAddress) {
    throw new Error("PaymentHook reference-script publish requires config parameterization first (run preview:config:parameterize).");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  if (!state.compiledScripts.paymentHookValidator) {
    throw new Error("paymentHookValidator compiled script not found. Run preview:payment-hook:parameterize first.");
  }
  const paymentHookValidator = spendingValidatorFromCompiledScript(state.compiledScripts.paymentHookValidator);
  const referenceAddress = state.scripts.referenceHolderAddress;
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (!coinsPerUtxoByte) {
    throw new Error("Lucid protocol parameters did not expose coinsPerUtxoByte.");
  }
  const paymentHookMinLovelace = computeMinUtxoForScriptOutput({
    coinsPerUtxoByte,
    address: referenceAddress,
    scriptRef: paymentHookValidator,
  });
  reportProgress(
    `Computed min lovelace for reference-script outputs: paymentHookValidator=${paymentHookMinLovelace}`,
  );
  const fundingUtxo = selectFundingUtxo(
    walletUtxos,
    [state.bootstrapRefs.config, state.bootstrapRefs.paymentHook],
    paymentHookMinLovelace,
    "payment-hook reference-script publish",
  );

  reportProgress("Building Preview payment-hook reference-script publish transaction");
  const txSignBuilder = await lucid
    .newTx()
    .collectFrom([fundingUtxo])
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: paymentHookMinLovelace }, paymentHookValidator)
    .complete();
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
