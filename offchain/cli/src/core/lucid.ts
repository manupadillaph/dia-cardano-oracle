import { Lucid } from "@lucid-evolution/lucid";
import { Blockfrost, Koios } from "@lucid-evolution/provider";

import { getCliConfig } from "./config.js";

export async function makeConfiguredProvider(): Promise<Blockfrost | Koios> {
  const config = getCliConfig();

  if (config.cardanoProvider === "Koios") {
    return new Koios(config.koiosApiUrl);
  }

  return new Blockfrost(
    config.blockfrostApiUrl,
    config.blockfrostProjectId,
  );
}

export async function makeConfiguredLucid(): Promise<
  Awaited<ReturnType<typeof Lucid>>
> {
  const config = getCliConfig();
  const provider = await makeConfiguredProvider();

  return Lucid(provider, config.cardanoNetwork);
}

export async function selectConfiguredWallet(
  lucid: Awaited<ReturnType<typeof Lucid>>,
): Promise<"seed" | "private-key"> {
  const seed = process.env.CARDANO_WALLET_SEED?.trim();
  const privateKey = process.env.CARDANO_PRIVATE_KEY?.trim();

  if (seed) {
    lucid.selectWallet.fromSeed(seed);
    return "seed";
  }

  if (privateKey) {
    lucid.selectWallet.fromPrivateKey(privateKey);
    return "private-key";
  }

  throw new Error(
    "Missing wallet configuration. Set CARDANO_WALLET_SEED or CARDANO_PRIVATE_KEY.",
  );
}
