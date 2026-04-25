# Milestone 1 Implementation Plan

## Purpose

This document defines the implementation tasks required to deliver Milestone 1.

## Related Documents

- [Milestone 1 Work Plan](./20260415-011726-milestone1-work-plan.md)
- [Milestone 1 Acceptance Checklist](./20260415-011727-milestone1-acceptance-checklist.md)

## Deliverable

Produce one concrete execution plan for contract delivery, testing, deployment evidence, and required documentation.

## Task List

- [x] Select the first contract topology to implement.
- [x] Define the initial contract file set under `contracts/aiken/`.
- [x] Define the initial datum type, redeemer type, and state identity mechanism.
- [x] Define the authorization, freshness, replay-protection, pair consistency, and state replacement checks.
- [x] Implement the first Milestone 1 Aiken validator set.
- [x] Define and implement the minimum unit test file set.
- [ ] Define and implement the minimum integration test flow.
- [x] Define the required build artifacts for Milestone 1 deployment.
- [x] Define the repository location for Preview validation evidence and mainnet milestone evidence.
- [ ] Prepare the required developer documentation for Milestone 1 review.

## Execution Order

Milestone 1 implementation must follow this execution order:

1. local development and validation with `aiken check` and `aiken build`
2. first end-to-end transaction flow on the Cardano Preview network
3. correction of scripts, parameters, and transaction-building logic
4. final milestone evidence capture on Cardano mainnet

Mainnet is required for milestone acceptance, but it is not the first execution target for implementation work.

## Milestone 1 Target Contract Architecture

### A. Contract topology

Milestone 1 targets the contract architecture defined by the current requirement and technical specification documents.

The target on-chain contract set is:

- one Config contract governing domain data, signer authorization, allowed pairs, and the active payment-hook reference
- one Config NFT bootstrap path for the unique Config state
- one PaymentHook contract governing fee accumulation and withdrawal
- one PaymentHook NFT bootstrap path for the unique fee state
- one Oracle Receiver contract governing per-pair oracle state updates
- one pair-NFT minting path tied to authorized pair creation
- one coordinator stake-validator path governing single and batch update execution
- one per-pair oracle state UTxO model for live price data

The implementation order may be staged, but the Milestone 1 finish line is the complete contract set required for deployment and execution, not only a reduced receiver-only subset.

### B. Initial contract file set

The Aiken package must evolve toward the following contract set:

- `contracts/aiken/aiken.toml`
- `contracts/aiken/validators/config_validator.ak`
- `contracts/aiken/validators/config_nft.ak`
- `contracts/aiken/validators/payment_hook_validator.ak`
- `contracts/aiken/validators/payment_hook_nft.ak`
- `contracts/aiken/validators/oracle_receiver.ak`
- `contracts/aiken/validators/update_coordinator.ak`
- `contracts/aiken/validators/pair_nft.ak`
- `contracts/aiken/lib/dia_cardano_oracle/oracle_logic.ak`
- `contracts/aiken/lib/dia_cardano_oracle/config_logic.ak`
- `contracts/aiken/lib/dia_cardano_oracle/payment_hook_logic.ak`
- tests colocated in `lib/` and `validators/` modules as required by Aiken

### C. Initial datum type

The Milestone 1 implementation must support both:

- a Config datum containing signer authorization, domain data, allowed pairs, and the active payment-hook reference
- a PaymentHook datum containing fee configuration and withdrawal target data
- an Oracle datum containing pair identity and the latest accepted price update state

### D. Initial redeemer type

The Milestone 1 implementation must support redeemers for:

- Config bootstrap
- Config update
- PaymentHook bootstrap
- PaymentHook update
- PaymentHook withdrawal
- pair bootstrap
- oracle update

### E. State identity mechanism

The state model must support:

- one unique Config state identified by a Config NFT
- one unique PaymentHook state identified by a PaymentHook NFT
- one live oracle state per pair identified by a pair NFT
- continuity rules for Config replacement, PaymentHook replacement, and pair-state replacement

### F. Initial validator checks

The Milestone 1 contract set must enforce:

- Config bootstrap validity
- Config update authorization by valid config signers
- PaymentHook update and withdrawal authorization by valid config signers
- pair creation authorization through Config state transition
- pair NFT minting tied to authorized pair creation
- oracle update authorization by valid oracle signers
- domain-aware signature verification
- freshness and replay protection
- payment-hook reference enforcement
- fee accumulation and withdrawal continuity
- coordinator-path enforcement for single and batch updates
- state continuity for both Config state and pair state

## Work Breakdown

### A. Contract design

- implement the Config validator and Config NFT bootstrap path
- implement the PaymentHook validator and PaymentHook NFT bootstrap path
- implement the Oracle Receiver validator and pair NFT minting path
- implement the coordinator stake-validator path
- encode the Config datum and Config redeemers
- encode the PaymentHook datum and PaymentHook redeemers
- encode the Oracle datum and Oracle update redeemer
- implement signer, domain, fee, coordinator, and pair authorization logic
- implement replay protection and freshness checks
- implement the NFT-based state identity model for Config, PaymentHook, and pair state

### B. Contract implementation

- implement the required validator checks
- implement helper modules if required
- define the expected build outputs

### C. Testing

- define the minimum positive-path contract test cases
- define the minimum negative-path contract test cases
- define the first end-to-end contract interaction flow
- define the fixtures required for signed updates and state transitions
- define the commands that must execute the test suite

## Current Implementation Status

- `contracts/aiken/aiken.toml` is present
- `contracts/aiken/validators/config_validator.ak` is present
- `contracts/aiken/validators/config_nft.ak` is present
- `contracts/aiken/validators/oracle_receiver.ak` is present
- `contracts/aiken/validators/pair_nft.ak` is present
- `contracts/aiken/lib/dia_cardano_oracle/config_logic.ak` contains the Config datum, redeemer, and transition helpers
- `contracts/aiken/lib/dia_cardano_oracle/oracle_logic.ak` contains the oracle datum, redeemer, signature, fee, and update helpers
- `aiken check` succeeds for the current Milestone 1 contract set and unit test suite
- `aiken build` succeeds and generates `contracts/aiken/plutus.json`
- `offchain/cli` is scaffolded as the TypeScript integration CLI for Preview and mainnet operations
- the CLI can read the generated blueprint and list validator entries
- the CLI can read Preview protocol parameters through the configured provider
- the CLI can derive the Preview wallet summary from seed or private key configuration
- the CLI can build and optionally submit the Preview Config bootstrap transaction from a JSON input file
- deployment evidence is recorded under `docs/milestones/`

## Remaining Gaps Before Milestone 1 Readiness

- the coordinator and payment-hook refactor are not yet implemented in the contracts or the CLI
- integration-level tests for coordinated Config and pair flows are not yet implemented
- deployment artifacts are defined, and the evidence storage location exists in the repository
- developer-facing deployment and usage documentation is not yet written

### D. Deployment and evidence

- identify the build artifacts required for deployment
- define the Preview Config bootstrap transaction
- define the Preview Config update transaction
- define the Preview pair bootstrap transaction
- define the Preview oracle update transaction
- define the first mainnet deployment transaction to capture after Preview validation is complete
- define the first mainnet execution transaction to capture after Preview validation is complete
- define the repository location for Preview validation records and mainnet transaction evidence
- define the operator checklist for recording evidence during execution

### E. Documentation

- document the purpose of the Cardano oracle contract
- document the configuration inputs required by the first implementation
- document how the oracle is accessed or consumed
- document the commands required to build, test, and prepare deployment artifacts

## Off-Chain Integration Tooling Decision

The first integration tooling for Milestone 1 is implemented as a TypeScript CLI under `offchain/cli`.

The first CLI stack is:

- `Preview` as the only pre-mainnet execution network
- Blockfrost as the first provider
- Lucid Evolution as the transaction-building library

`cardano-cli` and `cardano-node` are not part of the primary implementation path for this repository.

## First Integration Flow

The Milestone 1 integration flow is:

1. Bootstrap the Config NFT and Config UTxO.
2. Bootstrap the PaymentHook NFT and PaymentHook state UTxO.
3. Update Config state as required for signer, domain, payment-hook, and pair authorization data.
4. Mint the pair NFT and create the initial pair oracle state.
5. Submit a signed oracle update transaction for an authorized pair through the coordinator path.
6. Verify the resulting transaction hashes and resulting on-chain datum fields.

The first complete execution of this flow must happen on the Cardano Preview network before the mainnet milestone run is attempted.

## Required Build Artifacts

The Milestone 1 deployment preparation must use the following build artifacts:

- `contracts/aiken/plutus.json`
- the `config_validator` validator entry from the generated blueprint
- the `config_nft` minting policy entry from the generated blueprint
- the `payment_hook_validator` validator entry from the generated blueprint
- the `payment_hook_nft` minting policy entry from the generated blueprint
- the `oracle_receiver` validator entry from the generated blueprint
- the `update_coordinator` stake validator entry from the generated blueprint
- the `pair_nft` minting policy entry from the generated blueprint
- the parameter values required to instantiate each script for deployment

The deployment flow must additionally record:

- the bootstrap `OutputReference` used for one-shot minting
- the state asset name used for the state NFT
- the tracked `pair_id` used for the first oracle state

## Exit Criteria

This plan is complete when Milestone 1 execution can begin without unresolved questions about:

- contract topology
- state representation
- required validator checks
- required tests
- required deployment evidence
- required documentation outputs
