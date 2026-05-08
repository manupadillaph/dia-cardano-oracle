import path from "node:path";
import { Constr } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  hasCompletedStep,
  readConfigState,
  type ConfigStateArtifact,
} from "../core/state.js";
import {
  isAnyReferenceScriptMissing,
  loadReferenceScriptUtxos,
} from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildPaymentHookDatumCbor,
  decodePaymentHookDatum,
  findSingleUtxoAtUnit,
  toBigInt,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertPaymentHookWithdrawAmountPositive,
  assertPaymentHookWithdrawAmountValid,
} from "../preflight/index.js";

export { assertPaymentHookWithdrawAmountValid } from "../preflight/index.js";

export async function paymentHookWithdraw(args: {
  amountLovelace: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Using amountLovelace=${args.amountLovelace} for payment-hook withdraw`);
  const statePath = path.resolve(args.statePath ?? "state/preview/config-bootstrap.json");
  reportProgress(`Loading config state from ${statePath}`);
  const state = await readConfigState(statePath);

  if (
    !state.paymentHookState ||
    !state.bootstrapRefs.paymentHook ||
    !hasCompletedStep(state.transactions, "preview:payment-hook:bootstrap")
  ) {
    throw new Error("Payment-hook withdraw requires a state artifact produced after payment-hook bootstrap.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    state.configState.validConfigSigners,
  );

  const [currentConfigUtxo, currentPaymentHookUtxo] = await Promise.all([
    findSingleUtxoAtUnit(
      lucid,
      state.scripts.configValidatorAddress,
      state.scripts.configUnit,
      "config",
    ),
    findSingleUtxoAtUnit(
      lucid,
      state.scripts.paymentHookValidatorAddress!,
      state.scripts.paymentHookUnit!,
      "payment hook",
    ),
  ]);
  if (!state.compiledScripts?.paymentHookValidator) {
    throw new Error("paymentHookValidator compiled script not found. Run preview:payment-hook:parameterize first.");
  }
  const paymentHookValidator = spendingValidatorFromCompiledScript(state.compiledScripts.paymentHookValidator);

  const amountLovelace = toBigInt(args.amountLovelace, "amountLovelace");
  assertPaymentHookWithdrawAmountPositive(amountLovelace);
  const currentPaymentHookState =
    currentPaymentHookUtxo.datum
      ? decodePaymentHookDatum(
          currentPaymentHookUtxo.datum,
          state.paymentHookState.withdrawAddress,
        )
      : state.paymentHookState;
  assertPaymentHookWithdrawAmountValid(
    amountLovelace,
    BigInt(currentPaymentHookState.accruedFeesLovelace),
  );

  const nextPaymentHookState = {
    ...currentPaymentHookState,
    accruedFeesLovelace: (
      BigInt(currentPaymentHookState.accruedFeesLovelace) - amountLovelace
    ).toString(),
    lifetimeWithdrawnLovelace: (
      BigInt(currentPaymentHookState.lifetimeWithdrawnLovelace) + amountLovelace
    ).toString(),
  };

  const paymentHookDatumCbor = buildPaymentHookDatumCbor(nextPaymentHookState);
  const withdrawRedeemer = Data.to(
    new Constr<PlutusData>(2, [amountLovelace]),
  );

  reportProgress("Building Preview payment-hook withdraw transaction");
  const { utxos: referenceScriptUtxos, missing: missingReferenceScript } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "paymentHook",
          label: "payment hook",
          outRef: state.referenceScripts?.global?.paymentHook
            ? {
                txHash: state.referenceScripts.global.paymentHook.txHash,
                outputIndex: state.referenceScripts.global.paymentHook.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  let txBuilder = lucid
    .newTx()
    .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
    .collectFrom([currentPaymentHookUtxo], withdrawRedeemer)
    .addSignerKey(walletDefaults.paymentKeyHash)
    .pay.ToContract(
      state.scripts.paymentHookValidatorAddress!,
      { kind: "inline", value: paymentHookDatumCbor },
      {
        lovelace:
          BigInt(nextPaymentHookState.minUtxoLovelace) +
          BigInt(nextPaymentHookState.accruedFeesLovelace),
        [state.scripts.paymentHookUnit!]: 1n,
      },
    )
    .pay.ToAddress(currentPaymentHookState.withdrawAddress, {
      lovelace: amountLovelace,
    });

  if (isAnyReferenceScriptMissing(missingReferenceScript)) {
    reportProgress(
      "Reference script for payment hook is missing on-chain; attaching the payment hook validator inline.",
    );
    txBuilder = txBuilder.attach.SpendingValidator(paymentHookValidator);
  }

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
      label: "payment-hook withdraw transaction",
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      spentUtxos: [],
      label: "payment-hook withdraw",
      requireChangeWhenNoSpentUtxos: true,
    });
  }

  if (!args.buildOnly && confirmed) {
    await waitForUnitUtxoReplacement({
      lucid,
      address: state.scripts.paymentHookValidatorAddress!,
      unit: state.scripts.paymentHookUnit!,
      label: "payment hook",
      previousOutRef: currentPaymentHookUtxo,
    });
  }

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    paymentHookState: nextPaymentHookState,
    datum: {
      ...state.datum,
      paymentHookCbor: paymentHookDatumCbor,
    },
    transactions: appendTransactionRecord(state.transactions, {
      step: "preview:payment-hook:withdraw",
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:payment-hook:withdraw] ${message}`);
}
