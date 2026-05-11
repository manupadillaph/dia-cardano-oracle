# DIA Cardano Oracle

Implementation repository for the DIA oracle integration on Cardano.

The source-of-truth architecture is:

- [Cardano Oracle Architecture](docs/architecture/cardano-oracle-architecture.md)

Project and delivery documents:

- [Final Cardano Milestones](docs/milestones/final-cardano-milestones.md)
- [Milestone 1 Preview Evidence](docs/milestones/evidence/m1-preview-20260506-084452/milestone-1-preview-evidence.md)
- [Requirements](docs/requirements/cardano-integration-requirement-pf.md)

Component docs:

- [On-chain contracts (Aiken)](contracts/aiken/README.md)
- [Off-chain CLI runbook](offchain/cli/README.md)

## Repository Scope

- `contracts/`: on-chain implementation
- `offchain/`: off-chain components and operator tooling
- `docs/`: architecture, milestones, requirements, plans, references

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

Use [`offchain/cli/README.md`](offchain/cli/README.md) for the step-by-step Preview runbook:

- protocol bootstrap (Config, PaymentHook, coordinator stake registration)
- global and client reference-script publication
- client onboarding (per-client Receiver and Pair scripts)
- pair create/update through signed oracle intents
- single and batch updates, including first-time pair creation
- decoupled fee settlement with formula `base + n × per_pair`: every update
  accrues the protocol fee on the Receiver datum (base fee + per-pair fee for
  each pair in the batch); an admin-initiated Settle transaction periodically
  drains the accrued fees from one or more Receivers into the global
  PaymentHook in a single batched transaction
- admin and withdrawal transactions

The full transaction model, including Settle, is documented in the
[architecture document](docs/architecture/cardano-oracle-architecture.md) — see
§5 (per-transaction details) and §7.4 (per-transaction validation
tables).
