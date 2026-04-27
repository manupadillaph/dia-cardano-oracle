import path from "node:path";
import { Constr, type OutRef } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makePaymentHookValidator,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  makeConfiguredLucid,
  makeConfiguredProvider,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  readConfigState,
  type ConfigStateArtifact,
} from "../core/state.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildPaymentHookDatumCbor,
  decodePaymentHookDatum,
  findSingleUtxoAtUnit,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";

export async function paymentHookWithdraw(args: {
  amountLovelace: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Using amountLovelace=${args.amountLovelace} for payment-hook withdraw`);
  const statePath = path.resolve(args.statePath ?? "state/preview/config-bootstrap.json");
  reportProgress(`Loading config state from ${statePath}`);
  const state = await readConfigState(statePath);

  if (!state.paymentHookState || !state.paymentHookUtxo || !state.bootstrapRefs.paymentHook) {
    throw new Error("Payment-hook withdraw requires a state artifact produced after payment-hook bootstrap.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const walletAddress = await lucid.wallet().address();
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  if (!state.configState.validConfigSigners.includes(walletDefaults.paymentKeyHash)) {
    throw new Error("The configured wallet is not authorized as a config signer.");
  }

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
  const referenceScriptUtxos = await loadPaymentHookReferenceScriptUtxos(state);

  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const paymentHookValidator = state.compiledScripts?.paymentHookValidator
    ? spendingValidatorFromCompiledScript(state.compiledScripts.paymentHookValidator)
    : await makePaymentHookValidator({
        bootstrapOutRef: state.bootstrapRefs.paymentHook as OutRef,
        assetName: splitUnit(state.scripts.paymentHookUnit!).assetName,
        configPolicyId: state.scripts.configPolicyId,
        configAssetName,
        coordinatorCredentialHash: state.scripts.coordinatorHash,
      });

  const amountLovelace = toBigInt(args.amountLovelace, "amountLovelace");
  const currentPaymentHookState =
    currentPaymentHookUtxo.datum
      ? decodePaymentHookDatum(
          currentPaymentHookUtxo.datum,
          state.paymentHookState.withdrawAddress,
        )
      : state.paymentHookState;
  const nextPaymentHookState = {
    ...currentPaymentHookState,
    accruedFeesLovelace: (
      BigInt(currentPaymentHookState.accruedFeesLovelace) - amountLovelace
    ).toString(),
    lifetimeWithdrawnLovelace: (
      BigInt(currentPaymentHookState.lifetimeWithdrawnLovelace) + amountLovelace
    ).toString(),
  };

  if (BigInt(nextPaymentHookState.accruedFeesLovelace) < 0n) {
    throw new Error("PaymentHook accrued fees are not sufficient for the requested withdrawal.");
  }

  const paymentHookDatumCbor = buildPaymentHookDatumCbor(nextPaymentHookState);
  const withdrawRedeemer = Data.to(
    new Constr<PlutusData>(2, [amountLovelace]),
  );

  reportProgress("Building Preview payment-hook withdraw transaction");
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

  if (referenceScriptUtxos.length === 0) {
    txBuilder = txBuilder.attach.SpendingValidator(paymentHookValidator);
  }

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

  const latestPaymentHookUtxo =
    args.buildOnly || !confirmed
      ? state.paymentHookUtxo.current
      : await findSingleUtxoAtUnit(
          lucid,
          state.scripts.paymentHookValidatorAddress!,
          state.scripts.paymentHookUnit!,
          "payment hook",
        );

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    configUtxo: {
      current: {
        txHash: currentConfigUtxo.txHash,
        outputIndex: currentConfigUtxo.outputIndex,
      },
    },
    paymentHookState: nextPaymentHookState,
    paymentHookUtxo: {
      current: {
        txHash: latestPaymentHookUtxo.txHash,
        outputIndex: latestPaymentHookUtxo.outputIndex,
      },
    },
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

async function loadPaymentHookReferenceScriptUtxos(
  state: ConfigStateArtifact,
) {
  const paymentHookRef = state.referenceScripts?.global?.paymentHook;
  if (!paymentHookRef) {
    return [];
  }

  const provider = await makeConfiguredProvider();
  return provider.getUtxosByOutRef([
    {
      txHash: paymentHookRef.txHash,
      outputIndex: paymentHookRef.outputIndex,
    },
  ]);
}
