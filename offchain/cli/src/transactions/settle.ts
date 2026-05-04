import path from "node:path";
import { Constr, type OutRef } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeCoordinatorValidator,
  makePaymentHookValidator,
  makeReceiverValidator,
  spendingValidatorFromCompiledScript,
  scriptHashFromValidator,
  withdrawalValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  readConfigState,
  type ConfigStateArtifact,
  type ClientStateArtifact,
} from "../core/state.js";
import { loadReferenceScriptUtxos } from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { readClientContext } from "../core/artifact-context.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildPaymentHookDatumCbor,
  buildReceiverDatumCbor,
  decodePaymentHookDatum,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  requireInlineDatum,
  splitUnit,
  waitForUnitUtxoReplacement,
  writeJsonFile,
} from "../core/chain-helpers.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertSettleManifestMatchesSingleClientReceiver,
  assertSettleReceiverAccruedPositive,
} from "../preflight/index.js";

type SettleResult = {
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  settledReceivers: Array<{
    clientId: string;
    receiverUnit: string;
    drainedLovelace: string;
  }>;
  totalSettledLovelace: string;
  transactions?: ConfigStateArtifact["transactions"];
};

export async function settleAccruedFees(args: {
  protocolStatePath: string;
  clientStatePath: string;
  buildOnly: boolean;
}): Promise<SettleResult> {
  const protocolStatePath = path.resolve(args.protocolStatePath);
  const clientStatePath = path.resolve(args.clientStatePath);

  reportProgress(`Loading protocol state from ${protocolStatePath}`);
  const protocolState = await readConfigState(protocolStatePath);

  if (!protocolState.paymentHookState || !protocolState.paymentHookUtxo || !protocolState.bootstrapRefs.paymentHook) {
    throw new Error("Settle requires protocol state after PaymentHook bootstrap.");
  }

  reportProgress(`Loading client state from ${clientStatePath}`);
  const { client: clientState, protocol } = await readClientContext({
    clientStatePath,
    protocolStatePath,
  });

  if (!clientState.receiver) {
    throw new Error("Settle requires client state after Receiver bootstrap.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const walletAddress = await lucid.wallet().address();
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    protocol.configState.validConfigSigners,
    {
      unauthorizedMessage:
        "Settle requires a config signer. The configured wallet is not authorized.",
    },
  );

  const configAssetName = splitUnit(protocol.scripts.configUnit).assetName;

  // Fetch on-chain UTxOs
  const [currentConfigUtxo, currentReceiverUtxo, currentPaymentHookUtxo] =
    await Promise.all([
      findSingleUtxoAtUnit(
        lucid,
        protocol.scripts.configValidatorAddress,
        protocol.scripts.configUnit,
        "config",
      ),
      findSingleUtxoAtUnit(
        lucid,
        clientState.receiver.receiverValidatorAddress,
        clientState.receiver.receiverUnit,
        "receiver",
      ),
      findSingleUtxoAtUnit(
        lucid,
        protocol.scripts.paymentHookValidatorAddress!,
        protocol.scripts.paymentHookUnit!,
        "payment hook",
      ),
    ]);

  const currentReceiverState = decodeReceiverDatum(
    requireInlineDatum(currentReceiverUtxo, "receiver"),
  );
  const currentPaymentHookState = decodePaymentHookDatum(
    requireInlineDatum(currentPaymentHookUtxo, "payment hook"),
    protocolState.paymentHookState.withdrawAddress,
  );

  const accruedLovelace = BigInt(currentReceiverState.accruedToHookLovelace);
  assertSettleReceiverAccruedPositive(
    accruedLovelace,
    currentReceiverState.accruedToHookLovelace,
    clientState.receiver.receiverUnit,
  );

  reportProgress(`Settling ${accruedLovelace} lovelace from receiver to payment hook`);

  assertSettleManifestMatchesSingleClientReceiver(
    [
      {
        receiverPolicyId: clientState.receiver.receiverPolicyId,
        receiverAssetName: clientState.receiver.receiverAssetName,
      },
    ],
    {
      receiverPolicyId: clientState.receiver.receiverPolicyId,
      receiverAssetName: clientState.receiver.receiverAssetName,
    },
  );

  // --- Compute next states ---
  const nextReceiverState = {
    ...currentReceiverState,
    accruedToHookLovelace: "0",
  };
  const nextPaymentHookState = {
    ...currentPaymentHookState,
    accruedFeesLovelace: (
      BigInt(currentPaymentHookState.accruedFeesLovelace) + accruedLovelace
    ).toString(),
    lifetimeCollectedLovelace: (
      BigInt(currentPaymentHookState.lifetimeCollectedLovelace) + accruedLovelace
    ).toString(),
  };

  // --- Build redeemers ---
  // Receiver: Settle = Constr(2, [])
  const receiverRedeemer = Data.to(new Constr(2, []));
  // PaymentHook: ApplySettle = Constr(0, [])
  const paymentHookRedeemer = Data.to(new Constr(0, []));
  // Coordinator: ApplySettle(SettleManifest) = Constr(2, [SettleManifest])
  // SettleManifest { receivers: List<SettleReceiver> }
  // SettleReceiver { receiver_policy_id, receiver_asset_name }
  const settleManifest = new Constr<PlutusData>(0, [
    [
      new Constr<PlutusData>(0, [
        clientState.receiver.receiverPolicyId,
        clientState.receiver.receiverAssetName,
      ]),
    ],
  ]);
  const coordinatorRedeemer = Data.to(
    new Constr<PlutusData>(2, [settleManifest]),
  );

  // --- Build validators ---
  const receiverValidator = clientState.compiledScripts?.receiverValidator
    ? spendingValidatorFromCompiledScript(clientState.compiledScripts.receiverValidator)
    : await makeReceiverValidator({
        bootstrapOutRef: clientState.receiver.bootstrapRef,
        assetName: clientState.receiver.receiverAssetName,
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
      });

  const paymentHookValidator = protocol.compiledScripts?.paymentHookValidator
    ? spendingValidatorFromCompiledScript(protocol.compiledScripts.paymentHookValidator)
    : await makePaymentHookValidator({
        bootstrapOutRef: protocolState.bootstrapRefs.paymentHook as OutRef,
        assetName: splitUnit(protocol.scripts.paymentHookUnit!).assetName,
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
        coordinatorCredentialHash: protocol.scripts.coordinatorHash,
      });

  const coordinatorValidator = protocol.compiledScripts?.coordinatorValidator
    ? withdrawalValidatorFromCompiledScript(protocol.compiledScripts.coordinatorValidator)
    : await makeCoordinatorValidator({
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
      });

  // --- Load reference scripts ---
  const { utxos: referenceScriptUtxos, missing: missingReferenceScripts } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "coordinator",
          label: "coordinator",
          outRef: protocol.referenceScripts?.global?.coordinator
            ? {
                txHash: protocol.referenceScripts.global.coordinator.txHash,
                outputIndex: protocol.referenceScripts.global.coordinator.outputIndex,
              }
            : null,
        },
        {
          key: "paymentHook",
          label: "payment hook",
          outRef: protocol.referenceScripts?.global?.paymentHook
            ? {
                txHash: protocol.referenceScripts.global.paymentHook.txHash,
                outputIndex: protocol.referenceScripts.global.paymentHook.outputIndex,
              }
            : null,
        },
        {
          key: "receiver",
          label: "receiver",
          outRef: clientState.referenceScripts?.client?.receiver
            ? {
                txHash: clientState.referenceScripts.client.receiver.txHash,
                outputIndex: clientState.referenceScripts.client.receiver.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  // --- Build transaction ---
  reportProgress("Building Preview settle transaction");
  // Settle does not consume an intent, but the coordinator's
  // ApplySettle path still runs alongside other validators that may
  // require finite bounds (defence in depth). A 30-min window is safe.
  const nowMs = Date.now();
  let txBuilder = lucid
    .newTx()
    .validFrom(nowMs - 60_000)
    .validTo(nowMs + 30 * 60_000)
    .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
    .collectFrom([currentReceiverUtxo], receiverRedeemer)
    .collectFrom([currentPaymentHookUtxo], paymentHookRedeemer)
    .withdraw(protocol.scripts.coordinatorRewardAddress, 0n, coordinatorRedeemer)
    .addSignerKey(walletDefaults.paymentKeyHash)
    .pay.ToContract(
      clientState.receiver.receiverValidatorAddress,
      { kind: "inline", value: buildReceiverDatumCbor(nextReceiverState) },
      {
        lovelace:
          BigInt(nextReceiverState.minUtxoLovelace) +
          BigInt(nextReceiverState.balanceLovelace) +
          BigInt(nextReceiverState.accruedToHookLovelace),
        [clientState.receiver.receiverUnit]: 1n,
      },
    )
    .pay.ToContract(
      protocol.scripts.paymentHookValidatorAddress!,
      { kind: "inline", value: buildPaymentHookDatumCbor(nextPaymentHookState) },
      {
        lovelace:
          BigInt(nextPaymentHookState.minUtxoLovelace) +
          BigInt(nextPaymentHookState.accruedFeesLovelace),
        [protocol.scripts.paymentHookUnit!]: 1n,
      },
    );

  if (missingReferenceScripts.receiver) {
    reportProgress("Reference script for receiver is missing on-chain; attaching inline.");
    txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
  }
  if (missingReferenceScripts.paymentHook) {
    reportProgress("Reference script for payment hook is missing on-chain; attaching inline.");
    txBuilder = txBuilder.attach.SpendingValidator(paymentHookValidator);
  }
  if (missingReferenceScripts.coordinator) {
    reportProgress("Reference script for coordinator is missing on-chain; attaching inline.");
    txBuilder = txBuilder.attach.WithdrawalValidator(coordinatorValidator);
  }

  const txSignBuilder = await txBuilder.complete();
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
      label: "settle transaction",
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }
  }

  // --- Wait for UTxO replacement ---
  const latestReceiverUtxo =
    args.buildOnly || !confirmed
      ? clientState.receiver.receiverUtxo.current
      : await waitForUnitUtxoReplacement({
          lucid,
          address: clientState.receiver.receiverValidatorAddress,
          unit: clientState.receiver.receiverUnit,
          label: "receiver",
          previousOutRef: currentReceiverUtxo,
        });
  const latestPaymentHookUtxo =
    args.buildOnly || !confirmed
      ? protocolState.paymentHookUtxo.current
      : await waitForUnitUtxoReplacement({
          lucid,
          address: protocol.scripts.paymentHookValidatorAddress!,
          unit: protocol.scripts.paymentHookUnit!,
          label: "payment hook",
          previousOutRef: currentPaymentHookUtxo,
        });

  // --- Persist updated state files ---
  if (!args.buildOnly && confirmed) {
    await writeJsonFile(protocolStatePath, {
      ...protocolState,
      wallet: { source, address: walletAddress },
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
        ...protocolState.datum,
        paymentHookCbor: buildPaymentHookDatumCbor(nextPaymentHookState),
      },
      transactions: appendTransactionRecord(protocolState.transactions, {
        step: "preview:settle",
        submittedTxHash,
        confirmed,
      }),
    });

    await writeJsonFile(clientStatePath, {
      ...clientState,
      wallet: { source, address: walletAddress },
      receiver: {
        ...clientState.receiver,
        receiverState: nextReceiverState,
        receiverUtxo: {
          current: {
            txHash: latestReceiverUtxo.txHash,
            outputIndex: latestReceiverUtxo.outputIndex,
          },
        },
      },
      datum: {
        ...clientState.datum,
        receiverCbor: buildReceiverDatumCbor(nextReceiverState),
      },
      transactions: appendTransactionRecord(clientState.transactions, {
        step: "preview:settle",
        submittedTxHash,
        confirmed,
      }),
    });
  }

  return {
    wallet: { source, address: walletAddress },
    settledReceivers: [
      {
        clientId: clientState.clientId,
        receiverUnit: clientState.receiver.receiverUnit,
        drainedLovelace: accruedLovelace.toString(),
      },
    ],
    totalSettledLovelace: accruedLovelace.toString(),
    transactions: appendTransactionRecord(undefined, {
      step: "preview:settle",
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:settle] ${message}`);
}
