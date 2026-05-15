#!/usr/bin/env bash
# Measures on-chain network fees and exec-unit limits for the DIA oracle.
#
# Modes (selected via --mode):
#   probe — find the max batch size that fits in the per-tx exec-unit budget.
#           Walks N upwards from --probe-start, minting one more pair after
#           each successful batch, until a batch tx fails. Writes the
#           discovered max to `discovered-max-batch.txt`. No cycles.
#   bench — gather network-fee/cpu/mem statistics by repeating a fixed
#           pattern (1 single update + batch-1..batch-MAX) CYCLES times.
#           Requires --max-batch N (use the value probe wrote earlier).
#   both  — run probe first, then immediately run cycles with the discovered
#           MAX_BATCH. This is the legacy behaviour.
#
# The setup is identical across modes (config UTxO discovery, top-up of the
# receiver, pre-seed of the pair UTxOs the chosen mode needs). Only the work
# done after setup differs.
#
# Requires a bootstrapped state from run-all-cli.sh (--run-id).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI_DIR="$REPO/offchain/cli"

CYCLES=5
EXISTING_RUN_ID=""
BENCH_RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
TOP_UP_LOVELACE=""
TOP_UP_OVERRIDE=0
POST_TX_DELAY_SECONDS="${POST_TX_DELAY_SECONDS:-15}"
CARDANO_PROVIDER="${CARDANO_PROVIDER:-Blockfrost}"
CLIENT_ID="client-a"
DOMAIN_NAME="DIA Oracle"

MODE="both"
MAX_BATCH_INPUT=""

# Probe phase configuration. PROBE_START is the first batch size we attempt;
# PROBE_MAX_HARD is a safety ceiling so the loop can't get stuck if everything
# keeps passing — bump it if you exceed it.
PROBE_START=9
PROBE_MAX_HARD=20

usage() {
  cat <<'EOF'
usage: fee-benchmark.sh --run-id RUN_ID --mode probe|bench|both [options]

  --run-id RUN_ID         bootstrapped state from run-all-cli.sh (required)
  --mode probe|bench|both selects what runs after the shared setup
                            probe : find MAX_BATCH and stop
                            bench : run cycles, requires --max-batch
                            both  : probe + cycles (default)
  --max-batch N           batch size to use for cycles (required in bench mode)
  --cycles N              number of benchmark cycles (default: 5)
  --probe-start N         first batch size to probe (default: 9)
  --probe-max N           hard ceiling on probe size (default: 20)
  --top-up-lovelace N     receiver top-up before benchmark (default: auto-scaled
                          from mode + sizes + cycles; pass explicitly to override)
  --bench-run-id ID       benchmark run ID (default: timestamp)

examples:
  # Find the max batch size the protocol can fit on Preview.
  fee-benchmark.sh --run-id 20260511-135140 --mode probe

  # Use the value the probe wrote (cat discovered-max-batch.txt) and run cycles.
  fee-benchmark.sh --run-id 20260511-135140 --mode bench --max-batch 12

  # Do everything in one go (legacy behaviour).
  fee-benchmark.sh --run-id 20260511-135140 --mode both --cycles 3
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)            EXISTING_RUN_ID="$2";    shift 2 ;;
    --run-id=*)          EXISTING_RUN_ID="${1#*=}"; shift ;;
    --mode)              MODE="$2";                shift 2 ;;
    --mode=*)            MODE="${1#*=}";           shift ;;
    --max-batch)         MAX_BATCH_INPUT="$2";     shift 2 ;;
    --max-batch=*)       MAX_BATCH_INPUT="${1#*=}"; shift ;;
    --cycles)            CYCLES="$2";              shift 2 ;;
    --cycles=*)          CYCLES="${1#*=}";         shift ;;
    --probe-start)       PROBE_START="$2";         shift 2 ;;
    --probe-start=*)     PROBE_START="${1#*=}";    shift ;;
    --probe-max)         PROBE_MAX_HARD="$2";      shift 2 ;;
    --probe-max=*)       PROBE_MAX_HARD="${1#*=}"; shift ;;
    --top-up-lovelace)   TOP_UP_LOVELACE="$2";     TOP_UP_OVERRIDE=1; shift 2 ;;
    --top-up-lovelace=*) TOP_UP_LOVELACE="${1#*=}"; TOP_UP_OVERRIDE=1; shift ;;
    --bench-run-id)      BENCH_RUN_ID="$2";        shift 2 ;;
    --bench-run-id=*)    BENCH_RUN_ID="${1#*=}";   shift ;;
    --help|-h)           usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$EXISTING_RUN_ID" ]] || { echo "[bench] --run-id is required" >&2; usage >&2; exit 1; }

case "$MODE" in
  probe|bench|both) ;;
  *) echo "[bench] --mode must be one of: probe, bench, both (got: $MODE)" >&2; exit 1 ;;
esac

RUN_PROBE=0
RUN_CYCLES=0
case "$MODE" in
  probe) RUN_PROBE=1 ;;
  bench) RUN_CYCLES=1 ;;
  both)  RUN_PROBE=1; RUN_CYCLES=1 ;;
esac

if (( RUN_CYCLES == 1 && RUN_PROBE == 0 )); then
  if ! [[ "$MAX_BATCH_INPUT" =~ ^[0-9]+$ ]] || (( MAX_BATCH_INPUT < 1 )); then
    echo "[bench] --max-batch is required in bench mode (positive integer)" >&2; exit 1
  fi
fi

if ! [[ "$CYCLES" =~ ^[0-9]+$ ]] || (( CYCLES < 1 || CYCLES > 20 )); then
  echo "[bench] --cycles must be an integer between 1 and 20" >&2; exit 1
fi
if ! [[ "$PROBE_START" =~ ^[0-9]+$ ]] || (( PROBE_START < 1 )); then
  echo "[bench] --probe-start must be a positive integer" >&2; exit 1
fi
if ! [[ "$PROBE_MAX_HARD" =~ ^[0-9]+$ ]] || (( PROBE_MAX_HARD < PROBE_START )); then
  echo "[bench] --probe-max must be ≥ --probe-start" >&2; exit 1
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
echo "[bench] mode         : $MODE"
echo "[bench] base state   : $STATE_ROOT"
echo "[bench] bench state  : $BENCH_STATE_ROOT"
echo "[bench] evidence     : $BENCH_EVIDENCE"
if (( RUN_CYCLES == 1 )); then
  echo "[bench] cycles       : $CYCLES"
fi
if (( RUN_PROBE == 1 )); then
  echo "[bench] probe start  : $PROBE_START"
  echo "[bench] probe max    : $PROBE_MAX_HARD"
fi
if (( RUN_PROBE == 0 )); then
  echo "[bench] max batch    : $MAX_BATCH_INPUT"
fi
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
# update-1 uses btc-usd (always the first slug).
# Probe and batch use BATCH_SLUGS, walking the list in order. The list is sized
# generously above PROBE_MAX_HARD so the probe can climb until a batch fails.
UPDATE_SLUG="btc-usd"

declare -ar BATCH_SLUGS=(
  "btc-usd"  "eth-usd"  "ada-usd"   "usdt-usd" "dai-usd"
  "sol-usd"  "bnb-usd"  "link-usd"  "matic-usd" "dot-usd"
  "avax-usd" "atom-usd" "xlm-usd"   "algo-usd" "near-usd"
  "ftm-usd"  "xrp-usd"  "ltc-usd"   "doge-usd" "trx-usd"
)

declare -Ar PAIR_SYMBOLS=(
  ["btc-usd"]="BTC/USD"
  ["eth-usd"]="ETH/USD"
  ["ada-usd"]="ADA/USD"
  ["usdt-usd"]="USDT/USD"
  ["dai-usd"]="DAI/USD"
  ["sol-usd"]="SOL/USD"
  ["bnb-usd"]="BNB/USD"
  ["link-usd"]="LINK/USD"
  ["matic-usd"]="MATIC/USD"
  ["dot-usd"]="DOT/USD"
  ["avax-usd"]="AVAX/USD"
  ["atom-usd"]="ATOM/USD"
  ["xlm-usd"]="XLM/USD"
  ["algo-usd"]="ALGO/USD"
  ["near-usd"]="NEAR/USD"
  ["ftm-usd"]="FTM/USD"
  ["xrp-usd"]="XRP/USD"
  ["ltc-usd"]="LTC/USD"
  ["doge-usd"]="DOGE/USD"
  ["trx-usd"]="TRX/USD"
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
  ["link-usd"]="2500000000"
  ["matic-usd"]="900000000"
  ["dot-usd"]="6800000000"
  ["avax-usd"]="34000000000"
  ["atom-usd"]="9500000000"
  ["xlm-usd"]="130000000"
  ["algo-usd"]="220000000"
  ["near-usd"]="6300000000"
  ["ftm-usd"]="800000000"
  ["xrp-usd"]="610000000"
  ["ltc-usd"]="80000000000"
  ["doge-usd"]="120000000"
  ["trx-usd"]="180000000"
)

if (( PROBE_MAX_HARD > ${#BATCH_SLUGS[@]} )); then
  echo "[bench] --probe-max ($PROBE_MAX_HARD) exceeds BATCH_SLUGS length (${#BATCH_SLUGS[@]}); add more pairs to BATCH_SLUGS/PAIR_SYMBOLS/BASE_PRICES" >&2
  exit 1
fi

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
# Runs a CLI command, writes output to LOG_FILE, then waits POST_TX_DELAY_SECONDS.
# Fails fast on non-zero exit (set -e + pipefail).
run_tx() {
  local log_file="$1"; shift
  echo "[bench] npm run cli -- $*"
  script -q -e -c "npm run cli -- $*" /dev/null | tee "$log_file"
  [[ "$POST_TX_DELAY_SECONDS" -gt 0 ]] && sleep "$POST_TX_DELAY_SECONDS"
}

# try_tx LOG_FILE CLI_ARGS...
# Same as run_tx but does NOT abort the script on failure. Returns 0/1.
# Used during probe to detect the first batch size that doesn't fit.
try_tx() {
  local log_file="$1"; shift
  echo "[bench] [probe] npm run cli -- $*"
  set +e
  script -q -e -c "npm run cli -- $*" /dev/null | tee "$log_file"
  local rc=${PIPESTATUS[0]}
  set -e
  if [[ "$rc" -eq 0 && "$POST_TX_DELAY_SECONDS" -gt 0 ]]; then
    sleep "$POST_TX_DELAY_SECONDS"
  fi
  return "$rc"
}

# seed_pair SLUG
# Runs preview:update for SLUG only if its state file does not exist yet, so
# the slug owns a Pair UTxO before we start probing pure-update batches. Idempotent.
seed_pair() {
  local slug="$1"
  local state_path="$STATE_ROOT/clients/${CLIENT_ID}/pairs/${slug}.json"
  if [[ -f "$state_path" ]]; then
    echo "[bench] seed: ${slug} already exists, skipping"
    return 0
  fi
  local tag="seed"
  generate_intent "$slug" "$tag"
  run_tx "$BENCH_EVIDENCE/seed-${slug}.log" \
    "preview:update \
     --intent $BENCH_STATE_REL/intents/${slug}-${tag}.signed.json \
     --protocol-state $STATE_REL/config-bootstrap.json \
     --client-state $STATE_REL/clients/${CLIENT_ID}.json \
     --state $STATE_REL/clients/${CLIENT_ID}/pairs/${slug}.json"
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

# Decide how many pairs the chosen mode needs on-chain BEFORE its main work:
#   probe : PROBE_START pairs (then probe creates the rest as it climbs).
#   bench : MAX_BATCH_INPUT pairs (so cycles run pure-update batches).
#   both  : PROBE_START pairs (probe handles the rest).
if (( RUN_PROBE == 1 )); then
  SEED_TARGET="$PROBE_START"
else
  SEED_TARGET="$MAX_BATCH_INPUT"
fi
if (( SEED_TARGET > ${#BATCH_SLUGS[@]} )); then
  echo "[bench] requested seed target ($SEED_TARGET) exceeds BATCH_SLUGS length (${#BATCH_SLUGS[@]}); add more pairs to BATCH_SLUGS/PAIR_SYMBOLS/BASE_PRICES" >&2
  exit 1
fi

# ── Top-up receiver ───────────────────────────────────────────────────────────
# Auto-scale top-up if the operator did not override it. The bench draws
# protocol fees from the receiver balance; per-tx cost is
# base_fee + N × per_pair_fee. Per-mode cost coverage:
#   probe : seed (SEED_TARGET) + probe walk (PROBE_START..PROBE_MAX_HARD)
#   bench : seed (SEED_TARGET) + cycles (CYCLES × (update-1 + sum 1..MAX_BATCH))
#   both  : seed + probe + cycles (with MAX_BATCH = PROBE_MAX_HARD as upper bound)
# Then a 20% margin, rounded up to 10 ADA, floored at 100 ADA.
if [[ "$TOP_UP_OVERRIDE" -eq 0 ]]; then
  TOP_UP_LOVELACE="$(
    PROBE_MAX_HARD="$PROBE_MAX_HARD" \
    PROBE_START="$PROBE_START" \
    CYCLES="$CYCLES" \
    SEED_TARGET="$SEED_TARGET" \
    MAX_BATCH_INPUT="${MAX_BATCH_INPUT:-0}" \
    RUN_PROBE="$RUN_PROBE" \
    RUN_CYCLES="$RUN_CYCLES" \
    CONFIG_STATE_PATH="$STATE_ROOT/config-bootstrap.json" \
    node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";
const cfgPath = process.env.CONFIG_STATE_PATH;
let base = 600_000n, perPair = 400_000n;
try {
  const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
  if (cfg?.configState?.baseFeeLovelace) base = BigInt(cfg.configState.baseFeeLovelace);
  if (cfg?.configState?.perPairFeeLovelace) perPair = BigInt(cfg.configState.perPairFeeLovelace);
} catch {}
const PMAX_HARD = BigInt(process.env.PROBE_MAX_HARD);
const PSTART    = BigInt(process.env.PROBE_START);
const CYCLES    = BigInt(process.env.CYCLES);
const SEED      = BigInt(process.env.SEED_TARGET);
const MAX_B     = BigInt(process.env.MAX_BATCH_INPUT);
const runProbe  = process.env.RUN_PROBE === "1";
const runCycles = process.env.RUN_CYCLES === "1";
function sumLinear(from, to) {
  if (to < from) return 0n;
  const n = to - from + 1n;
  return n * base + perPair * ((from + to) * n / 2n);
}
let total = 0n;
total += SEED * (base + perPair);                     // seeding (single updates)
if (runProbe)  total += sumLinear(PSTART, PMAX_HARD); // probe walk worst case
// cycles cost depends on the batch ceiling we'll actually use:
//   bench-only : MAX_B
//   both       : PMAX_HARD (probe may climb that high)
const cyclesCeiling = runProbe ? PMAX_HARD : MAX_B;
if (runCycles && cyclesCeiling > 0n) {
  total += CYCLES * ((base + perPair) + sumLinear(1n, cyclesCeiling));
}
const padded = (total * 12n) / 10n;
const stepped = ((padded + 9_999_999n) / 10_000_000n) * 10_000_000n;
const min = 100_000_000n;
console.log((stepped > min ? stepped : min).toString());
NODE
  )"
fi

if ! [[ "$TOP_UP_LOVELACE" =~ ^[0-9]+$ ]] || (( TOP_UP_LOVELACE <= 0 )); then
  echo "[bench] invalid top-up lovelace: $TOP_UP_LOVELACE" >&2
  exit 1
fi
echo "[bench] top-up       : $TOP_UP_LOVELACE lovelace ($(awk "BEGIN{printf \"%.2f\", $TOP_UP_LOVELACE/1e6}") ADA)"

echo ""
echo "[bench] ── Top-up receiver: $TOP_UP_LOVELACE lovelace ──"
run_tx "$BENCH_EVIDENCE/topup.log" \
  "preview:receiver:top-up --amount-lovelace $TOP_UP_LOVELACE --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/${CLIENT_ID}.json"

# ── Pre-seed: make sure the first SEED_TARGET pairs already exist ─────────────
# So the first batch the chosen mode runs (probe-PROBE_START or batch-MAX_BATCH)
# is a pure-update batch, not a mixed create+update batch. Pre-seeding via
# single-update txs also keeps each create isolated (admin signer required by
# pair_state.mint(MintPairs) — the bench wallet IS the protocol admin, so this
# works without extra config). Idempotent: existing slugs are skipped.
echo ""
echo "[bench] ── Pre-seed: ensure $SEED_TARGET pairs exist ──"
for ((i = 0; i < SEED_TARGET; i++)); do
  seed_pair "${BATCH_SLUGS[$i]}"
done

# ── Probe phase ───────────────────────────────────────────────────────────────
# Walk batch size up by 1 starting at PROBE_START. Each successful batch leaves
# the corresponding pair count on-chain, and we then create the next pair (so
# the next probe is again a pure-update batch). Stop at first failure.
MAX_BATCH=0
PROBE_FAILED_AT=""
if (( RUN_PROBE == 1 )); then
  echo ""
  echo "[bench] ── Probe phase: start=$PROBE_START, hard ceiling=$PROBE_MAX_HARD ──"
  MAX_BATCH=$(( PROBE_START - 1 ))
  for ((N = PROBE_START; N <= PROBE_MAX_HARD; N++)); do
    tag="probe-${N}"
    for ((i = 0; i < N; i++)); do
      generate_intent "${BATCH_SLUGS[$i]}" "$tag"
    done
    write_manifest "$tag" "$N"

    log="$BENCH_EVIDENCE/probe-batch${N}.log"
    echo ""
    echo "[bench] [probe] attempting batch-${N} (${N} pure updates)"
    if try_tx "$log" \
      "preview:update:batch \
       --protocol-state $STATE_REL/config-bootstrap.json \
       --client-state $STATE_REL/clients/${CLIENT_ID}.json \
       --manifest $BENCH_STATE_REL/manifests/bench-${tag}.manifest.json \
       --out $BENCH_STATE_REL/results/bench-${tag}.result.json"; then
      fee="$(extract_resource "$log" fee)"
      cpu="$(extract_resource "$log" cpu)"
      mem="$(extract_resource "$log" mem)"
      echo "[bench] [probe] batch-${N} OK  fee: $fee  cpu: $cpu  mem: $mem"
      MAX_BATCH="$N"

      # If we still have slugs left, seed one more pair so the next probe is a
      # pure-update batch of size N+1.
      if (( N + 1 <= PROBE_MAX_HARD )); then
        next_slug="${BATCH_SLUGS[$N]}"  # 0-based: index $N is the (N+1)-th slug
        echo "[bench] [probe] seeding pair #$((N + 1)): $next_slug"
        seed_pair "$next_slug"
      fi
    else
      PROBE_FAILED_AT="$N"
      echo "[bench] [probe] batch-${N} FAILED — see $log"
      break
    fi
  done

  echo ""
  echo "[bench] ── Probe summary ──"
  echo "[bench] max successful batch size: $MAX_BATCH"
  if [[ -n "$PROBE_FAILED_AT" ]]; then
    echo "[bench] first failing size      : $PROBE_FAILED_AT"
  else
    echo "[bench] (probe walked to ceiling without failing)"
  fi
  printf '%s\n' "$MAX_BATCH" > "$BENCH_EVIDENCE/discovered-max-batch.txt"
else
  # bench-only mode: the operator supplied --max-batch.
  MAX_BATCH="$MAX_BATCH_INPUT"
  echo ""
  echo "[bench] probe phase skipped (mode=bench); using --max-batch $MAX_BATCH"
fi

if (( RUN_CYCLES == 1 && MAX_BATCH < 1 )); then
  echo "[bench] ERROR: no successful batch size found; aborting cycles" >&2
  exit 1
fi

# ── Data collection (associative arrays keyed by batch size) ──────────────────
declare -a FEES_UPDATE=()  CPU_UPDATE=()  MEM_UPDATE=()
declare -A FEES_BATCH=()   CPU_BATCH=()   MEM_BATCH=()

# ── Benchmark cycles ──────────────────────────────────────────────────────────
if (( RUN_CYCLES == 0 )); then
  echo ""
  echo "[bench] cycles phase skipped (mode=$MODE)"
fi
for cycle in $(seq 1 "$CYCLES"); do
  (( RUN_CYCLES == 1 )) || break
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

  # ── Batch 1..MAX_BATCH: N pairs per tx ─────────────────────────────────────
  for size in $(seq 1 "$MAX_BATCH"); do
    bat_tag="bat${size}-c${cycle}"

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

    FEES_BATCH[$size]="${FEES_BATCH[$size]:-} $fee"
    CPU_BATCH[$size]="${CPU_BATCH[$size]:-} $cpu"
    MEM_BATCH[$size]="${MEM_BATCH[$size]:-} $mem"
  done
done

# ── Generate cost report ──────────────────────────────────────────────────────
echo ""
echo "[bench] ── Generating cost report ──"

# Build env-var list dynamically for sizes 1..MAX_BATCH so the Node block can
# iterate without knowing the size at script-write time.
ENV_ARGS=(
  "FEES_UPDATE_STR=${FEES_UPDATE[*]:-}"
  "CPU_UPDATE_STR=${CPU_UPDATE[*]:-}"
  "MEM_UPDATE_STR=${MEM_UPDATE[*]:-}"
  "BENCH_EVIDENCE=$BENCH_EVIDENCE"
  "BENCH_RUN_ID=$BENCH_RUN_ID"
  "BASE_RUN_ID=$EXISTING_RUN_ID"
  "CYCLES=$CYCLES"
  "MAX_BATCH=$MAX_BATCH"
  "PROBE_START=$PROBE_START"
  "PROBE_FAILED_AT=${PROBE_FAILED_AT:-}"
  "RUN_PROBE=$RUN_PROBE"
  "RUN_CYCLES=$RUN_CYCLES"
  "MODE=$MODE"
  "PROTOCOL_MAX_TX_EX_STEPS=$PROTOCOL_MAX_TX_EX_STEPS"
  "PROTOCOL_MAX_TX_EX_MEM=$PROTOCOL_MAX_TX_EX_MEM"
)
for size in $(seq 1 "$MAX_BATCH"); do
  ENV_ARGS+=(
    "FEES_BATCH_${size}_STR=${FEES_BATCH[$size]:-}"
    "CPU_BATCH_${size}_STR=${CPU_BATCH[$size]:-}"
    "MEM_BATCH_${size}_STR=${MEM_BATCH[$size]:-}"
  )
done

env "${ENV_ARGS[@]}" node --input-type=module <<'NODE'
import { writeFile } from "node:fs/promises";
import path from "node:path";

function parseInts(str) {
  return (str ?? "").trim() === ""
    ? []
    : str.trim().split(/\s+/).map(Number).filter((n) => !isNaN(n) && n > 0);
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

const MAX_BATCH = Number(process.env.MAX_BATCH);
const PROBE_START = Number(process.env.PROBE_START);
const PROBE_FAILED_AT = process.env.PROBE_FAILED_AT
  ? Number(process.env.PROBE_FAILED_AT)
  : null;
const RUN_PROBE  = process.env.RUN_PROBE  === "1";
const RUN_CYCLES = process.env.RUN_CYCLES === "1";
const MODE       = process.env.MODE;

// When cycles didn't run we still want the report to render (probe-only mode);
// the sample arrays will simply be empty and the markdown skips those sections.
const OPS = RUN_CYCLES
  ? ["update-1", ...Array.from({ length: MAX_BATCH }, (_, i) => `batch-${i + 1}`)]
  : [];

const fees = Object.fromEntries(OPS.map((op) => {
  const key = op === "update-1"
    ? "FEES_UPDATE_STR"
    : `FEES_BATCH_${op.slice("batch-".length)}_STR`;
  return [op, parseInts(process.env[key])];
}));
const cpus = Object.fromEntries(OPS.map((op) => {
  const key = op === "update-1"
    ? "CPU_UPDATE_STR"
    : `CPU_BATCH_${op.slice("batch-".length)}_STR`;
  return [op, parseInts(process.env[key])];
}));
const mems = Object.fromEntries(OPS.map((op) => {
  const key = op === "update-1"
    ? "MEM_UPDATE_STR"
    : `MEM_BATCH_${op.slice("batch-".length)}_STR`;
  return [op, parseInts(process.env[key])];
}));

const evidenceRoot = process.env.BENCH_EVIDENCE;
const benchRunId   = process.env.BENCH_RUN_ID;
const baseRunId    = process.env.BASE_RUN_ID;
const cycles       = Number(process.env.CYCLES);

// ── JSON ──────────────────────────────────────────────────────────────────────
const json = {
  generatedAt: new Date().toISOString(),
  mode: MODE,
  benchRunId,
  baseRunId,
  cycles: RUN_CYCLES ? cycles : null,
  probe: RUN_PROBE
    ? {
        start: PROBE_START,
        maxSuccessful: MAX_BATCH,
        firstFailingSize: PROBE_FAILED_AT,
      }
    : null,
  maxBatch: MAX_BATCH,
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
const CPU_LIMIT = Number(process.env.PROTOCOL_MAX_TX_EX_STEPS);
const MEM_LIMIT = Number(process.env.PROTOCOL_MAX_TX_EX_MEM);
const fmtLv = (v) => Math.round(v).toLocaleString("en-US");

const headerRows = [
  `| Mode             | \`${MODE}\` |`,
  `| Bench run        | \`${benchRunId}\` |`,
  `| Base state       | \`${baseRunId}\` |`,
];
if (RUN_CYCLES) headerRows.push(`| Cycles           | ${cycles} |`);
if (RUN_PROBE) {
  headerRows.push(`| Probe start      | batch-${PROBE_START} |`);
  headerRows.push(`| Max successful   | batch-${MAX_BATCH} |`);
  headerRows.push(`| First failing    | ${PROBE_FAILED_AT ? `batch-${PROBE_FAILED_AT}` : "—"} |`);
} else {
  headerRows.push(`| Max batch (in)   | batch-${MAX_BATCH} |`);
}
headerRows.push(`| Generated        | ${new Date().toISOString()} |`);

let probeLine = "";
if (RUN_PROBE) {
  probeLine = PROBE_FAILED_AT
    ? `Probe walked **batch-${PROBE_START} → batch-${MAX_BATCH}** successfully; **batch-${PROBE_FAILED_AT}** failed.`
    : `Probe walked **batch-${PROBE_START} → batch-${MAX_BATCH}** without failing (hit the probe ceiling).`;
}

// Cycle-derived sections (only render if cycles ran).
let cycleSections = "";
if (RUN_CYCLES && OPS.length > 0) {
  const feeRows = OPS.map((op) => {
    const f = avg(fees[op]);
    return `| ${op.padEnd(10)} | ${String(fees[op].length).padStart(7)} | ${String(f).padStart(14)} | ${toAda(f).padStart(10)} | ${String(minOf(fees[op])).padStart(14)} | ${String(maxOf(fees[op])).padStart(14)} |`;
  });
  const cpuRows = OPS.map((op) => {
    const c = avg(cpus[op]);
    const m = avg(mems[op]);
    return `| ${op.padEnd(10)} | ${String(c).padStart(15)} | ${String(minOf(cpus[op])).padStart(15)} | ${String(maxOf(cpus[op])).padStart(15)} | ${String(m).padStart(12)} | ${String(minOf(mems[op])).padStart(12)} | ${String(maxOf(mems[op])).padStart(12)} |`;
  });
  const maxMeasuredBatch = MAX_BATCH;
  const maxMeasuredOp = `batch-${maxMeasuredBatch}`;
  const maxMeasuredCpu = avg(cpus[maxMeasuredOp]);
  const maxMeasuredMem = avg(mems[maxMeasuredOp]);
  const cpuPct = CPU_LIMIT > 0 ? ((maxMeasuredCpu / CPU_LIMIT) * 100).toFixed(1) : "n/a";
  const memPct = MEM_LIMIT > 0 ? ((maxMeasuredMem / MEM_LIMIT) * 100).toFixed(1) : "n/a";

  // Linear regression over measured batch data: fee = base + k*N
  const batchOps = OPS.filter((op) => op.startsWith("batch-"));
  const pts = batchOps.map((op) => [
    Number(op.slice("batch-".length)),
    avg(fees[op]),
  ]);
  const nMeasured = pts.length;
  const sumN  = pts.reduce((a, [x]) => a + x, 0);
  const sumF  = pts.reduce((a, [, y]) => a + y, 0);
  const sumN2 = pts.reduce((a, [x]) => a + x * x, 0);
  const sumNF = pts.reduce((a, [x, y]) => a + x * y, 0);
  const denom = nMeasured * sumN2 - sumN ** 2;
  const kReg    = denom === 0 ? 0 : (nMeasured * sumNF - sumN * sumF) / denom;
  const baseReg = nMeasured === 0 ? 0 : (sumF - kReg * sumN) / nMeasured;

  const predUpTo = MAX_BATCH + 3;
  const predRows = Array.from({ length: predUpTo }, (_, i) => {
    const N    = i + 1;
    const pred = Math.round(baseReg + kReg * N);
    const op   = `batch-${N}`;
    const actualStr = fees[op] && fees[op].length > 0
      ? toAda(avg(fees[op]))
      : (PROBE_FAILED_AT && N >= PROBE_FAILED_AT ? "*(over budget)*" : "—");
    const errorStr = fees[op] && fees[op].length > 0
      ? (avg(fees[op]) - pred > 0 ? "+" : "") + (avg(fees[op]) - pred).toLocaleString("en-US")
      : "—";
    return `| ${String(N).padStart(2)} | ${fmtLv(pred).padStart(20)} | ${toAda(pred).padStart(15)} | ${actualStr.padStart(16)} | ${errorStr.padStart(9)} |`;
  });

  const utilLine = PROBE_FAILED_AT
    ? `batch-${maxMeasuredBatch} sits at ~${memPct}% of memory and ~${cpuPct}% of CPU; batch-${PROBE_FAILED_AT} exceeded one of the limits during probe.`
    : (RUN_PROBE
      ? `batch-${maxMeasuredBatch} sits at ~${memPct}% of memory and ~${cpuPct}% of CPU; the probe ceiling was hit before any size failed, so the real maximum is at least ${maxMeasuredBatch}.`
      : `batch-${maxMeasuredBatch} sits at ~${memPct}% of memory and ~${cpuPct}% of CPU.`);

  const fitLine = (() => {
    if (pts.length === 0) return "";
    const maxErr = Math.max(...pts.map(([N, f]) => Math.abs(f - Math.round(baseReg + kReg * N))));
    const maxErrK = Math.round(maxErr / 1000);
    const maxErrAda = (maxErr / 1e6).toFixed(3);
    return `The model fits with max ~${maxErrK}K lovelace (~${maxErrAda} ADA) error — acceptable for fee estimation.`;
  })();

  cycleSections = `
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

${utilLine}

## Fee Estimation Model

Linear regression over batch-1 … batch-${maxMeasuredBatch} data (least squares):

\`\`\`
fee (lovelace) ≈ ${fmtLv(baseReg)} + ${fmtLv(kReg)} × N
fee (ADA)      ≈ ${(baseReg / 1e6).toFixed(4)}  +  ${(kReg / 1e6).toFixed(4)} × N
\`\`\`

where N = number of pairs in the batch.

### Predicted fees for N = 1 … ${predUpTo}

| N  | Predicted (lovelace) | Predicted (ADA) | Actual avg (ADA) | Error     |
|----|----------------------|-----------------|------------------|-----------|
${predRows.join("\n")}

${fitLine}
`;
} else if (RUN_PROBE) {
  // Probe-only mode: still emit the headline ex-unit context so the report
  // is self-contained. We don't have per-cycle samples, but `discovered-max-batch.txt`
  // and `probe-batch${N}.log` live alongside this report.
  cycleSections = `
## Probe Outcome

The probe walked from batch-${PROBE_START} upwards${
    PROBE_FAILED_AT
      ? ` and stopped at the first failing size (batch-${PROBE_FAILED_AT}).`
      : ` and hit the configured ceiling (batch-${MAX_BATCH}) without failing.`
  } Detailed per-attempt logs are in this directory as \`probe-batch{N}.log\`. The integer max successful batch size is written to \`discovered-max-batch.txt\`.

| Resource           | Per-tx limit (Preview) |
|--------------------|------------------------|
| CPU (steps)        | ${fmtLv(CPU_LIMIT).padStart(20)} |
| Memory             | ${fmtLv(MEM_LIMIT).padStart(20)} |

To collect fee/exec-unit statistics for batch-1 … batch-${MAX_BATCH}, re-run with
\`--mode bench --max-batch ${MAX_BATCH}\` (re-uses the same protocol state).
`;
}

const md = `\
# DIA Oracle — Fee Benchmark Report

| Field            | Value |
|------------------|-------|
${headerRows.join("\n")}

${probeLine ? probeLine + "\n" : ""}${cycleSections}

## Protocol Fee Design Options

> Two separate fee flows:
> - **Network fee** (measured in this benchmark when cycles run): paid by the DIA oracle wallet to the Cardano network for each submitted transaction.
> - **Protocol fee** (\`base_fee + N × per_pair_fee\`): charged by the DIA protocol to the client, deducted from the client's receiver and accumulated in the payment hook.

## Notes

- \`update-1\` — single oracle price update (1 pair: BTC/USD).
- \`batch-N\` — N simultaneous price updates in one transaction. Slugs are taken from \`BATCH_SLUGS\` in order.
- Probe mode walks batch sizes outwards from \`--probe-start\` and stops at the first batch that doesn't fit; the discovered max lives in \`discovered-max-batch.txt\`.
- Bench mode runs CYCLES iterations of \`update-1\` + \`batch-1..--max-batch\`.
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
if (RUN_PROBE) {
  console.log(`  ${path.join(evidenceRoot, "discovered-max-batch.txt")}`);
}
if (RUN_CYCLES && OPS.length > 0) {
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
} else if (RUN_PROBE) {
  console.log("");
  console.log(`  Probe result: max successful batch = batch-${MAX_BATCH}${
    PROBE_FAILED_AT ? ` (first failing: batch-${PROBE_FAILED_AT})` : ` (ceiling reached without failing)`
  }`);
}
NODE

echo ""
echo "[bench] completed: $BENCH_EVIDENCE"
