# DIA Cardano Oracle

Implementation repository for the DIA oracle integration on Cardano.

The source-of-truth architecture is:

- [Cardano Oracle Architecture](docs/architecture/cardano-oracle-architecture.md)

Project and delivery documents:

- [Final Cardano Milestones](docs/milestones/final-cardano-milestones.md)
- [Milestone 1 Preview Evidence](docs/milestones/milestone-1-preview-evidence.md)
- [Work Plan](docs/plans/work-plan.md)
- [Requirements](docs/requirements/cardano-integration-requirement-pf.md)

Component docs:

- [On-chain contracts (Aiken)](contracts/aiken/README.md)
- [Off-chain CLI runbook](offchain/cli/README.md)

## Repository Scope

- `contracts/`: on-chain implementation
- `offchain/`: off-chain components and operator tooling
- `docs/`: architecture, milestones, requirements, plans, references
- `e2e/`: end-to-end validation artifacts
- `scripts/`: automation helpers
- `infra/`: infrastructure artifacts

## Operator Workflow

Use [`offchain/cli/README.md`](offchain/cli/README.md) for the step-by-step Preview runbook:

- protocol bootstrap
- global and client reference-script publication
- client onboarding
- pair bootstrap
- single and batch updates
- admin and withdrawal transactions
