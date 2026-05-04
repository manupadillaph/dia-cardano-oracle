import path from "node:path";
import { Constr, type OutRef } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";

import {
  makeConfigStateValidator,
  makePaymentHookMintingPolicy,
  makePaymentHookValidator,
  mintingPolicyFromCompiledScript,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptCredentialState,
  scriptHashFromValidator,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import { normalizeHex } from "../core/dia-intent.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import {
  appendTransactionRecord,
  emptyProtocolCompiledScripts,
  readConfigState,
  type ConfigStateArtifact,
} from "../core/state.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildConfigDatumCbor,
  buildPaymentHookDatumCbor,
  findSingleUtxoAtUnit,
  findUtxoByOutRef,
  selectBootstrapUtxo,
  selectFundingUtxo,
  splitUnit,
  toBigInt,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";
import { assertNftBootstrapDestinationIsNotFundingWallet } from "../preflight/bootstrap-pay.js";

export async function paymentHookBootstrap(args: {
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress("Using PaymentHook values from the protocol artifact");

  const statePath = path.resolve(args.statePath ?? "state/preview/config-bootstrap.json");
  reportProgress(`Loading config state from ${statePath}`);
  const state = await readConfigState(statePath);

  if (state.paymentHookUtxo?.current.txHash) {
    throw new Error(
      "PaymentHook bootstrap was already completed for this protocol artifact. Reuse the current artifact and continue with the next step instead of running preview:payment-hook:bootstrap again.",
    );
  }

  if (state.bootstrapRefs.config.txHash.length === 0) {
    throw new Error("Config state artifact is missing the selected Config bootstrap reference.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const walletAddress = await wallet.address();
  const walletUtxos = await wallet.getUtxos();
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });
  const resolvedInput = resolvePaymentHookBootstrapInput(state, walletAddress);

  if (!state.configState.validConfigSigners.includes(walletDefaults.paymentKeyHash)) {
    throw new Error(
      "The configured wallet is not authorized as a config signer in the provided config state.",
    );
  }

  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    state.scripts.configUnit,
    "config",
  );

  const configuredBootstrapRef =
    state.bootstrapRefs.paymentHook?.txHash
      ? state.bootstrapRefs.paymentHook
      : undefined;
  const paymentHookBootstrapUtxo = configuredBootstrapRef
    ? findUtxoByOutRef(walletUtxos, configuredBootstrapRef, "payment-hook bootstrap")
    : selectBootstrapUtxo(
        walletUtxos,
        toBigInt(resolvedInput.minUtxoLovelace, "minUtxoLovelace"),
        [state.bootstrapRefs.config],
      );
  if (!paymentHookBootstrapUtxo) {
    throw new Error(
      "No suitable wallet UTxO is available for payment-hook bootstrap.",
    );
  }

  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const configBootstrapOutRef: OutRef = state.bootstrapRefs.config;
  const paymentHookBootstrapOutRef: OutRef = {
    txHash: paymentHookBootstrapUtxo.txHash,
    outputIndex: paymentHookBootstrapUtxo.outputIndex,
  };
  const paymentHookMinUtxoLovelace = toBigInt(
    resolvedInput.minUtxoLovelace,
    "minUtxoLovelace",
  );
  const fundingUtxos =
    (paymentHookBootstrapUtxo.assets.lovelace ?? 0n) >=
    paymentHookMinUtxoLovelace + 4_000_000n
      ? []
      : [
          selectFundingUtxo(
            walletUtxos,
            [state.bootstrapRefs.config, paymentHookBootstrapOutRef],
            paymentHookMinUtxoLovelace + 4_000_000n,
            "payment-hook bootstrap",
          ),
        ];

  const configValidator = state.compiledScripts?.configValidator
    ? spendingValidatorFromCompiledScript(state.compiledScripts.configValidator)
    : await makeConfigStateValidator({
        bootstrapOutRef: configBootstrapOutRef,
        assetName: configAssetName,
      });
  const paymentHookAssetName = normalizeHex(
    resolvedInput.paymentHookAssetName,
    "paymentHookAssetName",
  );
  const paymentHookMintPolicy = state.compiledScripts?.paymentHookMintPolicy
    ? mintingPolicyFromCompiledScript(state.compiledScripts.paymentHookMintPolicy)
    : await makePaymentHookMintingPolicy({
        bootstrapOutRef: paymentHookBootstrapOutRef,
        assetName: paymentHookAssetName,
        configPolicyId: state.scripts.configPolicyId,
        configAssetName,
        coordinatorCredentialHash: state.scripts.coordinatorHash,
      });
  const paymentHookPolicyId = policyIdFromMintingPolicy(paymentHookMintPolicy);
  if (
    state.scripts.paymentHookPolicyId &&
    state.scripts.paymentHookPolicyId !== paymentHookPolicyId
  ) {
    throw new Error("PaymentHook bootstrap input does not match the previously published PaymentHook reference script.");
  }
  const paymentHookUnit = `${paymentHookPolicyId}${paymentHookAssetName}`;

  const paymentHookValidator = state.compiledScripts?.paymentHookValidator
    ? spendingValidatorFromCompiledScript(state.compiledScripts.paymentHookValidator)
    : await makePaymentHookValidator({
        bootstrapOutRef: paymentHookBootstrapOutRef,
        assetName: paymentHookAssetName,
        configPolicyId: state.scripts.configPolicyId,
        configAssetName,
        coordinatorCredentialHash: state.scripts.coordinatorHash,
      });
  const paymentHookValidatorHash = scriptHashFromValidator(paymentHookValidator);
  const paymentHookValidatorAddress = scriptAddressFromValidator(paymentHookValidator);

  const nextConfigState = {
    ...state.configState,
    paymentHookRef: {
      policyId: paymentHookPolicyId,
      assetName: paymentHookAssetName,
      unit: paymentHookUnit,
    },
    updateCoordinatorCredential: scriptCredentialState(state.scripts.coordinatorHash),
  };

  const paymentHookState = {
    withdrawAddress: resolvedInput.withdrawAddress,
    minUtxoLovelace: paymentHookMinUtxoLovelace.toString(),
    accruedFeesLovelace: "0",
    lifetimeCollectedLovelace: "0",
    lifetimeWithdrawnLovelace: "0",
  };

  const configDatumCbor = buildConfigDatumCbor(nextConfigState);
  const paymentHookDatumCbor = buildPaymentHookDatumCbor(paymentHookState);
  const adminUpdateRedeemer = Data.to(new Constr(0, []));
  const mintRedeemer = Data.to(new Constr(0, []));

  reportProgress("Building Preview payment-hook bootstrap transaction");
  assertNftBootstrapDestinationIsNotFundingWallet(
    state.scripts.configValidatorAddress,
    walletAddress,
    "preview:payment-hook:bootstrap:config-output",
  );
  assertNftBootstrapDestinationIsNotFundingWallet(
    paymentHookValidatorAddress,
    walletAddress,
    "preview:payment-hook:bootstrap:hook-output",
  );
  const txBuilder = lucid
    .newTx()
    .collectFrom([currentConfigUtxo], adminUpdateRedeemer)
    .collectFrom([paymentHookBootstrapUtxo, ...fundingUtxos])
    .addSignerKey(walletDefaults.paymentKeyHash)
    .register.Stake(state.scripts.coordinatorRewardAddress)
    .attach.SpendingValidator(configValidator)
    .attach.MintingPolicy(paymentHookMintPolicy)
    .mintAssets({ [paymentHookUnit]: 1n }, mintRedeemer)
    .pay.ToContract(
      state.scripts.configValidatorAddress,
      { kind: "inline", value: configDatumCbor },
      { ...currentConfigUtxo.assets },
    )
    .pay.ToContract(
      paymentHookValidatorAddress,
      { kind: "inline", value: paymentHookDatumCbor },
      {
        lovelace: BigInt(paymentHookState.minUtxoLovelace),
        [paymentHookUnit]: 1n,
      },
    );

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
    confirmed = await lucid.awaitTx(submittedTxHash, 3_000);
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      spentUtxos: [paymentHookBootstrapUtxo, ...fundingUtxos],
      label: "payment-hook bootstrap",
    });
  }

  const latestConfigUtxo =
    args.buildOnly || !confirmed
      ? state.configUtxo.current
      : await findSingleUtxoAtUnit(
          lucid,
          state.scripts.configValidatorAddress,
          state.scripts.configUnit,
          "config",
        );
  const latestPaymentHookUtxo =
    args.buildOnly || !confirmed
      ? { txHash: "", outputIndex: 0 }
      : await findSingleUtxoAtUnit(
          lucid,
          paymentHookValidatorAddress,
          paymentHookUnit,
          "payment hook",
        );

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    referenceHolderAddress: state.referenceHolderAddress,
    bootstrapRefs: {
      config: state.bootstrapRefs.config,
      paymentHook: paymentHookBootstrapOutRef,
    },
    scripts: {
      ...state.scripts,
      paymentHookPolicyId,
      paymentHookUnit,
      paymentHookValidatorHash,
      paymentHookValidatorAddress,
    },
    configState: nextConfigState,
    configUtxo: {
      current: latestConfigUtxo,
    },
    paymentHookState,
    paymentHookUtxo: {
      current: latestPaymentHookUtxo,
    },
    compiledScripts: state.compiledScripts ?? emptyProtocolCompiledScripts(),
    drafts: state.drafts,
    referenceScripts: state.referenceScripts,
    datum: {
      configCbor: configDatumCbor,
      paymentHookCbor: paymentHookDatumCbor,
    },
    transactions: appendTransactionRecord(state.transactions, {
      step: "preview:payment-hook:bootstrap",
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:payment-hook:bootstrap] ${message}`);
}

function resolvePaymentHookBootstrapInput(
  state: ConfigStateArtifact,
  walletAddress: string,
): {
  paymentHookAssetName: string;
  withdrawAddress: string;
  minUtxoLovelace: string;
} {
  const defaults = state.drafts?.paymentHookParameterize;
  const paymentHookState = state.paymentHookState;
  const paymentHookAssetName =
    defaults?.paymentHookAssetName ||
    (state.scripts.paymentHookUnit ? splitUnit(state.scripts.paymentHookUnit).assetName : undefined);
  const withdrawAddress =
    paymentHookState?.withdrawAddress ||
    defaults?.withdrawAddress ||
    walletAddress;
  const minUtxoLovelace =
    paymentHookState?.minUtxoLovelace ||
    defaults?.minUtxoLovelace;

  if (!paymentHookAssetName || !minUtxoLovelace) {
    throw new Error(
      "PaymentHook bootstrap requires the PaymentHook values already stored in the protocol artifact. Run preview:payment-hook:parameterize first.",
    );
  }

  return {
    paymentHookAssetName: normalizeHex(paymentHookAssetName, "paymentHookAssetName"),
    withdrawAddress,
    minUtxoLovelace: toBigInt(minUtxoLovelace, "minUtxoLovelace").toString(),
  };
}
