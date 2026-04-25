# Architecture Overview

This document provides a high-level view of the repository architecture.
The design reference remains [cardano-oracle-integration-technical-specification.md](/home/manuelpadilla/sources/reposUbuntu/PROTOFIRE/DIA/dia-cardano-oracle/specs/design/cardano-oracle-integration-technical-specification.md).

## Repository Scope

- This document describes repository organization.
- Directory names do not define final deployment topology, network coverage, or service boundaries.

## Top-Level Areas

### Contracts

- `contracts/`
- Contains on-chain implementation artifacts.

### Off-chain

- `offchain/`
- Contains off-chain implementation artifacts.
- Repository areas under `offchain/` are organized by concern:
- `bridge/`
- `cli/`
- `indexer/`
- `monitoring/`
- `shared/`

### End-to-end validation

- `e2e/`
- Contains end-to-end validation artifacts.

### Specifications

- `specs/`
- Contains milestone, requirement, design, and reference documents.

### Documentation

- `docs/`
- Contains technical and operational documentation.

### Scripts

- `scripts/`
- Contains automation artifacts.

### Infrastructure

- `infra/`
- Contains infrastructure-related artifacts.
