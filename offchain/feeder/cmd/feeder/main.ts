// DIA Cardano Oracle Feeder — entry point.
//
// Daemon shape mirrors
// `diadata-org/Spectra-interoperability/services/bridge/cmd/bridge/main.go`:
//
//   - `--config <dir>` selects the modular config directory.
//   - `--log-level <debug|info|warn|error>` controls logger verbosity.
//   - `--validate-only` loads + validates the config and exits.
//   - `--scan [--transport http|ws] [--dry-run]` runs the source
//     pipeline (scanner + dedup + enricher) without submitting txs;
//     used for QA, replays, and early bring-up.
//   - default: long-running daemon. Wiring lands in 3.4+; today this
//     mode parks on a shutdown signal.
//
// This file stays thin: it parses args, resolves the active network,
// dispatches to the right handler, and orchestrates graceful shutdown
// via an AbortController.

import "dotenv/config";

import { parseArgs, type FeederMode, type ParsedArgs } from "./args.js";
import { runScan } from "./scan-cmd.js";
import { runValidateOnly } from "./validate-cmd.js";
import { runDaemon } from "./daemon-cmd.js";

const HELP_TEXT = `dia-cardano-oracle-feeder

Long-running daemon that consumes DIA OracleIntentRegistry events from
DIA Lasernet (testnet or mainnet) and submits matching Cardano oracle
updates. Architecturally aligned with the DIA Spectra Bridge.

Usage:
  feeder --config <dir> [--log-level <level>]
  feeder --config <dir> --validate-only
  feeder --config <dir> --scan [--transport http|ws] [--dry-run]
  feeder --help

Flags:
  --config <dir>        Path to the modular configuration directory.
                        Expected files: infrastructure.<network>.yaml,
                        chains.yaml, contracts.yaml, events.yaml,
                        routers/*.yaml.
                        Default: ./config
  --log-level <level>   One of: debug | info | warn | error.
                        Default: info
  --validate-only       Load + validate the config and exit.
                        Exits 0 on success, 1 on any error-severity issue.
  --scan                Run the source pipeline (scanner + dedup +
                        enricher) and print enriched intents.
  --transport <kind>    Applies to --scan. http (default) or ws.
  --dry-run             Print enriched intents but never submit a
                        Cardano tx. Also reachable via DRY_RUN=true.
  --clean               Delete feeder-generated state before starting:
                          logs/, feeder-checkpoint.json, feeder.sqlite*,
                          clients/*/pairs/*.json
                        CLI bootstrap artifacts are never touched:
                          config-bootstrap.json, clients/*.json
  --help, -h            Show this help message and exit.

The active network (Preview <-> DIA Testnet, Mainnet <-> DIA Mainnet)
is selected by CARDANO_NETWORK in .env, matching the CLI behavior.
`;

const SUPPORTED_NETWORKS = ["Preview", "Mainnet"] as const;
type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

/**
 * Resolve the active network from the `CARDANO_NETWORK` env var, with
 * `Preview` as the default. Throws on any unsupported value so that
 * misconfigured environments fail loudly instead of silently picking
 * the wrong DIA registry.
 */
function resolveActiveNetwork(): SupportedNetwork {
  const raw = process.env.CARDANO_NETWORK?.trim() ?? "Preview";
  if (!(SUPPORTED_NETWORKS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unsupported CARDANO_NETWORK "${raw}". Supported: ${SUPPORTED_NETWORKS.join(", ")}.`,
    );
  }
  return raw as SupportedNetwork;
}

/** Prefix every line written to stderr with `[feeder]`. */
function report(line: string): void {
  process.stderr.write(`[feeder] ${line}\n`);
}

/** AbortController whose signal trips on SIGINT or SIGTERM. The first
 *  signal triggers a graceful shutdown; a second one forces exit. */
function installShutdownController(): AbortController {
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      report(`received second ${signal}, forcing exit.`);
      process.exit(130);
    }
    report(`received ${signal}, shutting down gracefully (Ctrl-C again to force).`);
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return controller;
}

async function dispatch(args: ParsedArgs): Promise<number> {
  if (args.showHelp) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const network = resolveActiveNetwork();

  switch (args.mode satisfies FeederMode) {
    case "validate":
      return runValidateOnly({ configPath: args.configPath, network, report });

    case "scan": {
      const shutdown = installShutdownController();
      return runScan({
        network,
        configPath: args.configPath,
        transport: args.transport,
        dryRun: args.dryRun,
        report,
        signal: shutdown.signal,
      });
    }

    case "daemon": {
      const shutdown = installShutdownController();
      return runDaemon({
        network,
        configPath: args.configPath,
        transport: args.transport,
        dryRun: args.dryRun,
        cleanState: args.cleanState,
        logLevel: args.logLevel,
        report,
        signal: shutdown.signal,
      });
    }
  }
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP_TEXT}`);
    process.exit(2);
  }

  const code = await dispatch(args);
  process.exit(code);
}

main().catch((error) => {
  process.stderr.write(`[feeder] fatal: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
