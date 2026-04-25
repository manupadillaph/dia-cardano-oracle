import { getAddressDetails } from "@lucid-evolution/lucid";

import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";

export type ConfiguredWalletDefaults = {
  paymentKeyHash: string;
  feeAddress: string;
};

export async function walletSummary(): Promise<{
  source: "seed" | "private-key";
  address: string;
  rewardAddress: string | null;
  utxoCount: number;
}> {
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();

  const [address, rewardAddress, utxos] = await Promise.all([
    wallet.address(),
    wallet.rewardAddress(),
    wallet.getUtxos(),
  ]);

  return {
    source,
    address,
    rewardAddress,
    utxoCount: utxos.length,
  };
}

export async function walletDefaults(): Promise<{
  source: "seed" | "private-key";
  address: string;
  rewardAddress: string | null;
  utxoCount: number;
  defaults: ConfiguredWalletDefaults;
}> {
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();

  const [address, rewardAddress, utxos] = await Promise.all([
    wallet.address(),
    wallet.rewardAddress(),
    wallet.getUtxos(),
  ]);

  return {
    source,
    address,
    rewardAddress,
    utxoCount: utxos.length,
    defaults: deriveConfiguredWalletDefaults({ source, address }),
  };
}

export async function walletUtxos(): Promise<{
  source: "seed" | "private-key";
  address: string;
  utxoCount: number;
  utxos: Array<{
    txHash: string;
    outputIndex: number;
    lovelace: bigint;
    assets: Record<string, bigint>;
  }>;
}> {
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();

  const [address, utxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);

  return {
    source,
    address,
    utxoCount: utxos.length,
    utxos: utxos.map((utxo) => ({
      txHash: utxo.txHash,
      outputIndex: utxo.outputIndex,
      lovelace: utxo.assets.lovelace ?? 0n,
      assets: utxo.assets,
    })),
  };
}

export function deriveConfiguredWalletDefaults(args: {
  source: "seed" | "private-key";
  address: string;
}): ConfiguredWalletDefaults {
  const details = getAddressDetails(args.address);

  if (!details.paymentCredential || details.paymentCredential.type !== "Key") {
    throw new Error(
      "The configured wallet address does not expose a key-based payment credential.",
    );
  }

  return {
    paymentKeyHash: details.paymentCredential.hash,
    feeAddress: args.address,
  };
}
