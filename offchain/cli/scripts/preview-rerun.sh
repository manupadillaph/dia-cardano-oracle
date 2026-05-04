#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI_DIR="$REPO/offchain/cli"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%d-%H%M%S)}"
STATE_NAME="${STATE_NAME:-preview_rerun_${RUN_ID}}"
STATE_REL="./state/${STATE_NAME}"
STATE_ROOT="$CLI_DIR/state/${STATE_NAME}"
EVIDENCE_NAME="${EVIDENCE_NAME:-m1-preview-${RUN_ID}}"
EVIDENCE_ROOT="$REPO/docs/milestones/evidence/${EVIDENCE_NAME}"
TEMPLATE_INTENTS_DIR="${TEMPLATE_INTENTS_DIR:-$CLI_DIR/state/preview/intents}"
BACKUP_NAME="${BACKUP_NAME:-preview_${RUN_ID}}"
BACKUP_ROOT="$CLI_DIR/state/${BACKUP_NAME}"
CARDANO_PROVIDER="${CARDANO_PROVIDER:-Blockfrost}"

mkdir -p "$CLI_DIR/state" "$REPO/docs/milestones/evidence"

if [[ -d "$CLI_DIR/state/preview" && ! -e "$BACKUP_ROOT" ]]; then
  cp -R "$CLI_DIR/state/preview" "$BACKUP_ROOT"
fi

rm -rf "$STATE_ROOT" "$EVIDENCE_ROOT"
mkdir -p \
  "$STATE_ROOT/clients/client-a/pairs" \
  "$STATE_ROOT/config-updates" \
  "$STATE_ROOT/intents" \
  "$STATE_ROOT/update-batches" \
  "$EVIDENCE_ROOT"

cd "$CLI_DIR"

set -a
source "$CLI_DIR/.env"
set +a

export CARDANO_PROVIDER

echo "[rerun] fresh state root: $STATE_ROOT"
echo "[rerun] fresh evidence root: $EVIDENCE_ROOT"

run_logged() {
  local log_name="$1"
  shift
  local cli_cmd="$*"
  echo "[rerun] $cli_cmd"
  script -q -e -c "npm run cli -- $cli_cmd" /dev/null | tee "$EVIDENCE_ROOT/$log_name"
}

run_logged "00-protocol-init.log" \
  "preview:protocol:init --use-defaults --out $STATE_REL/config-bootstrap.json"

run_logged "01-config-parameterize.log" \
  "preview:config:parameterize --state $STATE_REL/config-bootstrap.json"
run_logged "02-config-bootstrap.log" \
  "preview:config:bootstrap --state $STATE_REL/config-bootstrap.json"
run_logged "03-config-reference-scripts.log" \
  "preview:config:reference-scripts --lovelace-per-output 3000000 --state $STATE_REL/config-bootstrap.json"

run_logged "04-payment-hook-parameterize.log" \
  "preview:payment-hook:parameterize --state $STATE_REL/config-bootstrap.json"
run_logged "05-payment-hook-bootstrap.log" \
  "preview:payment-hook:bootstrap --state $STATE_REL/config-bootstrap.json"
run_logged "06-payment-hook-reference-script.log" \
  "preview:payment-hook:reference-script --lovelace-per-output 3000000 --state $STATE_REL/config-bootstrap.json"

run_logged "07-client-init.log" \
  "preview:client:init --state $STATE_REL/config-bootstrap.json --client-id client-a --use-defaults --out $STATE_REL/clients/client-a.json"

run_logged "08-receiver-parameterize.log" \
  "preview:receiver:parameterize --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/client-a.json"
run_logged "09-receiver-bootstrap.log" \
  "preview:receiver:bootstrap --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/client-a.json"
run_logged "10-client-reference-scripts.log" \
  "preview:reference-scripts:publish-client --lovelace-per-output 3000000 --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/client-a.json"

run_logged "11-receiver-top-up.log" \
  "preview:receiver:top-up --amount-lovelace 30000000 --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/client-a.json"

STATE_ROOT="$STATE_ROOT" TEMPLATE_INTENTS_DIR="$TEMPLATE_INTENTS_DIR" node --input-type=module <<'NODE' > "$EVIDENCE_ROOT/11a-generate-intents.log" 2>&1
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { signPreviewOracleIntentFromInput } from "./dist/oracle/intent-sign.js";

const stateRoot = process.env.STATE_ROOT;
const templateDir = process.env.TEMPLATE_INTENTS_DIR;
if (!stateRoot || !templateDir) {
  throw new Error("Missing STATE_ROOT or TEMPLATE_INTENTS_DIR.");
}

const configState = JSON.parse(
  await readFile(path.join(stateRoot, "config-bootstrap.json"), "utf8"),
);
const outDir = path.join(stateRoot, "intents");
await mkdir(outDir, { recursive: true });

const domain = {
  name: configState.configState.domain.name,
  version: configState.configState.domain.version,
  sourceChainId: configState.configState.domain.sourceChainId,
  verifyingContract: `0x${configState.configState.domain.verifyingContract.replace(/^0x/i, "")}`,
};

const templates = [
  "usdc-usd.signed.json",
  "btc-usd.signed.json",
  "eth-usd.signed.json",
  "ada-usd.signed.json",
  "usdt-usd.signed.json",
  "dai-usd.signed.json",
  "sol-usd.signed.json",
  "bnb-usd.signed.json",
  "xrp-usd.signed.json",
  "matic-usd.signed.json",
  "dot-usd.signed.json",
  "btc-usd-batch.signed.json",
  "eth-usd-batch.signed.json",
  "ada-usd-batch.signed.json",
  "usdt-usd-batch.signed.json",
  "dai-usd-batch.signed.json",
  "sol-usd-batch.signed.json",
  "bnb-usd-batch.signed.json",
  "xrp-usd-batch.signed.json",
  "matic-usd-batch.signed.json",
  "dot-usd-batch.signed.json",
];

const baseMs = Date.now();
for (const [index, templateName] of templates.entries()) {
  const template = JSON.parse(
    await readFile(path.join(templateDir, templateName), "utf8"),
  );
  const timestamp = Math.floor((baseMs + index * 60_000) / 1000);
  const input = {
    domain,
    intent: {
      intentType: template.intent.intentType,
      version: domain.version,
      chainId: domain.sourceChainId,
      nonce: String(baseMs + index * 1000),
      expiry: String(timestamp + 3600),
      symbol: template.intent.symbol,
      price: template.intent.price,
      timestamp: String(timestamp),
      source: domain.name,
    },
  };
  const signed = signPreviewOracleIntentFromInput({ input });
  await writeFile(
    path.join(outDir, templateName),
    JSON.stringify(signed, null, 2) + "\n",
    "utf8",
  );
  console.log(
    `wrote ${templateName}: symbol=${input.intent.symbol} price=${input.intent.price} nonce=${input.intent.nonce} expiry=${input.intent.expiry}`,
  );
}
NODE

run_logged "12-update-usdc-bootstrap.log" \
  "preview:update --intent $STATE_REL/intents/usdc-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/usdc-usd.json"
run_logged "13-bootstrap-btc-usd.log" \
  "preview:update --intent $STATE_REL/intents/btc-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/btc-usd.json"
run_logged "14-bootstrap-eth-usd.log" \
  "preview:update --intent $STATE_REL/intents/eth-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/eth-usd.json"
run_logged "15-bootstrap-ada-usd.log" \
  "preview:update --intent $STATE_REL/intents/ada-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/ada-usd.json"
run_logged "16-bootstrap-usdt-usd.log" \
  "preview:update --intent $STATE_REL/intents/usdt-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/usdt-usd.json"
run_logged "17-bootstrap-dai-usd.log" \
  "preview:update --intent $STATE_REL/intents/dai-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/dai-usd.json"
run_logged "18-bootstrap-sol-usd.log" \
  "preview:update --intent $STATE_REL/intents/sol-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/sol-usd.json"
run_logged "19-bootstrap-bnb-usd.log" \
  "preview:update --intent $STATE_REL/intents/bnb-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/bnb-usd.json"
run_logged "20-bootstrap-xrp-usd.log" \
  "preview:update --intent $STATE_REL/intents/xrp-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/xrp-usd.json"
run_logged "21-bootstrap-matic-usd.log" \
  "preview:update --intent $STATE_REL/intents/matic-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/matic-usd.json"
run_logged "22-bootstrap-dot-usd.log" \
  "preview:update --intent $STATE_REL/intents/dot-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --state $STATE_REL/clients/client-a/pairs/dot-usd.json"

run_logged "23-receiver-top-up-2.log" \
  "preview:receiver:top-up --amount-lovelace 30000000 --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/client-a.json"

STATE_ROOT="$STATE_ROOT" STATE_REL="$STATE_REL" node --input-type=module <<'NODE' > "$EVIDENCE_ROOT/23a-generate-batch-manifests.log" 2>&1
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const stateRoot = process.env.STATE_ROOT;
const stateRel = process.env.STATE_REL;
if (!stateRoot || !stateRel) {
  throw new Error("Missing STATE_ROOT or STATE_REL.");
}

const batchesDir = path.join(stateRoot, "update-batches");
await mkdir(batchesDir, { recursive: true });

const orderedPairs = [
  "btc-usd",
  "eth-usd",
  "ada-usd",
  "usdt-usd",
  "dai-usd",
  "sol-usd",
  "bnb-usd",
  "xrp-usd",
  "matic-usd",
  "dot-usd",
];

const updates = orderedPairs.map((slug) => ({
  statePath: `${stateRel}/clients/client-a/pairs/${slug}.json`,
  intentPath: `${stateRel}/intents/${slug}-batch.signed.json`,
}));

for (const size of [10, 9, 8, 7, 6, 5]) {
  const manifest = { updates: updates.slice(0, size) };
  const manifestPath = path.join(batchesDir, `batch-${size}.manifest.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`wrote ${path.basename(manifestPath)} with ${size} updates`);
}
NODE

SUCCESS_BATCH_SIZE=""
for size in 10 9 8 7 6; do
  log_name="24-update-batch-${size}.log"
  if run_logged "$log_name" \
    "preview:update:batch --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --manifest $STATE_REL/update-batches/batch-${size}.manifest.json --min-utxo-lovelace 5000000 --out $STATE_REL/update-batches/batch-${size}.result.json"; then
    SUCCESS_BATCH_SIZE="$size"
    break
  fi
done

if [[ -z "$SUCCESS_BATCH_SIZE" ]]; then
  run_logged "24-update-batch-5.log" \
    "preview:update:batch --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json --manifest $STATE_REL/update-batches/batch-5.manifest.json --min-utxo-lovelace 5000000 --out $STATE_REL/update-batches/batch-5.result.json"
  SUCCESS_BATCH_SIZE="5"
fi

printf '%s\n' "$SUCCESS_BATCH_SIZE" > "$EVIDENCE_ROOT/batch-success-size.txt"

run_logged "25-settle.log" \
  "preview:settle --protocol-state $STATE_REL/config-bootstrap.json --client-state $STATE_REL/clients/client-a.json"
run_logged "26-receiver-withdraw.log" \
  "preview:receiver:withdraw --amount-lovelace 5000000 --protocol-state $STATE_REL/config-bootstrap.json --state $STATE_REL/clients/client-a.json"
run_logged "27-payment-hook-withdraw.log" \
  "preview:payment-hook:withdraw --amount-lovelace 10000000 --state $STATE_REL/config-bootstrap.json"

STATE_ROOT="$STATE_ROOT" EVIDENCE_ROOT="$EVIDENCE_ROOT" SUCCESS_BATCH_SIZE="$SUCCESS_BATCH_SIZE" node --input-type=module <<'NODE' > "$EVIDENCE_ROOT/28-summary-build.log" 2>&1
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const stateRoot = process.env.STATE_ROOT;
const evidenceRoot = process.env.EVIDENCE_ROOT;
const successBatchSize = process.env.SUCCESS_BATCH_SIZE;
if (!stateRoot || !evidenceRoot || !successBatchSize) {
  throw new Error("Missing summary build environment variables.");
}

const protocol = JSON.parse(await readFile(path.join(stateRoot, "config-bootstrap.json"), "utf8"));
const client = JSON.parse(await readFile(path.join(stateRoot, "clients", "client-a.json"), "utf8"));
const pairsDir = path.join(stateRoot, "clients", "client-a", "pairs");
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
  paymentHookUtxo: protocol.paymentHookUtxo,
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
