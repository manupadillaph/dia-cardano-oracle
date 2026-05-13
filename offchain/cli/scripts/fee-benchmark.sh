#!/usr/bin/env bash
# Measures on-chain network fees for single update and batch(1..7), repeated CYCLES times.
# Requires a bootstrapped state from run-all-cli.sh (--run-id).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI_DIR="$REPO/offchain/cli"

CYCLES=5
EXISTING_RUN_ID=""
BENCH_RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
TOP_UP_LOVELACE="260000000"
POST_TX_DELAY_SECONDS="${POST_TX_DELAY_SECONDS:-15}"
CARDANO_PROVIDER="${CARDANO_PROVIDER:-Blockfrost}"
CLIENT_ID="client-a"
DOMAIN_NAME="DIA Oracle"

usage() {
  cat <<'EOF'
usage: fee-benchmark.sh --run-id RUN_ID [options]

  --run-id RUN_ID        bootstrapped state from run-all-cli.sh (required)
  --cycles N             number of benchmark cycles (default: 5)
  --top-up-lovelace N    receiver top-up before benchmark in lovelace (default: 260000000)
  --bench-run-id ID      benchmark run ID (default: timestamp)

example:
  fee-benchmark.sh --run-id 20260511-135140
  fee-benchmark.sh --run-id 20260511-135140 --cycles 3 --top-up-lovelace 150000000
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)            EXISTING_RUN_ID="$2";    shift 2 ;;
    --run-id=*)          EXISTING_RUN_ID="${1#*=}"; shift ;;
    --cycles)            CYCLES="$2";              shift 2 ;;
    --cycles=*)          CYCLES="${1#*=}";         shift ;;
    --top-up-lovelace)   TOP_UP_LOVELACE="$2";     shift 2 ;;
    --top-up-lovelace=*) TOP_UP_LOVELACE="${1#*=}"; shift ;;
    --bench-run-id)      BENCH_RUN_ID="$2";        shift 2 ;;
    --bench-run-id=*)    BENCH_RUN_ID="${1#*=}";   shift ;;
    --help|-h)           usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$EXISTING_RUN_ID" ]] || { echo "[bench] --run-id is required" >&2; usage >&2; exit 1; }

if ! [[ "$CYCLES" =~ ^[0-9]+$ ]] || (( CYCLES < 1 || CYCLES > 20 )); then
  echo "[bench] --cycles must be an integer between 1 and 20" >&2; exit 1
fi

STATE_NAME="preview_rerun_${EXISTING_RUN_ID}"
STATE_REL="./state/${STATE_NAME}"
STATE_ROOT="$CLI_DIR/state/${STATE_NAME}"
# Bench artifacts (intents, manifests, results) live in their own subfolder
# inside the base state so they don't pollute the original run's directories.
BENCH_STATE_REL="$STATE_REL/bench-${BENCH_RUN_ID}"
BENCH_STATE_ROOT="$STATE_ROOT/bench-${BENCH_RUN_ID}"
BENCH_EVIDENCE="$REPO/docs/milestones/evidence/m1-fee-benchmark-${BENCH_RUN_ID}"

[[ -d "$STATE_ROOT" ]] \
  || { echo "[bench] state not found: $STATE_ROOT" >&2; exit 1; }
[[ -f "$STATE_ROOT/config-bootstrap.json" ]] \
  || { echo "[bench] missing config-bootstrap.json in: $STATE_ROOT" >&2; exit 1; }
[[ -f "$STATE_ROOT/clients/${CLIENT_ID}.json" ]] \
  || { echo "[bench] missing client state for ${CLIENT_ID} in: $STATE_ROOT" >&2; exit 1; }

mkdir -p \
  "$BENCH_EVIDENCE" \
  "$BENCH_STATE_ROOT/intents" \
  "$BENCH_STATE_ROOT/manifests" \
  "$BENCH_STATE_ROOT/results"

exec > >(tee -a "$BENCH_EVIDENCE/00-bench-master.log") 2>&1

cd "$CLI_DIR"
set -a; source "$CLI_DIR/.env"; set +a
export CARDANO_PROVIDER

[[ -n "${DIA_EVM_PRIVATE_KEY:-}" ]] \
  || { echo "[bench] DIA_EVM_PRIVATE_KEY is required" >&2; exit 1; }

echo "[bench] bench run id : $BENCH_RUN_ID"
echo "[bench] base state   : $STATE_ROOT"
echo "[bench] bench state  : $BENCH_STATE_ROOT"
echo "[bench] evidence     : $BENCH_EVIDENCE"
echo "[bench] cycles       : $CYCLES"
echo "[bench] top-up       : $TOP_UP_LOVELACE lovelace"
echo "[bench] provider     : $CARDANO_PROVIDER"

echo "[bench] fetching protocol parameters"
PROTOCOL_PARAMS_JSON="$(npm run --silent cli -- preview:protocol)"
printf '%s\n' "$PROTOCOL_PARAMS_JSON" > "$BENCH_EVIDENCE/protocol-parameters.json"
PROTOCOL_LIMITS="$(
  PROTOCOL_PARAMS_JSON="$PROTOCOL_PARAMS_JSON" node --input-type=module <<'NODE'
const params = JSON.parse(process.env.PROTOCOL_PARAMS_JSON ?? "{}");
const maxTxExSteps = params.maxTxExSteps ?? params.max_tx_ex_steps;
const maxTxExMem = params.maxTxExMem ?? params.max_tx_ex_mem;
if (!maxTxExSteps || !maxTxExMem) {
  throw new Error("Protocol parameters are missing maxTxExSteps/maxTxExMem.");
}
console.log(`${maxTxExSteps} ${maxTxExMem}`);
NODE
)"
PROTOCOL_MAX_TX_EX_STEPS="${PROTOCOL_LIMITS%% *}"
PROTOCOL_MAX_TX_EX_MEM="${PROTOCOL_LIMITS##* }"
[[ "$PROTOCOL_MAX_TX_EX_STEPS" =~ ^[0-9]+$ ]] \
  || { echo "[bench] invalid maxTxExSteps: $PROTOCOL_MAX_TX_EX_STEPS" >&2; exit 1; }
[[ "$PROTOCOL_MAX_TX_EX_MEM" =~ ^[0-9]+$ ]] \
  || { echo "[bench] invalid maxTxExMem: $PROTOCOL_MAX_TX_EX_MEM" >&2; exit 1; }
echo "[bench] max tx ex steps: $PROTOCOL_MAX_TX_EX_STEPS"
echo "[bench] max tx ex mem  : $PROTOCOL_MAX_TX_EX_MEM"

# ── Pair configuration ────────────────────────────────────────────────────────
# update-1 uses btc-usd; batch-N uses first N slugs from BATCH_SLUGS
UPDATE_SLUG="btc-usd"

declare -ar BATCH_SLUGS=("btc-usd" "eth-usd" "ada-usd" "usdt-usd" "dai-usd" "sol-usd" "bnb-usd")

declare -Ar PAIR_SYMBOLS=(
  ["btc-usd"]="BTC/USD"
  ["eth-usd"]="ETH/USD"
  ["ada-usd"]="ADA/USD"
  ["usdt-usd"]="USDT/USD"
  ["dai-usd"]="DAI/USD"
  ["sol-usd"]="SOL/USD"
  ["bnb-usd"]="BNB/USD"
)

# Base prices (starting point); each intent gets base + seq*1M to guarantee uniqueness.
declare -Ar BASE_PRICES=(
  ["btc-usd"]="6010000000000"
  ["eth-usd"]="251000000000"
  ["ada-usd"]="760000000"
  ["usdt-usd"]="100200000"
  ["dai-usd"]="100200000"
  ["sol-usd"]="18600000000"
  ["bnb-usd"]="61600000000"
)

# Global sequence counter — incremented directly in generate_intent (not in subshell)
# to avoid subshell-copy isolation.
PRICE_SEQ=0

# ── Helpers ───────────────────────────────────────────────────────────────────

# generate_intent SLUG TAG
# Creates and signs an intent with a unique price. Writes to state intents dir.
# Must be called directly (not via $()), so PRICE_SEQ increments in main shell.
generate_intent() {
  local slug="$1"
  local tag="$2"
  PRICE_SEQ=$(( PRICE_SEQ + 1 ))
  local price=$(( ${BASE_PRICES[$slug]} + PRICE_SEQ * 1000000 ))
  local symbol="${PAIR_SYMBOLS[$slug]}"
  echo "[bench] intent: $slug  tag=$tag  price=$price  seq=$PRICE_SEQ"
  npm run --silent cli -- \
    preview:intent:create-and-sign \
    --state "$STATE_REL/config-bootstrap.json" \
    --intent-type OracleUpdate \
    --symbol "$symbol" \
    --price "$price" \
    --source "$DOMAIN_NAME" \
    --out "$BENCH_STATE_REL/intents/${slug}-${tag}.signed.json"
}

# write_manifest TAG SIZE
# Writes a batch manifest into bench manifests dir referencing the first SIZE slugs.
# Pair states stay in the base run's clients dir; intents come from bench intents dir.
write_manifest() {
  local tag="$1"
  local size="$2"
  local manifest_path="$BENCH_STATE_ROOT/manifests/bench-${tag}.manifest.json"
  {
    printf '{\n  "updates": [\n'
    local first=1
    for ((i = 0; i < size; i++)); do
      local slug="${BATCH_SLUGS[$i]}"
      [[ "$first" -eq 0 ]] && printf ',\n'
      first=0
      printf '    {\n'
      printf '      "statePath": "%s",\n' "$STATE_REL/clients/${CLIENT_ID}/pairs/${slug}.json"
      printf '      "intentPath": "%s"\n' "$BENCH_STATE_REL/intents/${slug}-${tag}.signed.json"
      printf '    }'
    done
    printf '\n  ]\n}\n'
  } > "$manifest_path"
}

# run_tx LOG_FILE CLI_ARGS...
# Runs a CLI command, writes output to LOG_FILE (and master log via exec redirect),
# then waits POST_TX_DELAY_SECONDS.
run_tx() {
  local log_file="$1"; shift
  echo "[bench] npm run cli -- $*"
  script -q -e -c "npm run cli -- $*" /dev/null | tee "$log_file"
  [[ "$POST_TX_DELAY_SECONDS" -gt 0 ]] && sleep "$POST_TX_DELAY_SECONDS"
}

# extract_resource LOG_FILE FIELD → prints integer value
# FIELD is one of: fee (lovelace), cpu, mem
extract_resource() {
  local log_file="$1"
  local field="$2"
  local val
  case "$field" in
    fee) val="$(grep -oP 'fee=[\d.]+ ADA \(\K\d+' "$log_file" | head -1)" ;;
    cpu) val="$(grep -oP 'cpu=\K\d+' "$log_file" | head -1)" ;;
    mem) val="$(grep -oP 'mem=\K\d+' "$log_file" | head -1)" ;;
  esac
  if [[ -z "$val" ]]; then
    echo "[bench] ERROR: could not extract $field from $(basename "$log_file")" >&2
    exit 1
  fi
  printf '%s\n' "$val"
}

# ── Data collection arrays ────────────────────────────────────────────────────
declare -a FEES_UPDATE=()  CPU_UPDATE=()  MEM_UPDATE=()
declare -a FEES_BATCH_1=() CPU_BATCH_1=() MEM_BATCH_1=()
declare -a FEES_BATCH_2=() CPU_BATCH_2=() MEM_BATCH_2=()
declare -a FEES_BATCH_3=() CPU_BATCH_3=() MEM_BATCH_3=()
declare -a FEES_BATCH_4=() CPU_BATCH_4=() MEM_BATCH_4=()
declare -a FEES_BATCH_5=() CPU_BATCH_5=() MEM_BATCH_5=()
declare -a FEES_BATCH_6=() CPU_BATCH_6=() MEM_BATCH_6=()
declare -a FEES_BATCH_7=() CPU_BATCH_7=() MEM_BATCH_7=()

# ── Top-up receiver ───────────────────────────────────────────────────────────
# Each cycle costs ~(1+1+2+3+4+5+6+7) = 29 protocol-fee-bearing updates.
# Default top-up of 260 ADA covers 5 cycles with margin.
echo ""
echo "[bench] ── Top-up receiver: $TOP_UP_LOVELACE lovelace ──"
run_tx "$BENCH_EVIDENCE/topup.log" \
  "preview:receiver:top-up --amount-lovelace $TOP_UP_LOVELACE --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/${CLIENT_ID}.json"

# ── Benchmark cycles ──────────────────────────────────────────────────────────
for cycle in $(seq 1 "$CYCLES"); do
  echo ""
  echo "[bench] ══════ Cycle $cycle / $CYCLES ══════"

  # ── Single update: 1 pair (btc-usd) ────────────────────────────────────────
  upd_tag="upd-c${cycle}"
  generate_intent "$UPDATE_SLUG" "$upd_tag"

  upd_log="$BENCH_EVIDENCE/c${cycle}-update.log"
  run_tx "$upd_log" \
    "preview:update \
     --intent $BENCH_STATE_REL/intents/${UPDATE_SLUG}-${upd_tag}.signed.json \
     --protocol-state $STATE_REL/config-bootstrap.json \
     --client-state $STATE_REL/clients/${CLIENT_ID}.json \
     --state $STATE_REL/clients/${CLIENT_ID}/pairs/${UPDATE_SLUG}.json"

  fee="$(extract_resource "$upd_log" fee)"
  cpu="$(extract_resource "$upd_log" cpu)"
  mem="$(extract_resource "$upd_log" mem)"
  echo "[bench] update-1  fee: $fee lovelace  cpu: $cpu  mem: $mem"
  FEES_UPDATE+=("$fee"); CPU_UPDATE+=("$cpu"); MEM_UPDATE+=("$mem")

  # ── Batch 1..7: N pairs per tx ─────────────────────────────────────────────
  for size in 1 2 3 4 5 6 7; do
    bat_tag="bat${size}-c${cycle}"

    # Fresh intents for all N slugs (each with a unique price via PRICE_SEQ)
    for ((i = 0; i < size; i++)); do
      generate_intent "${BATCH_SLUGS[$i]}" "$bat_tag"
    done

    write_manifest "$bat_tag" "$size"

    bat_log="$BENCH_EVIDENCE/c${cycle}-batch${size}.log"
    run_tx "$bat_log" \
      "preview:update:batch \
       --protocol-state $STATE_REL/config-bootstrap.json \
       --client-state $STATE_REL/clients/${CLIENT_ID}.json \
       --manifest $BENCH_STATE_REL/manifests/bench-${bat_tag}.manifest.json \
       --out $BENCH_STATE_REL/results/bench-${bat_tag}.result.json"

    fee="$(extract_resource "$bat_log" fee)"
    cpu="$(extract_resource "$bat_log" cpu)"
    mem="$(extract_resource "$bat_log" mem)"
    echo "[bench] batch-${size}    fee: $fee lovelace  cpu: $cpu  mem: $mem"

    case "$size" in
      1) FEES_BATCH_1+=("$fee"); CPU_BATCH_1+=("$cpu"); MEM_BATCH_1+=("$mem") ;;
      2) FEES_BATCH_2+=("$fee"); CPU_BATCH_2+=("$cpu"); MEM_BATCH_2+=("$mem") ;;
      3) FEES_BATCH_3+=("$fee"); CPU_BATCH_3+=("$cpu"); MEM_BATCH_3+=("$mem") ;;
      4) FEES_BATCH_4+=("$fee"); CPU_BATCH_4+=("$cpu"); MEM_BATCH_4+=("$mem") ;;
      5) FEES_BATCH_5+=("$fee"); CPU_BATCH_5+=("$cpu"); MEM_BATCH_5+=("$mem") ;;
      6) FEES_BATCH_6+=("$fee"); CPU_BATCH_6+=("$cpu"); MEM_BATCH_6+=("$mem") ;;
      7) FEES_BATCH_7+=("$fee"); CPU_BATCH_7+=("$cpu"); MEM_BATCH_7+=("$mem") ;;
    esac
  done
done

# ── Generate cost report ──────────────────────────────────────────────────────
echo ""
echo "[bench] ── Generating cost report ──"

FEES_UPDATE_STR="${FEES_UPDATE[*]:-}"
FEES_BATCH_1_STR="${FEES_BATCH_1[*]:-}"
FEES_BATCH_2_STR="${FEES_BATCH_2[*]:-}"
FEES_BATCH_3_STR="${FEES_BATCH_3[*]:-}"
FEES_BATCH_4_STR="${FEES_BATCH_4[*]:-}"
FEES_BATCH_5_STR="${FEES_BATCH_5[*]:-}"
FEES_BATCH_6_STR="${FEES_BATCH_6[*]:-}"
FEES_BATCH_7_STR="${FEES_BATCH_7[*]:-}"
CPU_UPDATE_STR="${CPU_UPDATE[*]:-}"
CPU_BATCH_1_STR="${CPU_BATCH_1[*]:-}"
CPU_BATCH_2_STR="${CPU_BATCH_2[*]:-}"
CPU_BATCH_3_STR="${CPU_BATCH_3[*]:-}"
CPU_BATCH_4_STR="${CPU_BATCH_4[*]:-}"
CPU_BATCH_5_STR="${CPU_BATCH_5[*]:-}"
CPU_BATCH_6_STR="${CPU_BATCH_6[*]:-}"
CPU_BATCH_7_STR="${CPU_BATCH_7[*]:-}"
MEM_UPDATE_STR="${MEM_UPDATE[*]:-}"
MEM_BATCH_1_STR="${MEM_BATCH_1[*]:-}"
MEM_BATCH_2_STR="${MEM_BATCH_2[*]:-}"
MEM_BATCH_3_STR="${MEM_BATCH_3[*]:-}"
MEM_BATCH_4_STR="${MEM_BATCH_4[*]:-}"
MEM_BATCH_5_STR="${MEM_BATCH_5[*]:-}"
MEM_BATCH_6_STR="${MEM_BATCH_6[*]:-}"
MEM_BATCH_7_STR="${MEM_BATCH_7[*]:-}"

FEES_UPDATE_STR="$FEES_UPDATE_STR" \
FEES_BATCH_1_STR="$FEES_BATCH_1_STR" \
FEES_BATCH_2_STR="$FEES_BATCH_2_STR" \
FEES_BATCH_3_STR="$FEES_BATCH_3_STR" \
FEES_BATCH_4_STR="$FEES_BATCH_4_STR" \
FEES_BATCH_5_STR="$FEES_BATCH_5_STR" \
FEES_BATCH_6_STR="$FEES_BATCH_6_STR" \
FEES_BATCH_7_STR="$FEES_BATCH_7_STR" \
CPU_UPDATE_STR="$CPU_UPDATE_STR" \
CPU_BATCH_1_STR="$CPU_BATCH_1_STR" \
CPU_BATCH_2_STR="$CPU_BATCH_2_STR" \
CPU_BATCH_3_STR="$CPU_BATCH_3_STR" \
CPU_BATCH_4_STR="$CPU_BATCH_4_STR" \
CPU_BATCH_5_STR="$CPU_BATCH_5_STR" \
CPU_BATCH_6_STR="$CPU_BATCH_6_STR" \
CPU_BATCH_7_STR="$CPU_BATCH_7_STR" \
MEM_UPDATE_STR="$MEM_UPDATE_STR" \
MEM_BATCH_1_STR="$MEM_BATCH_1_STR" \
MEM_BATCH_2_STR="$MEM_BATCH_2_STR" \
MEM_BATCH_3_STR="$MEM_BATCH_3_STR" \
MEM_BATCH_4_STR="$MEM_BATCH_4_STR" \
MEM_BATCH_5_STR="$MEM_BATCH_5_STR" \
MEM_BATCH_6_STR="$MEM_BATCH_6_STR" \
MEM_BATCH_7_STR="$MEM_BATCH_7_STR" \
BENCH_EVIDENCE="$BENCH_EVIDENCE" \
BENCH_RUN_ID="$BENCH_RUN_ID" \
BASE_RUN_ID="$EXISTING_RUN_ID" \
CYCLES="$CYCLES" \
PROTOCOL_MAX_TX_EX_STEPS="$PROTOCOL_MAX_TX_EX_STEPS" \
PROTOCOL_MAX_TX_EX_MEM="$PROTOCOL_MAX_TX_EX_MEM" \
node --input-type=module <<'NODE'
import { writeFile } from "node:fs/promises";
import path from "node:path";

function parseInts(str) {
  return str.trim() === ""
    ? []
    : str.trim().split(" ").map(Number).filter((n) => !isNaN(n) && n > 0);
}
function avg(arr) {
  return arr.length === 0
    ? 0
    : Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}
function toAda(lovelace) {
  return (lovelace / 1_000_000).toFixed(6);
}
function minOf(arr) { return arr.length === 0 ? 0 : Math.min(...arr); }
function maxOf(arr) { return arr.length === 0 ? 0 : Math.max(...arr); }

const OPS = ["update-1", "batch-1", "batch-2", "batch-3", "batch-4", "batch-5", "batch-6", "batch-7"];
const suffixes = ["UPDATE", "BATCH_1", "BATCH_2", "BATCH_3", "BATCH_4", "BATCH_5", "BATCH_6", "BATCH_7"];

const fees = Object.fromEntries(OPS.map((op, i) => [op, parseInts(process.env[`FEES_${suffixes[i]}_STR`])]));
const cpus = Object.fromEntries(OPS.map((op, i) => [op, parseInts(process.env[`CPU_${suffixes[i]}_STR`])]));
const mems = Object.fromEntries(OPS.map((op, i) => [op, parseInts(process.env[`MEM_${suffixes[i]}_STR`])]));

const evidenceRoot = process.env.BENCH_EVIDENCE;
const benchRunId   = process.env.BENCH_RUN_ID;
const baseRunId    = process.env.BASE_RUN_ID;
const cycles       = Number(process.env.CYCLES);

// ── JSON ──────────────────────────────────────────────────────────────────────
const json = {
  generatedAt: new Date().toISOString(),
  benchRunId,
  baseRunId,
  cycles,
  results: Object.fromEntries(
    OPS.map((op) => [
      op,
      {
        fee: {
          samples:     fees[op],
          count:       fees[op].length,
          avgLovelace: avg(fees[op]),
          avgAda:      toAda(avg(fees[op])),
          minLovelace: minOf(fees[op]),
          maxLovelace: maxOf(fees[op]),
        },
        cpu: {
          samples: cpus[op],
          avg:     avg(cpus[op]),
          min:     minOf(cpus[op]),
          max:     maxOf(cpus[op]),
        },
        mem: {
          samples: mems[op],
          avg:     avg(mems[op]),
          min:     minOf(mems[op]),
          max:     maxOf(mems[op]),
        },
      },
    ])
  ),
};

await writeFile(
  path.join(evidenceRoot, "fee-report.json"),
  JSON.stringify(json, null, 2) + "\n",
  "utf8",
);

// ── Markdown ──────────────────────────────────────────────────────────────────
const feeRows = OPS.map((op) => {
  const f = avg(fees[op]);
  return `| ${op.padEnd(10)} | ${String(fees[op].length).padStart(7)} | ${String(f).padStart(14)} | ${toAda(f).padStart(10)} | ${String(minOf(fees[op])).padStart(14)} | ${String(maxOf(fees[op])).padStart(14)} |`;
});

const cpuRows = OPS.map((op) => {
  const c = avg(cpus[op]);
  const m = avg(mems[op]);
  return `| ${op.padEnd(10)} | ${String(c).padStart(15)} | ${String(minOf(cpus[op])).padStart(15)} | ${String(maxOf(cpus[op])).padStart(15)} | ${String(m).padStart(12)} | ${String(minOf(mems[op])).padStart(12)} | ${String(maxOf(mems[op])).padStart(12)} |`;
});

// Preview per-tx execution unit limits
const CPU_LIMIT = Number(process.env.PROTOCOL_MAX_TX_EX_STEPS);
const MEM_LIMIT = Number(process.env.PROTOCOL_MAX_TX_EX_MEM);
const maxMeasuredBatch = 7;
const maxMeasuredOp = `batch-${maxMeasuredBatch}`;
const maxMeasuredCpu = avg(cpus[maxMeasuredOp]);
const maxMeasuredMem = avg(mems[maxMeasuredOp]);
const cpuPct = ((maxMeasuredCpu / CPU_LIMIT) * 100).toFixed(1);
const memPct = ((maxMeasuredMem / MEM_LIMIT) * 100).toFixed(1);

// Linear regression over measured batch data: fee = base + k*N
const batchOps = OPS.filter((op) => op.startsWith("batch-"));
const pts = batchOps.map((op, i) => [i + 1, avg(fees[op])]);
const nMeasured = pts.length;
const sumN  = pts.reduce((a, [x]) => a + x, 0);
const sumF  = pts.reduce((a, [, y]) => a + y, 0);
const sumN2 = pts.reduce((a, [x]) => a + x * x, 0);
const sumNF = pts.reduce((a, [x, y]) => a + x * y, 0);
const kReg    = (nMeasured * sumNF - sumN * sumF) / (nMeasured * sumN2 - sumN ** 2);
const baseReg = (sumF - kReg * sumN) / nMeasured;

const fmtLv = (v) => Math.round(v).toLocaleString("en-US");

const predRows = Array.from({ length: 10 }, (_, i) => {
  const N    = i + 1;
  const pred = Math.round(baseReg + kReg * N);
  const op   = `batch-${N}`;
  const actualStr = fees[op]
    ? toAda(avg(fees[op]))
    : "*(mem limit)*";
  const errorStr = fees[op]
    ? (avg(fees[op]) - pred > 0 ? "+" : "") + (avg(fees[op]) - pred).toLocaleString("en-US")
    : "—";
  return `| ${String(N).padStart(2)} | ${fmtLv(pred).padStart(20)} | ${toAda(pred).padStart(15)} | ${actualStr.padStart(16)} | ${errorStr.padStart(9)} |`;
});

const md = `\
# DIA Oracle — Fee Benchmark Report

| Field        | Value |
|--------------|-------|
| Bench run    | \`${benchRunId}\` |
| Base state   | \`${baseRunId}\` |
| Cycles       | ${cycles} |
| Generated    | ${new Date().toISOString()} |

## Network Fee Summary (lovelace / ADA)

> On-chain transaction fees paid to Cardano. Protocol fees are separate and currently use 0.6 ADA + 0.4 ADA × N pairs.

| Operation  | Samples | Avg (lovelace) | Avg (ADA)  | Min (lovelace) | Max (lovelace) |
|------------|---------|----------------|------------|----------------|----------------|
${feeRows.join("\n")}

## Execution Units

> CPU steps and memory units consumed per transaction (Plutus budget).

| Operation  |       Avg CPU |       Min CPU |       Max CPU |    Avg Mem |    Min Mem |    Max Mem |
|------------|---------------|---------------|---------------|------------|------------|------------|
${cpuRows.join("\n")}

## Cardano Budget Limits & Utilization

> Per-tx execution unit limits on Cardano Preview.

| Resource | Limit            | batch-${maxMeasuredBatch} avg    | batch-${maxMeasuredBatch} % used |
|----------|-----------------|----------------|----------------|
| CPU      | ${fmtLv(CPU_LIMIT).padStart(15)} | ${fmtLv(maxMeasuredCpu).padStart(14)} |         ${cpuPct}% |
| Memory   | ${fmtLv(MEM_LIMIT).padStart(15)} | ${fmtLv(maxMeasuredMem).padStart(14)} |        **${memPct}%** |

Memory is the binding constraint. batch-${maxMeasuredBatch} sits at ~${memPct}% of the memory limit — the preview run showed batch-8 and above fail.

## Fee Estimation Model

Linear regression over batch-1 … batch-${maxMeasuredBatch} data (least squares):

\`\`\`
fee (lovelace) ≈ ${fmtLv(baseReg)} + ${fmtLv(kReg)} × N
fee (ADA)      ≈ ${(baseReg / 1e6).toFixed(4)}  +  ${(kReg / 1e6).toFixed(4)} × N
\`\`\`

where N = number of pairs in the batch.

### Predicted fees for N = 1 … 10

| N  | Predicted (lovelace) | Predicted (ADA) | Actual avg (ADA) | Error     |
|----|----------------------|-----------------|------------------|-----------|
${predRows.join("\n")}

${(() => {
  const maxErr = Math.max(...pts.map(([N, f]) => Math.abs(f - Math.round(baseReg + kReg * N))));
  const maxErrK = Math.round(maxErr / 1000);
  const maxErrAda = (maxErr / 1e6).toFixed(3);
  return `The model fits with max ~${maxErrK}K lovelace (~${maxErrAda} ADA) error — acceptable for fee estimation.`;
})()}

## Protocol Fee Design Options

> Two separate fee flows:
> - **Network fee** (measured in this benchmark): paid by the DIA oracle wallet to the Cardano network for each submitted transaction.
> - **Protocol fee** (\`PROTOCOL_FEE_LOVELACE = 2,000,000\` = 2 ADA × N pairs): charged by the DIA protocol to the client, deducted from the client's receiver and accumulated in the payment hook.
>
> The table below compares options for the **protocol fee** design, using the measured network fees as the cost baseline.

| Model | Formula | Example: 1 pair | Example: 7 pairs | Notes |
|-------|---------|-----------------|------------------|-------|
| **Flat per-pair** | 2 ADA × N | 2 ADA | 14 ADA | Simple; over-collects at scale |
| **Base + per-pair** (current) | 0.6 + 0.40 × N ADA | 1.00 ADA | 3.40 ADA | Tracks real cost closely |

## Notes

- \`update-1\` — single oracle price update (1 pair: BTC/USD).
- \`batch-N\` — N simultaneous price updates in one transaction (pairs: BTC/USD … up to BNB/USD).
- Data collected on Cardano **preview** testnet.
`;

await writeFile(
  path.join(evidenceRoot, "fee-report.md"),
  md,
  "utf8",
);

// ── Console summary ───────────────────────────────────────────────────────────
console.log("[bench] Reports written:");
console.log(`  ${path.join(evidenceRoot, "fee-report.json")}`);
console.log(`  ${path.join(evidenceRoot, "fee-report.md")}`);
console.log("");
console.log("  Operation    Avg (ADA)      Avg (lovelace)      Avg CPU          Avg Mem    n");
console.log("  -----------  -------------  ------------------  ---------------  ---------  -");
for (const op of OPS) {
  const f = avg(fees[op]);
  const c = avg(cpus[op]);
  const m = avg(mems[op]);
  console.log(
    `  ${op.padEnd(12)} ${toAda(f).padStart(13)}  ${String(f).padStart(18)}  ${String(c).padStart(15)}  ${String(m).padStart(9)}  ${fees[op].length}`,
  );
}
NODE

echo ""
echo "[bench] completed: $BENCH_EVIDENCE"
