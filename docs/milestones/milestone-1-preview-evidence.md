# Milestone 1 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](./final-cardano-milestones.md)

Scope: Milestone 1 validation on Cardano Preview. Cardano mainnet deployment and final mainnet evidence are not included in this Preview evidence file.

Verification date: 2026-04-25T10:23:34Z; updated 2026-04-25T10:41:00Z

Network: Cardano Preview

## Official Milestone 1 Outputs

| Official output | Repository status |
| --- | --- |
| Aiken oracle smart contract ported to Cardano UTxO model | Complete |
| Compiled contract | Complete: `contracts/aiken/plutus.json` |
| Unit/integration test coverage | Complete for current repository scope: `aiken check` passes 23/23 tests; CLI tests pass; Preview transaction coverage is recorded below |
| Deployment scripts | Complete: `offchain/cli` runbook and CLI commands |
| Documentation for Cardano developers | Complete in repository: root README, Aiken README, CLI runbook, architecture document |
| Verified Cardano mainnet deployment and execution hashes | Pending: mainnet not executed yet |

## Current Verification

- `aiken check`: 23/23 tests passed.
- `npm run test`: passed in `offchain/cli`.
- `npm run typecheck`: passed in `offchain/cli`.
- `npm run build`: passed in `offchain/cli`.
- Preview transactions were verified through Blockfrost Preview.

## Milestone 1 Coverage

| Official requirement | Evidence |
| --- | --- |
| Cardano UTxO oracle contracts | `contracts/aiken/validators/`, `contracts/aiken/lib/dia_cardano_oracle/`, `aiken check` |
| DIA signed price updates | `real_dia_signature_is_accepted`, `next_pair_matches_witness_requires_fresh_data`, Preview transactions: Oracle update, Batch oracle update |
| Reject stale or replayed updates | `stale_timestamp_is_rejected`, `stale_nonce_is_rejected` |
| Reject invalid signer or pair mismatch | `unauthorized_dia_signer_is_rejected`, `wrong_pair_symbol_is_rejected`, `wrong_pair_nft_is_rejected` |
| Reject invalid price state | `negative_price_pair_state_is_rejected`, `negative_price_intent_signature_is_rejected` |
| Protocol fee accounting | `fee_charge_transition_increments_balances`, `fee_charge_transition_rejects_wrong_fee_amount`, Preview transactions: Oracle update, Batch oracle update, PaymentHook withdraw |
| Receiver balance accounting | `pay_fee_transition_decrements_balance`, `pay_fee_transition_rejects_wrong_fee_amount`, `pay_fee_transition_rejects_balance_underflow`, Preview transactions: Oracle update, Receiver top-up, Receiver withdraw, Batch oracle update |
| PaymentHook withdrawal accounting | `withdraw_transition_decrements_accrued_balance`, `withdraw_transition_rejects_above_accrued_fees`, Preview step 9 |
| Protocol and client deployment flow | Preview transactions: Config bootstrap, PaymentHook bootstrap, reference scripts, Receiver bootstrap, Pair bootstrap |
| CLI example, signer, intent, and state artifact checks | `npm run test` in `offchain/cli` |
| Developer documentation | `README.md`, `contracts/aiken/README.md`, `offchain/cli/README.md`, `docs/architecture/cardano-oracle-architecture.md` |
| Mainnet deployment hashes | Pending |

## Preview Transactions

| Step | Operation | Transaction hash | Block | Fee lovelace |
| --- | --- | --- | ---: | ---: |
| 1 | Config bootstrap | `c66dca4248ebeb8097f5c9c87cecdaf86acea71b871fbaf7411d21e606b2d1e9` | 4220889 | 294367 |
| 2 | PaymentHook bootstrap | `9d4278bcfd864ee816c2abe98dff4462d4d70669084dfd5569c775ca6f50e4bd` | 4220908 | 536662 |
| 3 | Global reference scripts | `71d1c8a46d5e4a57fa9377a105356ca95f4de366df7adad22880bef84a079fa5` | 4220911 | 692973 |
| 4 | Receiver bootstrap | `bac345681154b473e64ea7901cc9efdc2720ba9268613f9485cb9ba8a26bb440` | 4220914 | 361475 |
| 5 | Client reference scripts | `f808e5adb3c4412e1490ae1d5d681b398bef52911f7706704d5386cb847ef6c5` | 4220917 | 455329 |
| 6 | Pair bootstrap | `a9e4e01d0b1fd2cb67f44deacaa86cdcbd7b7f5d3af79f90bb48396970fd9e10` | 4220918 | 342748 |
| 7 | Oracle update | `0fcffb20d7a394d1172ce51c604395eaf2006c46159da2b7ad65a42b5eece42c` | 4220925 | 860434 |
| 8 | Receiver top-up | `5207c7e3d6f6a4e944725fd6dd189a68396c1ae0416300d24222a72c267d6745` | 4220932 | 352982 |
| 9 | PaymentHook withdraw | `472e37062846a4ade466e52bdd93576a2dd63351ff74ed1a4902da49fc8b1fb7` | 4220934 | 342675 |
| 10 | Receiver withdraw | `caac8c2fb9c06f70eb5acb2d58f69ab5aa35ede37747e45d51be9a8fefbc8064` | 4220935 | 335606 |
| 11 | Config update | `1012e3161a2cc8f25c99af5d987212eddea569381b58a793c239da55b043c965` | 4221019 | 324120 |
| 12 | Batch oracle update | `ee155d70cc2a0cc6c005dea3551449ab76d696db04d9af5970c923fc1460dcae` | 4221025 | 846313 |
| 13 | Batch oracle update, artifact sync validation | `46ff601dc1018c76218acacc5b44d68d431e4822d64cd6157fd14f7176a487cf` | 4221034 | 841627 |

## Local State Artifacts

- `offchain/cli/state/preview/config-bootstrap.json`
- `offchain/cli/state/preview/clients/client-a.json`
- `offchain/cli/state/preview/clients/client-a/pairs/usdc-usd.json`

## Notes

Each DIA `OracleIntent` signature is valid only for the exact payload it signs, including `symbol`, `price`, `timestamp`, and `nonce`. The first Preview update uses the available DIA fixture intent and signature for one `USDC/USD` update. Later updates require newer `timestamp` and `nonce` values, so the batch update validation uses an Ethereum/EIP-712 test signer that was added to the authorized signer set through the Config update transaction for Preview validation.

Mainnet evidence must be recorded after the final transaction flow is executed on Cardano mainnet.
