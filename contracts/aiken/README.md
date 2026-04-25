# Aiken Contracts

This package contains the Aiken on-chain implementation for the DIA Cardano Oracle project.

## Architecture

The current contract set follows the final Receiver-based architecture:

- `config_state` mints and guards the global Config NFT. Config stores DIA admin keys, authorized DIA secp256k1 public keys, the EIP-712 domain, the protocol fee, the active PaymentHook reference, and the coordinator credential.
- `update_coordinator` is the global withdrawal validator used once per update transaction.
- `payment_hook` mints and guards the global PaymentHook NFT and accumulates protocol fees.
- `receiver` is compiled once per client and guards that client's prepaid fee balance.
- `pair_state` is compiled once per client with that client's `receiver_hash`; each pair is a separate Pair NFT and Pair UTxO under the client-specific pair script.
- `reference_holder` is the script address used for reference-script UTxOs. It rejects spend attempts so reference-script UTxOs are not spendable by the deploy wallet.

There is no global pair allow-list. Pair identity is represented by the Pair NFT asset name, derived as `blake2b_256(pair_id)`, and client isolation comes from the Receiver-specific `pair_state` script hash.

## Structure

- `validators/` contains spending, minting, and withdrawal validators.
- `lib/` contains shared types, validation helpers, and unit tests.

## Commands

```sh
aiken check
aiken build
```
