import { CML, type TxSignBuilder } from "@lucid-evolution/lucid";

export type TxResourceMetrics = {
  feeLovelace: bigint;
  feeAda: string;
  exUnits: {
    cpu: bigint;
    mem: bigint;
  };
};

export function collectTxSignBuilderMetrics(txSignBuilder: TxSignBuilder): TxResourceMetrics {
  const tx = txSignBuilder.toTransaction();
  const feeLovelace = BigInt(tx.body().fee().toString());
  const exUnits = collectTransactionExUnits(tx);

  return {
    feeLovelace,
    feeAda: formatAda(feeLovelace),
    exUnits,
  };
}

export function reportTxSignBuilderMetrics(
  txSignBuilder: TxSignBuilder,
  reportProgress: (message: string) => void,
): TxResourceMetrics {
  const metrics = collectTxSignBuilderMetrics(txSignBuilder);
  reportProgress(
    `Tx resources: fee=${metrics.feeAda} ADA (${metrics.feeLovelace} lovelace), cpu=${metrics.exUnits.cpu}, mem=${metrics.exUnits.mem}`,
  );
  return metrics;
}

function collectTransactionExUnits(tx: CML.Transaction): TxResourceMetrics["exUnits"] {
  const totals = { cpu: 0n, mem: 0n };
  const redeemers = tx.witness_set().redeemers();
  if (!redeemers) return totals;

  const legacy = redeemers.as_arr_legacy_redeemer();
  if (legacy) {
    for (let index = 0; index < legacy.len(); index += 1) {
      const redeemer = legacy.get(index);
      totals.cpu += BigInt(redeemer.ex_units().steps().toString());
      totals.mem += BigInt(redeemer.ex_units().mem().toString());
    }
  }

  const redeemerMap = redeemers.as_map_redeemer_key_to_redeemer_val();
  if (redeemerMap) {
    const keys = redeemerMap.keys();
    for (let index = 0; index < keys.len(); index += 1) {
      const key = keys.get(index);
      const value = redeemerMap.get(key);
      if (!value) continue;
      totals.cpu += BigInt(value.ex_units().steps().toString());
      totals.mem += BigInt(value.ex_units().mem().toString());
    }
  }

  return totals;
}

function formatAda(lovelace: bigint): string {
  const whole = lovelace / 1_000_000n;
  const fractional = (lovelace % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fractional}`;
}
