// Bridge between the in-memory Lucid Emulator and the CLI builders.
//
// The CLI builders in `src/deploys/*` and `src/transactions/*` call
// `makeConfiguredLucid()` and `selectConfiguredWallet()` from `src/core/
// lucid.ts` to obtain a Lucid instance + a wallet. In production those
// helpers read `.env` (Blockfrost/Koios provider + wallet seed). For
// local benchmarks and tests, this module redirects those calls at the
// emulator's pre-built Lucid instance and a seed-phrase-funded account
// from the emulator's genesis, so every CLI builder runs untouched
// against the in-memory ledger.
//
// Always pair `installEmulatorLucid(...)` with `uninstallEmulatorLucid()`
// in a `try { ... } finally { ... }` block; otherwise the CLI keeps
// pointing at the emulator after the test or benchmark completes.

import type { Emulator } from "@lucid-evolution/lucid";

import {
  setLucidFactory,
  setProviderFactory,
  setWalletSelector,
  setEmulatorModeActive,
  resetLucidFactories,
  type LucidInstance,
} from "../core/lucid.js";

export type InstallEmulatorLucidArgs = {
  // Lucid instance backed by the emulator (e.g. from
  // `makeOracleEmulatorLucid` in the test harness, or built directly in
  // a benchmark script).
  lucid: LucidInstance;
  // The emulator backing the lucid instance. CLI helpers that go
  // directly through `makeConfiguredProvider()` (notably
  // `core/reference-scripts.ts` and `core/protocol.ts`) need a
  // `Provider` to look up UTxOs by outRef and fetch protocol params.
  // The Lucid Emulator implements that interface natively, so we just
  // pass the same emulator instance in.
  emulator: Emulator;
  // Seed phrase of the genesis-funded emulator account that will play
  // the role of the protocol admin / DIA submitter wallet for every
  // builder call.
  walletSeedPhrase: string;
};

export function installEmulatorLucid(args: InstallEmulatorLucidArgs): void {
  setLucidFactory(async () => args.lucid);
  setProviderFactory(async () => args.emulator);
  setWalletSelector(async (lucid) => {
    lucid.selectWallet.fromSeed(args.walletSeedPhrase);
    return "seed";
  });
  // Tells `getNetworkNow` / `slotBackoffUnixTimeMs` to use the
  // emulator's local slot clock instead of Blockfrost's HTTP `/blocks/
  // latest` endpoint. See comment in `core/lucid.ts` and `core/
  // network-time.ts`.
  setEmulatorModeActive(true);
}

export function uninstallEmulatorLucid(): void {
  resetLucidFactories();
}
