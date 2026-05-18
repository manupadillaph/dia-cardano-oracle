# DIA Cardano Oracle

Implementation repository for the DIA oracle integration on Cardano.

The source-of-truth architecture is:

- [Cardano Oracle Architecture](docs/architecture/cardano-oracle-architecture.md)

Project and delivery documents:

- [Final Cardano Milestones](docs/milestones/final-cardano-milestones.md)
- [Milestone 1 Preview Evidence](docs/milestones/evidence/m1-preview-20260516-090057/milestone-1-preview-evidence.md)
- [Milestone 1 Mainnet Evidence](docs/milestones/evidence/m1-mainnet-20260517-063917/milestone-1-mainnet-evidence.md)
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

The end-to-end Preview runbook lives in
[`offchain/cli/README.md`](offchain/cli/README.md). At a glance, the phases are:

1. Wallet setup.
2. Protocol deployment (Config, PaymentHook, coordinator).
3. Client deployment (per-client Receiver and Pair scripts).
4. Oracle intent flow (create + sign).
5. Live updates (single and batch).
6. Maintenance transactions (settle, withdraws, min-UTxO updates, pair burn,
   reference-script reclaim).

For the protocol design behind each phase — datums, redeemers, cross-script
invariants, fee flow, batch validation algorithm, trust model — see the
[architecture document](docs/architecture/cardano-oracle-architecture.md)
and [security notes](docs/security/m1-security-notes.md).
