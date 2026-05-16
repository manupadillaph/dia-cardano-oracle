import { config as loadDotenv } from "dotenv";

loadDotenv();

export type CardanoNetwork = "Preview" | "Mainnet";

export type CliConfig = {
  cardanoNetwork: CardanoNetwork;
  cardanoProvider: "Koios" | "Blockfrost";
  blockfrostProjectId: string;
  blockfrostApiUrl: string;
  koiosApiUrl: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function requireSupportedNetwork(value: string): CardanoNetwork {
  if (value !== "Preview" && value !== "Mainnet") {
    throw new Error(
      `Unsupported CARDANO_NETWORK "${value}". Supported values: Preview, Mainnet.`,
    );
  }

  return value;
}

function defaultBlockfrostUrl(network: CardanoNetwork): string {
  return network === "Mainnet"
    ? "https://cardano-mainnet.blockfrost.io/api/v0"
    : "https://cardano-preview.blockfrost.io/api/v0";
}

function defaultKoiosUrl(network: CardanoNetwork): string {
  return network === "Mainnet"
    ? "https://api.koios.rest/api/v1"
    : "https://preview.koios.rest/api/v1";
}

export function getCliConfig(): CliConfig {
  const cardanoNetwork = requireSupportedNetwork(
    process.env.CARDANO_NETWORK?.trim() ?? "Preview",
  );

  return {
    cardanoNetwork,
    cardanoProvider:
      process.env.CARDANO_PROVIDER?.trim() === "Koios"
        ? "Koios"
        : "Blockfrost",
    blockfrostProjectId: required("BLOCKFROST_PROJECT_ID"),
    blockfrostApiUrl:
      process.env.BLOCKFROST_API_URL?.trim() ??
      defaultBlockfrostUrl(cardanoNetwork),
    koiosApiUrl:
      process.env.KOIOS_API_URL?.trim() ?? defaultKoiosUrl(cardanoNetwork),
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