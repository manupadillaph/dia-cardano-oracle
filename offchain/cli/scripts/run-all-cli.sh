#!/usr/bin/env bash
set -euo pipefail


SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI_DIR="$REPO/offchain/cli"

CLEAN_PREVIOUS=false
FROM_STEP=1
EXPLICIT_RUN_ID="${RUN_ID:-}"

usage() {
  cat <<'EOF'
usage: run-all-cli.sh [--clean-previous=false|true] [--from-step N] [--run-id ID]

examples:
  run-all-cli.sh
  run-all-cli.sh --clean-previous=true
  run-all-cli.sh --from-step 11 --run-id 20260513-130106
EOF
}

normalize_bool() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes) printf 'true\n' ;;
    false|0|no) printf 'false\n' ;;
    *)
      echo "invalid boolean value: $1" >&2
      exit 1
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean-previous)
      [[ $# -ge 2 ]] || { echo "missing value for --clean-previous" >&2; exit 1; }
      CLEAN_PREVIOUS="$(normalize_bool "$2")"
      shift 2
      ;;
    --clean-previous=*)
      CLEAN_PREVIOUS="$(normalize_bool "${1#*=}")"
      shift
      ;;
    --from-step)
      [[ $# -ge 2 ]] || { echo "missing value for --from-step" >&2; exit 1; }
      FROM_STEP="$2"
      shift 2
      ;;
    --from-step=*)
      FROM_STEP="${1#*=}"
      shift
      ;;
    --run-id)
      [[ $# -ge 2 ]] || { echo "missing value for --run-id" >&2; exit 1; }
      EXPLICIT_RUN_ID="$2"
      shift 2
      ;;
    --run-id=*)
      EXPLICIT_RUN_ID="${1#*=}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$FROM_STEP" =~ ^[0-9]+$ ]] || (( FROM_STEP < 1 || FROM_STEP > 31 )); then
  echo "--from-step must be an integer between 1 and 31" >&2
  exit 1
fi

if (( FROM_STEP > 1 )); then
  CLEAN_PREVIOUS=false
  if [[ -z "$EXPLICIT_RUN_ID" ]]; then
    echo "--from-step requires --run-id" >&2
    exit 1
  fi
fi

RUN_ID="${EXPLICIT_RUN_ID:-$(date -u +%Y%m%d-%H%M%S)}"
STATE_NAME="preview_rerun_${RUN_ID}"
STATE_REL="./state/${STATE_NAME}"
STATE_ROOT="$CLI_DIR/state/${STATE_NAME}"
EVIDENCE_NAME="m1-preview-${RUN_ID}"
EVIDENCE_ROOT="$REPO/docs/milestones/evidence/${EVIDENCE_NAME}"
CARDANO_PROVIDER="${CARDANO_PROVIDER:-Blockfrost}"
POST_TX_DELAY_SECONDS="${POST_TX_DELAY_SECONDS:-15}"

declare -ar PROTECTED_STATE_DIRS=(
  "preview_20260504"
)
declare -ar PROTECTED_EVIDENCE_DIRS=(
  "m1-preview-20260427"
)

CLIENT_ID="client-a"
DOMAIN_NAME="DIA Oracle"
DOMAIN_VERSION="1.0"
DOMAIN_SOURCE_CHAIN_ID="100640"
DOMAIN_VERIFYING_CONTRACT="0xF8c614A483A0427A13512F52ac72A576678bE317"
BASE_FEE_LOVELACE="600000"
PER_PAIR_FEE_LOVELACE="400000"
MAX_BOOTSTRAP_DRIFT_SECONDS="300"
CONFIG_MIN_UTXO_LOVELACE="5000000"
CONFIG_ASSET_LABEL="DIA_CONFIG"
PAYMENT_HOOK_ASSET_LABEL="DIA_PAYMENT_HOOK"
RECEIVER_ASSET_LABEL="DIA_RECEIVER_CLIENT_A"
RECEIVER_TOP_UP_1_LOVELACE="30000000"
RECEIVER_TOP_UP_2_LOVELACE="30000000"
RECEIVER_WITHDRAW_LOVELACE="5000000"
PAYMENT_HOOK_WITHDRAW_LOVELACE="10000000"
INTENT_EXPIRY_SECONDS="3600"

declare -ar BOOTSTRAP_SLUGS=(
  "usdc-usd"
  "btc-usd"
  "eth-usd"
  "ada-usd"
  "usdt-usd"
  "dai-usd"
  "sol-usd"
  "bnb-usd"
  "xrp-usd"
  "matic-usd"
  "dot-usd"
)

declare -ar BATCH_SLUGS=(
  "btc-usd"
  "eth-usd"
  "ada-usd"
  "usdt-usd"
  "dai-usd"
  "sol-usd"
  "bnb-usd"
  "xrp-usd"
  "matic-usd"
  "dot-usd"
)

pair_symbol() {
  case "$1" in
    usdc-usd)  printf 'USDC/USD\n' ;;
    btc-usd)   printf 'BTC/USD\n' ;;
    eth-usd)   printf 'ETH/USD\n' ;;
    ada-usd)   printf 'ADA/USD\n' ;;
    usdt-usd)  printf 'USDT/USD\n' ;;
    dai-usd)   printf 'DAI/USD\n' ;;
    sol-usd)   printf 'SOL/USD\n' ;;
    bnb-usd)   printf 'BNB/USD\n' ;;
    xrp-usd)   printf 'XRP/USD\n' ;;
    matic-usd) printf 'MATIC/USD\n' ;;
    dot-usd)   printf 'DOT/USD\n' ;;
    *) echo "unknown pair slug: $1" >&2; exit 1 ;;
  esac
}

bootstrap_price() {
  case "$1" in
    usdc-usd)  printf '100045678\n' ;;
    btc-usd)   printf '6000000000000\n' ;;
    eth-usd)   printf '250000000000\n' ;;
    ada-usd)   printf '750000000\n' ;;
    usdt-usd)  printf '100001234\n' ;;
    dai-usd)   printf '100000345\n' ;;
    sol-usd)   printf '18500000000\n' ;;
    bnb-usd)   printf '61500000000\n' ;;
    xrp-usd)   printf '520000000\n' ;;
    matic-usd) printf '980000000\n' ;;
    dot-usd)   printf '420000000\n' ;;
    *) echo "unknown pair slug: $1" >&2; exit 1 ;;
  esac
}

batch_price() {
  case "$1" in
    btc-usd)   printf '6001000000000\n' ;;
    eth-usd)   printf '250100000000\n' ;;
    ada-usd)   printf '751000000\n' ;;
    usdt-usd)  printf '100101234\n' ;;
    dai-usd)   printf '100100345\n' ;;
    sol-usd)   printf '18510000000\n' ;;
    bnb-usd)   printf '61510000000\n' ;;
    xrp-usd)   printf '521000000\n' ;;
    matic-usd) printf '981000000\n' ;;
    dot-usd)   printf '421000000\n' ;;
    *) echo "unknown pair slug: $1" >&2; exit 1 ;;
  esac
}

mkdir -p "$CLI_DIR/state" "$REPO/docs/milestones/evidence"

cleanup_previous_runs() {
  local dir_name
  shopt -s nullglob

  for dir_path in "$CLI_DIR"/state/preview_rerun_*; do
    dir_name="$(basename "$dir_path")"
    case " ${PROTECTED_STATE_DIRS[*]} " in
      *" $dir_name "*) continue ;;
    esac
    rm -rf "$dir_path"
  done

  for dir_path in "$REPO"/docs/milestones/evidence/m1-preview-*; do
    dir_name="$(basename "$dir_path")"
    case " ${PROTECTED_EVIDENCE_DIRS[*]} " in
      *" $dir_name "*) continue ;;
    esac
    rm -rf "$dir_path"
  done

  shopt -u nullglob
}

if (( FROM_STEP == 1 )); then
  if [[ "$CLEAN_PREVIOUS" == "true" ]]; then
    cleanup_previous_runs
  fi
  rm -rf "$STATE_ROOT" "$EVIDENCE_ROOT"
else
  [[ -d "$STATE_ROOT" ]] || { echo "[rerun] state root not found: $STATE_ROOT" >&2; exit 1; }
  [[ -d "$EVIDENCE_ROOT" ]] || { echo "[rerun] evidence root not found: $EVIDENCE_ROOT" >&2; exit 1; }
fi

mkdir -p \
  "$STATE_ROOT/clients/${CLIENT_ID}/pairs" \
  "$STATE_ROOT/config-updates" \
  "$STATE_ROOT/intents" \
  "$STATE_ROOT/update-batches" \
  "$EVIDENCE_ROOT"

exec > >(tee -a "$EVIDENCE_ROOT/00-master.log") 2>&1

cd "$CLI_DIR"

set -a
source "$CLI_DIR/.env"
set +a

export CARDANO_PROVIDER

if [[ -z "${DIA_EVM_PRIVATE_KEY:-}" ]]; then
  echo "[rerun] DIA_EVM_PRIVATE_KEY is required for explicit non-interactive intent signing" >&2
  exit 1
fi

echo "[rerun] run id: $RUN_ID"
echo "[rerun] from step: $FROM_STEP"
echo "[rerun] clean previous: $CLEAN_PREVIOUS"
echo "[rerun] state root: $STATE_ROOT"
echo "[rerun] evidence root: $EVIDENCE_ROOT"
echo "[rerun] cardano provider: $CARDANO_PROVIDER"

should_run_step() {
  local step="$1"
  (( step >= FROM_STEP ))
}

run_cli_logged() {
  local log_name="$1"
  shift
  local cli_cmd="$*"
  echo "[rerun] $cli_cmd"
  script -q -e -c "npm run cli -- $cli_cmd" /dev/null | tee "$EVIDENCE_ROOT/$log_name"
}

append_cli_log() {
  local log_name="$1"
  shift
  local cli_cmd="$*"
  echo "[rerun] $cli_cmd" | tee -a "$EVIDENCE_ROOT/$log_name"
  script -q -e -c "npm run cli -- $cli_cmd" /dev/null | tee -a "$EVIDENCE_ROOT/$log_name"
}

run_tx_logged() {
  run_cli_logged "$@"
  if [[ "$POST_TX_DELAY_SECONDS" -gt 0 ]]; then
    sleep "$POST_TX_DELAY_SECONDS"
  fi
}

capture_cli_json() {
  local log_name="$1"
  shift
  npm run --silent cli -- "$@" | tee "$EVIDENCE_ROOT/$log_name"
}

read_json_field() {
  local json_path="$1"
  local expression="$2"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const filePath = process.argv[1];
    const expression = process.argv[2];
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    const value = expression.split(".").reduce((current, key) => current?.[key], data);
    if (value === undefined || value === null) {
      process.exit(1);
    }
    process.stdout.write(String(value));
  ' "$json_path" "$expression"
}

intent_path() {
  local slug="$1"
  local suffix="${2:-}"
  printf '%s\n' "$STATE_ROOT/intents/${slug}${suffix}.signed.json"
}

append_tx_log() {
  local log_name="$1"
  shift
  local cli_cmd="$*"
  echo "[rerun] $cli_cmd" | tee -a "$EVIDENCE_ROOT/$log_name"
  script -q -e -c "npm run cli -- $cli_cmd" /dev/null | tee -a "$EVIDENCE_ROOT/$log_name"
  if [[ "$POST_TX_DELAY_SECONDS" -gt 0 ]]; then
    sleep "$POST_TX_DELAY_SECONDS"
  fi
}

generate_signed_intent_now() {
  local log_name="$1"
  local slug="$2"
  local suffix="$3"
  local price="$4"
  local symbol
  symbol="$(pair_symbol "$slug")"

  append_cli_log "$log_name" \
    "preview:intent:create-and-sign --state $STATE_REL/config-bootstrap.json --intent-type OracleUpdate --symbol $symbol --price $price --source \"$DOMAIN_NAME\" --out $STATE_REL/intents/${slug}${suffix}.signed.json"
}

generate_batch_signed_intents_now() {
  local log_name="$1"
  local slug

  : > "$EVIDENCE_ROOT/$log_name"
  for slug in "${BATCH_SLUGS[@]}"; do
    generate_signed_intent_now "$log_name" "$slug" "-batch" "$(batch_price "$slug")"
  done
}

write_batch_manifest() {
  local size="$1"
  local manifest_path="$STATE_ROOT/update-batches/batch-${size}.manifest.json"
  {
    printf '{\n  "updates": [\n'
    local first=1
    local index
    for ((index = 0; index < size; index += 1)); do
      local slug="${BATCH_SLUGS[$index]}"
      if [[ "$first" -eq 0 ]]; then
        printf ',\n'
      fi
      first=0
      printf '    {\n'
      printf '      "statePath": "%s",\n' "$STATE_REL/clients/${CLIENT_ID}/pairs/${slug}.json"
      printf '      "intentPath": "%s"\n' "$STATE_REL/intents/${slug}-batch.signed.json"
      printf '    }'
    done
    printf '\n  ]\n}\n'
  } > "$manifest_path"
  echo "[rerun] wrote $(basename "$manifest_path") with ${size} updates" | tee -a "$EVIDENCE_ROOT/24a-generate-batch-manifests.log"
}

infer_success_batch_size() {
  local size
  for size in 10 9 8 7 6 5; do
    if [[ -s "$STATE_ROOT/update-batches/batch-${size}.result.json" ]]; then
      printf '%s\n' "$size"
      return 0
    fi
  done
  return 1
}

WALLET_DEFAULTS_JSON_PATH="$EVIDENCE_ROOT/00-wallet-defaults.json"
capture_cli_json "00-wallet-defaults.log" "preview:wallet:defaults" > "$WALLET_DEFAULTS_JSON_PATH"
CONFIG_SIGNER_PKH="$(read_json_field "$WALLET_DEFAULTS_JSON_PATH" "defaults.paymentKeyHash")"
PAYMENT_HOOK_WITHDRAW_ADDRESS="$(read_json_field "$WALLET_DEFAULTS_JSON_PATH" "address")"

AUTHORIZED_DIA_PUBLIC_KEY="$(
  node --input-type=module -e '
    import { SigningKey } from "ethers";
    const privateKey = process.env.DIA_EVM_PRIVATE_KEY?.trim();
    if (!privateKey) {
      throw new Error("Missing DIA_EVM_PRIVATE_KEY.");
    }
    process.stdout.write(
      new SigningKey(privateKey).compressedPublicKey.replace(/^0x/i, "").toLowerCase(),
    );
  '
)"

CLIENT_ID="$CLIENT_ID" \
CARDANO_PROVIDER="$CARDANO_PROVIDER" \
CONFIG_SIGNER_PKH="$CONFIG_SIGNER_PKH" \
AUTHORIZED_DIA_PUBLIC_KEY="$AUTHORIZED_DIA_PUBLIC_KEY" \
PAYMENT_HOOK_WITHDRAW_ADDRESS="$PAYMENT_HOOK_WITHDRAW_ADDRESS" \
DOMAIN_NAME="$DOMAIN_NAME" \
DOMAIN_VERSION="$DOMAIN_VERSION" \
DOMAIN_SOURCE_CHAIN_ID="$DOMAIN_SOURCE_CHAIN_ID" \
DOMAIN_VERIFYING_CONTRACT="$DOMAIN_VERIFYING_CONTRACT" \
BASE_FEE_LOVELACE="$BASE_FEE_LOVELACE" \
PER_PAIR_FEE_LOVELACE="$PER_PAIR_FEE_LOVELACE" \
MAX_BOOTSTRAP_DRIFT_SECONDS="$MAX_BOOTSTRAP_DRIFT_SECONDS" \
CONFIG_MIN_UTXO_LOVELACE="$CONFIG_MIN_UTXO_LOVELACE" \
CONFIG_ASSET_LABEL="$CONFIG_ASSET_LABEL" \
PAYMENT_HOOK_ASSET_LABEL="$PAYMENT_HOOK_ASSET_LABEL" \
RECEIVER_ASSET_LABEL="$RECEIVER_ASSET_LABEL" \
RECEIVER_TOP_UP_1_LOVELACE="$RECEIVER_TOP_UP_1_LOVELACE" \
RECEIVER_TOP_UP_2_LOVELACE="$RECEIVER_TOP_UP_2_LOVELACE" \
RECEIVER_WITHDRAW_LOVELACE="$RECEIVER_WITHDRAW_LOVELACE" \
PAYMENT_HOOK_WITHDRAW_LOVELACE="$PAYMENT_HOOK_WITHDRAW_LOVELACE" \
node --input-type=module <<'NODE' > "$EVIDENCE_ROOT/00-run-config.json"
const data = {
  clientId: process.env.CLIENT_ID,
  provider: process.env.CARDANO_PROVIDER,
  signer: {
    configSignerPkh: process.env.CONFIG_SIGNER_PKH,
    authorizedDiaPublicKey: process.env.AUTHORIZED_DIA_PUBLIC_KEY,
    paymentHookWithdrawAddress: process.env.PAYMENT_HOOK_WITHDRAW_ADDRESS,
  },
  protocol: {
    domainName: process.env.DOMAIN_NAME,
    domainVersion: process.env.DOMAIN_VERSION,
    domainSourceChainId: process.env.DOMAIN_SOURCE_CHAIN_ID,
    domainVerifyingContract: process.env.DOMAIN_VERIFYING_CONTRACT,
    baseFeeLovelace: process.env.BASE_FEE_LOVELACE,
    perPairFeeLovelace: process.env.PER_PAIR_FEE_LOVELACE,
    maxBootstrapDriftSeconds: process.env.MAX_BOOTSTRAP_DRIFT_SECONDS,
    configMinUtxoLovelace: process.env.CONFIG_MIN_UTXO_LOVELACE,
    configAssetLabel: process.env.CONFIG_ASSET_LABEL,
    paymentHookAssetLabel: process.env.PAYMENT_HOOK_ASSET_LABEL,
  },
  client: {
    receiverAssetLabel: process.env.RECEIVER_ASSET_LABEL,
  },
  transactionParams: {
    receiverTopUp1Lovelace: process.env.RECEIVER_TOP_UP_1_LOVELACE,
    receiverTopUp2Lovelace: process.env.RECEIVER_TOP_UP_2_LOVELACE,
    receiverWithdrawLovelace: process.env.RECEIVER_WITHDRAW_LOVELACE,
    paymentHookWithdrawLovelace: process.env.PAYMENT_HOOK_WITHDRAW_LOVELACE,
  },
};
process.stdout.write(JSON.stringify(data, null, 2) + "\n");
NODE

# Run contract and node tests first — always, on every full run and resume.
# Logs are saved to the evidence directory so failures are captured as evidence.
echo "[rerun] running contracts tests (aiken check)"
bash "$SCRIPT_DIR/run-contracts-tests.sh" --evidence-dir "$EVIDENCE_ROOT"
echo "[rerun] running node tests (npm test)"
bash "$SCRIPT_DIR/run-node-tests.sh" --evidence-dir "$EVIDENCE_ROOT"

# Capture initial wallet balance before any transaction. Only on a fresh full run;
# on --from-step resumes the file already exists from the original run.
if (( FROM_STEP == 1 )); then
  capture_cli_json "00b-wallet-initial.json" preview:wallet:utxos
fi

if should_run_step 1; then
  run_cli_logged "01-protocol-init.log" \
    "preview:protocol:init --valid-config-signers $CONFIG_SIGNER_PKH --authorized-dia-public-keys $AUTHORIZED_DIA_PUBLIC_KEY --domain-name \"$DOMAIN_NAME\" --domain-version $DOMAIN_VERSION --domain-source-chain-id $DOMAIN_SOURCE_CHAIN_ID --domain-verifying-contract $DOMAIN_VERIFYING_CONTRACT --base-fee-lovelace $BASE_FEE_LOVELACE --per-pair-fee-lovelace $PER_PAIR_FEE_LOVELACE --max-bootstrap-drift-seconds $MAX_BOOTSTRAP_DRIFT_SECONDS --min-utxo-lovelace $CONFIG_MIN_UTXO_LOVELACE --config-asset-label $CONFIG_ASSET_LABEL --payment-hook-asset-label $PAYMENT_HOOK_ASSET_LABEL --payment-hook-withdraw-address $PAYMENT_HOOK_WITHDRAW_ADDRESS --out $STATE_REL/config-bootstrap.json"
fi

if should_run_step 2; then
  run_cli_logged "02-config-parameterize.log" \
    "preview:config:parameterize --state $STATE_REL/config-bootstrap.json"
fi
if should_run_step 3; then
  run_tx_logged "03-config-bootstrap.log" \
    "preview:config:bootstrap --state $STATE_REL/config-bootstrap.json"
fi
if should_run_step 4; then
  run_tx_logged "04-config-reference-scripts.log" \
    "preview:config:reference-scripts --state $STATE_REL/config-bootstrap.json"
fi

if should_run_step 5; then
  run_cli_logged "05-payment-hook-parameterize.log" \
    "preview:payment-hook:parameterize --state $STATE_REL/config-bootstrap.json"
fi
if should_run_step 6; then
  run_tx_logged "06-payment-hook-bootstrap.log" \
    "preview:payment-hook:bootstrap --state $STATE_REL/config-bootstrap.json"
fi
if should_run_step 7; then
  run_tx_logged "07-payment-hook-reference-script.log" \
    "preview:payment-hook:reference-script --state $STATE_REL/config-bootstrap.json"
fi

if should_run_step 8; then
  run_cli_logged "08-client-init.log" \
    "preview:client:init --state $STATE_REL/config-bootstrap.json --client-id $CLIENT_ID --receiver-asset-label $RECEIVER_ASSET_LABEL --out $STATE_REL/clients/${CLIENT_ID}.json"
fi

if should_run_step 9; then
  run_cli_logged "09-receiver-parameterize.log" \
    "preview:receiver:parameterize --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/${CLIENT_ID}.json"
fi
if should_run_step 10; then
  run_tx_logged "10-receiver-bootstrap.log" \
    "preview:receiver:bootstrap --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/${CLIENT_ID}.json"
fi
if should_run_step 11; then
  run_tx_logged "11-client-reference-scripts.log" \
    "preview:reference-scripts:publish-client --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/${CLIENT_ID}.json"
fi

if should_run_step 12; then
  run_tx_logged "12-receiver-top-up.log" \
    "preview:receiver:top-up --amount-lovelace $RECEIVER_TOP_UP_1_LOVELACE --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/${CLIENT_ID}.json"
fi

if should_run_step 13; then
  generate_signed_intent_now "13a-generate-usdc-usd-intent.log" "usdc-usd" "" "$(bootstrap_price "usdc-usd")"
  run_tx_logged "13-update-usdc-bootstrap.log" \
    "preview:update --intent $STATE_REL/intents/usdc-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/usdc-usd.json"
fi
if should_run_step 14; then
  generate_signed_intent_now "14a-generate-btc-usd-intent.log" "btc-usd" "" "$(bootstrap_price "btc-usd")"
  run_tx_logged "14-bootstrap-btc-usd.log" \
    "preview:update --intent $STATE_REL/intents/btc-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/btc-usd.json"
fi
if should_run_step 15; then
  generate_signed_intent_now "15a-generate-eth-usd-intent.log" "eth-usd" "" "$(bootstrap_price "eth-usd")"
  run_tx_logged "15-bootstrap-eth-usd.log" \
    "preview:update --intent $STATE_REL/intents/eth-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/eth-usd.json"
fi
if should_run_step 16; then
  generate_signed_intent_now "16a-generate-ada-usd-intent.log" "ada-usd" "" "$(bootstrap_price "ada-usd")"
  run_tx_logged "16-bootstrap-ada-usd.log" \
    "preview:update --intent $STATE_REL/intents/ada-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/ada-usd.json"
fi
if should_run_step 17; then
  generate_signed_intent_now "17a-generate-usdt-usd-intent.log" "usdt-usd" "" "$(bootstrap_price "usdt-usd")"
  run_tx_logged "17-bootstrap-usdt-usd.log" \
    "preview:update --intent $STATE_REL/intents/usdt-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/usdt-usd.json"
fi
if should_run_step 18; then
  generate_signed_intent_now "18a-generate-dai-usd-intent.log" "dai-usd" "" "$(bootstrap_price "dai-usd")"
  run_tx_logged "18-bootstrap-dai-usd.log" \
    "preview:update --intent $STATE_REL/intents/dai-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/dai-usd.json"
fi
if should_run_step 19; then
  generate_signed_intent_now "19a-generate-sol-usd-intent.log" "sol-usd" "" "$(bootstrap_price "sol-usd")"
  run_tx_logged "19-bootstrap-sol-usd.log" \
    "preview:update --intent $STATE_REL/intents/sol-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/sol-usd.json"
fi
if should_run_step 20; then
  generate_signed_intent_now "20a-generate-bnb-usd-intent.log" "bnb-usd" "" "$(bootstrap_price "bnb-usd")"
  run_tx_logged "20-bootstrap-bnb-usd.log" \
    "preview:update --intent $STATE_REL/intents/bnb-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/bnb-usd.json"
fi
if should_run_step 21; then
  generate_signed_intent_now "21a-generate-xrp-usd-intent.log" "xrp-usd" "" "$(bootstrap_price "xrp-usd")"
  run_tx_logged "21-bootstrap-xrp-usd.log" \
    "preview:update --intent $STATE_REL/intents/xrp-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/xrp-usd.json"
fi
if should_run_step 22; then
  generate_signed_intent_now "22a-generate-matic-usd-intent.log" "matic-usd" "" "$(bootstrap_price "matic-usd")"
  run_tx_logged "22-bootstrap-matic-usd.log" \
    "preview:update --intent $STATE_REL/intents/matic-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/matic-usd.json"
fi
if should_run_step 23; then
  generate_signed_intent_now "23a-generate-dot-usd-intent.log" "dot-usd" "" "$(bootstrap_price "dot-usd")"
  run_tx_logged "23-bootstrap-dot-usd.log" \
    "preview:update --intent $STATE_REL/intents/dot-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/dot-usd.json"
fi

if should_run_step 24; then
  run_tx_logged "24-receiver-top-up-2.log" \
    "preview:receiver:top-up --amount-lovelace $RECEIVER_TOP_UP_2_LOVELACE --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/${CLIENT_ID}.json"
fi

if should_run_step 25; then
  generate_batch_signed_intents_now "24b-generate-batch-intents.log"
  : > "$EVIDENCE_ROOT/24a-generate-batch-manifests.log"
  for size in 10 9 8 7 6 5; do
    write_batch_manifest "$size"
  done

  SUCCESS_BATCH_SIZE=""
  for size in 10 9 8 7 6; do
    log_name="25-update-batch-${size}.log"
    result_root="$STATE_ROOT/update-batches/batch-${size}.result.json"
    rm -f "$result_root"
    if run_tx_logged "$log_name" \
      "preview:update:batch --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --manifest $STATE_REL/update-batches/batch-${size}.manifest.json --out $STATE_REL/update-batches/batch-${size}.result.json"; then
      if [[ -s "$result_root" ]]; then
        SUCCESS_BATCH_SIZE="$size"
        break
      fi
      echo "[rerun] batch-$size did not produce a result artifact; treating it as a failed attempt" | tee -a "$EVIDENCE_ROOT/$log_name"
    fi
  done

  if [[ -z "$SUCCESS_BATCH_SIZE" ]]; then
    result_root="$STATE_ROOT/update-batches/batch-5.result.json"
    rm -f "$result_root"
    run_tx_logged "25-update-batch-5.log" \
      "preview:update:batch --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --manifest $STATE_REL/update-batches/batch-5.manifest.json --out $STATE_REL/update-batches/batch-5.result.json"
    if [[ ! -s "$result_root" ]]; then
      echo "[rerun] batch-5 did not produce a result artifact; aborting rerun" | tee -a "$EVIDENCE_ROOT/25-update-batch-5.log"
      exit 1
    fi
    SUCCESS_BATCH_SIZE="5"
  fi

  printf '%s\n' "$SUCCESS_BATCH_SIZE" > "$EVIDENCE_ROOT/batch-success-size.txt"
else
  SUCCESS_BATCH_SIZE="$(
    if [[ -f "$EVIDENCE_ROOT/batch-success-size.txt" ]]; then
      cat "$EVIDENCE_ROOT/batch-success-size.txt"
    else
      infer_success_batch_size
    fi
  )"
fi

if should_run_step 26; then
  run_tx_logged "26-settle.log" \
    "preview:settle --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json"
fi
if should_run_step 27; then
  run_tx_logged "27-receiver-withdraw.log" \
    "preview:receiver:withdraw --amount-lovelace $RECEIVER_WITHDRAW_LOVELACE --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/${CLIENT_ID}.json"
fi
if should_run_step 28; then
  run_tx_logged "28-payment-hook-withdraw.log" \
    "preview:payment-hook:withdraw --amount-lovelace $PAYMENT_HOOK_WITHDRAW_LOVELACE --state $STATE_REL/config-bootstrap.json"
fi

if should_run_step 29; then
  run_tx_logged "29-reclaim-payment-hook-reference-script.log" \
    "preview:reclaim-reference-script --script payment-hook --state $STATE_REL/config-bootstrap.json"
fi
if should_run_step 30; then
  run_tx_logged "30-republish-payment-hook-reference-script.log" \
    "preview:payment-hook:reference-script --state $STATE_REL/config-bootstrap.json"
fi

# Step 31: admin-gated burn of one Pair NFT. Pairs DOT/USD on purpose because
# it's the last pair created during bootstrap, so retiring it does not disrupt
# the runbook's primary example (USDC/USD / BTC/USD). The single tx fires:
#   - pair_state.spend.BurnPair   (consumes the Pair UTxO, no continuation)
#   - pair_state.mint.BurnPairs   (burns the matching Pair NFT, qty -1)
# Both validators require a config_admins signature; the bench wallet is the
# admin, so the tx is fully gated by the same key that ran every other step.
BURN_PAIR_SLUG="dot-usd"
if should_run_step 31; then
  run_tx_logged "31-pair-burn-${BURN_PAIR_SLUG}.log" \
    "preview:pair:burn --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/${BURN_PAIR_SLUG}.json"
fi

STATE_ROOT="$STATE_ROOT" EVIDENCE_ROOT="$EVIDENCE_ROOT" SUCCESS_BATCH_SIZE="$SUCCESS_BATCH_SIZE" CLIENT_ID="$CLIENT_ID" BURN_PAIR_SLUG="$BURN_PAIR_SLUG" node --input-type=module <<'NODE' > "$EVIDENCE_ROOT/30-summary-build.log" 2>&1
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const stateRoot = process.env.STATE_ROOT;
const evidenceRoot = process.env.EVIDENCE_ROOT;
const successBatchSize = process.env.SUCCESS_BATCH_SIZE;
const clientId = process.env.CLIENT_ID;
const burnPairSlug = process.env.BURN_PAIR_SLUG ?? "";
if (!stateRoot || !evidenceRoot || !successBatchSize || !clientId) {
  throw new Error("Missing summary build environment variables.");
}

const protocol = JSON.parse(await readFile(path.join(stateRoot, "config-bootstrap.json"), "utf8"));
const client = JSON.parse(await readFile(path.join(stateRoot, "clients", `${clientId}.json`), "utf8"));
const pairsDir = path.join(stateRoot, "clients", clientId, "pairs");
const pairFiles = (await readdir(pairsDir)).filter((name) => name.endsWith(".json")).sort();
const pairs = {};
// Pair burn keeps `pairState` populated for audit (only `datum.pairCbor` is
// cleared by pair-burn.ts), so we detect a burn by looking for a
// `preview:pair:burn` entry in the pair's transactions log. Downstream math
// (locked-ADA totals, evidence markdown) MUST exclude burned pairs.
let burnedCount = 0;
for (const fileName of pairFiles) {
  const pair = JSON.parse(await readFile(path.join(pairsDir, fileName), "utf8"));
  const txs = pair.transactions ?? [];
  const burnRec = txs.find((t) => t && t.step === "preview:pair:burn");
  if (burnRec) {
    burnedCount += 1;
    pair.burned = true;
    pair.burnTxHash = burnRec.submittedTxHash ?? null;
  }
  pairs[fileName] = pair;
}

const summary = {
  generatedAt: new Date().toISOString(),
  stateRoot,
  successBatchSize: Number(successBatchSize),
  burnPairSlug: burnPairSlug || null,
  burnedPairCount: burnedCount,
  protocolTransactions: protocol.transactions ?? [],
  clientTransactions: client.transactions ?? [],
  scripts: protocol.scripts,
  configState: protocol.configState,
  paymentHookState: protocol.paymentHookState,
  receiver: client.receiver ?? null,
  referenceScripts: {
    protocol: protocol.referenceScripts ?? null,
    client: client.referenceScripts ?? null,
  },
  pairs,
};

await writeFile(
  path.join(evidenceRoot, "SUMMARY.json"),
  JSON.stringify(summary, null, 2) + "\n",
  "utf8",
);
console.log(`wrote SUMMARY.json with ${pairFiles.length} pair states (${burnedCount} burned)`);
NODE

# Capture final wallet balance after all transactions
capture_cli_json "30a-wallet-final.json" preview:wallet:utxos

# Generate the full evidence markdown from all collected data
STATE_ROOT="$STATE_ROOT" EVIDENCE_ROOT="$EVIDENCE_ROOT" SUCCESS_BATCH_SIZE="$SUCCESS_BATCH_SIZE" CLIENT_ID="$CLIENT_ID" RUN_ID="$RUN_ID" EVIDENCE_NAME="$EVIDENCE_NAME" BURN_PAIR_SLUG="$BURN_PAIR_SLUG" node --input-type=module <<'NODE' > "$EVIDENCE_ROOT/30-evidence-build.log" 2>&1
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const stateRoot   = process.env.STATE_ROOT;
const evidenceRoot = process.env.EVIDENCE_ROOT;
const successBatchSize = Number(process.env.SUCCESS_BATCH_SIZE);
const clientId    = process.env.CLIENT_ID;
const runId       = process.env.RUN_ID;
const evidenceName = process.env.EVIDENCE_NAME;
const burnPairSlug = process.env.BURN_PAIR_SLUG ?? "";
if (!stateRoot || !evidenceRoot || !clientId || !runId || !evidenceName) {
  throw new Error("Missing evidence build environment variables.");
}
const burnSymbolLabel = burnPairSlug
  ? burnPairSlug.toUpperCase().replace(/-/g, "/")
  : "";

// ── helpers ────────────────────────────────────────────────────────────────

function lovelaceToAda(lovelace) {
  const l = BigInt(lovelace);
  const whole = l / 1_000_000n;
  const frac  = (l % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

async function readLogSafe(name) {
  try { return await readFile(path.join(evidenceRoot, name), "utf8"); }
  catch { return ""; }
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// Extract LAST fee=X ADA (lovelace) from a log (some logs have multiple build attempts)
function extractFeeLovelace(content) {
  const matches = [...content.matchAll(/fee=([\d.]+) ADA \((\d+) lovelace\)/g)];
  if (!matches.length) return null;
  return BigInt(matches[matches.length - 1][2]);
}

function extractFeeAda(content) {
  const matches = [...content.matchAll(/fee=([\d.]+) ADA/g)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1];
}

function extractTxHash(content) {
  const m = content.match(/Submitted transaction hash: ([a-f0-9]{64})/);
  return m ? m[1] : null;
}

// Parse the `execution went over budget Mem <signed> CPU <signed>` line
// produced by the node when a tx fails before submission. Returns the
// signed Mem and CPU deltas so callers can identify the binding dimension.
function extractOverBudget(content) {
  const m = content.match(/over budget Mem (-?\d+) CPU (-?\d+)/);
  if (!m) return null;
  return { mem: Number(m[1]), cpu: Number(m[2]) };
}

function extractMinLovelaceValues(content, ...keys) {
  const result = {};
  for (const key of keys) {
    const m = content.match(new RegExp(`${key}=(\\d+)`));
    result[key] = m ? BigInt(m[1]) : 0n;
  }
  return result;
}

// ── load state artifacts ───────────────────────────────────────────────────

const protocol = JSON.parse(await readFile(path.join(stateRoot, "config-bootstrap.json"), "utf8"));
const client   = JSON.parse(await readFile(path.join(stateRoot, "clients", `${clientId}.json`), "utf8"));

const pairsDir  = path.join(stateRoot, "clients", clientId, "pairs");
const pairFiles = (await readdir(pairsDir)).filter((n) => n.endsWith(".json")).sort();
const pairs = {};
for (const f of pairFiles) {
  pairs[f] = JSON.parse(await readFile(path.join(pairsDir, f), "utf8"));
}

const summary = JSON.parse(await readFile(path.join(evidenceRoot, "SUMMARY.json"), "utf8"));

// ── load wallet balances ───────────────────────────────────────────────────

const walletInitialRaw = await readLogSafe("00b-wallet-initial.json");
const walletFinalRaw   = await readLogSafe("30a-wallet-final.json");

function sumUtxoLovelace(walletJson) {
  try {
    const data = JSON.parse(walletJson);
    return data.utxos.reduce((s, u) => s + BigInt(u.lovelace), 0n);
  } catch { return null; }
}

const initialLovelace = sumUtxoLovelace(walletInitialRaw);
const finalLovelace   = sumUtxoLovelace(walletFinalRaw);
const walletAddress   = (() => { try { return JSON.parse(walletInitialRaw).address; } catch { return ""; } })();

// ── load log files and extract fees ───────────────────────────────────────

const STEPS = [
  { log: "03-config-bootstrap.log",                     label: "`preview:config:bootstrap`",                          tx: true },
  { log: "04-config-reference-scripts.log",             label: "`preview:config:reference-scripts` (Config+Coordinator)", tx: true },
  { log: "06-payment-hook-bootstrap.log",               label: "`preview:payment-hook:bootstrap`",                    tx: true },
  { log: "07-payment-hook-reference-script.log",        label: "`preview:payment-hook:reference-script`",             tx: true },
  { log: "10-receiver-bootstrap.log",                   label: "`preview:receiver:bootstrap`",                        tx: true },
  { log: "11-client-reference-scripts.log",             label: "`preview:reference-scripts:publish-client` (Receiver+Pair+PairMint)", tx: true },
  { log: "12-receiver-top-up.log",                      label: "`preview:receiver:top-up` (top-up 1)",                tx: true },
  { log: "13-update-usdc-bootstrap.log",                label: "`preview:update` — USDC/USD create",                  tx: true },
  { log: "14-bootstrap-btc-usd.log",                    label: "`preview:update` — BTC/USD create",                   tx: true },
  { log: "15-bootstrap-eth-usd.log",                    label: "`preview:update` — ETH/USD create",                   tx: true },
  { log: "16-bootstrap-ada-usd.log",                    label: "`preview:update` — ADA/USD create",                   tx: true },
  { log: "17-bootstrap-usdt-usd.log",                   label: "`preview:update` — USDT/USD create",                  tx: true },
  { log: "18-bootstrap-dai-usd.log",                    label: "`preview:update` — DAI/USD create",                   tx: true },
  { log: "19-bootstrap-sol-usd.log",                    label: "`preview:update` — SOL/USD create",                   tx: true },
  { log: "20-bootstrap-bnb-usd.log",                    label: "`preview:update` — BNB/USD create",                   tx: true },
  { log: "21-bootstrap-xrp-usd.log",                    label: "`preview:update` — XRP/USD create",                   tx: true },
  { log: "22-bootstrap-matic-usd.log",                  label: "`preview:update` — MATIC/USD create",                 tx: true },
  { log: "23-bootstrap-dot-usd.log",                    label: "`preview:update` — DOT/USD create",                   tx: true },
  { log: "24-receiver-top-up-2.log",                    label: "`preview:receiver:top-up` (top-up 2)",                tx: true },
  { log: `25-update-batch-${successBatchSize}.log`,     label: `\`preview:update:batch\` (${successBatchSize} pairs)`, tx: true },
  { log: "26-settle.log",                               label: "`preview:settle`",                                    tx: true },
  { log: "27-receiver-withdraw.log",                    label: "`preview:receiver:withdraw`",                         tx: true },
  { log: "28-payment-hook-withdraw.log",                label: "`preview:payment-hook:withdraw`",                     tx: true },
  { log: "29-reclaim-payment-hook-reference-script.log",label: "`preview:reclaim-reference-script --script payment-hook`", tx: true },
  { log: "30-republish-payment-hook-reference-script.log",label: "`preview:payment-hook:reference-script` (republish)", tx: true },
  ...(burnPairSlug
    ? [{
        log:   `31-pair-burn-${burnPairSlug}.log`,
        label: `\`preview:pair:burn\` — ${burnSymbolLabel} burn (admin-gated)`,
        tx:    true,
      }]
    : []),
];

// Batch attempts that were not submitted
const BATCH_ATTEMPT_SIZES = [10, 9, 8, 7, 6, 5];
const batchAttempts = [];
for (const sz of BATCH_ATTEMPT_SIZES) {
  if (sz === successBatchSize) break;
  batchAttempts.push(sz);
}

const stepData = [];
let totalFeesLovelace = 0n;
for (const s of STEPS) {
  const content = await readLogSafe(s.log);
  const feeLovelace = extractFeeLovelace(content);
  const feeAda      = extractFeeAda(content);
  const txHash      = extractTxHash(content);
  if (feeLovelace) totalFeesLovelace += feeLovelace;
  stepData.push({ ...s, content, feeLovelace, feeAda, txHash });
}

// ── reference-script min-UTxO breakdown ───────────────────────────────────

const log04 = await readLogSafe("04-config-reference-scripts.log");
const log07 = await readLogSafe("07-payment-hook-reference-script.log");
const log11 = await readLogSafe("11-client-reference-scripts.log");
const log30 = await readLogSafe("30-republish-payment-hook-reference-script.log");

const { configValidator: configRefMin, coordinatorValidator: coordinatorRefMin } =
  extractMinLovelaceValues(log04, "configValidator", "coordinatorValidator");
const { paymentHookValidator: hookRefMin } =
  extractMinLovelaceValues(
    log30 || log07, // prefer republished value if available
    "paymentHookValidator",
  );
const { receiverValidator: receiverRefMin, pairValidator: pairRefMin, pairMintPolicy: pairMintRefMin } =
  extractMinLovelaceValues(log11, "receiverValidator", "pairValidator", "pairMintPolicy");

const totalRefScriptLockedLovelace =
  configRefMin + coordinatorRefMin + hookRefMin + receiverRefMin + pairRefMin + pairMintRefMin;

// ── state UTxO locked ADA ─────────────────────────────────────────────────

const configLockedLovelace = BigInt(protocol.configState?.minUtxoLovelace ?? 0);
const hookState = protocol.paymentHookState;
const hookLockedLovelace = hookState
  ? BigInt(hookState.minUtxoLovelace ?? 0) + BigInt(hookState.accruedFeesLovelace ?? 0)
  : 0n;
const receiverState = client.receiver?.receiverState;
const receiverLockedLovelace = receiverState
  ? BigInt(receiverState.minUtxoLovelace ?? 0) +
    BigInt(receiverState.balanceLovelace ?? 0) +
    BigInt(receiverState.accruedToHookLovelace ?? 0)
  : 0n;
// Burned pairs no longer lock min-ADA on-chain even though their state file
// keeps `pairState` populated for audit (pair-burn.ts clears `datum.pairCbor`
// only). Skip them so the reconciliation initial = final + fees + locked stays
// accurate. Detection mirrors the SUMMARY.json builder above.
const isPairBurned = (p) =>
  (p?.transactions ?? []).some((t) => t && t.step === "preview:pair:burn");
const burnedPairCount = Object.values(pairs).filter(isPairBurned).length;
const livePairCount   = Object.values(pairs).length - burnedPairCount;
const pairLockedLovelace = Object.values(pairs).reduce(
  (s, p) => (isPairBurned(p) ? s : s + BigInt(p.pairState?.minUtxoLovelace ?? 0)),
  0n,
);
const totalStateLockedLovelace =
  configLockedLovelace + hookLockedLovelace + receiverLockedLovelace + pairLockedLovelace;

const totalLockedLovelace = totalRefScriptLockedLovelace + totalStateLockedLovelace;

// Net check: initial = final + fees + locked (approx — small rounding from other wallet UTxOs)
const netLockedCheck = initialLovelace != null && finalLovelace != null
  ? initialLovelace - finalLovelace - totalFeesLovelace
  : null;

// ── build tx table rows ───────────────────────────────────────────────────

function cexLink(hash) {
  return `https://preview.cexplorer.io/tx/${hash}`;
}

function txRow(label, txHash, feeAda, logFile) {
  const hashCell = txHash ? `\`${txHash}\`` : "*(local step)*";
  const feeCell  = feeAda  ? `${feeAda} ADA` : "—";
  const logCell  = `[\`${logFile}\`](./${logFile})`;
  return `| ${label} | ${hashCell} | ${feeCell} | ${logCell} |`;
}

// ── build pair price table ────────────────────────────────────────────────

const PAIR_SYMBOL = {
  "usdc-usd.json": "USDC/USD", "btc-usd.json": "BTC/USD", "eth-usd.json": "ETH/USD",
  "ada-usd.json":  "ADA/USD",  "usdt-usd.json": "USDT/USD", "dai-usd.json": "DAI/USD",
  "sol-usd.json":  "SOL/USD",  "bnb-usd.json": "BNB/USD",  "xrp-usd.json": "XRP/USD",
  "matic-usd.json": "MATIC/USD", "dot-usd.json": "DOT/USD",
};

// Determine which pairs were batch-updated
const batchLog = await readLogSafe(`25-update-batch-${successBatchSize}.log`);
const batchTxHash = extractTxHash(batchLog);

// ── assemble markdown ─────────────────────────────────────────────────────

const verificationDate = runId.slice(0, 10).replace(/-/g, "-"); // YYYY-MM-DD

const allTxRows = stepData
  .filter((s) => s.txHash || (s.feeAda && s.tx))
  .map((s) => txRow(s.label, s.txHash, s.feeAda, s.log));

// Fee table rows
const feeTableRows = stepData
  .filter((s) => s.feeLovelace && s.feeLovelace > 0n)
  .map((s) => `| ${s.label} | ${s.txHash ? `\`${s.txHash.slice(0, 16)}…\`` : "—"} | ${s.feeAda} ADA |`);

// Batch attempt rows — annotate each with the actual over-budget dimension
// reported by the node (Mem or CPU) so the narrative matches the logs.
const batchAttemptReasons = await Promise.all(
  batchAttempts.map(async (sz) => {
    const logName = `25-update-batch-${sz}.log`;
    const content = await readLogSafe(logName);
    const over = extractOverBudget(content);
    return { sz, logName, over };
  }),
);
function reasonLabel(over) {
  if (!over) return "execution budget exceeded — not submitted";
  if (over.mem < 0 && over.cpu >= 0) return `memory budget exceeded — Mem ${over.mem} — not submitted`;
  if (over.cpu < 0 && over.mem >= 0) return `CPU budget exceeded — CPU ${over.cpu} — not submitted`;
  return `execution budget exceeded — Mem ${over.mem} CPU ${over.cpu} — not submitted`;
}
const batchAttemptRows = batchAttemptReasons.map(({ sz, logName, over }) =>
  `| \`preview:update:batch\` (${sz} pairs, attempted) | *(${reasonLabel(over)})* | 0 ADA | [\`${logName}\`](./${logName}) |`,
);

// Decide the binding dimension for the narrative based on the captured
// over-budget reasons. If every failure was memory-bound, say so explicitly.
function deriveBindingDimension(reasons) {
  if (reasons.length === 0) return null;
  const dims = reasons.map(({ over }) => {
    if (!over) return "unknown";
    if (over.mem < 0 && over.cpu >= 0) return "memory";
    if (over.cpu < 0 && over.mem >= 0) return "cpu";
    return "both";
  });
  if (dims.every((d) => d === "memory")) return "memory";
  if (dims.every((d) => d === "cpu")) return "cpu";
  return "mixed";
}
const bindingDimension = deriveBindingDimension(batchAttemptReasons);
function batchNarrative(reasons, successSize, binding) {
  if (reasons.length === 0) return `Batch size **${successSize}** succeeded.`;
  const sizes = reasons.map((r) => r.sz).join(", ");
  let preface;
  if (binding === "memory") {
    preface =
      `Batch sizes ${sizes} were attempted first but exceeded the per-tx Plutus ` +
      `**memory** budget; the node reported \`execution went over budget Mem\` ` +
      `with negative memory deltas while CPU stayed within budget, so memory — ` +
      `not CPU steps — is the binding constraint on this bytecode.`;
  } else if (binding === "cpu") {
    preface =
      `Batch sizes ${sizes} were attempted first but exceeded the per-tx Plutus ` +
      `**CPU** budget; the node reported \`execution went over budget CPU\` ` +
      `with negative CPU deltas while memory stayed within budget.`;
  } else {
    preface =
      `Batch sizes ${sizes} were attempted first but exceeded the per-tx Plutus ` +
      `execution budget.`;
  }
  return `${preface} Batch size **${successSize}** succeeded.`;
}

// Explorer rows for key txs
const explorerSteps = [
  { label: "Config bootstrap",                step: stepData.find(s => s.log === "03-config-bootstrap.log") },
  { label: "PaymentHook bootstrap",           step: stepData.find(s => s.log === "06-payment-hook-bootstrap.log") },
  { label: "Receiver bootstrap (`client-a`)", step: stepData.find(s => s.log === "10-receiver-bootstrap.log") },
  { label: "Publish client reference scripts (Receiver+Pair+PairMint)", step: stepData.find(s => s.log === "11-client-reference-scripts.log") },
  { label: "First single-pair update (USDC/USD)", step: stepData.find(s => s.log === "13-update-usdc-bootstrap.log") },
  { label: `Batch update (${successBatchSize} pairs)`, step: stepData.find(s => s.log === `25-update-batch-${successBatchSize}.log`) },
  { label: "**Settle**",                       step: stepData.find(s => s.log === "26-settle.log") },
  { label: "Receiver withdraw",                step: stepData.find(s => s.log === "27-receiver-withdraw.log") },
  { label: "PaymentHook withdraw",             step: stepData.find(s => s.log === "28-payment-hook-withdraw.log") },
  { label: "Reclaim payment-hook ref script",  step: stepData.find(s => s.log === "29-reclaim-payment-hook-reference-script.log") },
  { label: "Republish payment-hook ref script",step: stepData.find(s => s.log === "30-republish-payment-hook-reference-script.log") },
];
const explorerRows = explorerSteps
  .filter(({ step }) => step?.txHash)
  .map(({ label, step }) =>
    `| ${label} | \`${step.txHash}\` | [CExplorer](${cexLink(step.txHash)}) |`
  );

const md = `# Milestone 1 Preview Evidence

Source of truth: [\`final-cardano-milestones.md\`](../../final-cardano-milestones.md).

Scope: Milestone 1 validation on Cardano Preview. Cardano mainnet deployment and final mainnet evidence are not included here.

Verification date: **${verificationDate}** (chain walk + local tooling, current bytecode).

Network: Cardano Preview.

Evidence pack location: [\`docs/milestones/evidence/${evidenceName}/\`](./) — captured logs for every CLI step plus \`SUMMARY.json\` with the final on-chain state.

## Official Milestone 1 Outputs

| Official output | Repository status |
| --- | --- |
| Aiken oracle smart contract ported to Cardano UTxO model | Complete |
| Compiled contract | Complete: \`contracts/aiken/plutus.json\` |
| Unit/integration test coverage | \`aiken check\` — unit tests passed; \`offchain/cli\` \`npm run test\` + typecheck + build green. End-to-end Preview chain walk captured below. |
| Deployment scripts | Complete: \`offchain/cli\` runbook and CLI commands |
| Documentation for Cardano developers | Complete in repository: root README, Aiken README, CLI runbook, architecture document |
| Verified Cardano mainnet deployment and execution hashes | Pending (mainnet not executed yet — separate gate) |

## Preview transactions executed end-to-end

All transactions below were submitted on Cardano Preview and confirmed. The chain walk demonstrates every Milestone 1 protocol surface including **Settle**, **reclaim**, and **republish** of a reference-script UTxO.

The integration exercises **eleven price pairs** (\`USDC/USD\`, \`BTC/USD\`, \`ETH/USD\`, \`ADA/USD\`, \`USDT/USD\`, \`DAI/USD\`, \`SOL/USD\`, \`BNB/USD\`, \`XRP/USD\`, \`MATIC/USD\`, \`DOT/USD\`). All eleven are bootstrapped via individual \`preview:update\` transactions. A subsequent batch transaction updates the first ${successBatchSize} non-USDC pairs in one \`preview:update:batch\` call.

### Protocol bootstrap (one-time)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 1 | \`preview:protocol:init\` | *(local artifact)* | — | [\`01-protocol-init.log\`](./01-protocol-init.log) |
| 2 | \`preview:config:parameterize\` | *(local artifact)* | — | [\`02-config-parameterize.log\`](./02-config-parameterize.log) |
${stepData.filter(s => ["03-config-bootstrap.log","04-config-reference-scripts.log"].includes(s.log)).map((s,i) => txRow(`${i+3} | ` + s.label, s.txHash, s.feeAda, s.log)).join("\n")}
| 5 | \`preview:payment-hook:parameterize\` | *(local artifact)* | — | [\`05-payment-hook-parameterize.log\`](./05-payment-hook-parameterize.log) |
${stepData.filter(s => ["06-payment-hook-bootstrap.log","07-payment-hook-reference-script.log"].includes(s.log)).map((s,i) => txRow(`${i+6} | ` + s.label, s.txHash, s.feeAda, s.log)).join("\n")}

### Client onboarding (\`${clientId}\`)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 8 | \`preview:client:init\` | *(local artifact)* | — | [\`08-client-init.log\`](./08-client-init.log) |
| 9 | \`preview:receiver:parameterize\` | *(local artifact)* | — | [\`09-receiver-parameterize.log\`](./09-receiver-parameterize.log) |
${stepData.filter(s => ["10-receiver-bootstrap.log","11-client-reference-scripts.log","12-receiver-top-up.log"].includes(s.log)).map((s,i) => txRow(`${i+10} | ` + s.label, s.txHash, s.feeAda, s.log)).join("\n")}

### Single-pair pair-create updates — 11 pairs via \`preview:update\`

| Step | Pair | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
${[
  {n:13,slug:"usdc-usd",log:"13-update-usdc-bootstrap.log"},
  {n:14,slug:"btc-usd",log:"14-bootstrap-btc-usd.log"},
  {n:15,slug:"eth-usd",log:"15-bootstrap-eth-usd.log"},
  {n:16,slug:"ada-usd",log:"16-bootstrap-ada-usd.log"},
  {n:17,slug:"usdt-usd",log:"17-bootstrap-usdt-usd.log"},
  {n:18,slug:"dai-usd",log:"18-bootstrap-dai-usd.log"},
  {n:19,slug:"sol-usd",log:"19-bootstrap-sol-usd.log"},
  {n:20,slug:"bnb-usd",log:"20-bootstrap-bnb-usd.log"},
  {n:21,slug:"xrp-usd",log:"21-bootstrap-xrp-usd.log"},
  {n:22,slug:"matic-usd",log:"22-bootstrap-matic-usd.log"},
  {n:23,slug:"dot-usd",log:"23-bootstrap-dot-usd.log"},
].map(({n,slug,log: logFile}) => {
  const sym = PAIR_SYMBOL[`${slug}.json`];
  const s = stepData.find(x => x.log === logFile);
  return `| ${n} | ${sym} | ${s?.txHash ? `\`${s.txHash}\`` : "—"} | ${s?.feeAda ? s.feeAda + " ADA" : "—"} | [\`${logFile}\`](./${logFile}) |`;
}).join("\n")}

### Second top-up (replenish before batch)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
${stepData.filter(s => s.log === "24-receiver-top-up-2.log").map(s => txRow(`24 | ${s.label}`, s.txHash, s.feeAda, s.log)).join("\n")}

### Batch update — coordinator \`ApplyBatch\`

${batchNarrative(batchAttemptReasons, successBatchSize, bindingDimension)}

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
${batchAttemptRows.join("\n")}
${stepData.filter(s => s.log === `25-update-batch-${successBatchSize}.log`).map(s => txRow(`25 | ${s.label}`, s.txHash, s.feeAda, s.log)).join("\n")}

### Settle, withdrawals, reclaim + republish reference script

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
${stepData.filter(s => ["26-settle.log","27-receiver-withdraw.log","28-payment-hook-withdraw.log","29-reclaim-payment-hook-reference-script.log","30-republish-payment-hook-reference-script.log"].includes(s.log)).map((s,i) => txRow(`${i+26} | ${s.label}`, s.txHash, s.feeAda, s.log)).join("\n")}

## ADA flow summary

Single wallet used for all operations (DIA admin = updater = funder).

| Item | Value |
| --- | --- |
| Wallet address | \`${walletAddress}\` |
| Initial wallet balance | ${initialLovelace != null ? `**${lovelaceToAda(initialLovelace)} ADA** (${initialLovelace.toLocaleString()} lovelace)` : "*(not captured)*"} |
| Final wallet balance | ${finalLovelace != null ? `**${lovelaceToAda(finalLovelace)} ADA** (${finalLovelace.toLocaleString()} lovelace)` : "*(not captured)*"} |
| Total on-chain fees paid | **${lovelaceToAda(totalFeesLovelace)} ADA** (${totalFeesLovelace.toLocaleString()} lovelace) |
| Net ADA locked in protocol | ${netLockedCheck != null ? `**${lovelaceToAda(netLockedCheck)} ADA** (initial − final − fees)` : "—"} |

### ADA locked breakdown

| Location | ADA locked |
| --- | --- |
| Config UTxO (min-UTxO) | ${lovelaceToAda(configLockedLovelace)} ADA |
| PaymentHook UTxO (min-UTxO + accrued) | ${lovelaceToAda(hookLockedLovelace)} ADA |
| Receiver UTxO (min-UTxO + balance + accrued) | ${lovelaceToAda(receiverLockedLovelace)} ADA |
| Pair UTxOs × ${livePairCount} (min-UTxO each${burnedPairCount > 0 ? `; ${burnedPairCount} burned excluded` : ""}) | ${lovelaceToAda(pairLockedLovelace)} ADA |
| Reference-script UTxOs × 6 (config+coordinator+hook+receiver+pair+pairMint) | ${lovelaceToAda(totalRefScriptLockedLovelace)} ADA |
| **Total locked in protocol** | **${lovelaceToAda(totalLockedLovelace)} ADA** |

Reference-script min-UTxO breakdown: \`configValidator\`=${lovelaceToAda(configRefMin)} ADA, \`coordinatorValidator\`=${lovelaceToAda(coordinatorRefMin)} ADA, \`paymentHookValidator\`=${lovelaceToAda(hookRefMin)} ADA, \`receiverValidator\`=${lovelaceToAda(receiverRefMin)} ADA, \`pairValidator\`=${lovelaceToAda(pairRefMin)} ADA, \`pairMintPolicy\`=${lovelaceToAda(pairMintRefMin)} ADA.

## On-chain fee audit

| Step | Operation | Tx hash (first 16 chars) | Fee paid |
| --- | --- | --- | --- |
${feeTableRows.join("\n")}

**Total confirmed on-chain fees: ${lovelaceToAda(totalFeesLovelace)} ADA** (${totalFeesLovelace.toLocaleString()} lovelace).

## Final on-chain state

Snapshot from [\`SUMMARY.json\`](./SUMMARY.json) at the end of the Preview chain walk.

### Script identities (current bytecode)

| Item | Value |
| --- | --- |
| Reference-holder address | \`${protocol.scripts?.referenceHolderAddress ?? "—"}\` |
| Config policy ID / validator hash | \`${protocol.scripts?.configPolicyId ?? "—"}\` |
| Config NFT unit | \`${protocol.scripts?.configUnit ?? "—"}\` |
| Coordinator stake validator hash | \`${protocol.scripts?.coordinatorHash ?? "—"}\` |
| PaymentHook policy ID / validator hash | \`${protocol.scripts?.paymentHookPolicyId ?? "—"}\` |
| PaymentHook NFT unit | \`${protocol.scripts?.paymentHookUnit ?? "—"}\` |
| Receiver validator hash (\`${clientId}\`) | \`${client.receiver?.receiverValidatorHash ?? "—"}\` |
| Receiver validator address (\`${clientId}\`) | \`${client.receiver?.receiverValidatorAddress ?? "—"}\` |
| Pair validator hash (\`${clientId}\`) | \`${client.scripts?.pairValidatorHash ?? "—"}\` |
| Pair validator address (\`${clientId}\`) | \`${client.scripts?.pairValidatorAddress ?? "—"}\` |

### Final UTxO states

| Artifact | Field | Value |
| --- | --- | --- |
| Receiver | balance | ${receiverState ? lovelaceToAda(BigInt(receiverState.balanceLovelace)) + " ADA" : "—"} |
| Receiver | accrued_to_hook | ${receiverState ? lovelaceToAda(BigInt(receiverState.accruedToHookLovelace)) + " ADA" : "—"} |
| Receiver | min_utxo | ${receiverState ? lovelaceToAda(BigInt(receiverState.minUtxoLovelace)) + " ADA" : "—"} |
| PaymentHook | accrued_fees | ${hookState ? lovelaceToAda(BigInt(hookState.accruedFeesLovelace)) + " ADA" : "—"} |
| PaymentHook | lifetime_collected | ${hookState ? lovelaceToAda(BigInt(hookState.lifetimeCollectedLovelace)) + " ADA" : "—"} |
| PaymentHook | lifetime_withdrawn | ${hookState ? lovelaceToAda(BigInt(hookState.lifetimeWithdrawnLovelace)) + " ADA" : "—"} |
| PaymentHook | min_utxo | ${hookState ? lovelaceToAda(BigInt(hookState.minUtxoLovelace)) + " ADA" : "—"} |

### Pair final prices

| Pair | Final price (scaled) | Updated via |
| --- | --- | --- |
${Object.entries(pairs).map(([fileName, pairArtifact]) => {
  const sym = PAIR_SYMBOL[fileName] ?? fileName;
  const price = pairArtifact.pairState?.price ?? "—";
  const txHash = pairArtifact.transactions?.slice(-1)[0]?.submittedTxHash ?? null;
  const viaBatch = txHash && batchTxHash && txHash === batchTxHash;
  const via = viaBatch ? `batch (step 25, ${successBatchSize} pairs)` : "single create (step 13–23)";
  return `| ${sym} | \`${price}\` | ${via} |`;
}).join("\n")}

## Key transaction explorer links (Preview CExplorer)

| Operation | Tx hash | Explorer |
| --- | --- | --- |
${explorerRows.join("\n")}

## Notes

Each DIA \`OracleIntent\` is generated just-in-time from the live chain tip immediately before its transaction so the signed \`timestamp\` and \`validFrom\`/\`validTo\` window are anchored to real network time. For the batch update, all intents are generated at the start of step 25 with a 1-hour expiry; each retry derives a fresh validity window from the chain tip at that moment.

Step 29–30 demonstrates the full reclaim + republish round-trip for the \`payment-hook\` reference-script UTxO: step 29 spends it back to the admin wallet; step 30 republishes it at a new outRef. This validates that \`reference_holder\` correctly enforces the admin-gated spend (Config signer + Config NFT as reference input).
`;

const mdPath = path.join(evidenceRoot, "milestone-1-preview-evidence.md");
await writeFile(mdPath, md, "utf8");
console.log(`wrote milestone-1-preview-evidence.md (${md.length} bytes)`);
NODE

echo "[rerun] completed; success batch size=$SUCCESS_BATCH_SIZE"
