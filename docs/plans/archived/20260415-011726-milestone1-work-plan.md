# Milestone 1 Work Plan

## Purpose

This document is the master Milestone 1 planning tracker.

## Source Documents

- [Final Cardano Milestones](../milestones/final-cardano-milestones.md)
- [Cardano Integration Requirement [PF]](../requirements/cardano-integration-requirement-pf.md)
- [Cardano Oracle Integration – Technical Specification](../design/20260416-cardano-oracle-integration-technical-specification.md)

## Planning Rules

- Each plan file must have one clear deliverable.
- Each plan file must include a task list.
- Task ownership must not be duplicated across plan files.
- Cross-plan status is tracked only in this file.

## Deliverable

Produce the complete Milestone 1 plan set required to move from milestone text to implementation-ready work items.

## Plan Files

### 20260415-011726-milestone1-work-plan.md

- role: master plan index
- status: active

### 20260415-011727-milestone1-acceptance-checklist.md

- role: acceptance and submission checklist
- status: drafted

### 20260415-142121-milestone1-contract-and-transaction-architecture-plan.md

- role: contract, state, authority, and transaction architecture
- status: active

## Archived Plan Files

- `archived/20260415-011729-milestone1-implementation-plan.md`
- `archived/20260415-130828-milestone1-coordinator-and-payment-hook-plan.md`

## Task List

- [x] Create the Milestone 1 master plan tracker.
- [x] Create the Milestone 1 acceptance checklist plan.
- [x] Consolidate the related implementation and coordinator plans into one architecture plan.
- [x] Archive the superseded detailed plan files.
- [x] Refactor the on-chain contracts to the validated Config, PaymentHook, Pair, and Coordinator model.
- [x] Refactor the CLI commands, examples, and operator documentation for the new transaction flow.
- [x] Re-run and persist the new Preview flow through Config bootstrap, PaymentHook bootstrap, pair bootstrap, and single update.
- [ ] Add the remaining CLI commands for Config update, PaymentHook withdraw, and batch update.
- [ ] Add the remaining Preview coverage for batch update and PaymentHook withdraw.

## Current Next Step

Implement the remaining operator commands and Preview coverage for batch update and PaymentHook withdraw.
