import { input as promptInput } from "@inquirer/prompts";

import { toBigInt } from "../core/chain-helpers.js";
import { getCliConfig, requireDiaSourceConfig } from "../core/config.js";
import {
  deriveCompressedPublicKeyFromPrivateKey,
  normalizeEthereumAddressHex,
  normalizeHex,
  parseCommaSeparatedHexList,
  utf8ToHex,
} from "../core/dia-intent.js";
import {
  assertNonEmptyConfigSignerList,
  assertPositiveMinUtxoLovelace,
} from "../preflight/index.js";
import type { ConfigStateArtifact } from "../core/state.js";
import {
  emptyProtocolCompiledScripts,
  emptyReferenceScriptUtxo,
} from "../core/state.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";

const DEFAULT_BASE_FEE_LOVELACE = "600000"; // 0.6 ADA base fee
const DEFAULT_PER_PAIR_FEE_LOVELACE = "400000"; // 0.40 ADA per pair
const DEFAULT_MAX_BOOTSTRAP_DRIFT_SECONDS = "300"; // 5 minutes
const DEFAULT_MIN_UTXO_LOVELACE = "5000000";
const DEFAULT_CONFIG_ASSET_LABEL = "DIA_CONFIG";
const DEFAULT_PAYMENT_HOOK_ASSET_LABEL = "DIA_PAYMENT_HOOK";

type ProtocolInitConfigInput = {
  validConfigSigners: string[];
  authorizedDiaPublicKeys: string[];
  domain: {
    name: string;
    version: string;
    sourceChainId: string;
    verifyingContract: string;
  };
  /// Base protocol fee in lovelace (constant component of fee formula)
  baseFeeLovelace: string;
  /// Per-pair protocol fee in lovelace (variable component per pair)
  perPairFeeLovelace: string;
  maxBootstrapDriftSeconds: string;
  minUtxoLovelace: string;
  configAssetLabel: string;
  configAssetName: string;
  paymentHookAssetLabel: string;
  paymentHookAssetName: string;
  paymentHookWithdrawAddress: string;
};

function defaultProtocolConfigInput(
  defaultSigner: string,
  walletAddress: string,
): ProtocolInitConfigInput {
  const cliConfig = getCliConfig();
  const dia = requireDiaSourceConfig(cliConfig);
  const { diaEvmPrivateKey } = cliConfig;
  const defaultAuthorizedDiaPublicKeys = diaEvmPrivateKey
    ? [deriveCompressedPublicKeyFromPrivateKey(diaEvmPrivateKey)]
    : [];

  return {
    validConfigSigners: [defaultSigner],
    authorizedDiaPublicKeys: defaultAuthorizedDiaPublicKeys,
    domain: {
      name: dia.domainName,
      version: dia.domainVersion,
      sourceChainId: dia.sourceChainId,
      verifyingContract: normalizeEthereumAddressHex(
        dia.registryAddress,
        "domain.verifyingContract",
      ),
    },
    baseFeeLovelace: DEFAULT_BASE_FEE_LOVELACE,
    perPairFeeLovelace: DEFAULT_PER_PAIR_FEE_LOVELACE,
    maxBootstrapDriftSeconds: DEFAULT_MAX_BOOTSTRAP_DRIFT_SECONDS,
    minUtxoLovelace: DEFAULT_MIN_UTXO_LOVELACE,
    configAssetLabel: DEFAULT_CONFIG_ASSET_LABEL,
    configAssetName: normalizeHex(utf8ToHex(DEFAULT_CONFIG_ASSET_LABEL), "configAssetName"),
    paymentHookAssetLabel: DEFAULT_PAYMENT_HOOK_ASSET_LABEL,
    paymentHookAssetName: normalizeHex(
      utf8ToHex(DEFAULT_PAYMENT_HOOK_ASSET_LABEL),
      "paymentHookAssetName",
    ),
    paymentHookWithdrawAddress: walletAddress,
  };
}

export function createProtocolStateArtifact(args: {
  source: "seed" | "private-key";
  walletAddress: string;
  configInput?: ProtocolInitConfigInput;
}): ConfigStateArtifact {
  const walletDefaults = deriveConfiguredWalletDefaults({
    source: args.source,
    address: args.walletAddress,
  });
  const configInput =
    args.configInput ??
    defaultProtocolConfigInput(walletDefaults.paymentKeyHash, args.walletAddress);
  const configAssetName =
    configInput.configAssetName.trim().length > 0
      ? normalizeHex(configInput.configAssetName, "configAssetName")
      : normalizeHex(utf8ToHex(configInput.configAssetLabel), "configAssetName");
  const paymentHookAssetName =
    configInput.paymentHookAssetName.trim().length > 0
      ? normalizeHex(configInput.paymentHookAssetName, "paymentHookAssetName")
      : normalizeHex(
          utf8ToHex(configInput.paymentHookAssetLabel),
          "paymentHookAssetName",
        );
  const configState = {
    validConfigSigners: configInput.validConfigSigners,
    authorizedDiaPublicKeys: configInput.authorizedDiaPublicKeys,
    domain: {
      name: configInput.domain.name,
      version: configInput.domain.version,
      sourceChainId: configInput.domain.sourceChainId,
      verifyingContract: configInput.domain.verifyingContract,
    },
    baseFeeLovelace: configInput.baseFeeLovelace,
    perPairFeeLovelace: configInput.perPairFeeLovelace,
    maxBootstrapDriftSeconds: configInput.maxBootstrapDriftSeconds,
    paymentHookRef: null,
    updateCoordinatorCredential: null,
    minUtxoLovelace: configInput.minUtxoLovelace,
  };

  assertNonEmptyConfigSignerList(configState.validConfigSigners);
  assertPositiveMinUtxoLovelace(
    toBigInt(configState.minUtxoLovelace, "minUtxoLovelace"),
    "Protocol",
  );

  return {
    wallet: {
      source: args.source,
      address: args.walletAddress,
    },
    bootstrapRefs: {
      config: {
        txHash: "",
        outputIndex: 0,
      },
      paymentHook: null,
    },
    scripts: {
      configPolicyId: "",
      configUnit: "",
      configValidatorHash: "",
      configValidatorAddress: "",
      coordinatorHash: "",
      coordinatorRewardAddress: "",
      referenceHolderValidatorHash: "",
      referenceHolderAddress: "",
      paymentHookPolicyId: "",
      paymentHookUnit: "",
      paymentHookValidatorHash: "",
      paymentHookValidatorAddress: "",
    },
    configState,
    paymentHookState: null,
    compiledScripts: emptyProtocolCompiledScripts(),
    drafts: {
      configParameterize: {
        configAssetLabel: configInput.configAssetLabel,
        configAssetName,
      },
      paymentHookParameterize: {
        paymentHookAssetLabel: configInput.paymentHookAssetLabel,
        paymentHookAssetName,
        withdrawAddress: configInput.paymentHookWithdrawAddress,
        minUtxoLovelace: configInput.minUtxoLovelace,
      },
    },
    referenceScripts: {
      global: {
        config: emptyReferenceScriptUtxo(),
        coordinator: emptyReferenceScriptUtxo(),
        paymentHook: emptyReferenceScriptUtxo(),
      },
    },
    datum: {
      configCbor: "",
      paymentHookCbor: "",
    },
  };
}

async function promptForText(args: {
  message: string;
  defaultValue: string;
  validate?: (value: string) => string | true;
}): Promise<string> {
  return promptInput({
    message: args.message,
    default: args.defaultValue,
    validate: (value) => args.validate?.(value.trim()) ?? (value.trim().length > 0 || "Value is required."),
    transformer: (value) => value.trim(),
  });
}

async function promptForProtocolConfigInput(
  defaultSigner: string,
  walletAddress: string,
): Promise<ProtocolInitConfigInput> {
  console.error("[protocol:init] Enter the initial Config values.");
  const defaults = defaultProtocolConfigInput(defaultSigner, walletAddress);
  const validConfigSignersRaw = await promptForText({
    message: "Valid config signers (comma-separated payment key hashes from the configured Cardano wallet)",
    defaultValue: defaults.validConfigSigners.join(", "),
  });
  const authorizedDiaPublicKeysRaw = await promptForText({
    message: "Authorized DIA public keys (comma-separated compressed secp256k1 pubkeys; derived from DIA_EVM_PRIVATE_KEY_<network suffix> or from Step 5 output)",
    defaultValue: defaults.authorizedDiaPublicKeys.join(", "),
  });
  const domainName = await promptForText({
    message: "Domain name",
    defaultValue: defaults.domain.name,
  });
  const domainVersion = await promptForText({
    message: "Domain version",
    defaultValue: defaults.domain.version,
  });
  const sourceChainId = await promptForText({
    message: "Domain sourceChainId",
    defaultValue: defaults.domain.sourceChainId,
    validate: (value) => (/^\d+$/.test(value) ? true : "Enter a non-negative integer."),
  });
  const verifyingContract = await promptForText({
    message: "Domain verifyingContract",
    defaultValue: defaults.domain.verifyingContract,
  });
  const baseFeeLovelace = await promptForText({
    message: "Base protocol fee lovelace (constant component)",
    defaultValue: defaults.baseFeeLovelace,
    validate: (value) => (/^\d+$/.test(value) ? true : "Enter a non-negative integer."),
  });
  const perPairFeeLovelace = await promptForText({
    message: "Per-pair protocol fee lovelace (variable component per pair)",
    defaultValue: defaults.perPairFeeLovelace,
    validate: (value) => (/^\d+$/.test(value) ? true : "Enter a non-negative integer."),
  });
  const maxBootstrapDriftSeconds = await promptForText({
    message: "Max bootstrap drift seconds (intent freshness window)",
    defaultValue: defaults.maxBootstrapDriftSeconds,
    validate: (value) => (/^\d+$/.test(value) ? true : "Enter a non-negative integer."),
  });
  const minUtxoLovelace = await promptForText({
    message: "Config min UTxO lovelace",
    defaultValue: defaults.minUtxoLovelace,
    validate: (value) => (/^[1-9]\d*$/.test(value) ? true : "Enter a positive integer."),
  });
  const configAssetLabel = await promptForText({
    message: "Config asset label",
    defaultValue: defaults.configAssetLabel,
  });
  const paymentHookAssetLabel = await promptForText({
    message: "PaymentHook asset label",
    defaultValue: defaults.paymentHookAssetLabel,
  });
  const paymentHookWithdrawAddress = await promptForText({
    message: "PaymentHook withdraw address",
    defaultValue: defaults.paymentHookWithdrawAddress,
  });

  return {
    validConfigSigners: parseCommaSeparatedHexList(validConfigSignersRaw, "validConfigSigners[]"),
    authorizedDiaPublicKeys: parseCommaSeparatedHexList(
      authorizedDiaPublicKeysRaw,
      "authorizedDiaPublicKeys[]",
    ),
    domain: {
      name: domainName,
      version: domainVersion,
      sourceChainId: toBigInt(sourceChainId, "domain.sourceChainId").toString(),
      verifyingContract: normalizeEthereumAddressHex(
        verifyingContract,
        "domain.verifyingContract",
      ),
    },
    baseFeeLovelace: toBigInt(baseFeeLovelace, "baseFeeLovelace").toString(),
    perPairFeeLovelace: toBigInt(perPairFeeLovelace, "perPairFeeLovelace").toString(),
    maxBootstrapDriftSeconds: toBigInt(maxBootstrapDriftSeconds, "maxBootstrapDriftSeconds").toString(),
    minUtxoLovelace: toBigInt(minUtxoLovelace, "minUtxoLovelace").toString(),
    configAssetLabel: configAssetLabel.trim(),
    configAssetName: normalizeHex(utf8ToHex(configAssetLabel.trim()), "configAssetName"),
    paymentHookAssetLabel: paymentHookAssetLabel.trim(),
    paymentHookAssetName: normalizeHex(
      utf8ToHex(paymentHookAssetLabel.trim()),
      "paymentHookAssetName",
    ),
    paymentHookWithdrawAddress: paymentHookWithdrawAddress.trim(),
  };
}

export async function initializeProtocolState(args?: {
  useDefaults?: boolean;
  configInput?: ProtocolInitConfigInput;
}): Promise<ConfigStateArtifact> {
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const walletAddress = await lucid.wallet().address();
  const walletDefaults = deriveConfiguredWalletDefaults({
    source,
    address: walletAddress,
  });
  const configInput = args?.configInput ??
    (args?.useDefaults
    ? defaultProtocolConfigInput(walletDefaults.paymentKeyHash, walletAddress)
    : await promptForProtocolConfigInput(
        walletDefaults.paymentKeyHash,
        walletAddress,
      ));

  return createProtocolStateArtifact({
    source,
    walletAddress,
    configInput,
  });
}
