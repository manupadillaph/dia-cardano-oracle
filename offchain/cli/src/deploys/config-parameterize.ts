import path from "node:path";

import {
  makeConfigStateMintingPolicy,
  makeConfigStateValidator,
  makeCoordinatorValidator,
  makeReferenceHolderValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  scriptRewardAddress,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import {
  emptyProtocolCompiledScripts,
  readConfigState,
  type ConfigParameterizeDefaults,
  type ConfigStateArtifact,
} from "../core/state.js";
import {
  buildConfigDatumCbor,
  findUtxoByOutRef,
  selectBootstrapUtxo,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";
import {
  normalizeEthereumAddressHex,
  normalizeHex,
} from "../core/dia-intent.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";

export async function parameterizeConfigScripts(args: {
  statePath?: string;
}): Promise<ConfigStateArtifact> {
  reportProgress("Using Config values from the protocol artifact");
  const previousState = args.statePath
    ? await readConfigState(path.resolve(args.statePath))
    : null;

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });
  const resolvedInput = resolveConfigParameterizeInput(previousState, walletDefaults);
  const minUtxoLovelace = toBigInt(resolvedInput.minUtxoLovelace, "minUtxoLovelace");
  const selectedBootstrapUtxo = previousState?.bootstrapRefs.config.txHash
    ? findUtxoByOutRef(walletUtxos, previousState.bootstrapRefs.config, "config bootstrap")
    : selectBootstrapUtxo(walletUtxos);
  if (!selectedBootstrapUtxo) {
    throw new Error(
      "No suitable pure ADA wallet UTxO is available for config script parameterization. Inspect the wallet with 'npm run cli -- preview:wallet:utxos'.",
    );
  }

  const bootstrapRef = {
    txHash: selectedBootstrapUtxo.txHash,
    outputIndex: selectedBootstrapUtxo.outputIndex,
  };
  reportProgress(`Using wallet bootstrap UTxO ${bootstrapRef.txHash}#${bootstrapRef.outputIndex}`);
  reportProgress("Deriving parameterized Config and Coordinator scripts offline");
  const configAssetName = normalizeHex(resolvedInput.configAssetName, "configAssetName");
  const configMintPolicy = await makeConfigStateMintingPolicy({
    bootstrapOutRef: bootstrapRef,
    assetName: configAssetName,
  });
  const configPolicyId = policyIdFromMintingPolicy(configMintPolicy);
  const configUnit = `${configPolicyId}${configAssetName}`;
  const configValidator = await makeConfigStateValidator({
    bootstrapOutRef: bootstrapRef,
    assetName: configAssetName,
  });
  const coordinatorValidator = await makeCoordinatorValidator({
    configPolicyId,
    configAssetName: splitUnit(configUnit).assetName,
  });
  const coordinatorHash = scriptHashFromValidator(coordinatorValidator);
  const configState = {
    validConfigSigners: resolvedInput.validConfigSigners.map((value) =>
      normalizeHex(value, "validConfigSigners[]"),
    ),
    authorizedDiaPublicKeys: resolvedInput.authorizedDiaPublicKeys.map((value) =>
      normalizeHex(value, "authorizedDiaPublicKeys[]"),
    ),
    domain: {
      name: resolvedInput.domain.name.trim(),
      version: resolvedInput.domain.version.trim(),
      sourceChainId: toBigInt(
        resolvedInput.domain.sourceChainId,
        "domain.sourceChainId",
      ).toString(),
      verifyingContract: normalizeEthereumAddressHex(
        resolvedInput.domain.verifyingContract,
        "domain.verifyingContract",
      ),
    },
    protocolFeeLovelace: toBigInt(
      resolvedInput.protocolFeeLovelace,
      "protocolFeeLovelace",
    ).toString(),
    paymentHookRef: null,
    updateCoordinatorCredential: null,
    minUtxoLovelace: minUtxoLovelace.toString(),
  };

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    referenceHolderAddress:
      previousState?.referenceHolderAddress ??
      scriptAddressFromValidator(await makeReferenceHolderValidator()),
    bootstrapRefs: {
      config: bootstrapRef,
      paymentHook: previousState?.bootstrapRefs.paymentHook ?? null,
    },
    scripts: {
      configPolicyId,
      configUnit,
      configValidatorHash: scriptHashFromValidator(configValidator),
      configValidatorAddress: scriptAddressFromValidator(configValidator),
      coordinatorHash,
      coordinatorRewardAddress: scriptRewardAddress(coordinatorHash),
      paymentHookPolicyId: previousState?.scripts.paymentHookPolicyId ?? null,
      paymentHookUnit: previousState?.scripts.paymentHookUnit ?? null,
      paymentHookValidatorHash: previousState?.scripts.paymentHookValidatorHash ?? null,
      paymentHookValidatorAddress: previousState?.scripts.paymentHookValidatorAddress ?? null,
    },
    configState,
    configUtxo: {
      current: {
        txHash: "",
        outputIndex: 0,
      },
    },
    paymentHookState: previousState?.paymentHookState ?? null,
    paymentHookUtxo: previousState?.paymentHookUtxo ?? null,
    compiledScripts: {
      ...(previousState?.compiledScripts ?? emptyProtocolCompiledScripts()),
      configMintPolicy: configMintPolicy.script,
      configValidator: configValidator.script,
      coordinatorValidator: coordinatorValidator.script,
    },
    drafts: {
      ...previousState?.drafts,
      configParameterize: {
        ...(previousState?.drafts?.configParameterize ?? {}),
        configAssetName,
      },
    },
    referenceScripts: previousState?.referenceScripts,
    datum: {
      configCbor: buildConfigDatumCbor(configState),
      paymentHookCbor: previousState?.datum.paymentHookCbor ?? "",
    },
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:config:parameterize] ${message}`);
}

function resolveConfigParameterizeInput(
  state: ConfigStateArtifact | null,
  walletDefaults: ReturnType<typeof deriveConfiguredWalletDefaults>,
): {
  configAssetName: string;
  validConfigSigners: string[];
  authorizedDiaPublicKeys: string[];
  domain: {
    name: string;
    version: string;
    sourceChainId: number | string;
    verifyingContract: string;
  };
  protocolFeeLovelace: string;
  minUtxoLovelace: string;
} {
  const configDefaults: ConfigParameterizeDefaults | undefined = state?.drafts?.configParameterize;
  const configState = state?.configState;
  const configAssetName = configDefaults?.configAssetName;
  const validConfigSigners =
    configState?.validConfigSigners?.length
      ? configState.validConfigSigners
      : [walletDefaults.paymentKeyHash];
  const authorizedDiaPublicKeys = configState?.authorizedDiaPublicKeys ?? [];
  const domain = configState?.domain;
  const protocolFeeLovelace = configState?.protocolFeeLovelace;
  const minUtxoLovelace = configState?.minUtxoLovelace;

  if (
    !configAssetName ||
    authorizedDiaPublicKeys.length === 0 ||
    !domain ||
    !protocolFeeLovelace ||
    !minUtxoLovelace
  ) {
    throw new Error(
      "Config parameterization requires configAssetName and Config state values in the protocol artifact. Run preview:protocol:init first.",
    );
  }

  return {
    configAssetName,
    validConfigSigners,
    authorizedDiaPublicKeys,
    domain,
    protocolFeeLovelace,
    minUtxoLovelace,
  };
}
