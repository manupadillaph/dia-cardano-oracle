import path from "node:path";
import { networkTag , getCliConfig} from "../core/config.js";

import {
  makePaymentHookMintingPolicy,
  makePaymentHookValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import {
  emptyProtocolCompiledScripts,
  type PaymentHookParameterizeDefaults,
  readConfigState,
  type ConfigStateArtifact,
} from "../core/state.js";
import {
  buildPaymentHookDatumCbor,
  findUtxoByOutRef,
  selectBootstrapUtxo,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";
import { normalizeHex } from "../core/dia-intent.js";
import { assertPositiveMinUtxoLovelace } from "../preflight/index.js";

export async function parameterizePaymentHookScripts(args: {
  statePath?: string;
}): Promise<ConfigStateArtifact> {
  reportProgress("Using PaymentHook values from the protocol artifact");
  const state = await readConfigState(path.resolve(args.statePath ?? `state/${networkTag()}/config-bootstrap.json`));

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const resolvedInput = resolvePaymentHookParameterizeInput(state, walletAddress);
  const configuredBootstrapRef = state.bootstrapRefs.paymentHook ?? undefined;
  const selectedBootstrapUtxo = configuredBootstrapRef
    ? findUtxoByOutRef(walletUtxos, configuredBootstrapRef, "payment-hook bootstrap")
    : selectBootstrapUtxo(walletUtxos, 0n, [state.bootstrapRefs.config]);
  if (!selectedBootstrapUtxo) {
    throw new Error(
      "No suitable pure ADA wallet UTxO is available for payment-hook script parameterization. Inspect the wallet with 'npm run cli -- wallet:utxos'.",
    );
  }

  const paymentHookBootstrapRef = {
    txHash: selectedBootstrapUtxo.txHash,
    outputIndex: selectedBootstrapUtxo.outputIndex,
  };
  reportProgress(
    `Using wallet bootstrap UTxO ${paymentHookBootstrapRef.txHash}#${paymentHookBootstrapRef.outputIndex}`,
  );
  reportProgress("Deriving parameterized PaymentHook scripts offline");
  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const paymentHookAssetName = normalizeHex(
    resolvedInput.paymentHookAssetName,
    "paymentHookAssetName",
  );
  const paymentHookMintPolicy = await makePaymentHookMintingPolicy({
    bootstrapOutRef: paymentHookBootstrapRef,
    assetName: paymentHookAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    coordinatorCredentialHash: state.scripts.coordinatorHash,
  });
  const paymentHookPolicyId = policyIdFromMintingPolicy(paymentHookMintPolicy);
  const paymentHookUnit = `${paymentHookPolicyId}${paymentHookAssetName}`;
  const paymentHookValidator = await makePaymentHookValidator({
    bootstrapOutRef: paymentHookBootstrapRef,
    assetName: paymentHookAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    coordinatorCredentialHash: state.scripts.coordinatorHash,
  });
  const paymentHookMinUtxoLovelace = toBigInt(
    resolvedInput.minUtxoLovelace,
    "minUtxoLovelace",
  );
  assertPositiveMinUtxoLovelace(paymentHookMinUtxoLovelace, "PaymentHook");
  const paymentHookState = {
    withdrawAddress: resolvedInput.withdrawAddress,
    minUtxoLovelace: paymentHookMinUtxoLovelace.toString(),
    accruedFeesLovelace: "0",
    lifetimeCollectedLovelace: "0",
    lifetimeWithdrawnLovelace: "0",
  };

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    bootstrapRefs: {
      ...state.bootstrapRefs,
      paymentHook: paymentHookBootstrapRef,
    },
    scripts: {
      ...state.scripts,
      paymentHookPolicyId,
      paymentHookUnit,
      paymentHookValidatorHash: scriptHashFromValidator(paymentHookValidator),
      paymentHookValidatorAddress: scriptAddressFromValidator(paymentHookValidator),
    },
    paymentHookState,
    compiledScripts: {
      ...(state.compiledScripts ?? emptyProtocolCompiledScripts()),
      paymentHookMintPolicy: paymentHookMintPolicy.script,
      paymentHookValidator: paymentHookValidator.script,
    },
    drafts: {
      ...state.drafts,
      paymentHookParameterize: {
        ...(state.drafts?.paymentHookParameterize ?? {}),
        paymentHookAssetName,
        withdrawAddress: paymentHookState.withdrawAddress,
        minUtxoLovelace: paymentHookState.minUtxoLovelace,
      },
    },
    datum: {
      ...state.datum,
      paymentHookCbor: buildPaymentHookDatumCbor(paymentHookState),
    },
  };
}

function reportProgress(message: string): void {
  console.error(`[payment-hook:parameterize] ${message}`);
}

function resolvePaymentHookParameterizeInput(
  state: ConfigStateArtifact,
  walletAddress: string,
): PaymentHookParameterizeDefaults {
  const defaults = state.drafts?.paymentHookParameterize;
  const currentState = state.paymentHookState;
  const paymentHookAssetName =
    defaults?.paymentHookAssetName ||
    state.scripts.paymentHookUnit?.slice(56);
  const withdrawAddress =
    currentState?.withdrawAddress ||
    defaults?.withdrawAddress ||
    walletAddress;
  const minUtxoLovelace =
    currentState?.minUtxoLovelace ||
    defaults?.minUtxoLovelace;

  if (!paymentHookAssetName || !minUtxoLovelace) {
    throw new Error(
      "PaymentHook parameterization requires paymentHookAssetName and minUtxoLovelace in the protocol artifact. Run protocol:init first.",
    );
  }

  const resolvedMinUtxoLovelace = toBigInt(minUtxoLovelace, "minUtxoLovelace");
  assertPositiveMinUtxoLovelace(resolvedMinUtxoLovelace, "PaymentHook");

  return {
    paymentHookAssetLabel: defaults?.paymentHookAssetLabel,
    paymentHookAssetName: normalizeHex(paymentHookAssetName, "paymentHookAssetName"),
    withdrawAddress,
    minUtxoLovelace: resolvedMinUtxoLovelace.toString(),
  };
}
