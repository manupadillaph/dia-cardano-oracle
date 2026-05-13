import { Lucid } from "@lucid-evolution/lucid";
import { Blockfrost, Koios } from "@lucid-evolution/provider";
import type { Provider } from "@lucid-evolution/core-types";

import { getCliConfig } from "./config.js";

type ProtocolParameters = Awaited<
  ReturnType<Blockfrost["getProtocolParameters"]>
>;

type BlockfrostProtocolParametersResponse = {
  min_fee_a: string | number;
  min_fee_b: string | number;
  max_tx_size: string | number;
  max_val_size: string | number;
  key_deposit: string | number;
  pool_deposit: string | number;
  drep_deposit: string | number;
  gov_action_deposit: string | number;
  price_mem: string | number;
  price_step: string | number;
  max_tx_ex_mem: string | number;
  max_tx_ex_steps: string | number;
  coins_per_utxo_size: string | number;
  collateral_percent: string | number;
  max_collateral_inputs: string | number;
  min_fee_ref_script_cost_per_byte: string | number;
  cost_models_raw: {
    PlutusV1: number[];
    PlutusV2: number[];
    PlutusV3: number[];
  };
};

// Configured provider — in production this is Blockfrost or Koios; in
// emulator mode the test harness swaps in the in-memory Lucid
// `Emulator`, which implements the same `Provider` interface from
// `@lucid-evolution/core-types`.
export type ConfiguredProvider = Provider;

async function makeRealConfiguredProvider(): Promise<Blockfrost | Koios> {
  const config = getCliConfig();

  if (config.cardanoProvider === "Koios") {
    return new Koios(config.koiosApiUrl);
  }

  const provider = new Blockfrost(
    config.blockfrostApiUrl,
    config.blockfrostProjectId,
  );
  provider.getProtocolParameters = async (): Promise<ProtocolParameters> =>
    fetchBlockfrostProtocolParameters(
      config.blockfrostApiUrl,
      config.blockfrostProjectId,
    );

  return provider;
}

export type ProviderFactory = () => Promise<ConfiguredProvider>;
let activeProviderFactory: ProviderFactory = makeRealConfiguredProvider;

export async function makeConfiguredProvider(): Promise<ConfiguredProvider> {
  return activeProviderFactory();
}

// Override the provider factory. Subsequent calls to
// `makeConfiguredProvider()` return whatever the supplied factory
// returns. The emulator harness installs an emulator instance here so
// every CLI helper that looks UTxOs up by outRef hits the in-memory
// ledger instead of Blockfrost/Koios HTTP.
export function setProviderFactory(factory: ProviderFactory): void {
  activeProviderFactory = factory;
}

export type LucidInstance = Awaited<ReturnType<typeof Lucid>>;
export type WalletSource = "seed" | "private-key";

export type LucidFactory = () => Promise<LucidInstance>;
export type WalletSelector = (lucid: LucidInstance) => Promise<WalletSource>;

// Production-mode factories. They keep the original env-based behavior so
// the live CLI (and `run-all-cli.sh`) keeps working exactly as today.
async function makeRealConfiguredLucid(): Promise<LucidInstance> {
  const config = getCliConfig();
  const provider = await makeConfiguredProvider();

  return Lucid(provider, config.cardanoNetwork);
}

async function selectRealConfiguredWallet(
  lucid: LucidInstance,
): Promise<WalletSource> {
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

// Mutable factory references. Tests and the local emulator benchmark swap
// these to redirect every CLI builder at the in-memory Lucid Emulator
// without touching any builder's source. Always restore via
// `resetLucidFactories()` in a `finally` block.
let activeLucidFactory: LucidFactory = makeRealConfiguredLucid;
let activeWalletSelector: WalletSelector = selectRealConfiguredWallet;

export async function makeConfiguredLucid(): Promise<LucidInstance> {
  return activeLucidFactory();
}

export async function selectConfiguredWallet(
  lucid: LucidInstance,
): Promise<WalletSource> {
  return activeWalletSelector(lucid);
}

// Override the Lucid factory. Subsequent calls to `makeConfiguredLucid()`
// return whatever the supplied factory returns. Use from the emulator
// harness only.
export function setLucidFactory(factory: LucidFactory): void {
  activeLucidFactory = factory;
}

// Override the wallet selector. Subsequent calls to
// `selectConfiguredWallet(lucid)` delegate to the supplied selector.
// Use from the emulator harness only.
export function setWalletSelector(selector: WalletSelector): void {
  activeWalletSelector = selector;
}

// Restore the production env-based factories. Tests and benchmarks MUST
// call this in a `finally` block so production code paths are never left
// pointed at the emulator after the test completes.
export function resetLucidFactories(): void {
  activeLucidFactory = makeRealConfiguredLucid;
  activeWalletSelector = selectRealConfiguredWallet;
  activeProviderFactory = makeRealConfiguredProvider;
  emulatorModeActive = false;
}

// Emulator-mode flag. When true, helpers like `getNetworkNow` use
// `lucid.currentSlot()` instead of hitting Blockfrost's `/blocks/latest`
// endpoint, because the Blockfrost HTTP route always returns the real
// Preview tip (millions of slots ahead of the emulator's slot 0-based
// clock), which would build txs with validity bounds outside the
// emulator's slot range. Production CLI keeps `emulatorModeActive ===
// false` and is unaffected.
let emulatorModeActive = false;

export function setEmulatorModeActive(active: boolean): void {
  emulatorModeActive = active;
}

export function isEmulatorModeActive(): boolean {
  return emulatorModeActive;
}

async function fetchBlockfrostProtocolParameters(
  blockfrostApiUrl: string,
  blockfrostProjectId: string,
): Promise<ProtocolParameters> {
  const response = await fetch(`${blockfrostApiUrl}/epochs/latest/parameters`, {
    headers: {
      project_id: blockfrostProjectId,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch protocol parameters from Blockfrost (${response.status} ${response.statusText}).`,
    );
  }

  const latest = (await response.json()) as BlockfrostProtocolParametersResponse;

  return {
    minFeeA: Number(latest.min_fee_a),
    minFeeB: Number(latest.min_fee_b),
    maxTxSize: Number(latest.max_tx_size),
    maxValSize: Number(latest.max_val_size),
    keyDeposit: BigInt(latest.key_deposit),
    poolDeposit: BigInt(latest.pool_deposit),
    drepDeposit: BigInt(latest.drep_deposit),
    govActionDeposit: BigInt(latest.gov_action_deposit),
    priceMem: Number(latest.price_mem),
    priceStep: Number(latest.price_step),
    maxTxExMem: BigInt(latest.max_tx_ex_mem),
    maxTxExSteps: BigInt(latest.max_tx_ex_steps),
    coinsPerUtxoByte: BigInt(latest.coins_per_utxo_size),
    collateralPercentage: Number(latest.collateral_percent),
    maxCollateralInputs: Number(latest.max_collateral_inputs),
    minFeeRefScriptCostPerByte: Number(latest.min_fee_ref_script_cost_per_byte),
    costModels: {
      PlutusV1: indexedCostModel(latest.cost_models_raw.PlutusV1),
      PlutusV2: indexedCostModel(latest.cost_models_raw.PlutusV2),
      PlutusV3: indexedCostModel(latest.cost_models_raw.PlutusV3),
    },
  };
}

function indexedCostModel(values: number[]): Record<string, number> {
  return Object.fromEntries(
    values.map((value, index) => [index.toString(), value]),
  );
}
