import { randomBytes } from "node:crypto";

import { entropyToMnemonic } from "bip39";
import { walletFromSeed } from "@lucid-evolution/wallet";

export function createWallet(): {
  mnemonic: string;
  address: string;
  rewardAddress: string | null;
  paymentPrivateKey: string;
  stakePrivateKey: string | null;
  env: {
    CARDANO_NETWORK: "Preview";
    CARDANO_WALLET_SEED: string;
  };
} {
  const mnemonic = entropyToMnemonic(randomBytes(32));
  const wallet = walletFromSeed(mnemonic, { network: "Preview" });

  return {
    mnemonic,
    address: wallet.address,
    rewardAddress: wallet.rewardAddress,
    paymentPrivateKey: wallet.paymentKey,
    stakePrivateKey: wallet.stakeKey,
    env: {
      CARDANO_NETWORK: "Preview",
      CARDANO_WALLET_SEED: mnemonic,
    },
  };
}
