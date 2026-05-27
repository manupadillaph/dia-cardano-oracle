import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from the CLI's own directory, not from cwd.
// This allows the feeder to import CLI modules from a different working directory.
const cliDir = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(cliDir, "../../.env") });

export type CardanoNetwork = "Preview" | "Mainnet";
export type NetworkSuffix = "TESTNET" | "MAINNET";

export type DiaSourceConfig = {
  sourceChainId: string;
  rpcUrl: string;
  wsUrl: string;
  registryAddress: string;
  explorerUrl: string | null;
  domainName: string;
  domainVersion: string;
};

export type CliConfig = {
  cardanoNetwork: CardanoNetwork;
  networkSuffix: NetworkSuffix;
  cardanoProvider: "Koios" | "Blockfrost";
  blockfrostProjectId: string;
  blockfrostApiUrl: string;
  koiosApiUrl: string;
  cardanoWalletSeed: string | null;
  cardanoPrivateKey: string | null;
  diaEvmPrivateKey: string | null;
  diaWsCredential: string | null;
  dia: DiaSourceConfig | null;
};

// All per-network env vars live in offchain/cli/.env with suffix
// _TESTNET (CARDANO_NETWORK=Preview) or _MAINNET (CARDANO_NETWORK=Mainnet).
// `pickNetworkEnv` is the single read path — never reach into
// `process.env.<UNSUFFIXED>` for a per-network value elsewhere.
function pickNetworkEnv(suffix: NetworkSuffix, baseName: string): string | null {
  const value = process.env[`${baseName}_${suffix}`]?.trim();
  return value && value.length > 0 ? value : null;
}

function requireNetworkEnv(suffix: NetworkSuffix, baseName: string): string {
  const value = pickNetworkEnv(suffix, baseName);
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${baseName}_${suffix}. ` +
        `Active CARDANO_NETWORK requires the *_${suffix} variant of every per-network setting.`,
    );
  }
  return value;
}

function resolveOptionalDiaSourceConfig(suffix: NetworkSuffix): DiaSourceConfig | null {
  const requiredNames = [
    "DIA_SOURCE_CHAIN_ID",
    "DIA_RPC_URL",
    "DIA_WS_URL",
    "DIA_REGISTRY_ADDRESS",
  ] as const;
  const values = requiredNames.map((name) => [name, pickNetworkEnv(suffix, name)] as const);
  const present = values.filter(([, value]) => value !== null);

  if (present.length === 0) {
    return null;
  }

  const missing = values
    .filter(([, value]) => value === null)
    .map(([name]) => `${name}_${suffix}`);
  if (missing.length > 0) {
    throw new Error(
      `Incomplete DIA source environment block for ${suffix}. Missing: ${missing.join(", ")}.`,
    );
  }

  return {
    sourceChainId: requireNetworkEnv(suffix, "DIA_SOURCE_CHAIN_ID"),
    rpcUrl: requireNetworkEnv(suffix, "DIA_RPC_URL"),
    wsUrl: requireNetworkEnv(suffix, "DIA_WS_URL"),
    registryAddress: requireNetworkEnv(suffix, "DIA_REGISTRY_ADDRESS"),
    explorerUrl: pickNetworkEnv(suffix, "DIA_EXPLORER_URL"),
    domainName: process.env.DIA_DOMAIN_NAME?.trim() || "DIA Oracle",
    domainVersion: process.env.DIA_DOMAIN_VERSION?.trim() || "1.0",
  };
}

function requireSupportedNetwork(value: string): CardanoNetwork {
  if (value !== "Preview" && value !== "Mainnet") {
    throw new Error(
      `Unsupported CARDANO_NETWORK "${value}". Supported values: Preview, Mainnet.`,
    );
  }
  return value;
}

function suffixForNetwork(network: CardanoNetwork): NetworkSuffix {
  return network === "Mainnet" ? "MAINNET" : "TESTNET";
}

export function getCliConfig(): CliConfig {
  const cardanoNetwork = requireSupportedNetwork(
    process.env.CARDANO_NETWORK?.trim() ?? "Preview",
  );
  const suffix = suffixForNetwork(cardanoNetwork);

  return {
    cardanoNetwork,
    networkSuffix: suffix,
    cardanoProvider:
      process.env.CARDANO_PROVIDER?.trim() === "Koios"
        ? "Koios"
        : "Blockfrost",
    blockfrostProjectId: requireNetworkEnv(suffix, "BLOCKFROST_PROJECT_ID"),
    blockfrostApiUrl: requireNetworkEnv(suffix, "BLOCKFROST_API_URL"),
    koiosApiUrl: requireNetworkEnv(suffix, "KOIOS_API_URL"),
    cardanoWalletSeed: pickNetworkEnv(suffix, "CARDANO_WALLET_SEED"),
    cardanoPrivateKey: pickNetworkEnv(suffix, "CARDANO_PRIVATE_KEY"),
    diaEvmPrivateKey: pickNetworkEnv(suffix, "DIA_EVM_PRIVATE_KEY"),
    diaWsCredential: pickNetworkEnv(suffix, "DIA_WS_CREDENTIAL"),
    dia: resolveOptionalDiaSourceConfig(suffix),
  };
}

export function requireDiaSourceConfig(config: CliConfig): DiaSourceConfig {
  if (config.dia) {
    return config.dia;
  }
  throw new Error(
    "Missing DIA source environment block for the active network. Set DIA_SOURCE_CHAIN_ID_*, DIA_RPC_URL_*, DIA_WS_URL_*, DIA_REGISTRY_ADDRESS_*, and DIA_EXPLORER_URL_* before running CLI flows that create DIA intents or initialize protocol domain settings.",
  );
}

// Variant of `getCliConfig()` that resolves the per-network block for a
// caller-supplied suffix instead of the active CARDANO_NETWORK. Used by
// ops tools (e.g. probe-dia-ws.ts) that intentionally exercise BOTH
// networks in a single run.
export function getDiaSourceConfigFor(suffix: NetworkSuffix): DiaSourceConfig & {
  evmPrivateKey: string | null;
  wsCredential: string | null;
} {
  return {
    sourceChainId: requireNetworkEnv(suffix, "DIA_SOURCE_CHAIN_ID"),
    rpcUrl: requireNetworkEnv(suffix, "DIA_RPC_URL"),
    wsUrl: requireNetworkEnv(suffix, "DIA_WS_URL"),
    registryAddress: requireNetworkEnv(suffix, "DIA_REGISTRY_ADDRESS"),
    explorerUrl: pickNetworkEnv(suffix, "DIA_EXPLORER_URL"),
    domainName: process.env.DIA_DOMAIN_NAME?.trim() || "DIA Oracle",
    domainVersion: process.env.DIA_DOMAIN_VERSION?.trim() || "1.0",
    evmPrivateKey: pickNetworkEnv(suffix, "DIA_EVM_PRIVATE_KEY"),
    wsCredential: pickNetworkEnv(suffix, "DIA_WS_CREDENTIAL"),
  };
}

// Lowercase tag derived from CARDANO_NETWORK ("preview" | "mainnet"). Used to
// prefix step IDs and artifact directories so the same code produces
// network-scoped state without hardcoding the network name.
export function networkTag(): string {
  return (process.env.CARDANO_NETWORK?.trim() ?? "Preview").toLowerCase();
}

// Network-scoped step identifier. The prefix is read from CARDANO_NETWORK at
// call time, so the same source emits "preview:foo" on Preview and
// "mainnet:foo" on Mainnet.
export function stepId(suffix: string): string {
  return `${networkTag()}:${suffix}`;
}
