import path from "node:path";
import { stepId, networkTag } from "../core/config.js";

import {
  scriptHashFromValidator,
  spendingValidatorFromCompiledScript,
  withdrawalValidatorFromCompiledScript,
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

export async function publishConfigReferenceScripts(args: {
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  const state = await readConfigState(path.resolve(args.statePath ?? `state/${networkTag()}/config-bootstrap.json`));

  if (!state.scripts.referenceHolderAddress) {
    throw new Error("Config reference-scripts publish requires config parameterization first (run config:parameterize).");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  if (!state.compiledScripts?.configValidator) {
    throw new Error("configValidator compiled script not found. Run config:parameterize first.");
  }
  const configValidator = spendingValidatorFromCompiledScript(state.compiledScripts.configValidator);
  if (!state.compiledScripts?.coordinatorValidator) {
    throw new Error("coordinatorValidator compiled script not found. Run config:parameterize first.");
  }
  const coordinatorValidator = withdrawalValidatorFromCompiledScript(state.compiledScripts.coordinatorValidator);
  const referenceAddress = state.scripts.referenceHolderAddress;
  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (!coinsPerUtxoByte) {
    throw new Error("Lucid protocol parameters did not expose coinsPerUtxoByte.");
  }
  const configMinLovelace = computeMinUtxoForScriptOutput({
    coinsPerUtxoByte,
    address: referenceAddress,
    scriptRef: configValidator,
  });
  const coordinatorMinLovelace = computeMinUtxoForScriptOutput({
    coinsPerUtxoByte,
    address: referenceAddress,
    scriptRef: coordinatorValidator,
  });
  reportProgress(
    `Computed min lovelace for reference-script outputs: configValidator=${configMinLovelace}, coordinatorValidator=${coordinatorMinLovelace}`,
  );
  const fundingUtxo = selectFundingUtxo(
    walletUtxos,
    [
      state.bootstrapRefs.config,
      ...(state.bootstrapRefs.paymentHook ? [state.bootstrapRefs.paymentHook] : []),
    ],
    configMinLovelace + coordinatorMinLovelace,
    "config reference-script publish",
  );

  reportProgress("Building Preview config reference-script publish transaction");
  const txSignBuilder = await lucid
    .newTx()
    .collectFrom([fundingUtxo])
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: configMinLovelace }, configValidator)
    .pay.ToAddressWithData(referenceAddress, undefined, { lovelace: coordinatorMinLovelace }, coordinatorValidator)
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
      label: "config reference-script publish transaction",
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
      label: "config reference-script publish",
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
    transactions: appendTransactionRecord(state.transactions, {
      step: stepId("config:reference-scripts"),
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[config:reference-scripts] ${message}`);
}
