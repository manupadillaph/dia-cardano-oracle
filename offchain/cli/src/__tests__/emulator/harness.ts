/**
 * Lucid {@link Emulator} harness: in-memory ledger for local transaction tests
 * without Preview RPC (`@lucid-evolution/lucid`).
 */
import {
  Emulator,
  Lucid,
  generateEmulatorAccount,
  type EmulatorAccount,
  type Network,
  type Script,
} from "@lucid-evolution/lucid";

import { makeReferenceHolderValidator } from "../../core/contracts.js";

export type LucidEvolution = Awaited<ReturnType<typeof Lucid>>;

export type OracleEmulatorContext = {
  emulator: Emulator;
  lucid: LucidEvolution;
  /** Genesis emulator rows (one UTxO each at startup). */
  accounts: EmulatorAccount[];
};

/** Enough ADA for protocol-style txs under default emulator fees. */
export const DEFAULT_EMULATOR_PRIMARY_LOVELACE = 50_000_000_000n;

export const DEFAULT_EMULATOR_SECONDARY_LOVELACE = 10_000_000_000n;

export async function makeOracleEmulatorLucid(options?: {
  network?: Network;
  /** If omitted, two funded seed accounts are generated. */
  accounts?: EmulatorAccount[];
}): Promise<OracleEmulatorContext> {
  const accounts =
    options?.accounts ??
    [
      generateEmulatorAccount({ lovelace: DEFAULT_EMULATOR_PRIMARY_LOVELACE }),
      generateEmulatorAccount({ lovelace: DEFAULT_EMULATOR_SECONDARY_LOVELACE }),
    ];
  const emulator = new Emulator(accounts);
  const lucid = await Lucid(emulator, options?.network ?? "Preview");
  lucid.selectWallet.fromSeed(accounts[0].seedPhrase);
  return { emulator, lucid, accounts };
}

/** Apply mempool → ledger (emulator does this on block boundary). */
export function emulatorMineBlock(emulator: Emulator, blocks = 1): void {
  emulator.awaitBlock(blocks);
}

export async function emulatorSubmitAndMine(
  emulator: Emulator,
  signedTx: { submit: () => Promise<string> },
): Promise<string> {
  const txHash = await signedTx.submit();
  emulatorMineBlock(emulator, 1);
  return txHash;
}

/**
 * Genesis UTxO carrying an inline reference script (same pattern as
 * `publishConfigReferenceScripts`, but seeded into the emulator ledger).
 */
export async function makeReferenceHolderScriptRefGenesisAccount(
  lovelace: bigint,
): Promise<EmulatorAccount> {
  const validator = await makeReferenceHolderValidator({ configPolicyId: "00", configAssetName: "00" });
  const base = generateEmulatorAccount({ lovelace });
  return { ...base, outputData: { scriptRef: validator } };
}

export async function makeOracleEmulatorWithReferenceScriptRow(options?: {
  network?: Network;
  referenceLovelace?: bigint;
}): Promise<OracleEmulatorContext> {
  const primary = generateEmulatorAccount({
    lovelace: DEFAULT_EMULATOR_PRIMARY_LOVELACE,
  });
  const refRow = await makeReferenceHolderScriptRefGenesisAccount(
    options?.referenceLovelace ?? 25_000_000n,
  );
  return makeOracleEmulatorLucid({
    network: options?.network,
    accounts: [primary, refRow],
  });
}

/** Attach a script ref to an existing genesis-style account shape (pure). */
export function withScriptRefOnGenesisAccount(
  account: EmulatorAccount,
  script: Script,
): EmulatorAccount {
  return { ...account, outputData: { scriptRef: script } };
}
