import { readFile } from "node:fs/promises";
import { stepId, networkTag } from "../core/config.js";
import path from "node:path";
import { Constr } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";

import {
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import { normalizeEthereumAddressHex, normalizeHex } from "../core/dia-intent.js";
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
import {
  isAnyReferenceScriptMissing,
  loadReferenceScriptUtxos,
} from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildConfigDatumCbor,
  findSingleUtxoAtUnit,
  toBigInt,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";
import {
  assertConfigUtxoLivesAtValidatorAddress,
  assertHookCoordinatorConsistency,
  assertPaymentKeyHashIsConfigSigner,
  assertPositiveMinUtxoLovelace,
} from "../preflight/index.js";

type ConfigUpdateInput = {
  validConfigSigners?: string[];
  authorizedDiaPublicKeys?: string[];
  authorizedOraclePublicKeys?: string[];
  domain?: {
    name?: string;
    version?: string;
    sourceChainId?: string | number;
    verifyingContract?: string;
  };
  baseFeeLovelace?: string;
  perPairFeeLovelace?: string;
  maxBootstrapDriftSeconds?: string;
  minUtxoLovelace?: string;
  paymentHookRef?: {
    policyId: string;
    assetName: string;
  } | null;
  updateCoordinatorCredential?: {
    type: "Script" | "Key";
    hash: string;
  } | null;
};

export async function configUpdate(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading config update input from ${path.resolve(args.inputPath)}`);
  const input = await readConfigUpdateInput(path.resolve(args.inputPath));
  const statePath = path.resolve(args.statePath ?? `state/${networkTag()}/config-bootstrap.json`);
  reportProgress(`Loading config state from ${statePath}`);
  const state = await readConfigState(statePath);

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
    {
      unauthorizedMessage:
        "The configured wallet is not authorized as a current config signer.",
    },
  );

  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    state.scripts.configUnit,
    "config",
  );
  assertConfigUtxoLivesAtValidatorAddress(
    currentConfigUtxo.address,
    state.scripts.configValidatorAddress,
  );
  const { utxos: referenceScriptUtxos, missing: missingReferenceScript } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "config",
          label: "config",
          outRef: state.referenceScripts?.global?.config
            ? {
                txHash: state.referenceScripts.global.config.txHash,
                outputIndex: state.referenceScripts.global.config.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  if (!state.compiledScripts?.configValidator) {
    throw new Error("configValidator compiled script not found. Run config:parameterize first.");
  }
  const configValidator = spendingValidatorFromCompiledScript(state.compiledScripts.configValidator);

  const nextConfigState = resolveNextConfigState(state, input);
  const configDatumCbor = buildConfigDatumCbor(nextConfigState);
  const adminUpdateRedeemer = Data.to(new Constr(0, []));
  const nextConfigAssets = {
    ...currentConfigUtxo.assets,
    lovelace: BigInt(nextConfigState.minUtxoLovelace),
  };

  reportProgress("Building Preview config update transaction");
  let txBuilder = lucid
    .newTx()
    .readFrom(referenceScriptUtxos)
    .collectFrom([currentConfigUtxo], adminUpdateRedeemer)
    .addSignerKey(walletDefaults.paymentKeyHash)
    .pay.ToContract(
      state.scripts.configValidatorAddress,
      { kind: "inline", value: configDatumCbor },
      nextConfigAssets,
    );

  if (isAnyReferenceScriptMissing(missingReferenceScript)) {
    reportProgress(
      "Reference script for config is missing on-chain; attaching the config validator inline.",
    );
    txBuilder = txBuilder.attach.SpendingValidator(configValidator);
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
      label: "config update transaction",
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
      label: "config update",
      requireChangeWhenNoSpentUtxos: true,
    });
  }

  if (!args.buildOnly && confirmed) {
    await waitForUnitUtxoReplacement({
      lucid,
      address: state.scripts.configValidatorAddress,
      unit: state.scripts.configUnit,
      label: "config",
      previousOutRef: currentConfigUtxo,
    });
  }

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    configState: nextConfigState,
    datum: {
      ...state.datum,
      configCbor: configDatumCbor,
    },
    transactions: appendTransactionRecord(state.transactions, {
      step: stepId("config:update"),
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[config:update] ${message}`);
}

async function readConfigUpdateInput(inputPath: string): Promise<ConfigUpdateInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ConfigUpdateInput;
}

function resolveNextConfigState(
  state: ConfigStateArtifact,
  input: ConfigUpdateInput,
): ConfigStateArtifact["configState"] {
  const authorizedDiaPublicKeys =
    input.authorizedDiaPublicKeys ??
    input.authorizedOraclePublicKeys ??
    state.configState.authorizedDiaPublicKeys;

  const nextPaymentHookRef =
    input.paymentHookRef === undefined
      ? state.configState.paymentHookRef
      : input.paymentHookRef === null
        ? null
        : {
            policyId: normalizeHex(input.paymentHookRef.policyId, "paymentHookRef.policyId"),
            assetName: normalizeHex(input.paymentHookRef.assetName, "paymentHookRef.assetName"),
            unit: `${normalizeHex(input.paymentHookRef.policyId, "paymentHookRef.policyId")}${normalizeHex(input.paymentHookRef.assetName, "paymentHookRef.assetName")}`,
          };

  const nextCoordinatorCredential =
    input.updateCoordinatorCredential === undefined
      ? state.configState.updateCoordinatorCredential
      : input.updateCoordinatorCredential === null
        ? null
        : {
            type: input.updateCoordinatorCredential.type,
            hash: normalizeHex(
              input.updateCoordinatorCredential.hash,
              "updateCoordinatorCredential.hash",
            ),
          };

  const next: ConfigStateArtifact["configState"] = {
    validConfigSigners:
      input.validConfigSigners?.map((value) =>
        normalizeHex(value, "validConfigSigners[]"),
      ) ?? state.configState.validConfigSigners,
    authorizedDiaPublicKeys: authorizedDiaPublicKeys.map((value) =>
      normalizeHex(value, "authorizedDiaPublicKeys[]"),
    ),
    domain: {
      name: input.domain?.name ?? state.configState.domain.name,
      version: input.domain?.version ?? state.configState.domain.version,
      sourceChainId:
        input.domain?.sourceChainId === undefined
          ? state.configState.domain.sourceChainId
          : toBigInt(input.domain.sourceChainId, "domain.sourceChainId").toString(),
      verifyingContract:
        input.domain?.verifyingContract === undefined
          ? state.configState.domain.verifyingContract
          : normalizeEthereumAddressHex(
              input.domain.verifyingContract,
              "domain.verifyingContract",
            ),
    },
    baseFeeLovelace:
      input.baseFeeLovelace === undefined
        ? state.configState.baseFeeLovelace
        : toBigInt(input.baseFeeLovelace, "baseFeeLovelace").toString(),
    perPairFeeLovelace:
      input.perPairFeeLovelace === undefined
        ? state.configState.perPairFeeLovelace
        : toBigInt(input.perPairFeeLovelace, "perPairFeeLovelace").toString(),
    maxBootstrapDriftSeconds:
      input.maxBootstrapDriftSeconds === undefined
        ? state.configState.maxBootstrapDriftSeconds
        : toBigInt(input.maxBootstrapDriftSeconds, "maxBootstrapDriftSeconds").toString(),
    paymentHookRef: nextPaymentHookRef,
    updateCoordinatorCredential: nextCoordinatorCredential,
    minUtxoLovelace:
      input.minUtxoLovelace === undefined
        ? state.configState.minUtxoLovelace
        : toBigInt(input.minUtxoLovelace, "minUtxoLovelace").toString(),
  };

  assertPositiveMinUtxoLovelace(BigInt(next.minUtxoLovelace), "Config");
  assertHookCoordinatorConsistency(
    next.paymentHookRef,
    next.updateCoordinatorCredential,
  );
  return next;
}
