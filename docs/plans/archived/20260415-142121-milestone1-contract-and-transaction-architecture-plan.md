# Milestone 1 Contract and Transaction Architecture Plan

## Purpose

This document defines the contract set, state model, authorization model, and transaction shapes for the Milestone 1 Cardano oracle implementation.

## Related Documents

- [Final Cardano Milestones](../milestones/final-cardano-milestones.md)
- [Cardano Integration Requirement [PF]](../requirements/cardano-integration-requirement-pf.md)
- [Cardano Oracle Integration – Technical Specification](../design/20260416-cardano-oracle-integration-technical-specification.md)

## Deliverable

Produce one implementation-ready architecture for:

- the on-chain contract set
- the unique state UTxOs and identity tokens
- the authority model for config, fees, and price updates
- the single-update and batch-update transaction flows

## Task List

- [x] Define the contract split between Config, PaymentHook, Pair state, and update coordination.
- [x] Define the state UTxOs and identity-token model.
- [x] Define the admin authority model and the DIA price-signature authority model.
- [x] Define the single-UTxO fee accumulation model.
- [x] Define the transaction shapes for bootstrap, update, and withdrawal.
- [x] Define the continuity rules for Config, PaymentHook, and Pair state, including `min_utxo_lovelace`.
- [x] Refactor the Aiken contracts to match this architecture.
- [x] Refactor the TypeScript CLI and state artifacts for Config bootstrap, PaymentHook bootstrap, pair bootstrap, and single update.
- [x] Add Aiken tests for Config, PaymentHook, and DIA intent verification.
- [x] Update the operator documentation and example JSON files to match this architecture.
- [ ] Add CLI commands for Config update, PaymentHook withdraw, and batch update.
- [x] Execute and persist the new Preview flow for Config bootstrap, PaymentHook bootstrap, pair bootstrap, and single update under the refactored architecture.
- [ ] Add Preview transaction coverage for batch update and PaymentHook withdraw.

## Implementation Phases

### Phase 1. On-chain type and validator refactor

- Replace the current Config datum and redeemers with the final Config-state model.
- Introduce the PaymentHook datum, redeemers, and validator.
- Refactor the pair-state validator and minting path to the final pair model.
- Introduce the coordinator stake validator for single-update and batch-update execution.
- Replace the current direct fee-output model with the PaymentHook state-transition model.

### Phase 2. On-chain tests

- Add Config continuity tests, including exact `min_utxo_lovelace` enforcement.
- Add PaymentHook continuity and accounting tests.
- Add Pair continuity tests.
- Add coordinator tests for single-update and batch-update validation.
- Keep real DIA `OracleIntent` fixtures in the test set for signature validation.

### Phase 3. CLI and state artifacts

- Replace the current config bootstrap flow with Config-state bootstrap under the new schema.
- Add PaymentHook bootstrap command and state-artifact support.
- Refactor pair bootstrap to the Config-governed Pair-NFT model.
- Refactor update flow to spend the PaymentHook UTxO and execute the coordinator withdrawal witness.
- Add Config update, PaymentHook withdraw, and batch update commands.

### Phase 4. Documentation and Preview execution

- Update the CLI README and root README to match the final architecture.
- Update the example JSON files to the final transaction inputs.
- Remove stale generated state artifacts that no longer match the refactored schema.
- Re-run the full Preview flow:
  - Config bootstrap
  - PaymentHook bootstrap
  - Pair bootstrap
  - Single update
  - Batch update
  - PaymentHook withdraw

## Contract Set

The target contract set is:

- `config_state`
  multivalidator with `mint` and `spend` handlers for the unique Config state
- `payment_hook`
  multivalidator with `mint` and `spend` handlers for the unique fee-accumulation state
- `pair_state`
  multivalidator with `mint` and `spend` handlers for pair identity and pair state continuity
- `update_coordinator`
  stake validator executed through `withdraw` once per transaction

## Live State UTxOs

At runtime, the system keeps:

- `1` Config UTxO
- `1` PaymentHook UTxO
- `N` Pair UTxOs

Total live state UTxOs: `N + 2`

## Identity Tokens

The system uses:

- `1` Config NFT
- `1` PaymentHook NFT
- `1` Pair NFT per pair

Minting events:

- Config NFT: minted during `config bootstrap`
- PaymentHook NFT: minted during `payment_hook bootstrap`
- Pair NFT: minted during `pair bootstrap`

### NFT minting strategy

- The Config NFT is a one-shot NFT. Its minting policy is parameterized by a bootstrap `OutputReference` that must be consumed by the bootstrap transaction.
- The PaymentHook NFT is a one-shot NFT. Its minting policy is parameterized by a bootstrap `OutputReference` that must be consumed by the bootstrap transaction.
- The Pair NFT is not modeled as one independent one-shot policy per pair.
- The Pair NFT is minted by the shared `pair_state` minting path.
- The Pair NFT asset name is derived deterministically from `pair_id`.
- Pair-NFT minting is authorized by a valid Config-state transition that registers the pair and creates the initial Pair UTxO in the same transaction.

This keeps unique singleton state strict for Config and PaymentHook, while keeping pair creation manageable through Config-governed pair registration.

## Datum Model

### Config datum

The Config datum stores:

- `valid_config_signers`
- `authorized_dia_public_keys`
- `domain_data`
- `allowed_pairs`
- `payment_hook_ref`
- `update_coordinator_credential`
- `min_utxo_lovelace`

The Config datum is the central admin state. It does not store live fee balances.

### PaymentHook datum

The PaymentHook datum stores:

- `withdraw_address`
- `protocol_fee_per_tx_lovelace`
- `min_utxo_lovelace`
- `accrued_fees_lovelace`
- `lifetime_fees_collected_lovelace`
- `lifetime_fees_withdrawn_lovelace`
- `fee_charge_count`

The live lovelace held by the PaymentHook UTxO must stay aligned with the datum.

### Pair datum

Each Pair datum stores:

- `pair_id`
- `price`
- `timestamp`
- `nonce`
- `intent_hash`
- `signer`
- `min_utxo_lovelace`

Each Pair UTxO tracks the latest accepted state for one pair only.

## Authority Model

### Config and fee administration

One admin set is used:

- `valid_config_signers`

This signer set authorizes:

- `config bootstrap`
- `config update`
- `payment_hook bootstrap`
- `payment_hook update`
- `payment_hook withdraw`
- pair registration or removal through Config transitions

### Price validity

Price validity is authorized only by DIA `OracleIntent` signatures.

The Cardano wallet that submits the transaction:

- pays fees
- witnesses the Cardano transaction
- does not authorize price correctness unless it is also acting as a config admin signer for an admin operation

## Fee Model

- Fees are charged only on price-update transactions.
- Fees are not charged on Config bootstrap, Config update, PaymentHook bootstrap, PaymentHook update, Pair bootstrap, or PaymentHook withdrawal.
- The first implementation uses one fixed fee per update transaction, not one fee per pair.
- Single update and batch update both use the same fee model.

## Continuity Rules

### Config continuity

Any transaction recreating the Config UTxO must preserve:

- the Config NFT
- the Config datum fields, except fields explicitly changed by the authorized redeemer
- the declared `min_utxo_lovelace`

The recreated Config UTxO must lock lovelace equal to its declared `min_utxo_lovelace`.

### PaymentHook continuity

Any transaction recreating the PaymentHook UTxO must preserve:

- the PaymentHook NFT
- the PaymentHook datum fields, except fields explicitly changed by the authorized redeemer
- the declared `min_utxo_lovelace`

The recreated PaymentHook UTxO must satisfy:

- `locked_lovelace == min_utxo_lovelace + accrued_fees_lovelace`

### Pair continuity

Any transaction recreating a Pair UTxO must preserve:

- the Pair NFT
- the `pair_id`
- the declared `min_utxo_lovelace`

The recreated Pair UTxO must lock lovelace equal to its declared `min_utxo_lovelace`.

## Redeemers

### Config state

- `AdminUpdate`
- `RegisterPair`

### PaymentHook

- `ApplyFee`
- `AdminUpdate`
- `Withdraw`

### Pair state

- `BootstrapPair`
- `ApplyUpdate`

### Update coordinator

- `ApplySingle`
- `ApplyBatch`

## Validator Responsibilities

### Config state

The Config validator is responsible for:

- enforcing admin authorization
- enforcing Config-state continuity
- enforcing allowed-pair transitions
- enforcing the active `payment_hook_ref`
- enforcing the active `update_coordinator_credential`

### PaymentHook

The PaymentHook validator is responsible for:

- enforcing admin authorization for hook updates and withdrawals
- enforcing PaymentHook-state continuity
- enforcing fee-accounting consistency
- enforcing PaymentHook NFT continuity
- enforcing `locked_lovelace == min_utxo_lovelace + accrued_fees_lovelace`

### Pair state

The Pair validator is responsible for:

- enforcing Pair-state continuity
- enforcing Pair NFT continuity
- enforcing pair identity
- checking that the coordinator withdrawal witness is present in the same transaction

### Update coordinator

The coordinator stake validator is responsible for:

- validating all DIA intents included in the transaction
- validating shared single-update and batch-update rules once per transaction
- validating the expected fee amount
- validating the PaymentHook state transition used by the update transaction
- validating that the referenced Config state is the active source of config

## Transaction Shapes

### 1. Config bootstrap

Inputs:

- wallet UTxO

Reference inputs:

- none

Mint:

- Config NFT

Outputs:

- Config UTxO

### 2. PaymentHook bootstrap

Inputs:

- wallet UTxO
- Config UTxO

Reference inputs:

- none

Mint:

- PaymentHook NFT

Outputs:

- recreated Config UTxO with `payment_hook_ref` and `update_coordinator_credential`
- PaymentHook UTxO

Additional effect:

- register the coordinator staking credential used by update transactions

### 3. Config update

Inputs:

- Config UTxO

Reference inputs:

- optional PaymentHook UTxO when updating the active hook reference

Mint:

- none

Outputs:

- recreated Config UTxO

### 4. Pair bootstrap

Inputs:

- wallet UTxO
- Config UTxO

Reference inputs:

- none

Mint:

- Pair NFT

Outputs:

- recreated Config UTxO
- Pair UTxO

Notes:

- the Pair NFT asset name is derived from `pair_id`
- the Pair NFT mint is authorized by the Config transition in the same transaction
- no separate arbitrary bootstrap UTxO is required for each pair

### 5. Single update

Inputs:

- one Pair UTxO
- PaymentHook UTxO

Reference inputs:

- Config UTxO

Withdrawals:

- `update_coordinator`

Outputs:

- recreated Pair UTxO
- recreated PaymentHook UTxO

### 6. Batch update

Inputs:

- multiple Pair UTxOs
- PaymentHook UTxO

Reference inputs:

- Config UTxO

Withdrawals:

- `update_coordinator`

Outputs:

- recreated Pair UTxOs
- recreated PaymentHook UTxO

### 7. PaymentHook update

Inputs:

- PaymentHook UTxO

Reference inputs:

- Config UTxO

Mint:

- none

Outputs:

- recreated PaymentHook UTxO

### 8. PaymentHook withdraw

Inputs:

- PaymentHook UTxO

Reference inputs:

- Config UTxO

Mint:

- none

Outputs:

- recreated PaymentHook UTxO
- payout to `withdraw_address`

## Concurrency and Batching

The first implementation uses one PaymentHook UTxO for fee accumulation. This means only one update transaction can consume the PaymentHook state at a time.

This is acceptable for Milestone 1 because:

- the EVM reference charges one fee per update transaction, including batch handling
- the requirement includes batch update handling
- the milestone scope is limited and does not require high-throughput parallel execution
- a single accumulating PaymentHook UTxO keeps accounting and withdrawal simple

If higher throughput is needed later, the PaymentHook can be redesigned to shard fee state.

## Exit Criteria

This plan is complete when the implementation can proceed without unresolved questions about:

- the contract set
- the live state UTxOs
- the identity-token model
- the authority split between admin actions and DIA price validation
- the continuity rules, including `min_utxo_lovelace`
- the single-update and batch-update transaction shapes
