# M1 Security Notes

Short, focused write-up of the trust model and known exclusions for the
Milestone-1 DIA Cardano Oracle. The authoritative protocol description lives in
[`docs/architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md);
this file only records what is in/out of scope and what to watch for in audits.

## Trust model

- **DIA price feed.** Off-chain. Prices originate from DIA's aggregation
  pipeline; this protocol trusts a `secp256k1`-signed `OracleIntent` whose
  signer is listed in `Config.authorized_dia_public_keys`. The protocol does
  not verify the inputs DIA used to produce the price.
- **DIA admin wallet (`config_admins`).** On-chain. Holds the privileged
  payment keys that can rotate Config (`AdminUpdate`), drain unused balances
  (`Withdraw`), drive `Settle`, create new Pair NFTs (`MintPairs`), and burn
  them (`BurnPairs`/`BurnPair`). Single-signature is sufficient (1-of-N over
  `config_admins`).
- **Client.** The party that prepays fees into a Receiver UTxO. Clients have
  no privileged on-chain role: they cannot sign updates, mint Pair NFTs, or
  modify Config.
- **Updater wallet (price relayer).** Any wallet may pay the network fee for
  a price update; authority comes from the DIA signature on the intent, not
  from the wallet signing the tx. Updates are NOT admin-gated.
- **Coordinator script.** Single source of truth for cross-UTxO arithmetic
  inside an update (fees, witness/output/input correspondence, expiry,
  freshness). Per-pair scripts run a minimal local body and trust the
  coordinator for the rest. See architecture §5.9.

## In-scope security properties

- DIA intent authenticity (EIP-712 + `secp256k1` recovery, authorised signer
  list pinned in Config).
- Intent expiry enforced against the tx's finite upper validity bound.
- Intent freshness on first-mint (max-drift window) and intent monotonicity
  on update (`is_fresh_update`: strict-greater `timestamp` AND `nonce`).
- Pair NFT non-duplication and continuity (NFT cannot escape the per-client
  `pair_state` script address; coordinator pins mint count vs. create count).
- Cross-script redeemer-confusion defence (`coordinator_in_update_mode` /
  `coordinator_intent_matches` at every script that consumes a coordinator
  redeemer).
- Admin gate on Pair NFT creation (`MintPairs`) and burn
  (`BurnPairs`/`BurnPair`), so a signed DIA intent alone cannot mint or
  destroy a Pair NFT.
- Fee accounting: receiver delta == coordinator-computed fee; settle delta
  == sum of receiver drains.

## Known exclusions (out of scope)

- **DIA price correctness.** Whether the signed price reflects reality is
  outside the protocol's purview. A compromised DIA aggregator that signs a
  wrong price will produce a valid on-chain update.
- **DIA signer-key compromise.** Theft or misuse of any
  `authorized_dia_public_keys` key allows an attacker to sign arbitrary
  intents that the protocol will accept until the key is rotated through an
  admin-signed `AdminUpdate`. Out-of-band key custody is not addressed here.
- **`config_admins` key compromise.** A malicious admin can: drain all
  unused Receiver balances via `Withdraw`, drain all PaymentHook balances
  via `Withdraw { amount }`, rotate Config to point at attacker-controlled
  scripts/keys, burn arbitrary Pair UTxOs to recover the locked min-ADA,
  and create duplicate Pair UTxOs for the same `pair_token_name`
  (see "Admin can still create duplicates" below). Mitigation lives in
  key custody (multi-sig wallet, HSM, etc.), not in the contracts.
- **Admin can still create duplicate pairs.** A `config_admins` signer
  with a fresh DIA intent can mint two Pair NFTs with the same
  `pair_token_name` in two separate transactions. There is no on-chain
  registry of "live" Pair NFTs per client and per symbol, so the
  per-client `pair_state` policy currently treats each mint as
  independent. The honest off-chain CLI prevents this by checking for an
  existing Pair UTxO before submitting `MintPairs`, but the on-chain
  validator does not enforce it. A registry-singleton design (one
  "client-pair index" NFT per `(receiver_hash, pair_token_name)` that
  toggles between "live" and "burned") would close this, at the cost of
  an extra UTxO and an extra script in every create/burn tx.
- **Censorship resistance of updates.** A withholding-style attacker can
  refuse to submit price updates, leaving on-chain prices stale. The
  protocol only guarantees that an accepted update is well-formed; it does
  not guarantee timely delivery. Stale-price handling is left to
  consumers.
- **Network-level MEV / replacement.** Standard Cardano EUTxO replay
  protection (per-UTxO nonce ordering on the Pair, intent expiry, and
  finite validity range) prevents on-chain replay, but does not prevent
  mempool reordering or rejection of competing tx submissions.
- **Off-chain CLI custody.** The reference CLI in `offchain/cli/` reads a
  seed from `.env`. Operators are expected to scope that file to the
  admin host. The contracts make no assumptions about which off-chain
  client builds the tx.

## Notable invariants worth re-checking on audit

- `pair_state.mint(MintPairs)` requires `has_config_signer` AND
  `pair_mint_intent_satisfied`. Removing either re-opens intent-replay at
  creation time.
- `pair_state.spend(BurnPair)` requires `has_config_signer` AND the matching
  `tx.mint == -1` entry. Removing either lets a malicious admin "drain"
  min-ADA without burning the NFT, or vice versa.
- `pair_state.spend(ApplyUpdate)` is intentionally minimal. The audit
  property is that the coordinator's redeemer body covers every check this
  branch omits. See architecture §5.9 ("Coordinator batch validation
  algorithm").
- The off-chain canonical batch order (`pair_token_name`, strict ascending)
  is enforced on-chain by `batch_witness_header_ok`. A divergence between
  the off-chain comparator and `bytearray.compare` over raw bytes would
  cause valid batches to be rejected, not invalid ones to be accepted —
  but is still worth a regression check.

