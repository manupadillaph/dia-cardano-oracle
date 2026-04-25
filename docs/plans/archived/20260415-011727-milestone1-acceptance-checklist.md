# Milestone 1 Acceptance Checklist

## Purpose

This document defines the Milestone 1 acceptance baseline.

## Source of Truth

- [Final Cardano Milestones](../milestones/final-cardano-milestones.md)

## Deliverable

Produce a normalized Milestone 1 acceptance checklist that can be used during implementation review and milestone signoff preparation.

## Task List

- [x] Extract Milestone 1 outputs from the milestone source.
- [x] Extract Milestone 1 acceptance criteria from the milestone source.
- [x] Extract Milestone 1 evidence requirements from the milestone source.
- [x] Convert the milestone text into a normalized review checklist.
- [x] Convert the evidence requirements into a normalized evidence inventory.
- [x] Define review gates for contract, testing, deployment, documentation, and submission.

## Acceptance Checklist

## A. On-Chain Contract Delivery

- [ ] An Aiken-based DIA oracle contract exists in the repository.
- [ ] The contract is adapted to the Cardano UTxO model.
- [ ] The contract compiles successfully.
- [ ] The contract logic required for Milestone 1 is implemented.
- [ ] The contract can be deployed to Cardano mainnet.
- [ ] The deployed contract can execute at least one successful mainnet update flow.

## B. Testing and Verification

- [ ] Unit tests exist for the Milestone 1 contract logic.
- [ ] Integration tests exist for the Milestone 1 contract flow.
- [ ] Test execution is reproducible from the repository.
- [ ] Test results demonstrate that the contract compiles, deploys, and functions correctly.
- [ ] Test results demonstrate that the oracle can process external data on-chain.
- [ ] Test outputs are preserved in a form suitable for milestone evidence.

## C. Deployment and Execution Evidence

- [ ] At least one Cardano mainnet transaction hash confirms successful contract deployment.
- [ ] At least one Cardano mainnet transaction hash confirms successful contract execution.
- [ ] All mainnet hashes are verifiable through a public Cardano blockchain explorer.
- [ ] The repository records the relevant explorer links for each required transaction hash.
- [ ] The evidence clearly distinguishes deployment evidence from execution evidence.

## D. Developer Documentation

- [ ] Documentation explains the purpose of the Cardano oracle contract.
- [ ] Documentation explains how to configure the oracle.
- [ ] Documentation identifies the smart contracts relevant for consuming the oracle.
- [ ] Documentation explains how to access the DIA oracle on Cardano.
- [ ] Documentation is prepared for publication through the DIA main developer documentation website.

## E. Repository Evidence Package

- [ ] The repository contains the smart contract source code.
- [ ] The repository contains unit and integration tests.
- [ ] The repository contains deployment scripts.
- [ ] The repository contains developer documentation.
- [ ] The repository contains the verified Cardano mainnet transaction hashes.
- [ ] The repository contains sufficient information for an external reviewer to validate milestone completion.

## Evidence Inventory

The Milestone 1 evidence package must include the following:

- [ ] contract source files
- [ ] test files
- [ ] test execution instructions
- [ ] deployment scripts or deployment tooling
- [ ] deployment transaction hash
- [ ] execution transaction hash
- [ ] public explorer links
- [ ] developer documentation references

## Review Gates

### Gate 1. Contract Readiness

- [ ] The Milestone 1 contract implementation is complete.
- [ ] The contract builds successfully in a reproducible way.

### Gate 2. Test Readiness

- [ ] Required unit tests are implemented.
- [ ] Required integration tests are implemented.
- [ ] Test commands and expected outputs are documented.

### Gate 3. Deployment Readiness

- [ ] Mainnet deployment prerequisites are documented.
- [ ] Deployment tooling is ready for use.
- [ ] The team can capture transaction evidence during deployment and execution.

### Gate 4. Documentation Readiness

- [ ] The developer documentation required by Milestone 1 is complete.
- [ ] The documentation is suitable for publication through DIA documentation channels.

### Gate 5. Submission Readiness

- [ ] All required repository artifacts are present.
- [ ] All required mainnet transaction hashes are recorded.
- [ ] All required public verification links are recorded.
- [ ] The repository evidence package is ready for milestone review.
