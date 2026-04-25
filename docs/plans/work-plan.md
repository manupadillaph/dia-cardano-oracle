# Work Plan

Single work plan for the Cardano port of DIA's push-oracle contracts.

## Related documents

- [Cardano Oracle Architecture](../../docs/architecture/cardano-oracle-architecture.md) — single architecture reference.
- [Cardano Integration Requirement [PF]](../requirements/cardano-integration-requirement-pf.md) — DIA requirement document.
- [Final Cardano Milestones](../../docs/milestones/final-cardano-milestones.md) — Catalyst milestone text.

## Scope

This plan covers all work required to deliver the Cardano integration end to end:

- on-chain contracts
- off-chain submission and tooling
- data feeder (bridge)
- indexer
- monitoring
- deployment, operations, and developer documentation

The work is organized by workstream, not by Catalyst milestone. Catalyst milestones remain the payment gates and are defined in `final-cardano-milestones.md`. A mapping from this plan to those milestones is in the last section.

---

## Workstream A — On-chain contracts

Target contract set, per the architecture:

- `config_state` — multivalidator (mint + spend), 1 global.
- `update_coordinator` — stake validator (withdraw), 1 global.
- `payment_hook` — multivalidator (mint + spend), 1 global.
- `receiver` — multivalidator (mint + spend), 1 per client.
- `pair_state` — multivalidator (mint + spend), 1 per client.

Tasks:

- [x] Implement the 5 scripts in Aiken.
- [x] Implement datum types and redeemers per the architecture (`Config`, `PaymentHook`, `Receiver`, `Pair`).
- [x] Implement `secp256k1` ECDSA + EIP-712 intent verification against the authorized DIA signer set.
- [x] Implement continuity rules for Config, Hook, Receiver and Pair UTxOs, including `min_utxo_lovelace` invariants.
- [x] Implement fee flow: Receiver → Hook on every price update; `ApplySingle` and `ApplyBatch` in the coordinator.
- [x] Unit tests for Config, Hook, Receiver, Pair, and coordinator logic, with real DIA `OracleIntent` fixtures for signature validation.
- [x] Finalize pair-NFT asset-name derivation as `blake2b_256(pair_id)`.
- [x] Finalize batch-update fee unit as one Config-defined fee per updated pair.

## Workstream B — Off-chain CLI and deployment tooling

Tasks:

- [x] TypeScript CLI scaffolding with non-interactive execution (`.env`, JSON input files, persisted state under `state/preview/`).
- [x] Preview wallet and provider verification commands.
- [x] Commands for Config bootstrap, PaymentHook bootstrap, Receiver bootstrap, pair bootstrap, single update.
- [x] Commands for Config update, PaymentHook withdraw.
- [x] Commands for Receiver top-up and Receiver withdraw (per client).
- [x] Commands for batch update.
- [x] Per-client state layout under `state/<network>/clients/<client>/`.
- [x] Scripts to publish reference-script UTxOs for the 3 global scripts and the 2 per-client scripts.

## Workstream C — Data feeder (bridge)

Tasks:

- [ ] Service that subscribes to DIA `OracleIntent` sources and pushes the corresponding Cardano update transactions.
- [ ] Submission strategy covering single and batch updates, retries, and fee-budget guards.
- [ ] Integration tests against the Preview network using real DIA fixtures.
- [ ] Uptime and accuracy reports aligned with the acceptance criteria in `final-cardano-milestones.md`.

## Workstream D — Indexer

Tasks:

- [ ] Indexer exposing per-pair latest price, timestamp, nonce, signer, and intent hash from live Pair UTxOs.
- [ ] Client-level query surface (Receiver balance, subscribed pairs, accrued fees per Hook).
- [ ] Integration examples for Cardano dApp developers.

## Workstream E — Monitoring

Tasks:

- [ ] Monitoring for feed freshness, signer-set drift, and Receiver balance depletion.
- [ ] Alerting for stale data, misreported prices, and failed update transactions.
- [ ] Dashboards covering the 10 Catalyst-referenced price feeds.
- [ ] QA validation report and anomaly-detection evidence.

## Workstream F — Deployment, operations and developer documentation

Tasks:

- [x] Preview execution: Config bootstrap, PaymentHook bootstrap, pair bootstrap, single update.
- [x] Preview execution: Receiver bootstrap, Receiver top-up, batch update, PaymentHook withdraw.
- [ ] Mainnet deployment scripts and evidence (contract addresses, reference-script UTxOs, verified mainnet tx hashes).
- [x] Operator runbook (onboarding a new client, subscribing a new pair, rotating signers, withdrawing accrued fees).
- [ ] Developer documentation published via DIA's developer documentation website, covering:
  - configuration of the oracle
  - on-chain contracts available for consumption
  - procedure to request any of DIA's 2,500+ price feeds or 10,000+ real-world asset feeds
- [ ] Final closeout report and video.

---

## Mapping to Catalyst milestones

Catalyst milestone text is in `final-cardano-milestones.md`; this mapping only indicates which workstreams feed which milestone deliverable. Workstreams can span multiple milestones.

| Catalyst milestone | Primary workstreams | Expected deliverables |
|---|---|---|
| M1 — Port DIA Oracle Smart Contract to Aiken | A, B, F (partial) | compiled contracts, unit/integration tests, deployment scripts, verified mainnet deployment hashes, developer docs |
| M2 — Data Feeder and Documentation | C, B, F (partial) | feeder, QA review logs, integration examples, verified mainnet update tx logs |
| M3 — Monitoring Library | E, F (partial) | monitoring stack, alerting, QA validation report, dashboards |
| M4 — End-to-End Integration and Mainnet Deployment | A, B, C, D, E, F | mainnet addresses, live feeds, final closeout report and video |
