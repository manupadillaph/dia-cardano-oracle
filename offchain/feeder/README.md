# DIA Cardano Oracle Feeder

Long-running daemon that consumes `IntentRegistered` events from the DIA
`OracleIntentRegistry` (DIA Lasernet testnet or mainnet) and submits
matching Cardano oracle update transactions through the contracts
deployed by `offchain/cli/`.

The architecture mirrors
[`diadata-org/Spectra-interoperability/services/bridge`](https://github.com/diadata-org/Spectra-interoperability/tree/main/services/bridge):
modular YAML config, scanner → extractor → enricher → router →
write-client pipeline, per-key transaction queues, HTTP API for health
/ metrics / prices. The Cardano write-client is the only piece that
diverges substantively — it builds Cardano txs via the pure builders in
`offchain/cli/src/lib/` instead of EVM ABI calls.

## Running with Docker

The feeder and all CLI admin commands ship in **one image**
(`dia-cardano-feeder:local`). Docker is the recommended deployment method
because it bundles the compiled feeder, compiled CLI, and all native deps
(better-sqlite3, lucid-evolution) without any host-side Node setup.

All `make` targets below run from `offchain/` (where `Makefile` lives).
Run `make help` for a complete target list.
The Makefile exports your current host `UID`/`GID` so Docker can write to
the bind-mounted `offchain/feeder/state/` tree without leaving it
read-only to the daemon.

### Daemon only

```sh
cp offchain/feeder/.env.example offchain/feeder/.env
# Fill in Blockfrost keys, wallet seeds, etc.

cd offchain
make build          # builds the unified image once
make up             # starts feeder-sqlite in the background
make logs           # tail daemon logs
```

Open `http://localhost:8080/health/live` to verify the daemon is running.

### Daemon + monitoring

```sh
cd offchain
make up-monitoring  # starts feeder-sqlite + Prometheus + Grafana + renderer
```

- Prometheus: `http://localhost:9090` — raw metrics and alert state
  (`/alerts` shows the configured alert rules).
- Grafana: `http://localhost:3000` — default credentials
  `admin` / value of `GRAFANA_ADMIN_PASSWORD` in `.env` (defaults to
  `admin`). The **DIA Cardano Oracle Feeder** dashboard is pre-provisioned.
- Renderer: a `grafana/grafana-image-renderer` sidecar reachable to
  Grafana over the compose network at `http://renderer:8081/render`.
  Grafana is configured via `GF_RENDERING_SERVER_URL` (where to reach
  the renderer) and `GF_RENDERING_CALLBACK_URL` (how the renderer's
  headless Chrome calls back into Grafana to fetch the dashboard).
  Used by `GET /render/d/...` requests to produce PNG snapshots of the
  dashboard. The renderer adds no exposed port; access is only
  intra-compose.

To add a new alert rule, edit
`offchain/feeder/monitoring/alerts.yml` and restart Prometheus
(`docker compose restart prometheus`) — no Grafana changes needed.

### Capturing an operational snapshot

The `scripts/m2-evidence/` directory contains a script that packages a
feeder's current logs, DB tables, live API responses and Grafana
dashboard PNGs into a self-contained dated directory. Useful for
sharing a point-in-time deployment record with another team or
attaching to a release note. The script does not stop or restart the
feeder. See
[`scripts/m2-evidence/README.md`](./scripts/m2-evidence/README.md) for
the full description (inputs, outputs, dependencies, dashboard rendering).

### Admin commands (CLI)

The `cli` compose service runs the same image as the feeder but invokes
`dia-cli` instead of the daemon. It is short-lived and removed after each
run (`--rm`).

```sh
cd offchain

# Inspect protocol state.
make cli CMD="protocol"

# Check wallet balances.
make cli CMD="wallet"
make cli CMD="wallet:utxos"

# Bootstrap a new client (after protocol:init + config:* commands).
make cli CMD="client:init"
make cli CMD="receiver:bootstrap"

# Top up the receiver wallet.
make cli CMD="receiver:top-up --amount-lovelace 5000000000"

# Publish reference scripts for a client.
make cli CMD="reference-scripts:publish-client"

# Trigger a manual settle.
make cli CMD="settle"

# Pair lifecycle.
make cli CMD="pair:burn --symbol BTC/USD"
make cli CMD="pair:dedup --symbol BTC/USD"

# Inspect the shared state tree inside the container.
docker compose -f feeder/docker-compose.yml --project-directory feeder --profile cli run --rm --entrypoint sh cli -c "ls -R /app/state"
```

### One-shot full bootstrap

```sh
cd offchain
make build

# Create wallet, initialise protocol, publish reference scripts,
# bootstrap the protocol on-chain, then register one client.
make bootstrap
```

`make bootstrap` expands to the canonical sequence:

```sh
make cli CMD="wallet:create"
make cli CMD="protocol:init"
make cli CMD="config:parameterize"
make cli CMD="config:reference-scripts"
make cli CMD="config:bootstrap"
make cli CMD="client:init"
make cli CMD="receiver:bootstrap"
make cli CMD="receiver:parameterize"
make cli CMD="reference-scripts:publish-client"
```

### Volume layout

| Host / named volume | Container path | Used by | Contents |
| --- | --- | --- | --- |
| `./config/` | `/config` (ro) | feeder, cli | Modular YAML config |
| `.env` | env_file | feeder, cli | Secrets + selectors |
| `./state/` | `/app/state` | feeder, cli | Bootstrap JSON, pair state, logs, checkpoint, SQLite DB |
| `postgres-data` | (postgres svc) | postgres | Postgres data dir |
| `grafana-data` | `/var/lib/grafana` | grafana | Dashboard and alert state |

## Prerequisites — one-time setup

Before the feeder can submit Cardano transactions it needs two bootstrap
state files produced by the CLI (see
[offchain/cli/README.md](../cli/README.md) for how to run the CLI
bootstrap commands):

| Artifact | Produced by CLI command |
| --- | --- |
| `state/<network>/config-bootstrap.json` | `config:bootstrap` |
| `state/<network>/clients/<id>.json` | `receiver:bootstrap` |

The `feeder init` commands handle the copy automatically:

```sh
cd offchain/feeder

# Copy config-bootstrap.json from the latest CLI state run.
# Auto-scans ../cli/state/ for matching network dirs; or use --from.
npm run feeder:dev -- init bootstrap

# Copy a client JSON and interactively generate its router YAML.
npm run feeder:dev -- init client

# Re-init with a specific source (skip auto-scan).
npm run feeder:dev -- init bootstrap --from ../cli/state/preview_run_20260516-090057
npm run feeder:dev -- init client    --from ../cli/state/preview_run_20260516-090057/clients/client-a.json

# Overwrite existing files without prompting.
npm run feeder:dev -- init bootstrap --force
npm run feeder:dev -- init client    --force
```

Docker Compose bind-mounts `offchain/feeder/state/` into `/app/state`,
so the container uses the exact same `state/<network>/...` tree you see
locally in the repo.

`--clean` never deletes bootstrap state files — only feeder-generated
runtime state. Re-running `init` on an existing setup asks for
confirmation before overwriting.

If the feeder starts and a required state file is missing it exits
immediately with the exact `init` command needed to fix it.

## Usage

```sh
cd offchain/feeder
npm install
cp .env.example .env
# fill in secrets from offchain/cli/.env (see Environment below)

# Validate the modular config and exit.
npm run feeder:dev -- --validate-only

# --scan: runs scanner + enricher only. Prints enriched intents as they
# arrive. The router, coalescer, and write-client are not started at all.
# Use this to verify connectivity with the DIA registry before going live.
npm run feeder:dev -- --scan --transport http
npm run feeder:dev -- --scan --transport ws   # requires DIA_WS_CREDENTIAL_*

# --dry-run: runs the full pipeline (scanner → router → coalescer →
# write-client) but the write-client is a no-op stub — no Cardano txs
# are submitted and no fees are spent. All logs, lane events, and the
# API server run exactly as in production. Use this to validate the
# full routing logic end-to-end.
npm run feeder:dev -- --dry-run
npm run feeder:dev -- --dry-run --transport ws

# Run the full daemon (HTTP polling, default transport).
npm run feeder:dev

# Run the full daemon (WebSocket).
npm run feeder:dev -- --transport ws

# Wipe all feeder-generated state and start fresh from the current chain tip.
# Without --from-latest / --from-block the scanner resumes from the YAML
# start_block, which may be weeks old — most intents will be expired.
npm run feeder:dev -- --clean --from-latest

# Start from a specific block (e.g. after a known deployment or incident).
npm run feeder:dev -- --clean --from-block 7800000

# --from-latest / --from-block can also be used without --clean to re-seed
# an existing checkpoint without wiping other runtime state.
npm run feeder:dev -- --from-latest
npm run feeder:dev -- --from-block 7800000
```

The active network (Cardano Preview ↔ DIA Testnet, Cardano Mainnet ↔
DIA Mainnet) is selected by `CARDANO_NETWORK` in `.env`.

## Flags

| Flag | Default | Description |
|---|---|---|
| `--config <dir>` | `./config` | Modular config directory |
| `--transport http\|ws` | `http` | Scanner transport |
| `--scan` | — | Scanner + enricher only — router/coalescer/write-client not started. Verify DIA registry connectivity. |
| `--dry-run` | false | Full pipeline with a no-op write-client — no Cardano txs, no fees. All logs and API run normally. Also `DRY_RUN=true` env |
| `--validate-only` | — | Load + validate config and exit |
| `--clean` | false | Delete feeder-generated state before starting (see below) |
| `--from-block <N>` | — | Seed the checkpoint to block N−1 before starting; scanner processes from block N onwards. Mutually exclusive with `--from-latest`. |
| `--from-latest` | false | Query the current chain tip via RPC and seed the checkpoint to that block; only intents arriving after startup are processed. Mutually exclusive with `--from-block`. |
| `--log-level debug\|info\|warn\|error` | `info` | Console verbosity (file always gets everything) |
| `--help` | — | Show help |

### `--log-level` — what each level shows

| Level | Console shows |
|---|---|
| `debug` | Everything — including `condition-filtered` (very noisy: one per non-matching intent, ~10/s), `policy-filtered`, scanner block deliveries (`scanner-ws: delivered N log(s)`), bridge internal calls (connecting, building, UTxO fetches) |
| `info` (default) | Daemon lifecycle, tx milestones (submitted, confirmed/failed), lane events |
| `warn` | Transaction failures, preflight rejections, reconcile warnings |
| `error` | Only TRANSACTION FAILED and fatal errors |

The log file (`feeder.log`) always receives all lines regardless of `--log-level`.
Level prefixes (`[debug]`, `[warn]`, `[error]`) are preserved in the file for
grep/filtering; they are stripped from console output.

### `--clean` — what gets deleted

Deletes all files the feeder writes at runtime. CLI bootstrap state files
are never touched.

| Deleted | Reason |
|---|---|
| `state/<network>/logs/` | All log streams (feeder.log, transactions.jsonl, lane.jsonl, intents/) |
| `state/<network>/feeder-checkpoint.json` | Block scanner position — resumes from block 0 |
| `state/<network>/feeder.sqlite*` | Full DB reset (processed_events, chain_state, transaction_log) |
| `state/<network>/clients/*/pairs/*.json` | Feeder-written pair state — reconstructed from chain on next update |

| Never deleted | Why |
|---|---|
| `state/<network>/config-bootstrap.json` | CLI state file (`config:bootstrap`) |
| `state/<network>/clients/*.json` | CLI state file (`receiver:bootstrap`) |

## Log streams

The feeder writes four separate log streams under `state/<network>/logs/`:

| File | Contents |
|---|---|
| `feeder.log` | Linear event stream — one line per daemon event (mirrors stderr) |
| `transactions.jsonl` | One JSON line per tx pipeline step in real time: `tx_start`, `connecting`, `building`, `signing`, `submitting`, `submitted` (with txHash), `waiting_confirm`, `waiting_utxo`, `writing_state`, `tx_confirmed`/`tx_failed`. Plus a final summary line with per-step ms timings. |
| `lane.jsonl` | Lane state events: `intent_buffered`, `intent_superseded`, `flush_triggered`, `flush_empty`, `tx_confirmed_reflush`, `lane_idle` |
| `intents/<ts>_<hash>.log` | Per-intent lifecycle: enriched → routed → queued → step-by-step → superseded OR confirmed OR failed |

## Environment

**Design rule:** the YAML config in `config/` is the single source of
truth for every public data point (chain ids, RPC URLs, WS URLs, registry
addresses, ABIs). `.env` carries only secrets and selectors.

The feeder's `.env` carries:

- **Selectors** — `CARDANO_NETWORK`, `CARDANO_PROVIDER`, `DRY_RUN`
- **Cardano-side secrets** — `BLOCKFROST_PROJECT_ID_*`,
  `BLOCKFROST_API_URL_*`, `KOIOS_API_URL_*`, `CARDANO_WALLET_SEED_*`,
  `CARDANO_PRIVATE_KEY_*`
- **DIA-side secret** — `DIA_WS_CREDENTIAL_*` (WebSocket transport only)
- **Feeder daemon ops** — `API_LISTEN_ADDR`, `METRICS_ENABLED`,
  `METRICS_NAMESPACE`, `DATABASE_DRIVER`, `DATABASE_PATH_*`,
  `DATABASE_DSN_*`, `FEEDER_LOG_DIR`

Variables that live in YAML (not in `.env`):

| Variable | Lives in |
|---|---|
| `DIA_SOURCE_CHAIN_ID_*` | `config/infrastructure.<network>.yaml::source.chain_id` |
| `DIA_RPC_URL_*` | `config/infrastructure.<network>.yaml::source.rpc_urls` |
| `DIA_WS_URL_*` | `config/infrastructure.<network>.yaml::source.ws_url` |
| `DIA_REGISTRY_ADDRESS_*` | `config/contracts.yaml::<id>.address` |

The scanner's starting block is controlled by three mechanisms, in priority order:

1. **`--from-latest` / `--from-block N`** — seed the checkpoint at startup. Use these after `--clean` to avoid replaying weeks of already-expired intents.
2. **Persisted checkpoint** — `state/<network>/feeder-checkpoint.json` stores `last_processed_block`; the scanner resumes from checkpoint+1 on restart.
3. **YAML `source.start_block`** — the fallback when no checkpoint exists (e.g. first run after `--clean` without `--from-*`).

## Config layout

```text
config/
├── infrastructure.preview.yaml     # source RPC/WS, scanner, dedup, API, DB (Preview ↔ DIA Testnet)
├── infrastructure.mainnet.yaml     # same shape for Mainnet ↔ DIA Mainnet
├── chains.yaml                     # DIA Testnet/Mainnet chain definitions
├── contracts.yaml                  # OracleIntentRegistry per network (ABI + address)
├── events.yaml                     # IntentRegistered ABI + getIntent enrichment
└── routers/
    └── client-a.preview.yaml       # 10 active DIA testnet pairs → one Cardano client
```

### Validation

Every YAML is checked at load time. A subset of what the validator catches:

- destination declares both `method:` (EVM) and `cardano:`, or neither
- destination declares an EVM `method:` block (this feeder is Cardano-only)
- router referencing an undefined event in `events.yaml`
- unknown `triggers.conditions[].operator`
- `cardano:` block with invalid `network` or missing
  `client_state_path` / `protocol_state_path`
- non-conventional `private_key_env` name (warning)

Run `npm run feeder:dev -- --validate-only` to see the full report.

### `event_processor` knobs

The lane coalescer reads these keys from `infrastructure.<network>.yaml::event_processor`:

| Key | Meaning |
|---|---|
| `coalesce_window` | Initial accumulation window before the first flush in an idle lane |
| `max_intent_age` | Drop buffered intents older than this when the lane flushes |
| `max_batch_size` | Hard cap on symbols included in one Cardano batch update tx |
| `size_fallback_enabled` | When `true`, split an oversized batch into smaller retries automatically |

## HTTP API

The daemon exposes a lightweight HTTP API (default `0.0.0.0:8080`):

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness alias |
| `GET /health/live` | Liveness — always 200 if the process is running |
| `GET /health/ready` | Readiness — 200 only if last registry poll is within `max_processing_lag` |
| `GET /metrics` | Prometheus metrics (requires `METRICS_ENABLED=true`) |
| `GET /api/v1/prices` | Latest confirmed prices per `(routerId, destinationIndex, symbol)` |
| `GET /api/v1/prices/:symbol` | Latest confirmed prices for one symbol across destinations |
| `GET /api/v1/symbols` | Symbols declared in the active router YAMLs |
| `GET /api/v1/symbols/:symbol/updates` | Recent joined transaction rows for one symbol |
| `GET /api/v1/transactions/:txHash` | Enriched view of one Cardano tx and its member intents |
| `GET /api/v1/chains` | Source-chain status from YAML + runtime state |
| `GET /api/v1/chains/:id/status` | One chain status entry |

### What "confirmed" means

Every entry returned by `/api/v1/prices` carries a `confirmedAtDepth` field.
This is the number of Cardano blocks that elapsed between the tx's inclusion
block and the moment the feeder declared it confirmed — i.e. the value of
`cardano.confirmation_depth` in `infrastructure.<network>.yaml` (default `1`).

| `confirmedAtDepth` | Meaning |
| --- | --- |
| `1` (default) | The tx was observed in **one block** by at least one indexer provider (Blockfrost primary, Koios or Blockfrost REST as fallback). Probabilistically final: rollbacks beyond 1–2 blocks are essentially unobserved on mainnet. |
| `3`–`5` | Practical finality for most DeFi integrations. |
| `2160` | Cryptographic security bound (Ouroboros Praos, `k = 2160` blocks ≈ 12 hours). Never needed for oracle feeds. |

**Cardano finality model**: Cardano uses Ouroboros Praos. The maximum
theoretical rollback depth is `k = 2160` blocks (~12 hours at ~20 s/block).
In practice, rollbacks deeper than 1–2 blocks are not observed on mainnet.
For a price oracle feed, `confirmation_depth = 1` is practically sufficient.

To configure a stricter depth: set `cardano.confirmation_depth` in
`config/infrastructure.<network>.yaml`. The feeder waits for
`confirmation_depth` additional blocks before emitting `tx_confirmed`,
updating the price cache, and recording the event in the DB.

**Reorg handling**: in this feeder, a "reorg" means a Cardano rollback
where a transaction that had already looked confirmed is later no longer
present on the canonical chain.

The feeder detects this conservatively. After confirmation, and again
during the long post-confirmation UTxO wait loops, it checks the
transaction hash against **both** Koios and Blockfrost REST. It treats
the transaction as dropped only when **both** providers definitively
report it missing. A single provider outage, timeout, or transient
indexer lag does **not** count as a reorg.

When that happens, the feeder classifies the failure as
`TxDroppedFromChain`, increments
`dia_bridge_transactions_reorg_total{symbol, client_id}`, and applies
the normal queue retry policy for transient submission failures. If
retries are exhausted, the failure is recorded in the logs/metrics, and
a later fresh intent can produce a new Cardano transaction.

The `ReorgCounter` panel in Grafana therefore means: "transactions that
looked confirmed at first, but were later dropped from the canonical
chain after a rollback."

## Thresholds and alerts

Operational thresholds live in two places with explicit responsibilities:

- `infrastructure.<network>.yaml::alerting.<key>` — **canonical source**.
  The feeder code reads these values directly (e.g. to emit
  `dia_bridge_cardano_receiver_topup_warnings_total` when the receiver
  balance drops below `receiver_balance_low_lovelace`).
- `monitoring/alerts.yml` (Prometheus rules) — mirrors the YAML values
  in alert `expr` lines. Each rule carries an inline comment naming the
  YAML key so the two cannot drift silently. Operators tune thresholds
  in the YAML; if you change a number, update `alerts.yml` to match.

**Units convention**: balances are **lovelace** (1 ADA = 1 000 000
lovelace). Time intervals are **seconds** (or `_ms` for milliseconds).
Price deviation is **percent** (0–100).

### Full alert map

| Alert | Metric | YAML key | Default | Action |
| --- | --- | --- | --- | --- |
| `OraclePairStale` | `dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds` | `oracle_pair_stale_seconds` | `3600` s | Investigate scanner / DIA source. |
| `ReceiverBalanceLow` | `dia_bridge_cardano_receiver_balance_lovelace` | `receiver_balance_low_lovelace` | `2 000 000 000` (2 ADA) | `dia-cli receiver:top-up --amount-lovelace 5000000000` |
| `SettleOverdue` | `dia_bridge_cardano_receiver_accrued_lovelace` | `settle_overdue_lovelace` | `10 000 000` (10 ADA) | `dia-cli settle` |
| `PaymentHookWithdrawReady` | `dia_bridge_cardano_payment_hook_accrued_lovelace` | `payment_hook_withdraw_ready_lovelace` | `50 000 000` (50 ADA) | DIA admin runs `dia-cli payment-hook:withdraw` |
| `AdminWalletLow` | `dia_bridge_cardano_admin_wallet_lovelace` | `admin_wallet_low_lovelace` | `5 000 000 000` (5 ADA) | Refill the operator/signer wallet. |
| `PriceDeviationHigh` | `dia_bridge_price_deviation_percent_bucket` (p95) | `price_deviation_high_percent` | `5` % | Investigate DIA source — possible misreport. |
| `PriceAgeHigh` | `dia_bridge_price_age_seconds_bucket` (p95) | `price_age_high_seconds` | `600` s | DIA source publishing stale prices. |
| `ReorgRateHigh` | `dia_bridge_transactions_reorg_total` | (alerts.yml only) | `> 3 / 1 h` | Check provider lag + scanner block-lag panel. |

### Operational wallets at a glance

The feeder emits four balance gauges, one per operational wallet involved
in the oracle update flow:

| Gauge | Wallet | Behaviour |
| --- | --- | --- |
| `dia_bridge_cardano_receiver_balance_lovelace{client_id}` | Per-client Receiver UTxO `balanceLovelace` | Drains by `protocolFee` per oracle update. Top-up needed when low. |
| `dia_bridge_cardano_receiver_accrued_lovelace{client_id}` | Per-client Receiver UTxO `accruedToHookLovelace` | Grows by `protocolFee` per oracle update. Settle drains it to the PaymentHook. |
| `dia_bridge_cardano_payment_hook_accrued_lovelace` | Singleton PaymentHook `accruedFeesLovelace` (DIA-managed) | Grows on each `settle`. DIA withdraws via `payment-hook:withdraw`. |
| `dia_bridge_cardano_admin_wallet_lovelace` | Operator/signer wallet (off-chain) | Pays Cardano tx fees for every oracle update. Receives PaymentHook withdrawals. |

All four are emitted post-confirm by the bridge — the feeder re-queries
chain state right after `tx_confirmed` so the gauges reflect actual UTxO
contents. A transient provider failure leaves an individual gauge
unchanged (no misleading 0).

## Spectra parity and Cardano divergences

This feeder is intentionally close to
[`diadata-org/Spectra-interoperability/services/bridge`](https://github.com/diadata-org/Spectra-interoperability/tree/main/services/bridge):
same modular YAML config layout, same scanner → enricher → router →
write-client pipeline, same HTTP API surface, same metric prefix
(`dia_bridge_*`). Most code-path behaviours map 1:1.

The Cardano-destination side diverges where the EUTxO model forces it
and where Spectra config fields are dead (declared but never read in
Spectra itself). The table below is the canonical reference:

| Concept | Spectra | This feeder | Why |
| --- | --- | --- | --- |
| Worker pool (`worker_pool.max_workers`, `task_queue_size`) | Per-router pool with N concurrent submission workers. | **Not implemented**. We use a per-client "lane" model: one serial queue per `(client_state_path, protocol_state_path)`. Cross-lane parallelism comes from multiple clients (different Receivers), not multiple workers within a lane. | Cardano's EUTxO model serialises spends of the same Receiver UTxO. Parallel workers on one lane would conflict. The keys are intentionally absent from our YAMLs. |
| In-flight lock timeout (`worker_pool.inflight_timeout_ms`) | Not present. | **Required**. Cardano-specific because the lane lock is held while a tx is in-flight. Default 15 min. | Reflects the wall-clock ceiling on Cardano submit+confirm. |
| Parallel event processor (`event_processor.enable_parallel_mode`, `parallel_*`) | Active — parallel enrichment + gas-est pipeline. | Declared as M3 placeholders, not read. | Sequential processing meets M2 throughput; this is a genuine future optimisation. |
| Block scanner gap recovery (`block_scanner.backward_sync`, `max_block_gap`, `head_tracker_interval`, `gap_detection_interval`) | Active — backfill in 5000-block chunks when the gap exceeds `max_block_gap`. | **Active**: when `backward_sync: true`, the scanner switches to 5000-block chunks (vs `block_range` default 500) and skips `scan_interval` between chunks until caught up. Emits `dia_bridge_scanner_backfill_*` counters. | Chain-agnostic; reuses Spectra's design. |
| Cron service (`cron_service.*` + per-destination `cron: true`) | Active — per-router cron timer re-pushes the latest cached intent when `time_threshold` elapsed. | **Active**: ticks every `cron_service.tick_interval`, re-submits via the same queue as the event-driven flow. Outcome partitioned in `dia_bridge_cron_resubmissions_total{outcome}`. | Required for M2 "uptime and accuracy" guarantees when the deviation filter drops every event. |
| `health_check.max_processing_lag` | Declared but never read in Spectra. | **Active** — drives the `registry` check in `/health/ready`. | Cardano-feeder extension. |
| `health_check.timeout`, `max_queue_size`, `recovery.*`, `event_processor.batch_size`, `validation_timeout` | Declared but never read in Spectra. | **Removed** from our types + YAMLs (cruft in both repos). | Reduces operator confusion. |
| `replica.*` | Active — HA failover monitor. | Declared as M3 placeholder. | Operational HA, not required for M2 functional correctness. |
| `cardano.confirmation_depth` | N/A. | **Active** — feeder waits `(depth - 1) × 20 s` past inclusion and re-verifies the tx is still on chain. Reflected in `/api/v1/prices` `confirmedAtDepth`. | Cardano-specific (Ouroboros Praos finality model). |
| `alerting.*` block | N/A. | **Active** — canonical thresholds for both feeder warnings and Prometheus alert rules. | Centralises operational thresholds; documented above. |

If you are porting a deployment FROM Spectra to this feeder:

- Drop `event_processor.{batch_size, validation_timeout}`,
  `worker_pool.{max_workers, task_queue_size}`,
  `health_check.{timeout, max_queue_size}`, and the `recovery` block —
  they are silently ignored.
- Add `cardano.confirmation_depth`, the `alerting:` block, and
  `worker_pool.inflight_timeout_ms` — all required by our validator.
- Per Cardano destination, optionally add `cron: true` +
  `time_threshold: 5m` to opt into cron-driven liveness.
