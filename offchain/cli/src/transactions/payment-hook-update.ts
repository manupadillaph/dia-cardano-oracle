import { readFile } from "node:fs/promises";
import { stepId, networkTag } from "../core/config.js";
import path from "node:path";
import { Constr } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";

import { spendingValidatorFromCompiledScript } from "../core/contracts.js";
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
  requireInlineDatum,
  toBigInt,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";
import {
  assertConfigUtxoLivesAtValidatorAddress,
  assertPaymentKeyHashIsConfigSigner,
  assertPositiveMinUtxoLovelace,
} from "../preflight/index.js";

export type PaymentHookUpdateInput = {
  withdrawAddress?: string;
  minUtxoLovelace?: string;
};

export async function paymentHookUpdate(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading payment-hook update input from ${path.resolve(args.inputPath)}`);
  const input = await readPaymentHookUpdateInput(path.resolve(args.inputPath));
  const statePath = path.resolve(args.statePath ?? `state/${networkTag()}/config-bootstrap.json`);
  reportProgress(`Loading config state from ${statePath}`);
  const state = await readConfigState(statePath);

  if (
    !state.paymentHookState ||
    !state.bootstrapRefs.paymentHook ||
    !hasCompletedStep(state.transactions, stepId("payment-hook:bootstrap"))
  ) {
    throw new Error("PaymentHook update requires a state artifact produced after payment-hook bootstrap.");
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
      state.scripts.paymentHookValidatorAddress,
      state.scripts.paymentHookUnit,
      "payment hook",
    ),
  ]);
  assertConfigUtxoLivesAtValidatorAddress(
    currentConfigUtxo.address,
    state.scripts.configValidatorAddress,
  );

  if (!state.compiledScripts?.paymentHookValidator) {
    throw new Error("paymentHookValidator compiled script not found. Run payment-hook:parameterize first.");
  }
  const paymentHookValidator = spendingValidatorFromCompiledScript(
    state.compiledScripts.paymentHookValidator,
  );

  const currentPaymentHookDatumCbor = requireInlineDatum(currentPaymentHookUtxo, "payment hook");
  const currentPaymentHookState = decodePaymentHookDatum(
    currentPaymentHookDatumCbor,
    state.paymentHookState.withdrawAddress,
  );
  const nextPaymentHookState = resolveNextPaymentHookState(currentPaymentHookState, input);
  assertPositiveMinUtxoLovelace(
    BigInt(nextPaymentHookState.minUtxoLovelace),
    "PaymentHook",
  );

  const paymentHookDatumCbor = buildPaymentHookDatumCbor(nextPaymentHookState);
  const adminUpdateRedeemer = Data.to(new Constr(1, []));

  reportProgress("Building Preview payment-hook update transaction");
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
    .collectFrom([currentPaymentHookUtxo], adminUpdateRedeemer)
    .addSignerKey(walletDefaults.paymentKeyHash)
    .pay.ToContract(
      state.scripts.paymentHookValidatorAddress,
      { kind: "inline", value: paymentHookDatumCbor },
      {
        lovelace:
          BigInt(nextPaymentHookState.minUtxoLovelace) +
          BigInt(nextPaymentHookState.accruedFeesLovelace),
        [state.scripts.paymentHookUnit]: 1n,
      },
    );

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
      label: "payment-hook update transaction",
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
      label: "payment-hook update",
      requireChangeWhenNoSpentUtxos: true,
    });
  }

  if (!args.buildOnly && confirmed) {
    await waitForUnitUtxoReplacement({
      lucid,
      address: state.scripts.paymentHookValidatorAddress,
      unit: state.scripts.paymentHookUnit,
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
      step: stepId("payment-hook:update"),
      submittedTxHash,
      confirmed,
    }),
  };
}

function resolveNextPaymentHookState(
  current: NonNullable<ConfigStateArtifact["paymentHookState"]>,
  input: PaymentHookUpdateInput,
): NonNullable<ConfigStateArtifact["paymentHookState"]> {
  return {
    ...current,
    withdrawAddress: input.withdrawAddress ?? current.withdrawAddress,
    minUtxoLovelace:
      input.minUtxoLovelace === undefined
        ? current.minUtxoLovelace
        : toBigInt(input.minUtxoLovelace, "minUtxoLovelace").toString(),
  };
}

async function readPaymentHookUpdateInput(inputPath: string): Promise<PaymentHookUpdateInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as PaymentHookUpdateInput;
}

function reportProgress(message: string): void {
  console.error(`[payment-hook:update] ${message}`);
}
