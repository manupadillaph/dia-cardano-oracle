#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI_DIR="$REPO/offchain/cli"

CLEAN_PREVIOUS=true
FROM_STEP=1
EXPLICIT_RUN_ID="${RUN_ID:-}"

usage() {
  cat <<'EOF'
usage: preview-rerun.sh [--clean-previous=true|false] [--from-step N] [--run-id ID]

examples:
  preview-rerun.sh
  preview-rerun.sh --clean-previous=false
  preview-rerun.sh --from-step 13 --run-id 20260506-030904
EOF
}

normalize_bool() {
  case "${1,,}" in
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

if ! [[ "$FROM_STEP" =~ ^[0-9]+$ ]] || (( FROM_STEP < 1 || FROM_STEP > 28 )); then
  echo "--from-step must be an integer between 1 and 28" >&2
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
PROTOCOL_FEE_LOVELACE="2000000"
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

declare -Ar PAIR_SYMBOLS=(
  ["usdc-usd"]="USDC/USD"
  ["btc-usd"]="BTC/USD"
  ["eth-usd"]="ETH/USD"
  ["ada-usd"]="ADA/USD"
  ["usdt-usd"]="USDT/USD"
  ["dai-usd"]="DAI/USD"
  ["sol-usd"]="SOL/USD"
  ["bnb-usd"]="BNB/USD"
  ["xrp-usd"]="XRP/USD"
  ["matic-usd"]="MATIC/USD"
  ["dot-usd"]="DOT/USD"
)

declare -Ar BOOTSTRAP_PRICES=(
  ["usdc-usd"]="100045678"
  ["btc-usd"]="6000000000000"
  ["eth-usd"]="250000000000"
  ["ada-usd"]="750000000"
  ["usdt-usd"]="100001234"
  ["dai-usd"]="100000345"
  ["sol-usd"]="18500000000"
  ["bnb-usd"]="61500000000"
  ["xrp-usd"]="520000000"
  ["matic-usd"]="980000000"
  ["dot-usd"]="420000000"
)

declare -Ar BATCH_PRICES=(
  ["btc-usd"]="6001000000000"
  ["eth-usd"]="250100000000"
  ["ada-usd"]="751000000"
  ["usdt-usd"]="100101234"
  ["dai-usd"]="100100345"
  ["sol-usd"]="18510000000"
  ["bnb-usd"]="61510000000"
  ["xrp-usd"]="521000000"
  ["matic-usd"]="981000000"
  ["dot-usd"]="421000000"
)

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
  local symbol="${PAIR_SYMBOLS[$slug]}"

  append_cli_log "$log_name" \
    "preview:intent:create-and-sign --state $STATE_REL/config-bootstrap.json --intent-type OracleUpdate --symbol $symbol --price $price --source \"$DOMAIN_NAME\" --out $STATE_REL/intents/${slug}${suffix}.signed.json"
}

generate_batch_signed_intents_now() {
  local log_name="$1"
  local slug

  : > "$EVIDENCE_ROOT/$log_name"
  for slug in "${BATCH_SLUGS[@]}"; do
    generate_signed_intent_now "$log_name" "$slug" "-batch" "${BATCH_PRICES[$slug]}"
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
PROTOCOL_FEE_LOVELACE="$PROTOCOL_FEE_LOVELACE" \
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
    protocolFeeLovelace: process.env.PROTOCOL_FEE_LOVELACE,
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

if should_run_step 1; then
  run_cli_logged "01-protocol-init.log" \
    "preview:protocol:init --valid-config-signers $CONFIG_SIGNER_PKH --authorized-dia-public-keys $AUTHORIZED_DIA_PUBLIC_KEY --domain-name \"$DOMAIN_NAME\" --domain-version $DOMAIN_VERSION --domain-source-chain-id $DOMAIN_SOURCE_CHAIN_ID --domain-verifying-contract $DOMAIN_VERIFYING_CONTRACT --protocol-fee-lovelace $PROTOCOL_FEE_LOVELACE --max-bootstrap-drift-seconds $MAX_BOOTSTRAP_DRIFT_SECONDS --min-utxo-lovelace $CONFIG_MIN_UTXO_LOVELACE --config-asset-label $CONFIG_ASSET_LABEL --payment-hook-asset-label $PAYMENT_HOOK_ASSET_LABEL --payment-hook-withdraw-address $PAYMENT_HOOK_WITHDRAW_ADDRESS --out $STATE_REL/config-bootstrap.json"
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
  generate_signed_intent_now "13a-generate-usdc-usd-intent.log" "usdc-usd" "" "${BOOTSTRAP_PRICES["usdc-usd"]}"
  run_tx_logged "13-update-usdc-bootstrap.log" \
    "preview:update --intent $STATE_REL/intents/usdc-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/usdc-usd.json"
fi
if should_run_step 14; then
  generate_signed_intent_now "14a-generate-btc-usd-intent.log" "btc-usd" "" "${BOOTSTRAP_PRICES["btc-usd"]}"
  run_tx_logged "14-bootstrap-btc-usd.log" \
    "preview:update --intent $STATE_REL/intents/btc-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/btc-usd.json"
fi
if should_run_step 15; then
  generate_signed_intent_now "15a-generate-eth-usd-intent.log" "eth-usd" "" "${BOOTSTRAP_PRICES["eth-usd"]}"
  run_tx_logged "15-bootstrap-eth-usd.log" \
    "preview:update --intent $STATE_REL/intents/eth-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/eth-usd.json"
fi
if should_run_step 16; then
  generate_signed_intent_now "16a-generate-ada-usd-intent.log" "ada-usd" "" "${BOOTSTRAP_PRICES["ada-usd"]}"
  run_tx_logged "16-bootstrap-ada-usd.log" \
    "preview:update --intent $STATE_REL/intents/ada-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/ada-usd.json"
fi
if should_run_step 17; then
  generate_signed_intent_now "17a-generate-usdt-usd-intent.log" "usdt-usd" "" "${BOOTSTRAP_PRICES["usdt-usd"]}"
  run_tx_logged "17-bootstrap-usdt-usd.log" \
    "preview:update --intent $STATE_REL/intents/usdt-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/usdt-usd.json"
fi
if should_run_step 18; then
  generate_signed_intent_now "18a-generate-dai-usd-intent.log" "dai-usd" "" "${BOOTSTRAP_PRICES["dai-usd"]}"
  run_tx_logged "18-bootstrap-dai-usd.log" \
    "preview:update --intent $STATE_REL/intents/dai-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/dai-usd.json"
fi
if should_run_step 19; then
  generate_signed_intent_now "19a-generate-sol-usd-intent.log" "sol-usd" "" "${BOOTSTRAP_PRICES["sol-usd"]}"
  run_tx_logged "19-bootstrap-sol-usd.log" \
    "preview:update --intent $STATE_REL/intents/sol-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/sol-usd.json"
fi
if should_run_step 20; then
  generate_signed_intent_now "20a-generate-bnb-usd-intent.log" "bnb-usd" "" "${BOOTSTRAP_PRICES["bnb-usd"]}"
  run_tx_logged "20-bootstrap-bnb-usd.log" \
    "preview:update --intent $STATE_REL/intents/bnb-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/bnb-usd.json"
fi
if should_run_step 21; then
  generate_signed_intent_now "21a-generate-xrp-usd-intent.log" "xrp-usd" "" "${BOOTSTRAP_PRICES["xrp-usd"]}"
  run_tx_logged "21-bootstrap-xrp-usd.log" \
    "preview:update --intent $STATE_REL/intents/xrp-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/xrp-usd.json"
fi
if should_run_step 22; then
  generate_signed_intent_now "22a-generate-matic-usd-intent.log" "matic-usd" "" "${BOOTSTRAP_PRICES["matic-usd"]}"
  run_tx_logged "22-bootstrap-matic-usd.log" \
    "preview:update --intent $STATE_REL/intents/matic-usd.signed.json --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/${CLIENT_ID}.json --state $STATE_REL/clients/${CLIENT_ID}/pairs/matic-usd.json"
fi
if should_run_step 23; then
  generate_signed_intent_now "23a-generate-dot-usd-intent.log" "dot-usd" "" "${BOOTSTRAP_PRICES["dot-usd"]}"
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

STATE_ROOT="$STATE_ROOT" EVIDENCE_ROOT="$EVIDENCE_ROOT" SUCCESS_BATCH_SIZE="$SUCCESS_BATCH_SIZE" CLIENT_ID="$CLIENT_ID" node --input-type=module <<'NODE' > "$EVIDENCE_ROOT/30-summary-build.log" 2>&1
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const stateRoot = process.env.STATE_ROOT;
const evidenceRoot = process.env.EVIDENCE_ROOT;
const successBatchSize = process.env.SUCCESS_BATCH_SIZE;
const clientId = process.env.CLIENT_ID;
if (!stateRoot || !evidenceRoot || !successBatchSize || !clientId) {
  throw new Error("Missing summary build environment variables.");
}

const protocol = JSON.parse(await readFile(path.join(stateRoot, "config-bootstrap.json"), "utf8"));
const client = JSON.parse(await readFile(path.join(stateRoot, "clients", `${clientId}.json`), "utf8"));
const pairsDir = path.join(stateRoot, "clients", clientId, "pairs");
const pairFiles = (await readdir(pairsDir)).filter((name) => name.endsWith(".json")).sort();
const pairs = {};
for (const fileName of pairFiles) {
  pairs[fileName] = JSON.parse(await readFile(path.join(pairsDir, fileName), "utf8"));
}

const summary = {
  generatedAt: new Date().toISOString(),
  stateRoot,
  successBatchSize: Number(successBatchSize),
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
console.log(`wrote SUMMARY.json with ${pairFiles.length} pair states`);
NODE

echo "[rerun] completed; success batch size=$SUCCESS_BATCH_SIZE"
