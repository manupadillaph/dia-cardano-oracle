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

## Usage

```sh
cd offchain/feeder
npm install
cp .env.example .env
# fill in secrets from offchain/cli/.env (see Environment below)

# Validate the modular config and exit.
npm run feeder:dev -- --validate-only

# Scan the live source registry without submitting Cardano txs.
npm run feeder:dev -- --scan --transport http
npm run feeder:dev -- --scan --transport ws   # requires DIA_WS_CREDENTIAL_*

# Run the full daemon (HTTP polling, default transport).
npm run feeder:dev

# Run the full daemon (WebSocket).
npm run feeder:dev -- --transport ws

# Wipe all feeder-generated state and start clean.
npm run feeder:dev -- --clean

# Dry-run: pipeline runs but no Cardano txs are submitted.
npm run feeder:dev -- --dry-run
```

The active network (Cardano Preview ↔ DIA Testnet, Cardano Mainnet ↔
DIA Mainnet) is selected by `CARDANO_NETWORK` in `.env`.

## Flags

| Flag | Default | Description |
|---|---|---|
| `--config <dir>` | `./config` | Modular config directory |
| `--transport http\|ws` | `http` | Scanner transport |
| `--dry-run` | false | Pipeline runs; no Cardano txs submitted. Also `DRY_RUN=true` env |
| `--clean` | false | Delete feeder-generated state before starting (see below) |
| `--validate-only` | — | Load + validate config and exit |
| `--scan` | — | Run scanner+enricher only, no submission |
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

Deletes all files the feeder writes at runtime. CLI bootstrap artifacts
are never touched.

| Deleted | Reason |
|---|---|
| `state/<network>/logs/` | All log streams (feeder.log, transactions.jsonl, lane.jsonl, intents/) |
| `state/<network>/feeder-checkpoint.json` | Block scanner position — resumes from block 0 |
| `state/<network>/feeder.sqlite*` | Full DB reset (processed_events, chain_state, transaction_log) |
| `state/<network>/clients/*/pairs/*.json` | Feeder-written pair state — reconstructed from chain on next update |

| Never deleted | Why |
|---|---|
| `state/<network>/config-bootstrap.json` | CLI artifact (`config:bootstrap`) |
| `state/<network>/clients/*.json` | CLI artifact (`receiver:bootstrap`) |

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

The scanner's starting block is not an env var — it lives in
`config/infrastructure.<network>.yaml` under `source.start_block`.
Once the feeder has seen at least one block, the persisted
`chain_state.last_processed_block` checkpoint wins over the YAML default.

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
- `cardano:` block with invalid `network`, `tx_mode`, or missing
  `client_state_path` / `protocol_state_path`
- non-conventional `private_key_env` name (warning)

Run `npm run feeder:dev -- --validate-only` to see the full report.

## HTTP API

The daemon exposes a lightweight HTTP API (default `:8080`):

| Endpoint | Description |
|---|---|
| `GET /healthz` | Liveness — always 200 if the process is running |
| `GET /readyz` | Readiness — 200 only if last registry poll is within `max_processing_lag` |
| `GET /metrics` | Prometheus metrics (requires `METRICS_ENABLED=true`) |
| `GET /prices` | Latest confirmed price per (routerId, destinationIndex, symbol) |
