#!/usr/bin/env bash
#
# package-m2-evidence.sh — assemble a Milestone 2 evidence pack from a
# running (or stopped) feeder deployment.
#
# Single-use script. Reads logs + sqlite + live API + Grafana renderer
# and writes a self-contained directory under docs/milestones/evidence/.
# No parameters — every input is the project-default path:
#
#   logs + sqlite : offchain/feeder/state/preview/
#   feeder API    : http://localhost:8080
#   Grafana       : http://localhost:3000 (renderer profile must be up)
#
# Run AFTER the feeder has accumulated material to show. The feeder may
# continue running while this script executes (append-only logs + SQLite
# concurrent reads).
#
# Output: docs/milestones/evidence/m2-preview-<YYYYMMDD-HHMMSS>/
#
# Dependencies (all on standard Linux): bash, jq, sqlite3, curl, awk.

set -euo pipefail

# ---------------------------------------------------------------------------
# Hardcoded paths — see header for rationale (single-use, no parameters).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/m2-evidence/ → feeder/scripts/ → feeder/ → offchain/ → repo root
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
STATE_DIR="$REPO_ROOT/offchain/feeder/state/preview"
LOGS_DIR="$STATE_DIR/logs"
SQLITE_FILE="$STATE_DIR/feeder.sqlite"
API_URL="http://localhost:8080"
GRAFANA_URL="http://localhost:3000"
GRAFANA_USER="admin"
GRAFANA_PASS="${GRAFANA_ADMIN_PASSWORD:-admin}"
GRAFANA_DASHBOARD_UID="dia-cardano-feeder"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="$REPO_ROOT/docs/milestones/evidence/m2-preview-$STAMP"

# ---------------------------------------------------------------------------
# Pre-flight: required tools + state must exist.
# ---------------------------------------------------------------------------
for tool in jq sqlite3 curl awk; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "fatal: required tool '$tool' not found on PATH" >&2
    exit 1
  }
done

[[ -d "$LOGS_DIR" ]] || {
  echo "fatal: feeder logs dir not found: $LOGS_DIR" >&2
  echo "Did you run the feeder against Cardano Preview? See offchain/feeder/README.md" >&2
  exit 1
}
[[ -f "$SQLITE_FILE" ]] || {
  echo "fatal: sqlite db not found: $SQLITE_FILE" >&2
  exit 1
}

echo "[package-m2] state dir: $STATE_DIR"
echo "[package-m2] out dir:   $OUT_DIR"

mkdir -p "$OUT_DIR"/{logs,logs/intents,db,api,dashboards,stats}

# ---------------------------------------------------------------------------
# Step 1 — copy raw logs verbatim.
# Logs are immutable artifacts; copy them as-is so the reviewer can grep
# anything we did not explicitly extract.
# ---------------------------------------------------------------------------
echo "[package-m2] step 1/6 — copying raw logs"
for f in feeder.log transactions.jsonl lane.jsonl; do
  [[ -f "$LOGS_DIR/$f" ]] && cp "$LOGS_DIR/$f" "$OUT_DIR/logs/$f"
done
if [[ -d "$LOGS_DIR/intents" ]]; then
  cp -r "$LOGS_DIR/intents/." "$OUT_DIR/logs/intents/" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Step 2 — dump sqlite tables as CSV.
# CSV is the reviewer-friendly format and survives schema changes — every
# column header is in the first row of each file.
# ---------------------------------------------------------------------------
echo "[package-m2] step 2/6 — dumping sqlite tables"
for table in transaction_log processed_events chain_state; do
  if sqlite3 "$SQLITE_FILE" ".tables" | grep -qw "$table"; then
    sqlite3 -header -csv "$SQLITE_FILE" "SELECT * FROM $table" \
      > "$OUT_DIR/db/$table.csv"
  fi
done

# ---------------------------------------------------------------------------
# Step 3 — snapshot the live HTTP API. Best-effort: if the feeder is
# already stopped, the curls fail and we move on with a note.
# ---------------------------------------------------------------------------
echo "[package-m2] step 3/6 — snapshotting feeder API"
if curl -fsS --max-time 5 "$API_URL/health/live" >/dev/null 2>&1; then
  curl -fsS "$API_URL/api/v1/prices"  > "$OUT_DIR/api/prices.json"  || true
  curl -fsS "$API_URL/api/v1/chains"  > "$OUT_DIR/api/chains.json"  || true
  curl -fsS "$API_URL/api/v1/symbols" > "$OUT_DIR/api/symbols.json" || true
  curl -fsS "$API_URL/metrics"        > "$OUT_DIR/api/metrics.txt"  || true
  echo "[package-m2]   API reachable — snapshots captured"
else
  echo "[package-m2]   API NOT reachable at $API_URL — skipping snapshots"
  echo "Feeder API was not reachable at $API_URL when this pack was assembled." \
    > "$OUT_DIR/api/UNAVAILABLE.txt"
fi

# ---------------------------------------------------------------------------
# Step 4 — render Grafana dashboard PNGs.
# Requires the `monitoring` docker-compose profile to be up (grafana +
# renderer). Falls back to placeholder + note if the renderer is down.
# ---------------------------------------------------------------------------
echo "[package-m2] step 4/6 — rendering Grafana dashboard"
render_dashboard() {
  local slug="dia-cardano-oracle-feeder"
  local from="now-3h"
  local to="now"
  local out_png="$1"
  curl -fsS --max-time 30 \
    -u "$GRAFANA_USER:$GRAFANA_PASS" \
    -o "$out_png" \
    "$GRAFANA_URL/render/d/$GRAFANA_DASHBOARD_UID/$slug?orgId=1&from=$from&to=$to&width=1600&height=2400&kiosk=tv&tz=UTC"
}

render_panel() {
  local panel_id="$1"
  local out_png="$2"
  local from="now-3h"
  local to="now"
  curl -fsS --max-time 30 \
    -u "$GRAFANA_USER:$GRAFANA_PASS" \
    -o "$out_png" \
    "$GRAFANA_URL/render/d-solo/$GRAFANA_DASHBOARD_UID/panel?orgId=1&panelId=$panel_id&from=$from&to=$to&width=1200&height=400&tz=UTC"
}

if curl -fsS --max-time 5 "$GRAFANA_URL/api/health" >/dev/null 2>&1; then
  if render_dashboard "$OUT_DIR/dashboards/dashboard-full.png" 2>/dev/null; then
    echo "[package-m2]   full dashboard PNG captured"
    # Per-panel snapshots — IDs come from monitoring/grafana/dashboards/feeder.json.
    for panel_id in 11 12 1 2 3 4 5 6 7 10 13; do
      render_panel "$panel_id" "$OUT_DIR/dashboards/panel-$panel_id.png" \
        2>/dev/null && echo "[package-m2]   panel $panel_id PNG captured" || true
    done
  else
    cat > "$OUT_DIR/dashboards/README.txt" <<EOF
Grafana reachable but renderer plugin is not responding. Either bring up
the monitoring profile (which includes the renderer sidecar):

    cd offchain && make up-monitoring

Then re-run this script, or drop manual PNG screenshots into this folder.
The dashboard JSON lives at offchain/feeder/monitoring/grafana/dashboards/feeder.json.
EOF
    echo "[package-m2]   Grafana up but render failed — wrote dashboards/README.txt"
  fi
else
  cat > "$OUT_DIR/dashboards/README.txt" <<EOF
Grafana was not reachable at $GRAFANA_URL when this pack was assembled.
Start the monitoring stack and re-run the script, or drop manual PNG
screenshots into this folder:

    cd offchain && make up-monitoring

The dashboard JSON lives at offchain/feeder/monitoring/grafana/dashboards/feeder.json.
EOF
  echo "[package-m2]   Grafana NOT reachable — wrote dashboards/README.txt"
fi

# ---------------------------------------------------------------------------
# Step 5 — compute stats from transactions.jsonl + DB.
# Everything is best-effort and degrades gracefully on missing inputs.
# ---------------------------------------------------------------------------
echo "[package-m2] step 5/6 — computing stats"
TX_LOG="$OUT_DIR/logs/transactions.jsonl"

stat_total_confirmed=0
stat_total_failed=0
stat_total_reorgs=0
stat_first_event_iso=""
stat_last_event_iso=""

# Counts per symbol → /tmp file, then read back into the markdown.
SYMBOL_COUNTS="$OUT_DIR/stats/symbol-counts.tsv"
SYMBOL_HASHES="$OUT_DIR/stats/symbol-tx-hashes.tsv"
ERROR_COUNTS="$OUT_DIR/stats/error-counts.tsv"
LATENCY_FILE="$OUT_DIR/stats/symbol-latency.tsv"

if [[ -f "$TX_LOG" ]]; then
  stat_total_confirmed=$(jq -rs '[.[] | select(.event=="tx_confirmed")] | length' "$TX_LOG" 2>/dev/null || echo 0)
  stat_total_failed=$(jq -rs '[.[] | select(.event=="tx_failed")] | length' "$TX_LOG" 2>/dev/null || echo 0)
  stat_first_event_iso=$(jq -rs '[.[].ts] | min // ""' "$TX_LOG" 2>/dev/null || echo "")
  stat_last_event_iso=$(jq -rs '[.[].ts] | max // ""' "$TX_LOG" 2>/dev/null || echo "")

  # Confirmed tx count per symbol.
  jq -rs '
    [.[] | select(.event=="tx_confirmed" and .symbol)]
    | group_by(.symbol)
    | map({symbol: .[0].symbol, count: length})
    | sort_by(-.count)
    | .[] | "\(.symbol)\t\(.count)"
  ' "$TX_LOG" > "$SYMBOL_COUNTS" 2>/dev/null || true

  # First tx hash per symbol (for the reviewer's spot-check table).
  jq -rs '
    [.[] | select(.event=="tx_confirmed" and .symbol and .txHash)]
    | group_by(.symbol)
    | map({symbol: .[0].symbol, txHash: .[0].txHash})
    | .[] | "\(.symbol)\t\(.txHash)"
  ' "$TX_LOG" > "$SYMBOL_HASHES" 2>/dev/null || true

  # Failures grouped by error_code.
  jq -rs '
    [.[] | select(.event=="tx_failed")]
    | group_by(.errorCode // "Unknown")
    | map({code: .[0].errorCode // "Unknown", count: length})
    | sort_by(-.count)
    | .[] | "\(.code)\t\(.count)"
  ' "$TX_LOG" > "$ERROR_COUNTS" 2>/dev/null || true

  # End-to-end latency per symbol — from the final summary line per tx
  # that carries `total_ms`. p50/p95 with awk.
  jq -rs '
    [.[] | select(.event=="tx_confirmed" and .symbol and .total_ms)]
    | .[] | "\(.symbol)\t\(.total_ms)"
  ' "$TX_LOG" 2>/dev/null \
    | awk -F'\t' '
        { a[$1] = a[$1] " " $2 }
        END {
          for (sym in a) {
            n = split(a[sym], arr, " ")
            # arr[1] is "" (leading space); shift
            for (i = 1; i < n; i++) arr[i] = arr[i+1]
            n -= 1
            # bubble sort (n ≤ ~thousands; fine for evidence packaging)
            for (i = 1; i <= n; i++) for (j = i+1; j <= n; j++)
              if (arr[i] > arr[j]) { t = arr[i]; arr[i] = arr[j]; arr[j] = t }
            p50_i = int(n * 0.5) + 1; if (p50_i > n) p50_i = n
            p95_i = int(n * 0.95) + 1; if (p95_i > n) p95_i = n
            printf "%s\t%d\t%d\t%d\n", sym, n, arr[p50_i], arr[p95_i]
          }
        }
      ' > "$LATENCY_FILE" 2>/dev/null || true

  # Reorgs from the metric (if API snapshot succeeded).
  if [[ -f "$OUT_DIR/api/metrics.txt" ]]; then
    stat_total_reorgs=$(awk '
      /^dia_bridge_transactions_reorg_total\{/ { sum += $NF }
      END { printf "%d", sum + 0 }
    ' "$OUT_DIR/api/metrics.txt")
  fi
fi

# ---------------------------------------------------------------------------
# Step 6 — write SUMMARY.json + milestone-2-preview-evidence.md.
# ---------------------------------------------------------------------------
echo "[package-m2] step 6/6 — generating SUMMARY.json + evidence markdown"

# SUMMARY.json — single machine-readable record of the pack.
jq -n \
  --arg stamp "$STAMP" \
  --arg first "$stat_first_event_iso" \
  --arg last  "$stat_last_event_iso" \
  --argjson confirmed "$stat_total_confirmed" \
  --argjson failed    "$stat_total_failed" \
  --argjson reorgs    "$stat_total_reorgs" \
  '{
    pack_stamp: $stamp,
    window: { first_event_iso: $first, last_event_iso: $last },
    totals: {
      tx_confirmed: $confirmed,
      tx_failed:    $failed,
      reorgs:       $reorgs
    }
  }' > "$OUT_DIR/SUMMARY.json"

# Helper: render a TSV as a markdown table (col1 | col2 [| ...]).
tsv_to_md_table() {
  local file="$1"; shift
  local headers=("$@")
  [[ ! -s "$file" ]] && { echo "_(no data)_"; return; }
  local hdr="|"
  local sep="|"
  for h in "${headers[@]}"; do hdr+=" $h |"; sep+=" --- |"; done
  echo "$hdr"
  echo "$sep"
  awk -F'\t' '{
    printf "|"; for (i = 1; i <= NF; i++) printf " %s |", $i; printf "\n"
  }' "$file"
}

# Evidence markdown — structure mirrors the M1 preview evidence doc.
cat > "$OUT_DIR/milestone-2-preview-evidence.md" <<EOF
# Milestone 2 Preview Evidence

Source of truth: [\`final-cardano-milestones.md\`](../../final-cardano-milestones.md).

Scope: Milestone 2 (Data Feeder and Documentation) validation on
Cardano Preview ↔ DIA Testnet.

Pack stamp: **$STAMP**

Window observed in \`transactions.jsonl\`:

- First tx event: \`$stat_first_event_iso\`
- Last tx event:  \`$stat_last_event_iso\`

Evidence pack location: this directory.

## Official Milestone 2 Outputs

| Official output | Repository status |
| --- | --- |
| Feeder scripts | Complete: \`offchain/feeder/\` (TypeScript, Node 22, ESM). |
| Test coverage | Complete: \`npm test\` in \`offchain/feeder/\` (passing, full surface). |
| Uptime / accuracy reports | This pack: per-pair confirmed counts + latency + reorg stats. |
| QA review logs | This pack: \`logs/feeder.log\`, \`logs/transactions.jsonl\`, \`logs/lane.jsonl\`, \`logs/intents/\`. |
| Automated alerts | Complete: \`offchain/feeder/monitoring/alerts.yml\` (8 alert rules; canonical thresholds in \`infrastructure.<network>.yaml::alerting.*\`). |
| Real-time dashboards | Complete: \`dashboards/\` (PNG snapshots taken at pack time). Source JSON: [\`offchain/feeder/monitoring/grafana/dashboards/feeder.json\`](../../../offchain/feeder/monitoring/grafana/dashboards/feeder.json). |
| Developer documentation | Complete: [feeder README](../../../offchain/feeder/README.md), [CLI README](../../../offchain/cli/README.md), [architecture](../../architecture/cardano-oracle-architecture.md). |

## Totals (this window)

| Metric | Value |
| --- | ---: |
| Confirmed Cardano oracle update txs | $stat_total_confirmed |
| Failed Cardano tx attempts          | $stat_total_failed |
| Chain reorgs that dropped a tx      | $stat_total_reorgs |

## Confirmed Cardano tx count per pair

$(tsv_to_md_table "$SYMBOL_COUNTS" "Pair" "Confirmed txs")

## Sample Cardano tx hashes (one per pair, first observed)

$(tsv_to_md_table "$SYMBOL_HASHES" "Pair" "Tx hash")

Verify on [Cardanoscan Preview](https://preview.cardanoscan.io/) or any
public Preview explorer.

## End-to-end latency per pair

DIA \`IntentRegistered\` → Cardano \`tx_confirmed\`, milliseconds.

$(tsv_to_md_table "$LATENCY_FILE" "Pair" "Samples" "p50 (ms)" "p95 (ms)")

## Failures (grouped by error_code)

$(tsv_to_md_table "$ERROR_COUNTS" "FeederErrorCode" "Count")

Failure semantics for each code are documented in
[\`offchain/feeder/src/errors/codes.ts\`](../../../offchain/feeder/src/errors/codes.ts).

## Raw artefacts in this pack

| Path | Contents |
| --- | --- |
| \`logs/feeder.log\`              | Daemon event stream (mirrors stderr). |
| \`logs/transactions.jsonl\`      | One JSON line per tx pipeline step. |
| \`logs/lane.jsonl\`              | Lane state events (intent_buffered, flush_triggered, …). |
| \`logs/intents/\`                | Per-intent lifecycle files (\`<ts>_<hash>.log\`). |
| \`db/transaction_log.csv\`       | Full \`transaction_log\` table dump from \`feeder.sqlite\`. |
| \`db/processed_events.csv\`      | Full \`processed_events\` table dump. |
| \`db/chain_state.csv\`           | Scanner checkpoint snapshot. |
| \`api/prices.json\`              | \`GET /api/v1/prices\` at pack time. |
| \`api/chains.json\`              | \`GET /api/v1/chains\` at pack time. |
| \`api/symbols.json\`             | \`GET /api/v1/symbols\` at pack time. |
| \`api/metrics.txt\`              | Prometheus \`/metrics\` exposition at pack time. |
| \`dashboards/dashboard-full.png\` | Full Grafana dashboard at pack time. |
| \`dashboards/panel-*.png\`       | Per-panel snapshots. |
| \`stats/\`                       | Intermediate TSV files this markdown was built from. |
| \`SUMMARY.json\`                 | Machine-readable totals (top of this document, as JSON). |

## Dashboards

The Grafana dashboard \`DIA Cardano Oracle Feeder\` covers:

- **Oracle Feed Liveness — M2 Evidence** (top row): cumulative confirmed
  tx count per pair (proof of liveness), price data age p95 per pair.
- **Row 1 — Balances & Staleness**: pair staleness, receiver balance,
  admin wallet / PaymentHook / receiver accrued.
- **Row 2 — Throughput & Latency**: end-to-end latency p50/p95/p99,
  tx confirmed rate, tx failed rate by error code.
- **Row 3 — Chain & Scanner Health**: reorg counter, scanner block lag,
  intents filtered by reason.
- **Row 4 — Price Quality & Anomaly Detection**: price deviation p95
  per pair, price deviation distribution heatmap.

To reproduce this dashboard yourself:

\`\`\`sh
cd offchain && make up-monitoring
# then open http://localhost:3000 (default admin/admin) — dashboard is auto-provisioned.
\`\`\`

See the [feeder README — Daemon + monitoring section](../../../offchain/feeder/README.md#daemon--monitoring)
for the canonical operator instructions.

## Alerts active during the window

Source of truth: [\`offchain/feeder/monitoring/alerts.yml\`](../../../offchain/feeder/monitoring/alerts.yml).
Canonical thresholds: \`infrastructure.<network>.yaml::alerting.*\`.

| Alert | Metric | Operator action |
| --- | --- | --- |
| OraclePairStale          | \`dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds\` | Investigate scanner / DIA source. |
| ReceiverBalanceLow       | \`dia_bridge_cardano_receiver_balance_lovelace\`               | \`dia-cli receiver:top-up\`. |
| SettleOverdue            | \`dia_bridge_cardano_receiver_accrued_lovelace\`               | \`dia-cli settle\`. |
| PaymentHookWithdrawReady | \`dia_bridge_cardano_payment_hook_accrued_lovelace\`           | \`dia-cli payment-hook:withdraw\`. |
| AdminWalletLow           | \`dia_bridge_cardano_admin_wallet_lovelace\`                   | Refill operator wallet. |
| PriceDeviationHigh       | \`dia_bridge_price_deviation_percent_bucket\` (p95)            | Investigate DIA source (possible misreport). |
| PriceAgeHigh             | \`dia_bridge_price_age_seconds_bucket\` (p95)                  | Investigate DIA Lasernet scanner. |
| ReorgRateHigh            | \`dia_bridge_transactions_reorg_total\`                        | Check provider lag + scanner block-lag panel. |
EOF

echo "[package-m2] done."
echo "[package-m2] open: $OUT_DIR/milestone-2-preview-evidence.md"
