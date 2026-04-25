import { Lucid } from "@lucid-evolution/lucid";
import { Blockfrost, Koios } from "@lucid-evolution/provider";

import { getCliConfig } from "./config.js";

type ProtocolParameters = Awaited<
  ReturnType<Blockfrost["getProtocolParameters"]>
>;

type KoiosEpochParams = {
  min_fee_a: number;
  min_fee_b: number;
  max_tx_size: number;
  max_val_size: number;
  key_deposit: string;
  pool_deposit: string;
  drep_deposit: string;
  gov_action_deposit: string;
  price_mem: number;
  price_step: number;
  max_tx_ex_mem: number | string;
  max_tx_ex_steps: number | string;
  coins_per_utxo_size: string;
  collateral_percent: number;
  max_collateral_inputs: number;
  min_fee_ref_script_cost_per_byte: number;
  cost_models: {
    PlutusV1: number[];
    PlutusV2: number[];
    PlutusV3: number[];
  };
};

export async function makeConfiguredProvider(): Promise<Blockfrost | Koios> {
  const config = getCliConfig();

  if (config.cardanoProvider === "Koios") {
    return new Koios(config.koiosApiUrl);
  }

  const provider = new Blockfrost(
    config.blockfrostApiUrl,
    config.blockfrostProjectId,
  );
  provider.getProtocolParameters = async (): Promise<ProtocolParameters> =>
    fetchKoiosProtocolParameters(config.koiosApiUrl);

  return provider;
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

async function fetchKoiosProtocolParameters(
  koiosApiUrl: string,
): Promise<ProtocolParameters> {
  const response = await fetch(`${koiosApiUrl}/epoch_params?limit=1`, {
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch protocol parameters from Koios (${response.status} ${response.statusText}).`,
    );
  }

  const payload = (await response.json()) as KoiosEpochParams[];
  const latest = payload[0];

  if (!latest) {
    throw new Error("Koios returned no protocol parameters.");
  }

  return {
    minFeeA: latest.min_fee_a,
    minFeeB: latest.min_fee_b,
    maxTxSize: latest.max_tx_size,
    maxValSize: latest.max_val_size,
    keyDeposit: BigInt(latest.key_deposit),
    poolDeposit: BigInt(latest.pool_deposit),
    drepDeposit: BigInt(latest.drep_deposit),
    govActionDeposit: BigInt(latest.gov_action_deposit),
    priceMem: latest.price_mem,
    priceStep: latest.price_step,
    maxTxExMem: BigInt(latest.max_tx_ex_mem),
    maxTxExSteps: BigInt(latest.max_tx_ex_steps),
    coinsPerUtxoByte: BigInt(latest.coins_per_utxo_size),
    collateralPercentage: latest.collateral_percent,
    maxCollateralInputs: latest.max_collateral_inputs,
    minFeeRefScriptCostPerByte: latest.min_fee_ref_script_cost_per_byte,
    costModels: {
      PlutusV1: indexedCostModel(latest.cost_models.PlutusV1),
      PlutusV2: indexedCostModel(latest.cost_models.PlutusV2),
      PlutusV3: indexedCostModel(latest.cost_models.PlutusV3),
    },
  };
}

function indexedCostModel(values: number[]): Record<string, number> {
  return Object.fromEntries(
    values.map((value, index) => [index.toString(), value]),
  );
}
