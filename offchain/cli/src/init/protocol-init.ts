import { input as promptInput } from "@inquirer/prompts";

import { toBigInt } from "../core/chain-helpers.js";
import {
  makeReferenceHolderValidator,
  scriptAddressFromValidator,
} from "../core/contracts.js";
import {
  deriveCompressedPublicKeyFromPrivateKey,
  normalizeEthereumAddressHex,
  normalizeHex,
  utf8ToHex,
} from "../core/dia-intent.js";
import type { ConfigStateArtifact } from "../core/state.js";
import { emptyProtocolCompiledScripts } from "../core/state.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";

const DEFAULT_AUTHORIZED_DIA_PUBLIC_KEY =
  "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807";
const DEFAULT_DOMAIN = {
  name: "DIA Oracle",
  version: "1.0",
  sourceChainId: "100640",
  verifyingContract: "0xF8c614A483A0427A13512F52ac72A576678bE317",
};
const DEFAULT_PROTOCOL_FEE_LOVELACE = "2000000";
const DEFAULT_MIN_UTXO_LOVELACE = "5000000";
const DEFAULT_CONFIG_ASSET_LABEL = "DIA_CONFIG";
const DEFAULT_PAYMENT_HOOK_ASSET_LABEL = "DIA_PAYMENT_HOOK";
const DEFAULT_PAYMENT_HOOK_MIN_UTXO_LOVELACE = "3000000";

type ProtocolInitConfigInput = {
  validConfigSigners: string[];
  authorizedDiaPublicKeys: string[];
  domain: {
    name: string;
    version: string;
    sourceChainId: string;
    verifyingContract: string;
  };
  protocolFeeLovelace: string;
  minUtxoLovelace: string;
  configAssetLabel: string;
  configAssetName: string;
  paymentHookAssetLabel: string;
  paymentHookAssetName: string;
  paymentHookWithdrawAddress: string;
  paymentHookMinUtxoLovelace: string;
};

function defaultProtocolConfigInput(
  defaultSigner: string,
  walletAddress: string,
): ProtocolInitConfigInput {
  const configuredEthereumPrivateKey = process.env.DIA_EVM_PRIVATE_KEY?.trim();
  const defaultAuthorizedDiaPublicKeys = configuredEthereumPrivateKey
    ? [deriveCompressedPublicKeyFromPrivateKey(configuredEthereumPrivateKey)]
    : [DEFAULT_AUTHORIZED_DIA_PUBLIC_KEY];

  return {
    validConfigSigners: [defaultSigner],
    authorizedDiaPublicKeys: defaultAuthorizedDiaPublicKeys,
    domain: {
      name: DEFAULT_DOMAIN.name,
      version: DEFAULT_DOMAIN.version,
      sourceChainId: DEFAULT_DOMAIN.sourceChainId,
      verifyingContract: normalizeEthereumAddressHex(
        DEFAULT_DOMAIN.verifyingContract,
        "domain.verifyingContract",
      ),
    },
    protocolFeeLovelace: DEFAULT_PROTOCOL_FEE_LOVELACE,
    minUtxoLovelace: DEFAULT_MIN_UTXO_LOVELACE,
    configAssetLabel: DEFAULT_CONFIG_ASSET_LABEL,
    configAssetName: normalizeHex(utf8ToHex(DEFAULT_CONFIG_ASSET_LABEL), "configAssetName"),
    paymentHookAssetLabel: DEFAULT_PAYMENT_HOOK_ASSET_LABEL,
    paymentHookAssetName: normalizeHex(
      utf8ToHex(DEFAULT_PAYMENT_HOOK_ASSET_LABEL),
      "paymentHookAssetName",
    ),
    paymentHookWithdrawAddress: walletAddress,
    paymentHookMinUtxoLovelace: DEFAULT_PAYMENT_HOOK_MIN_UTXO_LOVELACE,
  };
}

function emptyReferenceScriptUtxo() {
  return {
    txHash: "",
    outputIndex: 0,
    scriptHash: "",
  };
}

export function createProtocolStateArtifact(args: {
  source: "seed" | "private-key";
  walletAddress: string;
  referenceHolderAddress: string;
  configInput?: ProtocolInitConfigInput;
}): ConfigStateArtifact {
  const walletDefaults = deriveConfiguredWalletDefaults({
    source: args.source,
    address: args.walletAddress,
  });
  const configInput =
    args.configInput ??
    defaultProtocolConfigInput(walletDefaults.paymentKeyHash, args.walletAddress);
  const configState = {
    validConfigSigners: configInput.validConfigSigners,
    authorizedDiaPublicKeys: configInput.authorizedDiaPublicKeys,
    domain: {
      name: configInput.domain.name,
      version: configInput.domain.version,
      sourceChainId: configInput.domain.sourceChainId,
      verifyingContract: configInput.domain.verifyingContract,
    },
    protocolFeeLovelace: configInput.protocolFeeLovelace,
    paymentHookRef: null,
    updateCoordinatorCredential: null,
    minUtxoLovelace: configInput.minUtxoLovelace,
  };

  return {
    wallet: {
      source: args.source,
      address: args.walletAddress,
    },
    referenceHolderAddress: args.referenceHolderAddress,
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
      paymentHookPolicyId: null,
      paymentHookUnit: null,
      paymentHookValidatorHash: null,
      paymentHookValidatorAddress: null,
    },
    configState,
    configUtxo: {
      current: {
        txHash: "",
        outputIndex: 0,
      },
    },
    paymentHookState: null,
    paymentHookUtxo: null,
    compiledScripts: emptyProtocolCompiledScripts(),
    drafts: {
      configParameterize: {
        configAssetLabel: configInput.configAssetLabel,
        configAssetName: configInput.configAssetName,
      },
      paymentHookParameterize: {
        paymentHookAssetLabel: configInput.paymentHookAssetLabel,
        paymentHookAssetName: configInput.paymentHookAssetName,
        withdrawAddress: configInput.paymentHookWithdrawAddress,
        minUtxoLovelace: configInput.paymentHookMinUtxoLovelace,
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

function parseCommaSeparatedHexList(raw: string, label: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => normalizeHex(value, label));
}

async function promptForProtocolConfigInput(
  defaultSigner: string,
  walletAddress: string,
): Promise<ProtocolInitConfigInput> {
  console.error("[preview:protocol:init] Enter the initial Config values.");
  const defaults = defaultProtocolConfigInput(defaultSigner, walletAddress);
  const validConfigSignersRaw = await promptForText({
    message: "Valid config signers (comma-separated payment key hashes from the configured Cardano wallet)",
    defaultValue: defaults.validConfigSigners.join(", "),
  });
  const authorizedDiaPublicKeysRaw = await promptForText({
    message: "Authorized DIA public keys (comma-separated compressed secp256k1 pubkeys from DIA_EVM_PRIVATE_KEY or Step 5 output)",
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
  const protocolFeeLovelace = await promptForText({
    message: "Protocol fee lovelace",
    defaultValue: defaults.protocolFeeLovelace,
    validate: (value) => (/^\d+$/.test(value) ? true : "Enter a non-negative integer."),
  });
  const minUtxoLovelace = await promptForText({
    message: "Config min UTxO lovelace",
    defaultValue: defaults.minUtxoLovelace,
    validate: (value) => (/^\d+$/.test(value) ? true : "Enter a non-negative integer."),
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
  const paymentHookMinUtxoLovelace = await promptForText({
    message: "PaymentHook min UTxO lovelace",
    defaultValue: defaults.paymentHookMinUtxoLovelace,
    validate: (value) => (/^\d+$/.test(value) ? true : "Enter a non-negative integer."),
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
    protocolFeeLovelace: toBigInt(protocolFeeLovelace, "protocolFeeLovelace").toString(),
    minUtxoLovelace: toBigInt(minUtxoLovelace, "minUtxoLovelace").toString(),
    configAssetLabel: configAssetLabel.trim(),
    configAssetName: normalizeHex(utf8ToHex(configAssetLabel.trim()), "configAssetName"),
    paymentHookAssetLabel: paymentHookAssetLabel.trim(),
    paymentHookAssetName: normalizeHex(
      utf8ToHex(paymentHookAssetLabel.trim()),
      "paymentHookAssetName",
    ),
    paymentHookWithdrawAddress: paymentHookWithdrawAddress.trim(),
    paymentHookMinUtxoLovelace: toBigInt(
      paymentHookMinUtxoLovelace,
      "paymentHookMinUtxoLovelace",
    ).toString(),
  };
}

export async function initializeProtocolState(): Promise<ConfigStateArtifact> {
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const walletAddress = await lucid.wallet().address();
  const referenceHolderAddress = scriptAddressFromValidator(
    await makeReferenceHolderValidator(),
  );
  const walletDefaults = deriveConfiguredWalletDefaults({
    source,
    address: walletAddress,
  });
  const configInput = await promptForProtocolConfigInput(
    walletDefaults.paymentKeyHash,
    walletAddress,
  );

  return createProtocolStateArtifact({
    source,
    walletAddress,
    referenceHolderAddress,
    configInput,
  });
}
