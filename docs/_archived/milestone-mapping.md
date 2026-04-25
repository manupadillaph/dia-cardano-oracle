# Milestone Mapping

This document maps the Catalyst milestones to repository areas and expected evidence.
The source of truth remains [final-cardano-milestones.md](/home/manuelpadilla/sources/reposUbuntu/PROTOFIRE/DIA/dia-cardano-oracle/specs/milestones/final-cardano-milestones.md).

## Scope

- This document links milestone outputs to repository structure.
- This document does not replace the official milestone text.
- Repository areas listed here indicate where milestone-related artifacts are expected to live.

## Milestone 1

Title: Port DIA Oracle Smart Contract to Aiken

Repository areas:

- `contracts/`
- `offchain/cli/`
- `scripts/`
- `docs/`
- `e2e/`

Expected evidence:

- compilable contract
- unit and integration tests
- deployment scripts
- verifiable mainnet hashes
- public developer documentation

## Milestone 2

Title: Implement Data Feeder and Documentation

Repository areas:

- `offchain/bridge/`
- `offchain/cli/`
- `docs/`
- `e2e/`

Expected evidence:

- feeder source code
- test scripts
- QA review logs
- verifiable transactions publishing price updates
- integration examples

## Milestone 3

Title: Implement Monitoring Library for DIA Oracles on Cardano

Repository areas:

- `offchain/monitoring/`
- `infra/`
- `docs/`
- `e2e/`

Expected evidence:

- QA reports
- alert logs
- uptime / freshness / accuracy evidence
- monitoring documentation

## Milestone 4

Title: End-to-End Integration and Deployment on Cardano Mainnet

Repository areas:

- `contracts/`
- `offchain/`
- `infra/`
- `scripts/`
- `docs/`
- `e2e/`

Expected evidence:

- mainnet addresses / hashes / live feeds
- reproducible scripts
- final documentation
- closeout report and video
