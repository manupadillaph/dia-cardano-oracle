# Milestone 1 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](./final-cardano-milestones.md)

Scope: Milestone 1 validation on Cardano Preview. Cardano mainnet deployment and final mainnet evidence are not included in this Preview evidence file.

Verification date: 2026-04-25T10:23:34Z; updated 2026-04-26

Network: Cardano Preview

## Official Milestone 1 Outputs

| Official output | Repository status |
| --- | --- |
| Aiken oracle smart contract ported to Cardano UTxO model | Complete |
| Compiled contract | Complete: `contracts/aiken/plutus.json` |
| Unit/integration test coverage | Complete for current repository scope: `aiken check` passes 23/23 tests; CLI tests pass |
| Deployment scripts | Complete: `offchain/cli` runbook and CLI commands |
| Documentation for Cardano developers | Complete in repository: root README, Aiken README, CLI runbook, architecture document |
| Verified Cardano mainnet deployment and execution hashes | Pending: mainnet not executed yet |

## Current Verification

- `aiken check`: 23/23 tests passed.
- `npm run test`: passed in `offchain/cli`.
- `npm run typecheck`: passed in `offchain/cli`.
- `npm run build`: passed in `offchain/cli`.
- Preview transactions must be regenerated with the clarified init + parameterize + bootstrap + reference-script deployment flow before this evidence is marked complete.

## Milestone 1 Coverage

| Official requirement | Evidence |
| --- | --- |
| Cardano UTxO oracle contracts | `contracts/aiken/validators/`, `contracts/aiken/lib/dia_cardano_oracle/`, `aiken check` |
| DIA signed price updates | `real_dia_signature_is_accepted`, `next_pair_matches_witness_requires_fresh_data`, single and batch update CLI commands |
| Reject stale or replayed updates | `stale_timestamp_is_rejected`, `stale_nonce_is_rejected` |
| Reject invalid signer or pair mismatch | `unauthorized_dia_signer_is_rejected`, `wrong_pair_symbol_is_rejected`, `wrong_pair_nft_is_rejected` |
| Reject invalid price state | `negative_price_pair_state_is_rejected`, `negative_price_intent_signature_is_rejected` |
| Protocol fee accounting | `fee_charge_transition_increments_balances`, `fee_charge_transition_rejects_wrong_fee_amount`, update, batch update, and PaymentHook withdraw CLI commands |
| Receiver balance accounting | `pay_fee_transition_decrements_balance`, `pay_fee_transition_rejects_wrong_fee_amount`, `pay_fee_transition_rejects_balance_underflow`, update, batch update, Receiver top-up, and Receiver withdraw CLI commands |
| PaymentHook withdrawal accounting | `withdraw_transition_decrements_accrued_balance`, `withdraw_transition_rejects_above_accrued_fees`, PaymentHook withdraw CLI command |
| Protocol and client deployment flow | CLI runbook steps 6-28: initialize protocol/client artifacts, parameterize with existing wallet UTxOs, bootstrap Config, PaymentHook, Receiver, and Pair, publish reference scripts at ReferenceHolder, create and sign intents, generate Config-update and batch payloads, and submit maintenance transactions |
| CLI signer, intent, generated payload, and state artifact checks | `npm run test` in `offchain/cli` |
| Developer documentation | `README.md`, `contracts/aiken/README.md`, `offchain/cli/README.md`, `docs/architecture/cardano-oracle-architecture.md` |
| Mainnet deployment hashes | Pending |

## Required Preview Transaction Evidence

| CLI step | Operation | Evidence status |
| --- | --- | --- |
| 6 | Initialize protocol artifact | N/A: local artifact init |
| 7 | Parameterize Config scripts from an existing wallet UTxO | Pending Preview re-run |
| 8 | Bootstrap Config | Pending Preview re-run |
| 9 | Publish Config and Coordinator reference scripts at ReferenceHolder | Pending Preview re-run |
| 10 | Parameterize PaymentHook scripts from an existing wallet UTxO | Pending Preview re-run |
| 11 | Bootstrap PaymentHook | Pending Preview re-run |
| 12 | Publish PaymentHook reference script at ReferenceHolder | Pending Preview re-run |
| 13 | Initialize client artifact | N/A: local artifact init |
| 14 | Parameterize client Receiver and Pair scripts from an existing wallet UTxO | Pending Preview re-run |
| 15 | Bootstrap Receiver | Pending Preview re-run |
| 16 | Publish client Receiver and Pair reference scripts at ReferenceHolder | Pending Preview re-run |
| 17 | Create unsigned intent | N/A: local prompt workflow |
| 18 | Sign unsigned intent | N/A: local prompt workflow |
| 19 | Create and sign intent | N/A: local prompt workflow |
| 20 | Bootstrap Pair | Pending Preview re-run |
| 21 | Oracle update | Pending Preview re-run |
| 22 | Create Config update draft | N/A: local prompt workflow |
| 23 | Config update | Pending Preview re-run |
| 24 | Create batch manifest | N/A: local prompt workflow |
| 25 | Batch oracle update | Pending Preview re-run |
| 26 | Receiver top-up | Pending Preview re-run |
| 27 | Receiver withdraw | Pending Preview re-run |
| 28 | PaymentHook withdraw | Pending Preview re-run |

## Local State Artifacts

- `offchain/cli/state/preview/config-bootstrap.json`
- `offchain/cli/state/preview/clients/client-a.json`
- `offchain/cli/state/preview/clients/client-a/pairs/usdc-usd.json`

## Notes

Each DIA `OracleIntent` signature is valid only for the exact payload it signs, including `symbol`, `price`, `timestamp`, and `nonce`. The first Preview update uses the available DIA fixture intent and signature for one `USDC/USD` update. Later updates require newer `timestamp` and `nonce` values, so the batch update validation uses an Ethereum/EIP-712 test signer that was added to the authorized signer set through the Config update transaction for Preview validation.

Reference-script UTxOs must be created at the `reference_holder` script address derived from `contracts/aiken/plutus.json`. The deploy wallet funds those outputs but cannot spend them.

Mainnet evidence must be recorded after the final transaction flow is executed on Cardano mainnet.
