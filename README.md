# DIA Cardano Oracle

Implementation repository for the DIA oracle integration on Cardano.

The source-of-truth architecture is:

- [Cardano Oracle Architecture](docs/architecture/cardano-oracle-architecture.md)

Project and delivery documents:

- [Final Cardano Milestones](docs/milestones/final-cardano-milestones.md)
- ([Project Catalyst](https://milestones.projectcatalyst.io/projects/1400073))
- [Milestone 1 Proof of Achievement](docs/milestones/evidence/m1-mainnet-20260517-063917/milestone-1-poa.md) — Catalyst submission document
- [Milestone 1 Preview Evidence](docs/milestones/evidence/m1-preview-20260516-090057/milestone-1-preview-evidence.md)
- [Milestone 1 Mainnet Evidence](docs/milestones/evidence/m1-mainnet-20260517-063917/milestone-1-mainnet-evidence.md)
- [Requirements](docs/requirements/cardano-integration-requirement-pf.md)

Component docs:

- [On-chain contracts (Aiken)](contracts/aiken/README.md)
- [Off-chain CLI runbook](offchain/cli/README.md) — protocol bootstrap, client onboarding, maintenance txs (settle, withdraw, pair lifecycle).
- [Feeder daemon](offchain/feeder/README.md) — long-running service that consumes DIA Lasernet `OracleIntent` events and submits Cardano oracle updates (M2 deliverable).

## Repository Scope

- `contracts/`: on-chain Aiken implementation.
- `offchain/cli/`: admin CLI — protocol/client bootstrap, treasury ops, lifecycle txs.
- `offchain/feeder/`: long-running feeder daemon — DIA → Cardano pipeline, HTTP API, Prometheus metrics, cron-based liveness.
- `offchain/Makefile`: operator shortcuts wrapping the unified `dia-cardano-feeder` Docker image (CLI + feeder in one image; profiles `sqlite`, `postgres`, `cli`, `monitoring`).
- `docs/`: architecture, milestones, requirements, plans, references.

## Prerequisites

- **Node.js 20+** with `npm`, for the off-chain CLI.
- **Aiken `v1.1.21`** (Plutus V3), only required if you intend to modify or
  rebuild the on-chain contracts. See the
  [official installation instructions](https://aiken-lang.org/installation-instructions).
  The compiled blueprint `contracts/aiken/plutus.json` is committed in this
  repository, so a fresh clone can run the CLI runbook without installing
  Aiken first.
- A **Blockfrost** project id (or a Koios endpoint) for Cardano Preview, and
  a funded Preview wallet seed. Setup details are in the CLI runbook.

## Quick Start

For a fresh clone, the recommended order is:

1. (Optional) Build and test the on-chain contracts —
   see [`contracts/aiken/README.md`](contracts/aiken/README.md).
2. Install and configure the off-chain CLI — see
   [`offchain/cli/README.md`](offchain/cli/README.md).
3. Follow the CLI runbook end-to-end on Preview.

Step 1 can be skipped if you have not modified the contracts; the committed
`plutus.json` is the canonical compiled artifact that the CLI consumes.

## Operator Workflow

Two complementary surfaces:

**CLI (admin, one-shot ops)** — full Preview runbook in
[`offchain/cli/README.md`](offchain/cli/README.md). Phases:

1. Wallet setup.
2. Protocol deployment (Config, PaymentHook, coordinator).
3. Client deployment (per-client Receiver and Pair scripts).
4. Oracle intent flow (create + sign).
5. Live updates (single and batch).
6. Maintenance transactions (settle, withdraws, min-UTxO updates, pair burn,
   reference-script reclaim).

**Feeder daemon (M2, long-running)** — full operator manual in
[`offchain/feeder/README.md`](offchain/feeder/README.md). Pipeline:

1. Subscribe to DIA Lasernet `OracleIntent` events (WebSocket or HTTP polling).
2. Enrich, dedup, route by per-router policy (`time_threshold`, `price_deviation`).
3. Coalesce into per-lane batches and submit Cardano oracle update txs.
4. Cron-driven liveness — re-push the latest cached intent when a pair has
   gone stale beyond `time_threshold` (Spectra parity).
5. Expose `/health`, `/metrics`, `/api/v1/prices` over HTTP.
6. Optional monitoring profile — Prometheus + Grafana with alert rules covering
   pair staleness, balance thresholds, price anomalies, reorgs.

The fastest path to a working deployment is the unified Docker image:

```sh
cd offchain
make build               # builds the dia-cardano-feeder image (feeder + CLI)
make up                  # starts the feeder daemon (sqlite profile)
make up-monitoring       # adds Prometheus + Grafana
make cli CMD="protocol"  # one-shot CLI command in the same image
```

For the protocol design behind each phase — datums, redeemers, cross-script
invariants, fee flow, batch validation algorithm, trust model — see the
[architecture document](docs/architecture/cardano-oracle-architecture.md)
and [security notes](docs/security/m1-security-notes.md).
