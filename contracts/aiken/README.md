# Aiken Contracts

This package contains the Aiken on-chain implementation for the DIA Cardano Oracle project.

## Architecture

The current contract set follows the final Receiver-based architecture:

- `config_state` mints and guards the global Config NFT. Config stores DIA admin keys, authorized DIA secp256k1 public keys, the EIP-712 domain, the protocol fee, the active PaymentHook reference, and the coordinator credential.
- `update_coordinator` is the global withdrawal validator used once per update transaction. It is the authority for DIA intent validation, fee movement, pair creation, pair updates, and batch consistency.
- `payment_hook` mints and guards the global PaymentHook NFT and accumulates protocol fees.
- `receiver` is compiled once per client and guards that client's prepaid fee balance.
- `pair_state` is compiled once per client with that client's `receiver_hash`; each pair is a separate Pair NFT and Pair UTxO under the client-specific pair script. Pair NFTs are minted only inside real update transactions coordinated by `update_coordinator`.
- `reference_holder` is the script address used for reference-script UTxOs. It rejects spend attempts so reference-script UTxOs are not spendable by the deploy wallet.

There is no global pair allow-list. Pair identity is represented by the Pair NFT asset name, derived as `blake2b_256(pair_id)`, and client isolation comes from the Receiver-specific `pair_state` script hash.

There is also no placeholder Pair bootstrap state. The first transaction for a pair is an oracle update: it mints the Pair NFT and creates the Pair UTxO with the signed intent's real `price`, `timestamp`, `nonce`, `intent_hash`, and `signer`. Later updates consume the existing Pair UTxO and require strictly fresher `timestamp` and `nonce`.

## Structure

- `validators/` contains spending, minting, and withdrawal validators.
- `lib/` contains shared types, validation helpers, and unit tests.

## Commands

```sh
aiken check
aiken build
```
