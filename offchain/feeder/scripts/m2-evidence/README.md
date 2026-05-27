# Feeder operator scripts

Standalone scripts used to operate and audit a running feeder
deployment. Run them from the repo root (or anywhere — they resolve
paths from `$BASH_SOURCE`).

## `package-m2-evidence.sh`

Single-use script that assembles the **Milestone 2 evidence pack** for
the Catalyst submission. Snapshots a feeder's operational state at one
point in time into a self-contained dated directory under
`docs/milestones/evidence/m2-preview-<YYYYMMDD-HHMMSS>/`.

### Catalyst context

Milestone 2 of the DIA Cardano Oracle Catalyst project requires:

- Feeder source code (delivered in `offchain/feeder/`).
- Test coverage demonstrating oracle liveness via confirmed Cardano txs.
- QA review logs showing anomaly detection (stale data, misreports) and
  automated alerts.
- A demo of dashboards used by DIA for QA and anomaly detection.
- Developer documentation with integration examples.

This script produces the artefacts that satisfy outputs 2, 3 and the
QA-dashboard part of the demo, in a format that mirrors the Milestone 1
evidence packs already accepted under `docs/milestones/evidence/`.

### When to run it

After the feeder has accumulated useful activity against Cardano
Preview ↔ DIA Testnet (typically a 48–72 h evidence window).

The script does **not** stop or restart the feeder. You can run it any
number of times during a long-running deployment and each run produces
a fresh dated directory.

### What it reads

All inputs are hardcoded to the project-default paths — no parameters:

| Source | Path |
| --- | --- |
| Daemon logs (`feeder.log`, `transactions.jsonl`, `lane.jsonl`, `intents/`) | `offchain/feeder/state/preview/logs/` |
| Persistent state (`transaction_log`, `processed_events`, `chain_state`) | `offchain/feeder/state/preview/feeder.sqlite` |
| Live HTTP API (`/api/v1/prices`, `/chains`, `/symbols`, `/metrics`) | `http://localhost:8080` |
| Grafana dashboards | `http://localhost:3000` (requires the `monitoring` profile to be up) |

If the feeder API or Grafana is unreachable the script degrades
gracefully: it writes a placeholder file in the affected sub-directory
explaining what is missing and continues with the other steps.

### What it writes

```text
docs/milestones/evidence/m2-preview-<YYYYMMDD-HHMMSS>/
├── milestone-2-preview-evidence.md   # Catalyst-facing evidence document
├── SUMMARY.json                      # Machine-readable totals
├── logs/                             # Verbatim copies of the 4 feeder log streams
│   ├── feeder.log
│   ├── transactions.jsonl
│   ├── lane.jsonl
│   └── intents/
├── db/                               # CSV dumps of SQLite tables
│   ├── transaction_log.csv
│   ├── processed_events.csv
│   └── chain_state.csv
├── api/                              # Snapshots of the live HTTP API at pack time
│   ├── prices.json
│   ├── chains.json
│   ├── symbols.json
│   └── metrics.txt
├── dashboards/                       # PNG snapshots of the Grafana dashboard
│   ├── dashboard-full.png
│   └── panel-*.png
└── stats/                            # Intermediate TSV files used to build the markdown
    ├── symbol-counts.tsv
    ├── symbol-tx-hashes.tsv
    ├── symbol-latency.tsv
    └── error-counts.tsv
```

The `milestone-2-preview-evidence.md` is the document the Catalyst
reviewer reads. It mirrors the structure of
`docs/milestones/evidence/m1-preview-20260516-090057/milestone-1-preview-evidence.md`
and carries:

- The window covered (first/last tx event observed in `transactions.jsonl`).
- A table of **Official Milestone 2 Outputs** with status per output.
- Aggregate totals (confirmed tx count, failures, reorgs).
- A pair-by-pair table with confirmed tx counts.
- A sample Cardano tx hash per pair, intended for spot-checking on
  Cardanoscan Preview / any public explorer.
- Per-pair end-to-end latency p50/p95 from `IntentRegistered` to
  `tx_confirmed`.
- Failures grouped by `FeederErrorCode`.
- A directory of every raw artefact included in the pack.

### How the dashboard PNG snapshots work

Grafana does not render PNGs out of the box — it delegates to the
`grafana-image-renderer` headless-Chrome sidecar, started under the
`monitoring` compose profile. Grafana finds the renderer via
`GF_RENDERING_SERVER_URL=http://renderer:8081/render` and the renderer
calls back into Grafana via `GF_RENDERING_CALLBACK_URL=http://grafana:3000/`.
Both endpoints live on the compose-internal network; the renderer does
not expose a host port.

The script hits `GET /render/d/<dashboard-uid>/<slug>` for the full
dashboard and `GET /render/d-solo/<dashboard-uid>/panel?panelId=N` for
each interesting panel (IDs taken from
`monitoring/grafana/dashboards/feeder.json`).

If the renderer is not up the script writes `dashboards/README.txt`
explaining how to bring it up, and proceeds without the PNGs.

### Dependencies

Standard Linux tooling: `bash`, `jq`, `sqlite3`, `curl`, `awk`.
No Node, no Python, no Docker host access required.

### Run it

```sh
# (Optional) bring up monitoring + renderer so dashboard PNGs land in the pack
cd offchain && make up-monitoring

# Capture a snapshot of whatever state the feeder has now
./offchain/feeder/scripts/package-m2-evidence.sh
```

Output directory is printed at the end. Re-running creates a brand-new
dated directory — previous snapshots are never overwritten.

## `scan-dia-intents.ts`

TypeScript helper that scans DIA Lasernet for `IntentRegistered` events
and reports which symbols are currently active. Useful when you need to
decide which pairs to bind a Cardano destination to in
`config/routers/<router>.yaml`.

Run with `npm run` from `offchain/feeder/` (see the script header for
the exact invocation).
