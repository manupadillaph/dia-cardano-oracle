# Milestone 1 Coordinator and Payment Hook Plan

## Purpose

This document defines the contract and CLI changes required to move the oracle update flow to a once-per-transaction coordinator path with a separate payment hook state.

## Related Documents

- [Milestone 1 Work Plan](./20260415-011726-milestone1-work-plan.md)
- [Milestone 1 Implementation Plan](./20260415-011729-milestone1-implementation-plan.md)

## Deliverable

Produce one implementation-ready plan for:

- stake-validator based update coordination
- a separate payment hook contract state
- single-transaction and batch update processing
- fee withdrawal administration

## Task List

- [x] Define the `Config` datum changes required to reference the active payment hook.
- [x] Define the `PaymentHook` datum and NFT identity model.
- [x] Define the `PaymentHook` redeemers for bootstrap, config update, and withdrawal.
- [x] Define the coordinator stake validator redeemers for single update and batch update execution.
- [x] Define the reduced role of the per-pair spending validator once the coordinator path is introduced.
- [x] Define how the coordinator validates DIA intents once per transaction.
- [x] Define how the coordinator validates the expected fee amount for single and batch updates.
- [x] Define the single-UTxO accumulation model for the payment hook and its concurrency tradeoff.
- [x] Define the withdrawal authorization rule using the existing config signer set.
- [ ] Implement the contract refactor for `Config`, `PaymentHook`, coordinator, and pair validator changes.
- [ ] Refactor the CLI commands and state artifacts to match the coordinator and payment-hook flow.
- [ ] Add Aiken tests and Preview transaction coverage for single-update and batch-update execution.

## Scope

This plan covers:

- transaction-level coordination
- fee accumulation
- fee withdrawal
- batch update execution

This plan does not cover:

- monitoring
- mainnet evidence packaging
- non-fee config administration unrelated to coordinator execution

## Decided Architecture

- `Config` remains the central admin authority.
- `valid_config_signers` remain the admin signer set.
- DIA `OracleIntent` signatures remain the only authority for price validity.
- ordinary price updates will reference `Config`, but will not require config signer authorization.
- the payment hook will use a dedicated state UTxO identified by its own NFT.
- the payment hook will accumulate fees in a single state UTxO for the first implementation.
- batch execution will be coordinated through a stake validator so shared checks run once per transaction.

## Contract Set

The target contract set for this architecture is:

- `config_validator` spending validator for the unique Config state UTxO
- `config_nft` minting policy for the unique Config NFT
- `payment_hook_validator` spending validator for the unique fee-accumulation state UTxO
- `payment_hook_nft` minting policy for the unique PaymentHook NFT
- `oracle_receiver` spending validator for each pair state UTxO
- `pair_nft` minting policy for pair identity tokens
- `update_coordinator` stake validator used by both single-update and batch-update transactions

## Datum and State Model

### Config datum

The Config datum will keep:

- `valid_config_signers`
- DIA signer authorization data
- EIP-712 domain data
- allowed pairs
- a reference to the active PaymentHook state

The Config datum will not hold the live fee balance.

### PaymentHook datum

The PaymentHook datum will keep:

- `collector_address`
- `update_fee_lovelace`

The PaymentHook UTxO will also hold the accumulated lovelace balance. The same UTxO is consumed and recreated on every update transaction and on every withdrawal transaction.

### Pair datum

Each pair UTxO keeps the latest accepted oracle state for one pair only.

## Authority Model

- Config bootstrap, Config update, PaymentHook bootstrap, PaymentHook update, and PaymentHook withdrawal are authorized by `valid_config_signers`.
- Price validity is authorized only by DIA `OracleIntent` signatures.
- The submitting Cardano wallet pays fees and witnesses the transaction, but it does not authorize price correctness unless it is also acting as a config admin signer for an admin operation.

## Fee Model

- Fees are charged only on price-update transactions.
- Fees are not charged on Config bootstrap, Config update, Pair bootstrap, Pair removal, or PaymentHook withdrawal.
- Single update and batch update both use the same coordinator path.
- The first Cardano implementation uses one fixed fee per update transaction, matching the EVM behavior more closely than a per-pair fee.

## Transaction Model

### Single update

- spend one pair UTxO
- spend the PaymentHook state UTxO
- reference the Config state UTxO
- execute one `withdraw` against the coordinator stake validator
- recreate the pair UTxO with new oracle state
- recreate the PaymentHook UTxO with increased lovelace

### Batch update

- spend multiple pair UTxOs
- spend the PaymentHook state UTxO once
- reference the Config state UTxO
- execute one `withdraw` against the coordinator stake validator
- recreate each pair UTxO with new oracle state
- recreate the PaymentHook UTxO with increased lovelace

## Validator Responsibilities

### Coordinator stake validator

The coordinator stake validator is responsible for:

- validating all DIA intents included in the transaction
- validating batch-wide rules once per transaction
- validating the expected fee amount
- ensuring the PaymentHook state transition is correct

### Pair spending validator

The pair validator is reduced to:

- validating local pair-state continuity
- validating the expected pair NFT and pair identity
- checking that the transaction includes the coordinator withdrawal witness

### PaymentHook spending validator

The PaymentHook validator is responsible for:

- validating fee-state continuity
- validating admin-authorized hook updates
- validating admin-authorized withdrawals

## Concurrency Tradeoff

The single-UTxO fee accumulator intentionally serializes update transactions through one PaymentHook UTxO. This is acceptable for the first Milestone 1 implementation because it keeps the accounting and withdrawal model simple. If throughput becomes a problem later, the hook can be redesigned to shard fee state.

## CLI Impact

The CLI must evolve to support:

- `preview:payment-hook:bootstrap`
- `preview:payment-hook:update`
- `preview:payment-hook:withdraw`
- `preview:update` through the coordinator path
- `preview:update:batch`

The generated state artifacts must include both the Config state and the PaymentHook state.
