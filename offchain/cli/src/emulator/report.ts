// Renders the emulator protocol-flow report as Markdown + JSON in the
// same shape as `offchain/cli/scripts/fee-benchmark.sh`'s output, so a
// reviewer can compare an emulator run against a Preview run line by
// line. The values are exec-units (CPU steps + memory units) captured
// from the same Plutus VM that runs on-chain, so they are directly
// comparable to Preview/mainnet. Fees are recorded for reference but
// may differ from real-network fees because emulator protocol
// parameters can diverge from Preview/mainnet.

import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

import type {
  EmulatorProtocolFlowReport,
  EmulatorStepReport,
} from "./protocol-flow.js";

export type RenderedReport = {
  jsonPath: string;
  markdownPath: string;
};

export async function writeEmulatorBenchmarkReport(args: {
  outDir: string;
  report: EmulatorProtocolFlowReport;
  runId: string;
}): Promise<RenderedReport> {
  await mkdir(args.outDir, { recursive: true });
  const jsonPath = path.join(args.outDir, "fee-report.json");
  const markdownPath = path.join(args.outDir, "fee-report.md");

  const json = buildJsonReport(args.report, args.runId);
  await writeFile(jsonPath, JSON.stringify(json, null, 2) + "\n", "utf8");

  const markdown = buildMarkdownReport(json);
  await writeFile(markdownPath, markdown, "utf8");

  return { jsonPath, markdownPath };
}

type JsonReport = {
  generatedAt: string;
  runId: string;
  source: "lucid-emulator";
  steps: Array<{
    label: string;
    durationMs: number;
    ok: boolean;
    error?: string;
    feeLovelace?: string;
    cpu?: string;
    mem?: string;
  }>;
  batchAttempts: Array<{
    size: number;
    ok: boolean;
    feeLovelace?: string;
    cpu?: string;
    mem?: string;
    error?: string;
  }>;
};

function buildJsonReport(
  report: EmulatorProtocolFlowReport,
  runId: string,
): JsonReport {
  return {
    generatedAt: new Date().toISOString(),
    runId,
    source: "lucid-emulator",
    steps: report.steps.map(toJsonStep),
    batchAttempts: report.batchAttempts.map((attempt) => ({
      size: attempt.size,
      ok: attempt.ok,
      feeLovelace: attempt.metrics?.feeLovelace.toString(),
      cpu: attempt.metrics?.exUnits.cpu.toString(),
      mem: attempt.metrics?.exUnits.mem.toString(),
      error: attempt.error,
    })),
  };
}

function toJsonStep(step: EmulatorStepReport): JsonReport["steps"][number] {
  return {
    label: step.label,
    durationMs: step.durationMs,
    ok: step.ok,
    error: step.error,
    feeLovelace: step.metrics?.feeLovelace.toString(),
    cpu: step.metrics?.exUnits.cpu.toString(),
    mem: step.metrics?.exUnits.mem.toString(),
  };
}

function buildMarkdownReport(json: JsonReport): string {
  const txSteps = json.steps.filter((s) => s.cpu !== undefined);
  const rows = txSteps.map(
    (s) =>
      `| ${s.label.padEnd(48)} | ${(s.ok ? "ok" : "fail").padStart(4)} | ${formatLovelace(s.feeLovelace).padStart(14)} | ${formatAda(s.feeLovelace).padStart(10)} | ${formatNumber(s.cpu).padStart(15)} | ${formatNumber(s.mem).padStart(12)} |`,
  );

  const batchRows = json.batchAttempts.map((a) => {
    const status = a.ok ? "ok" : "fail";
    const fee = formatLovelace(a.feeLovelace);
    const feeAda = formatAda(a.feeLovelace);
    const cpu = formatNumber(a.cpu);
    const mem = formatNumber(a.mem);
    const note = a.ok ? "" : trimError(a.error);
    return `| ${String(a.size).padStart(4)} | ${status.padStart(4)} | ${fee.padStart(14)} | ${feeAda.padStart(10)} | ${cpu.padStart(15)} | ${mem.padStart(12)} | ${note} |`;
  });

  return `\
# DIA Oracle — Emulator Protocol-Flow Report

| Field        | Value |
|--------------|-------|
| Run id       | \`${json.runId}\` |
| Source       | ${json.source} |
| Generated    | ${json.generatedAt} |

> Exec-units (CPU steps + memory) are captured from the same Plutus VM
> that runs on Cardano, so they are directly comparable to Preview /
> mainnet evidence. Fees are reported for reference but may differ from
> real-network fees because emulator protocol parameters can diverge
> from Preview/mainnet.

## Per-transaction resources

| Step${" ".repeat(44)} | ok   |  fee (lovelace) | fee (ADA)  |         cpu     |      mem    |
|${"-".repeat(50)}|------|----------------|------------|-----------------|--------------|
${rows.join("\n")}

## Batch attempts

| size |  ok  |  fee (lovelace) | fee (ADA)  |         cpu     |      mem    | note |
|------|------|----------------|------------|-----------------|--------------|------|
${batchRows.join("\n")}

## Steps that did not submit a tx (init / parameterize / intent-sign)

${json.steps
  .filter((s) => s.cpu === undefined)
  .map((s) => `- \`${s.label}\` (${s.durationMs}ms${s.ok ? "" : ` FAILED: ${trimError(s.error)}`})`)
  .join("\n")}
`;
}

function formatLovelace(value?: string): string {
  if (!value) return "—";
  return value;
}

function formatAda(lovelaceStr?: string): string {
  if (!lovelaceStr) return "—";
  const lovelace = BigInt(lovelaceStr);
  const whole = lovelace / 1_000_000n;
  const fractional = (lovelace % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fractional}`;
}

function formatNumber(value?: string): string {
  if (!value) return "—";
  return value;
}

function trimError(error?: string): string {
  if (!error) return "";
  const first = error.split("\n", 1)[0];
  return first.length > 120 ? first.slice(0, 117) + "..." : first;
}
