// Startup reconciliation — feeder-side wrapper.
//
// Iterates every unique Cardano destination across all enabled routers,
// connects Lucid to the provider, and calls the CLI's `reconcilePairState`
// helper to sync local pair-state JSON files with the live on-chain state.
//
// CLI modules are loaded via dynamic `import()` — same pattern as
// `lib-bridge/index.ts` — so the feeder can typecheck without
// `@lucid-evolution/lucid` in its static dependency graph.
//
// Errors for an individual destination are logged as warnings, not thrown:
// a reconcile failure should not prevent the daemon from starting.

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ModularConfig, CardanoDestinationConfig } from "../config/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReconcileDestinationResult = {
  clientStatePath: string;
  pairsFound: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: Array<{ unit: string; error: string }>;
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Run startup reconciliation for every unique Cardano destination in the
 * loaded config. Returns one result entry per destination.
 *
 * Non-fatal: if a destination fails (provider down, missing state file,
 * etc.) it is logged and the next destination is attempted.
 */
export async function reconcileAllDestinations(args: {
  config: ModularConfig;
  log: (line: string) => void;
  cliSrcRoot?: string;
}): Promise<ReconcileDestinationResult[]> {
  const { config, log } = args;

  const cliRoot = args.cliSrcRoot
    ? path.resolve(args.cliSrcRoot)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../cli/src");

  // Collect unique (clientStatePath, protocolStatePath) pairs from all
  // enabled routers.
  const seen = new Set<string>();
  const destinations: CardanoDestinationConfig[] = [];

  for (const router of Object.values(config.routers)) {
    if (!router.enabled) continue;
    for (const dest of router.destinations) {
      if (!dest.cardano) continue;
      const key = `${dest.cardano.client_state_path}::${dest.cardano.protocol_state_path}`;
      if (!seen.has(key)) {
        seen.add(key);
        destinations.push(dest.cardano);
      }
    }
  }

  if (destinations.length === 0) {
    log("reconcile: no Cardano destinations in config — skipping");
    return [];
  }

  log(`reconcile: reconciling ${destinations.length} Cardano destination(s)…`);

  const results: ReconcileDestinationResult[] = [];
  for (const dest of destinations) {
    try {
      const result = await reconcileOneDestination({ dest, cliRoot, log });
      results.push(result);
    } catch (err) {
      log(
        `reconcile: WARNING — ${dest.client_state_path} failed: ${(err as Error).message}`,
      );
      results.push({
        clientStatePath: dest.client_state_path,
        pairsFound: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        errors: [{ unit: "destination", error: (err as Error).message }],
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Per-destination helper
// ---------------------------------------------------------------------------

async function reconcileOneDestination(args: {
  dest: CardanoDestinationConfig;
  cliRoot: string;
  log: (line: string) => void;
}): Promise<ReconcileDestinationResult> {
  const { dest, cliRoot, log } = args;

  function cliPath(rel: string): string {
    return `${cliRoot}/${rel}`;
  }

  const [
    { getCliConfig },
    { makeConfiguredLucidWithConfig, selectConfiguredWalletWithConfig },
    { readClientContext },
    { reconcilePairState },
  ] = await Promise.all([
    import(cliPath("core/config.js")),
    import(cliPath("core/lucid.js")),
    import(cliPath("core/artifact-context.js")),
    import(cliPath("lib/reconcile/pair-state.js")),
  ]);

  const cliConfig = getCliConfig();
  const lucid = await makeConfiguredLucidWithConfig(cliConfig);
  const walletSource = await selectConfiguredWalletWithConfig(lucid, cliConfig);
  const walletAddress: string = await lucid.wallet().address();

  const { client } = await readClientContext({
    clientStatePath: path.resolve(dest.client_state_path),
    protocolStatePath: path.resolve(dest.protocol_state_path),
  });

  const result = await reconcilePairState({
    lucid,
    clientStatePath: dest.client_state_path,
    clientState: client,
    walletAddress,
  });

  const created   = result.entries.filter((e: { action: string }) => e.action === "created").length;
  const updated   = result.entries.filter((e: { action: string }) => e.action === "updated").length;
  const unchanged = result.entries.filter((e: { action: string }) => e.action === "unchanged").length;

  log(
    `reconcile: ${dest.client_state_path} → ` +
    `found=${result.pairsFound} created=${created} updated=${updated} ` +
    `unchanged=${unchanged} errors=${result.errors.length}`,
  );
  for (const err of result.errors) {
    log(`reconcile: WARNING — unit=${err.unit}: ${err.error}`);
  }
  for (const entry of result.entries.filter((e: { action: string }) => e.action !== "unchanged")) {
    log(`reconcile: ${entry.action} ${entry.symbol} → ${entry.filePath}`);
  }

  void walletSource; // captured only to force wallet setup; address is what matters
  return {
    clientStatePath: dest.client_state_path,
    pairsFound: result.pairsFound,
    created,
    updated,
    unchanged,
    errors: result.errors,
  };
}
