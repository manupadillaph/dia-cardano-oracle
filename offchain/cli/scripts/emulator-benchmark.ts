#!/usr/bin/env tsx
// DIA Oracle — emulator protocol-flow benchmark.
//
// Runs the same end-to-end protocol flow as
// `offchain/cli/scripts/run-all-cli.sh` against the in-memory Lucid
// Emulator. Two modes:
//
//   - **probe (default)**: walks batch sizes ascending. For each N, the
//     orchestrator creates pair N (single update) and then runs batch-N
//     over all N created pairs. It keeps going until a batch fails;
//     the last successful N is the "max batch" the current bytecode
//     can fit. Reports every attempt with exec-units + fee.
//   - **single-shot (`--batch-size N`)**: seeds exactly N pairs via
//     single updates, then runs one batch-N. No probe up. Useful when
//     you already know the target size and just want fresh numbers
//     for it.
//
// In both modes the run finishes with settle → withdraws → reclaim →
// republish → admin-gated pair burn, and writes a Markdown + JSON
// report under `docs/milestones/evidence/m1-emulator-benchmark-<run-id>/`.
//
// Prerequisites:
//   - `DIA_EVM_PRIVATE_KEY` set in `.env` (same env var as the bash
//     script — used both to sign intents and to derive the authorized
//     DIA signer public key for the Config datum).
//
// Usage:
//   npm run benchmark:emulator
//   npm run benchmark:emulator -- --batch-size 12
//   npm run benchmark:emulator -- --keep-work-dir

import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeOracleEmulatorLucid } from "../src/__tests__/emulator/harness.js";
import { runEmulatorProtocolFlow } from "../src/emulator/protocol-flow.js";
import { writeEmulatorBenchmarkReport } from "../src/emulator/report.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..", "..");

type Args = {
  batchSize: number | undefined;
  keepWorkDir: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { batchSize: undefined, keepWorkDir: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--batch-size") {
      out.batchSize = parseBatchSize(argv[++i] ?? "");
    } else if (arg.startsWith("--batch-size=")) {
      out.batchSize = parseBatchSize(arg.slice("--batch-size=".length));
    } else if (arg === "--keep-work-dir") {
      out.keepWorkDir = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`[benchmark:emulator] unknown arg: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }
  return out;
}

function parseBatchSize(value: string): number {
  const n = Number(value.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --batch-size: ${value}. Must be a positive integer.`);
  }
  return n;
}

function printUsage(): void {
  console.error(`\
DIA Oracle — emulator protocol-flow benchmark.

Usage:
  npm run benchmark:emulator
  npm run benchmark:emulator -- [--batch-size N] [--keep-work-dir]

Modes:
  (no flag)              Probe mode. Walks N = 1, 2, 3, … For each N the
                         orchestrator creates pair N (single update) and
                         then runs batch-N over all N created pairs.
                         Stops at the first batch that fails; the last
                         successful N is the report's max.
  --batch-size N         Single-shot mode. Seeds exactly N pairs via
                         single updates, then runs one batch-N. No probe.

Options:
  --keep-work-dir        Keep the temporary state working dir on exit.
                         Useful for inspecting state JSON files after a
                         failed run. Default: cleaned up.

Prereq:
  DIA_EVM_PRIVATE_KEY must be set in offchain/cli/.env. The benchmark
  reads the same env var that run-all-cli.sh uses, so an env that runs
  the bash benchmark on Preview also runs this one.
`);
}

async function main(): Promise<void> {
  if (!process.env.DIA_EVM_PRIVATE_KEY?.trim()) {
    console.error(
      "[benchmark:emulator] DIA_EVM_PRIVATE_KEY is required (set it in offchain/cli/.env).",
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));

  const runId = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const evidenceDir = path.join(
    REPO_ROOT,
    "docs",
    "milestones",
    "evidence",
    `m1-emulator-benchmark-${runId}`,
  );

  console.error(`[benchmark:emulator] run id: ${runId}`);
  console.error(
    `[benchmark:emulator] mode: ${
      args.batchSize === undefined ? "probe (ascending, stop at first failure)" : `single-shot batch-${args.batchSize}`
    }`,
  );
  console.error(`[benchmark:emulator] evidence dir: ${evidenceDir}`);

  console.error("[benchmark:emulator] booting Lucid Emulator");
  const ctx = await makeOracleEmulatorLucid();

  const startedAt = Date.now();
  const report = await runEmulatorProtocolFlow({
    lucid: ctx.lucid,
    emulator: ctx.emulator,
    walletSeedPhrase: ctx.accounts[0].seedPhrase,
    keepWorkDir: args.keepWorkDir,
    batchSize: args.batchSize,
    reportProgress: (message) => console.error(message),
  });
  const elapsedMs = Date.now() - startedAt;

  const rendered = await writeEmulatorBenchmarkReport({
    outDir: evidenceDir,
    report,
    runId,
  });

  console.error(`[benchmark:emulator] completed in ${elapsedMs}ms`);
  console.error(`[benchmark:emulator] wrote ${rendered.jsonPath}`);
  console.error(`[benchmark:emulator] wrote ${rendered.markdownPath}`);
  if (args.keepWorkDir) {
    console.error(`[benchmark:emulator] work dir preserved at ${report.workDir}`);
  }

  // Print a compact batch-attempt summary to stdout so CI logs make it
  // obvious which sizes fit on the current bytecode. In probe mode the
  // attempts are in ascending size; in single-shot mode there's exactly one.
  console.log("\nBatch attempts:");
  for (const attempt of report.batchAttempts) {
    const tag = attempt.ok ? "ok  " : "FAIL";
    const cpu = attempt.metrics?.exUnits.cpu?.toString() ?? "—";
    const mem = attempt.metrics?.exUnits.mem?.toString() ?? "—";
    const note = attempt.error ? `  ← ${attempt.error.split("\n", 1)[0].slice(0, 100)}` : "";
    console.log(`  size=${attempt.size}  ${tag}  cpu=${cpu}  mem=${mem}${note}`);
  }
}

main().catch((error) => {
  console.error("[benchmark:emulator] fatal:", error);
  process.exit(1);
});
