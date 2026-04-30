import type { OutRef, UTxO } from "@lucid-evolution/lucid";

import { makeConfiguredProvider } from "./lucid.js";

export type ReferenceScriptDescriptor<K extends string> = {
  key: K;
  label: string;
  outRef?: OutRef | null;
};

export type ReferenceScriptLoadResult<K extends string> = {
  utxos: UTxO[];
  missing: Record<K, boolean>;
};

export async function loadReferenceScriptUtxos<K extends string>(
  descriptors: readonly ReferenceScriptDescriptor<K>[],
  reportProgress: (message: string) => void,
): Promise<ReferenceScriptLoadResult<K>> {
  const missing = Object.fromEntries(
    descriptors.map((descriptor) => [descriptor.key, !descriptor.outRef]),
  ) as Record<K, boolean>;

  const available = descriptors.filter(
    (descriptor): descriptor is ReferenceScriptDescriptor<K> & { outRef: OutRef } =>
      Boolean(descriptor.outRef),
  );

  for (const descriptor of descriptors) {
    if (!descriptor.outRef) {
      reportProgress(
        `Reference script for ${descriptor.label} is not configured; will attach the validator inline.`,
      );
    }
  }

  if (available.length === 0) {
    return { utxos: [], missing };
  }

  const provider = await makeConfiguredProvider();
  const loaded = await provider.getUtxosByOutRef(
    available.map((descriptor) => descriptor.outRef),
  );
  const utxos: UTxO[] = [];

  for (const descriptor of available) {
    const utxo = loaded.find(
      (candidate) =>
        candidate.txHash === descriptor.outRef.txHash &&
        candidate.outputIndex === descriptor.outRef.outputIndex,
    );
    if (utxo) {
      utxos.push(utxo);
      continue;
    }

    missing[descriptor.key] = true;
    reportProgress(
      `Reference script for ${descriptor.label} not found on-chain (${descriptor.outRef.txHash}#${descriptor.outRef.outputIndex}); will attach the validator inline.`,
    );
  }

  return { utxos, missing };
}
