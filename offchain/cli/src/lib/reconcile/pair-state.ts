// Reconcile local pair-state JSON files with live on-chain pair UTxOs.
//
// At daemon startup the local files may be stale (feeder restarted on a
// new machine) or absent (pair was created by a different operator or on
// the first boot against a pre-seeded pair UTxO). This helper queries
// the pair validator address, decodes every pair UTxO datum, and writes
// or updates the corresponding local pair-state file.
//
// Calling this on every startup is safe: when the on-chain nonce already
// matches what is stored locally the file is left untouched.

import path from "node:path";

import type { UTxO } from "@lucid-evolution/lucid";

import { decodePairDatum, writeJsonFile } from "../../core/chain-helpers.js";
import { pairSlugFromSymbol } from "../../core/intent-paths.js";
import { readOptionalPairState } from "../../core/state.js";
import type { ClientStateArtifact, PairStateArtifact } from "../../core/state.js";
import type { makeConfiguredLucid } from "../../core/lucid.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PairReconcileEntry = {
  symbol: string;
  pairUnit: string;
  outRef: { txHash: string; outputIndex: number };
  filePath: string;
  action: "created" | "updated" | "unchanged";
};

export type ReconcilePairStateResult = {
  pairsFound: number;
  entries: PairReconcileEntry[];
  errors: Array<{ unit: string; error: string }>;
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Query the pair validator address, decode every live pair UTxO datum,
 * and write or update the local pair-state files accordingly.
 *
 * Returns a summary of what was found and what changed. Errors in
 * individual UTxO decoding are collected (not thrown) so a single bad
 * UTxO does not abort the whole reconcile pass.
 *
 * No-ops quickly when the client state has no pair scripts yet (e.g.
 * before `receiver:parameterize` has run).
 */
export async function reconcilePairState(args: {
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>;
  clientStatePath: string;
  clientState: ClientStateArtifact;
  walletAddress?: string;
}): Promise<ReconcilePairStateResult> {
  const { lucid, clientStatePath, clientState, walletAddress } = args;

  const pairPolicyId = clientState.scripts.pairPolicyId;
  const pairValidatorAddress = clientState.scripts.pairValidatorAddress;

  if (!pairPolicyId || !pairValidatorAddress) {
    return { pairsFound: 0, entries: [], errors: [] };
  }

  let utxos: UTxO[];
  try {
    utxos = await lucid.utxosAt(pairValidatorAddress);
  } catch (err) {
    return {
      pairsFound: 0,
      entries: [],
      errors: [{ unit: "provider", error: (err as Error).message }],
    };
  }

  // Keep only UTxOs that carry an asset from pairPolicyId.
  // Avoid calling splitUnit on "lovelace" — filter by string prefix instead.
  const pairUtxos = utxos.filter((utxo) =>
    Object.keys(utxo.assets).some(
      (unit) => unit !== "lovelace" && unit.startsWith(pairPolicyId),
    ),
  );

  const entries: PairReconcileEntry[] = [];
  const errors: Array<{ unit: string; error: string }> = [];

  for (const utxo of pairUtxos) {
    const pairUnit = Object.keys(utxo.assets).find(
      (unit) => unit !== "lovelace" && unit.startsWith(pairPolicyId),
    );
    if (!pairUnit) continue;

    try {
      if (!utxo.datum) {
        errors.push({ unit: pairUnit, error: "UTxO has no inline datum" });
        continue;
      }

      const decoded = decodePairDatum(utxo.datum);
      const symbol = Buffer.from(decoded.pairId, "hex").toString("utf8");
      const tokenName = pairUnit.slice(pairPolicyId.length);
      const outRef = { txHash: utxo.txHash, outputIndex: utxo.outputIndex };
      const filePath = pairStateFilePath(clientStatePath, symbol);

      const existing = await readOptionalPairState(filePath);
      if (
        existing &&
        existing.pair.pairUnit === pairUnit &&
        existing.pairState.nonce === decoded.nonce
      ) {
        entries.push({ symbol, pairUnit, outRef, filePath, action: "unchanged" });
        continue;
      }

      const artifact = buildReconcileArtifact({
        existing,
        decoded,
        symbol,
        tokenName,
        pairUnit,
        pairValidatorAddress,
        rawDatum: utxo.datum,
        walletAddress: walletAddress ?? existing?.wallet.address ?? "",
      });
      await writeJsonFile(filePath, artifact);
      entries.push({
        symbol,
        pairUnit,
        outRef,
        filePath,
        action: existing ? "updated" : "created",
      });
    } catch (err) {
      errors.push({ unit: pairUnit, error: (err as Error).message });
    }
  }

  return { pairsFound: pairUtxos.length, entries, errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pairStateFilePath(clientStatePath: string, symbol: string): string {
  const resolved = path.resolve(clientStatePath);
  const clientFile = path.basename(resolved, path.extname(resolved));
  return path.join(
    path.dirname(resolved),
    clientFile,
    "pairs",
    `${pairSlugFromSymbol(symbol)}.json`,
  );
}

function buildReconcileArtifact(args: {
  existing: PairStateArtifact | null;
  decoded: ReturnType<typeof decodePairDatum>;
  symbol: string;
  tokenName: string;
  pairUnit: string;
  pairValidatorAddress: string;
  rawDatum: string;
  walletAddress: string;
}): PairStateArtifact {
  const { existing, decoded, symbol, tokenName, pairUnit, pairValidatorAddress, rawDatum, walletAddress } = args;

  // Preserve the stored intent from an existing file (it records the last
  // intent that produced the update). For a brand-new reconcile entry we
  // use a placeholder — the bridge overwrites this field on the next update.
  const intent = existing?.pairState.intent ?? {
    intentType: "",
    version: "0",
    chainId: "0",
    nonce: decoded.nonce,
    expiry: "0",
    symbol,
    price: decoded.price,
    timestamp: decoded.timestamp,
    source: "",
    signature: "",
    signer: decoded.signer,
  };

  return {
    wallet: existing?.wallet ?? { source: "seed", address: walletAddress },
    pair: {
      tokenName,
      pairId: decoded.pairId,
      pairUnit,
      pairValidatorAddress,
    },
    pairState: { ...decoded, intent },
    datum: { pairCbor: rawDatum },
    transactions: existing?.transactions,
  };
}
