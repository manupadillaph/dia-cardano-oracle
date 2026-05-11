import path from "node:path";
import { Constr, type OutRef } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";

import {
  mintingPolicyFromCompiledScript,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  spendingValidatorFromCompiledScript,
  scriptHashFromValidator,
  scriptRewardAddress,
  withdrawalValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  normalizeEthereumAddressHex,
  normalizeHex,
} from "../core/dia-intent.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import {
  appendTransactionRecord,
  emptyProtocolCompiledScripts,
  hasCompletedStep,
  readConfigState,
  type ConfigStateArtifact,
} from "../core/state.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildConfigDatumCbor,
  findSingleUtxoAtUnit,
  findUtxoByOutRef,
  selectBootstrapUtxo,
  selectFundingUtxo,
  splitUnit,
  toBigInt,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";
import { assertNftBootstrapDestinationIsNotFundingWallet } from "../preflight/bootstrap-pay.js";

type ResolvedConfigBootstrapInput = {
  configAssetName: string;
  validConfigSigners: string[];
  authorizedDiaPublicKeys: string[];
  domain: {
    name: string;
    version: string;
    sourceChainId: bigint;
    verifyingContract: string;
  };
  baseFeeLovelace: bigint;
  perPairFeeLovelace: bigint;
  maxBootstrapDriftSeconds: bigint;
  minUtxoLovelace: bigint;
};

export async function configBootstrap(args: {
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress("Using Config values from the protocol artifact");
  const previousState = args.statePath
    ? await readConfigState(path.resolve(args.statePath))
    : null;

  if (hasCompletedStep(previousState?.transactions, "preview:config:bootstrap")) {
    throw new Error(
      "Config bootstrap was already completed for this protocol artifact. Reuse the current artifact and continue with the next step instead of running preview:config:bootstrap again.",
    );
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const walletAddress = await wallet.address();
  const walletUtxos = await wallet.getUtxos();
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });
  const resolvedInput = resolveConfigBootstrapInput(previousState, walletDefaults);

  const configuredBootstrapRef =
    previousState?.bootstrapRefs.config.txHash
      ? previousState.bootstrapRefs.config
      : undefined;
  const walletBootstrapUtxo = configuredBootstrapRef
    ? findUtxoByOutRef(walletUtxos, configuredBootstrapRef, "config bootstrap")
    : selectBootstrapUtxo(walletUtxos, resolvedInput.minUtxoLovelace, []);

  if (!walletBootstrapUtxo) {
    throw new Error(
      "No suitable wallet UTxO is available for config bootstrap. Fund the configured Preview wallet and inspect it with 'npm run cli -- preview:wallet:utxos'.",
    );
  }

  const bootstrapOutRef: OutRef = {
    txHash: walletBootstrapUtxo.txHash,
    outputIndex: walletBootstrapUtxo.outputIndex,
  };
  reportProgress(
    `Selected wallet bootstrap UTxO ${bootstrapOutRef.txHash}#${bootstrapOutRef.outputIndex}`,
  );

  reportProgress("Loading Config and Coordinator scripts from compiled state");
  const configAssetName = normalizeHex(
    resolvedInput.configAssetName,
    "configAssetName",
  );
  if (!previousState?.compiledScripts?.configMintPolicy) {
    throw new Error("configMintPolicy compiled script not found. Run preview:config:parameterize first.");
  }
  const configMintPolicy = mintingPolicyFromCompiledScript(previousState.compiledScripts.configMintPolicy);
  const configPolicyId = policyIdFromMintingPolicy(configMintPolicy);
  if (previousState.scripts.configPolicyId && previousState.scripts.configPolicyId !== configPolicyId) {
    throw new Error("Config bootstrap input does not match the previously published Config reference script.");
  }
  const configUnit = `${configPolicyId}${configAssetName}`;

  if (!previousState.compiledScripts.configValidator) {
    throw new Error("configValidator compiled script not found. Run preview:config:parameterize first.");
  }
  const configValidator = spendingValidatorFromCompiledScript(previousState.compiledScripts.configValidator);
  const configValidatorHash = scriptHashFromValidator(configValidator);
  const configValidatorAddress = scriptAddressFromValidator(configValidator);

  if (!previousState.compiledScripts.coordinatorValidator) {
    throw new Error("coordinatorValidator compiled script not found. Run preview:config:parameterize first.");
  }
  const coordinatorValidator = withdrawalValidatorFromCompiledScript(previousState.compiledScripts.coordinatorValidator);
  const coordinatorHash = scriptHashFromValidator(coordinatorValidator);
  const coordinatorRewardAddress = scriptRewardAddress(coordinatorHash);

  const nextConfigState: ConfigStateArtifact["configState"] = {
    validConfigSigners: resolvedInput.validConfigSigners,
    authorizedDiaPublicKeys: resolvedInput.authorizedDiaPublicKeys,
    domain: {
      name: resolvedInput.domain.name,
      version: resolvedInput.domain.version,
      sourceChainId: resolvedInput.domain.sourceChainId.toString(),
      verifyingContract: resolvedInput.domain.verifyingContract,
    },
    baseFeeLovelace: resolvedInput.baseFeeLovelace.toString(),
    perPairFeeLovelace: resolvedInput.perPairFeeLovelace.toString(),
    maxBootstrapDriftSeconds: resolvedInput.maxBootstrapDriftSeconds.toString(),
    paymentHookRef: null,
    updateCoordinatorCredential: null,
    minUtxoLovelace: resolvedInput.minUtxoLovelace.toString(),
  };
  const configDatumCbor = buildConfigDatumCbor(nextConfigState);
  const mintRedeemer = Data.to(new Constr(0, []));
  const fundingUtxos =
    (walletBootstrapUtxo.assets.lovelace ?? 0n) >=
    resolvedInput.minUtxoLovelace + 2_000_000n
      ? []
      : [
          selectFundingUtxo(
            walletUtxos,
            [
              bootstrapOutRef,
              ...(previousState?.bootstrapRefs.paymentHook
                ? [previousState.bootstrapRefs.paymentHook]
                : []),
            ],
            resolvedInput.minUtxoLovelace + 2_000_000n,
            "config bootstrap",
          ),
        ];

  reportProgress("Building Preview config bootstrap transaction");
  assertNftBootstrapDestinationIsNotFundingWallet(
    configValidatorAddress,
    walletAddress,
    "preview:config:bootstrap",
  );
  const txBuilder = lucid
    .newTx()
    .collectFrom([walletBootstrapUtxo, ...fundingUtxos])
    .attach.MintingPolicy(configMintPolicy)
    .mintAssets({ [configUnit]: 1n }, mintRedeemer)
    .pay.ToContract(
      configValidatorAddress,
      { kind: "inline", value: configDatumCbor },
      {
        lovelace: resolvedInput.minUtxoLovelace,
        [configUnit]: 1n,
      },
    );

  const txSignBuilder = await txBuilder.complete();
  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
  logEffectiveOutputs(txSignBuilder, reportProgress);
  const unsignedHash = txSignBuilder.toHash();

  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(`Unsigned transaction ready: ${unsignedHash}`);
    reportProgress("Signing transaction with the configured wallet");
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    reportProgress("Submitting transaction to Preview");
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    reportProgress("Waiting for transaction confirmation on Preview");
    confirmed = await awaitTxConfirmation({
      lucid,
      txHash: submittedTxHash,
      reportProgress,
      label: "config bootstrap transaction",
    });

    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      spentUtxos: [walletBootstrapUtxo, ...fundingUtxos],
      label: "config bootstrap",
    });
  }

  // Wait for the indexer to see the freshly-minted Config UTxO before
  // returning, so the next CLI step can resolve it by NFT immediately.
  if (!args.buildOnly && confirmed) {
    await findSingleUtxoAtUnit(
      lucid,
      configValidatorAddress,
      configUnit,
      "config",
    );
  }

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    bootstrapRefs: {
      config: bootstrapOutRef,
      paymentHook: previousState?.bootstrapRefs.paymentHook ?? null,
    },
    scripts: {
      configPolicyId,
      configUnit,
      configValidatorHash,
      configValidatorAddress,
      coordinatorHash,
      coordinatorRewardAddress,
      referenceHolderValidatorHash: previousState?.scripts.referenceHolderValidatorHash ?? "",
      referenceHolderAddress: previousState?.scripts.referenceHolderAddress ?? "",
      paymentHookPolicyId: previousState?.scripts.paymentHookPolicyId ?? "",
      paymentHookUnit: previousState?.scripts.paymentHookUnit ?? "",
      paymentHookValidatorHash: previousState?.scripts.paymentHookValidatorHash ?? "",
      paymentHookValidatorAddress: previousState?.scripts.paymentHookValidatorAddress ?? "",
    },
    configState: nextConfigState,
    paymentHookState: previousState?.paymentHookState ?? null,
    compiledScripts: {
      ...(previousState?.compiledScripts ?? emptyProtocolCompiledScripts()),
      configMintPolicy: configMintPolicy.script,
      configValidator: configValidator.script,
      coordinatorValidator: coordinatorValidator.script,
    },
    drafts: previousState?.drafts,
    datum: {
      configCbor: configDatumCbor,
      paymentHookCbor: previousState?.datum.paymentHookCbor ?? "",
    },
    referenceScripts: previousState?.referenceScripts,
    transactions: appendTransactionRecord(previousState?.transactions, {
      step: "preview:config:bootstrap",
      submittedTxHash,
      confirmed,
    }),
  };
}

function resolveConfigBootstrapInput(
  state: ConfigStateArtifact | null,
  walletDefaults: ReturnType<typeof deriveConfiguredWalletDefaults>,
): ResolvedConfigBootstrapInput {
  const validConfigSigners =
    state?.configState.validConfigSigners?.length
      ? state.configState.validConfigSigners.map((value) =>
          normalizeHex(value, "validConfigSigners[]"),
        )
      : [walletDefaults.paymentKeyHash];
  const authorizedDiaPublicKeys = state?.configState.authorizedDiaPublicKeys.map((value) =>
          normalizeHex(value, "authorizedDiaPublicKeys[]"),
        ) ?? [];
  const domain = state?.configState.domain;
  const baseFeeLovelace = state?.configState.baseFeeLovelace;
  const perPairFeeLovelace = state?.configState.perPairFeeLovelace;
  const maxBootstrapDriftSeconds = state?.configState.maxBootstrapDriftSeconds ?? "300"; // Default 5 minutes
  const minUtxoLovelace = state?.configState.minUtxoLovelace;
  const configAssetName =
    state?.drafts?.configParameterize?.configAssetName ||
    (state?.scripts.configUnit ? splitUnit(state.scripts.configUnit).assetName : undefined);

  if (
    !configAssetName ||
    authorizedDiaPublicKeys.length === 0 ||
    !domain ||
    !baseFeeLovelace ||
    !perPairFeeLovelace ||
    !minUtxoLovelace
  ) {
    throw new Error(
      "Config bootstrap requires the Config values already stored in the protocol artifact. Run preview:protocol:init and preview:config:parameterize first.",
    );
  }

  return {
    configAssetName,
    validConfigSigners,
    authorizedDiaPublicKeys,
    domain: {
      name: domain.name.trim(),
      version: domain.version.trim(),
      sourceChainId: toBigInt(domain.sourceChainId, "domain.sourceChainId"),
      verifyingContract: normalizeEthereumAddressHex(
        domain.verifyingContract,
        "domain.verifyingContract",
      ),
    },
    baseFeeLovelace: toBigInt(baseFeeLovelace, "baseFeeLovelace"),
    perPairFeeLovelace: toBigInt(perPairFeeLovelace, "perPairFeeLovelace"),
    maxBootstrapDriftSeconds: toBigInt(maxBootstrapDriftSeconds, "maxBootstrapDriftSeconds"),
    minUtxoLovelace: toBigInt(minUtxoLovelace, "minUtxoLovelace"),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:config:bootstrap] ${message}`);
}
