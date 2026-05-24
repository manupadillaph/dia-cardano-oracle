# Aiken Contracts

On-chain implementation of the DIA Cardano Oracle, written in
[Aiken](https://aiken-lang.org) and targeting Plutus V3.

This package compiles to `plutus.json` — a blueprint the off-chain CLI in
[`offchain/cli/`](../../offchain/cli/) consumes verbatim to derive script
hashes, addresses, and policy ids.

> The protocol design (data model, transaction shapes, cross-script
> invariants, fee flow, security analysis) lives in
> [`docs/architecture/cardano-oracle-architecture.md`](../../docs/architecture/cardano-oracle-architecture.md).
> This README is a map of the code, not a re-statement of the design.

## Contracts

Six validators, each in its own file under [`validators/`](validators/).
Shared types and predicates live in [`lib/dia_cardano_oracle/`](lib/dia_cardano_oracle/).

| Validator | Kind | Role |
| --- | --- | --- |
| [`config_state`](validators/config_state.ak) | mint + spend | Mints and guards the global Config NFT (admin keys, DIA signer keys, EIP-712 domain, fee params, hook/coordinator pointers) |
| [`payment_hook`](validators/payment_hook.ak) | mint + spend | Mints and guards the global PaymentHook NFT; accumulates settled protocol fees |
| [`receiver`](validators/receiver.ak) | mint + spend | Per-client UTxO holding the client's prepaid fee balance and pending-to-hook accrual |
| [`pair_state`](validators/pair_state.ak) | mint + spend | Per-client minting policy + spend validator for Pair NFTs (one Pair UTxO per subscribed symbol) |
| [`update_coordinator`](validators/update_coordinator.ak) | withdraw | Global authority for oracle updates (single + batch) and Settle; validates DIA intents, fee movement, and pair-state transitions |
| [`reference_holder`](validators/reference_holder.ak) | spend | Holds reference-script UTxOs; admin-gated reclaim for contract upgrades |

`config_state`, `payment_hook`, `update_coordinator`, and `reference_holder`
exist exactly once per deployment. `receiver` and `pair_state` are recompiled
per client (different bootstrap reference and `receiver_hash` respectively),
so every client gets its own script address space.

## Design highlights worth knowing

These are the load-bearing properties of the design. **Why** each one exists
and **how** the validators enforce it is detailed in the architecture doc —
linked inline below.

- **Pair identity is unforgeable.** Pair NFT asset name is `blake2b_256(pair_id)`;
  per-client isolation comes from the Receiver-specific `pair_state` script hash.
  No global allow-list. See architecture §2 + §4.4.
- **DIA intents are EIP-712 + secp256k1.** The coordinator recovers and
  authorises every intent on-chain; signers must be listed in Config. See
  architecture §5.7.
- **Batch validation is single-pass.** Off-chain emits pair outputs and the
  witness list in canonical order (`pair_token_name` ascending); the
  coordinator validates the correspondence in one linear pass per relevant
  list. See architecture §5.9.
- **Fees are decoupled from updates.** Updates only reclassify ADA inside the
  client's Receiver datum (`AccrueFee`); a separate admin `Settle` tx drains
  the accrual into the global PaymentHook. See architecture §5.11.
- **Pair create + burn are admin-gated.** A signed DIA intent alone is not
  enough to mint or burn a Pair NFT; the tx must also be signed by a
  `config_admins` key. This prevents **unauthorized** creation or burn by a
  relayer holding only DIA intents. It does **not**, by itself, provide
  on-chain live-pair uniqueness: a config admin can still create duplicate
  live pairs for the same `(client, symbol)` unless a live-pair registry is
  added on-chain. The matching burn path is admin-gated on both the
  spend-side and mint-side validators. See
  [`docs/security/m1-security-notes.md`](../../docs/security/m1-security-notes.md)
  and architecture §5.7 + §5.13.

## Layout

```text
contracts/aiken/
├── aiken.toml            # package manifest (pins stdlib + Aiken version)
├── plutus.json           # compiled blueprint (committed; consumed by the CLI)
├── validators/           # one file per validator (see table above)
├── lib/dia_cardano_oracle/
│   ├── config_logic.ak       # ConfigDatum + admin gate helpers
│   ├── coordinator_logic.ak  # coordinator redeemers + cross-script binding
│   ├── oracle_logic.ak       # PairDatum, UpdateWitness, EIP-712 hashing, signature recovery
│   ├── payment_hook_logic.ak # PaymentHookDatum + settle/withdraw transitions
│   └── receiver_logic.ak     # ReceiverDatum + balance/accrual transitions
└── build/                # aiken build cache (gitignored)
```

Each `*_logic.ak` file ends with inline `test` blocks; `aiken check` runs them
all. Validators in `validators/` also carry their own regression tests against
the deployed handlers (admin gating, cross-script redeemer-confusion, etc.).

## Prerequisites

- Aiken `v1.1.21` (Plutus V3), pinned in `aiken.toml`. Install via the
  [official instructions](https://aiken-lang.org/installation-instructions).

You only need Aiken installed if you intend to modify the contracts, run
the unit tests, or rebuild the blueprint. The committed `plutus.json` is
the canonical compiled artifact, so a fresh clone can run the off-chain CLI
without installing Aiken first.

## Commands

```sh
aiken check    # run the full unit-test suite
aiken build    # regenerate ./plutus.json
aiken bench    # run the benchmark suite (CPU/mem growth by size)
```

Always commit the rebuilt `plutus.json` alongside any validator change so
the off-chain CLI stays in sync.

## Benchmarks

The contract package now includes targeted `aiken bench` baselines for the
hot paths we expect to revisit during fee work:

- `update_coordinator.valid_batch_update`
- `update_coordinator.valid_settle`
- `receiver.spend AccrueFee`
- `receiver.spend Settle`
- `payment_hook.spend ApplySettle`
- `pair_state.spend ApplyUpdate`

Useful commands:

```sh
# Full benchmark dataset as JSON
aiken bench --max-size 11 > benchmarks.json

# Only the coordinator benches (size 0..11 => modeled N = 1..12)
aiken bench --max-size 11 -m update_coordinator > update-coordinator-benches.json

# Focus on receiver / hook decode growth
aiken bench --max-size 11 -m receiver > receiver-benches.json
aiken bench --max-size 11 -m payment_hook > payment-hook-benches.json

# Control benchmark: pair_state fingerprint path
aiken bench --max-size 11 -m pair_state > pair-state-benches.json
```

These samplers model `N = size + 1`, so `--max-size 11` yields the range
`1..12`, which lines up well with the current batch-capacity investigation.
