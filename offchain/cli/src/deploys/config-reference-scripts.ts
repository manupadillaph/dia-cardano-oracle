import path from "node:path";

import {
  makeConfigStateValidator,
  makeCoordinatorValidator,
  makeReferenceHolderValidator,
  scriptAddressFromValidator,
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
import {
  selectFundingUtxo,
  splitUnit,
  toBigInt,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";

export async function publishConfigReferenceScripts(args: {
  lovelacePerOutput: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Using lovelacePerOutput=${args.lovelacePerOutput} for config reference scripts`);
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
    state.compiledScripts?.configValidator
      ? Promise.resolve(
          spendingValidatorFromCompiledScript(state.compiledScripts.configValidator),
        )
      : makeConfigStateValidator({
          bootstrapOutRef: state.bootstrapRefs.config,
          assetName: configAssetName,
        }),
    state.compiledScripts?.coordinatorValidator
      ? Promise.resolve(
          withdrawalValidatorFromCompiledScript(
            state.compiledScripts.coordinatorValidator,
          ),
        )
      : makeCoordinatorValidator({
          configPolicyId: state.scripts.configPolicyId,
          configAssetName,
        }),
  ]);
  const lovelacePerOutput = toBigInt(args.lovelacePerOutput, "lovelacePerOutput");
  const referenceAddress = scriptAddressFromValidator(await makeReferenceHolderValidator());
  const fundingUtxo = selectFundingUtxo(
    walletUtxos,
    [
      state.bootstrapRefs.config,
      ...(state.bootstrapRefs.paymentHook ? [state.bootstrapRefs.paymentHook] : []),
    ],
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
    referenceHolderAddress: referenceAddress,
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
      step: "preview:config:reference-scripts",
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:config:reference-scripts] ${message}`);
}
