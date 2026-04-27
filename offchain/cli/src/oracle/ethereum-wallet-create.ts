import { Wallet, SigningKey } from "ethers";

export function createEthereumWallet(): {
  address: string;
  privateKey: string;
  publicKey: string;
  env: {
    DIA_EVM_PRIVATE_KEY: string;
  };
} {
  const wallet = Wallet.createRandom();
  const publicKey = SigningKey.computePublicKey(wallet.signingKey.publicKey, true);

  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    publicKey: publicKey.startsWith("0x") ? publicKey.slice(2) : publicKey,
    env: {
      DIA_EVM_PRIVATE_KEY: wallet.privateKey,
    },
  };
}
