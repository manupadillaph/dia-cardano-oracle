# Cardano port — proposed architecture and pending confirmations

Port of `PushOracleReceiverV2` + `ProtocolFeeHook` to Cardano.
Assumes multi-tenant (one receiver per client).

## Architecture

Shared per chain:

- `ProtocolFeeHook` UTxO — accumulates fees from all clients.
- Shared script validators, compiled once.

Per client:

- `Receiver` UTxO — holds the client's prepaid lovelace balance used to
  pay protocol fees on each price update. Direct equivalent of the EVM
  `PushOracleReceiverV2` contract, whose own `address.balance` is the
  client's prepaid pool. Script is parameterized per client so each
  client has a unique on-chain address to send top-ups to.

- `Config` UTxO — signers, domain, allowed pairs, fee amount. Used as a
  read-only reference input on every price update, spent only on
  governance actions (rotate signers, adjust fee, update allowed pair
  list).

- N `Pair` UTxOs — one per subscribed pair.

Each per-client UTxO carries a client-identity NFT.

Off-chain wallets:

- DIA Updater — pays Cardano tx fees on updates and receives Hook
  withdrawals. In EVM there seem to be two separate DIA wallets (an
  updater/relayer and a Spectra gas wallet); on Cardano I'm collapsing
  them into a single wallet per your preference of fewer keys. Let me
  know if you want them split.
- Client — funds its own `Receiver`.

## Pending confirmations

1. **Deployment model.** I'm assuming one `PushOracleReceiver` per
   client/dApp (N per chain, sharing a single `ProtocolFeeHook`). I'm
   asking because the public DIA docs gave me conflicting signals:

   - `deployed_contracts.json` in `diadata-org/Spectra-interoperability`
     lists exactly one `PushOracleReceiver` address per destination
     chain.
   - `docs.diadata.org/introduction/intro-to-dia-oracles/request-an-oracle`
     says *"DIA deploys bespoke oracles per dApp"*.

   Everything else in this doc follows the per-client reading. Please
   confirm that's correct before I freeze the design.

2. **Client identity.** Is the receiver's address the only identifier, or
   is there an explicit client ID / registry? My proposal on Cardano: a
   per-client NFT.

3. **Per-client traceability in the Hook.** Each fee movement
   `Receiver` → `Hook` could record per-client usage. Two options:

   a) Hook datum holds only a total balance. Per-client usage is
      reconstructed off-chain by indexing tx events. Closest to the EVM
      model.

   b) Hook datum holds a map `{client identity NFT → accumulated lovelace
      contributed}`. Full on-chain accounting per client. The datum grows
      with the number of clients, so every fee-movement tx gets more
      expensive over time.

   Which one does DIA need?

4. **Fee flow.** In EVM, two independent flows run on each update: the
   Hyperlane relayer pays destination-chain gas upfront and is reimbursed
   later from manual `withdrawFees(…)` on the Hook; and inside `handle()`
   the receiver deducts a protocol fee from its own balance into the
   Hook.

   Cardano constraint: the ledger charges the tx fee from inputs before
   script execution, so the fee cannot be pulled from the Hook inside
   the same tx. The DIA Updater must already hold ADA to cover it.

   Two options for how the per-update protocol fee moves. In both, the
   DIA Updater pays the Cardano network fee on every tx below, and
   `fee` = `protocol_fee_per_tx_lovelace`.

   **Option A — Atomic update + periodic refill (2 tx types)**

   *A.1 Update tx* (every price update)
   - Inputs: client's `Receiver` UTxO, `Hook` UTxO, Pair UTxO, DIA Updater
     ADA (network fee).
   - Reference input: client's `Config` UTxO.
   - Redeemer: signed price update from an authorized DIA signer.
   - Outputs: `Receiver` recreated (balance − `fee`), `Hook` recreated
     (balance + `fee`), Pair recreated (new price + timestamp).
   - Signers: DIA Updater.

   *A.2 Refill tx* (periodic)
   - Inputs: `Hook` UTxO, DIA admin ADA (network fee).
   - Outputs: `Hook` recreated (balance − `X`), `X` lovelace to DIA Updater.
   - Signers: DIA admin.

   **Option B — Everything split (3 tx types)**

   *B.1 Fee collection tx* (every price update, or batched)
   - Inputs: client's `Receiver` UTxO, `Hook` UTxO, DIA Updater ADA
     (network fee).
   - Reference input: client's `Config` UTxO.
   - Outputs: `Receiver` recreated (balance − `fee`), `Hook` recreated
     (balance + `fee`).
   - Signers: DIA Updater.

   *B.2 Refill tx* (periodic)
   - Inputs: `Hook` UTxO, DIA admin ADA (network fee).
   - Outputs: `Hook` recreated (balance − `X`), `X` lovelace to DIA Updater.
   - Signers: DIA admin.

   *B.3 Update tx* (every price update)
   - Inputs: Pair UTxO, DIA Updater ADA (network fee).
   - Reference input: client's `Config` UTxO.
   - Redeemer: signed price update from an authorized DIA signer.
   - Outputs: Pair recreated (new price + timestamp).
   - Signers: DIA Updater.

5. **Config script layout.** The `Receiver` script is always per-client
   (each client needs a unique funding address). For the `Config` script,
   two options:

   A) One shared `Config` script address. All clients' `Config` UTxOs
      live at the same address, distinguished by their identity NFT in
      the datum.

   B) One parameterized `Config` script per client. Each client's
      `Config` UTxO lives at its own address.

## Not blocked by the above

- `ProtocolFeeHook` is one per chain, shared. Manual withdraws only.
- Hook withdrawals land in the DIA Updater wallet (off-chain EOA).
- Fee per update is an admin-tunable ADA amount per client (no Cardano
  equivalent to `gasUsedPerTx * tx.gasprice`). The plan is to estimate
  the Cardano tx execution cost (script steps + tx size) plus a safety
  margin, so the DIA Updater is always covered. The exact formula is
  still to be defined and may depend on factors like number of pairs
  updated per tx, which affect tx size and cost.

---

## DIA answers (2026-04-21)

Source: review comments by Nitin Gurbani (and Zygis Marazas) on the
shared Google Doc.

### Q1 — Deployment model → confirmed

> "Assumption is correct. Every chain has a single `ProtocolFeeHook`
> which is common per client."

Per-client `PushOracleReceiver` + single shared `ProtocolFeeHook` per
chain. No change to the assumption this doc was built on.

### Q2 — Client identity → receiver address is the only ID, no NFT

> "In current system receiver's address is the only identifier."
> "What benefit does this NFT provide? We can save all config in
> receiver contract."

DIA prefers not to introduce a per-client identity NFT on Cardano. The
receiver contract's own address is the client identifier.

Impact:

- Drop the per-client identity NFT from the design.
- Merge `Config` into the `Receiver`: signers, fee amount, domain, etc.
  live inside the receiver contract (as script parameters and/or datum),
  not in a separate UTxO. Q5 (Config script layout) becomes moot.
- `Pair` UTxOs link to the client by living at an address parameterized
  by the receiver's identity (script hash / pointer), not by an NFT.

### Q2b — Updater permissioning → permissionless + signed Intents

> "Receiver contract verifies secp256k1 signed Intent against public key
> which is configured in smart contract, so that updaters are
> permissionless, until they use signed updates."
> Example intent tx: `0x1f37f36641261a6cd321d735737264afb560d0d09da6fb643c1dfedb95369f3d`

Updaters are permissionless. Anyone can submit the update tx; the
receiver validates a `secp256k1`-signed Intent against a public key
stored in the receiver's configuration. Only validly signed updates
pass.

Impact:

- Receiver script must verify `secp256k1` signatures natively on Cardano
  (Plutus V2+ supports `verifyEcdsaSecp256k1Signature` /
  `verifySchnorrSecp256k1Signature`). Stick with ECDSA to match DIA
  signers.
- No allowlist of updater wallets on-chain. The `signers` field in the
  receiver config holds the DIA signer public keys.
- Need to define the exact Intent byte layout before implementation
  (followup: reproduce the example tx above and document the payload).

### Q3 — Per-client traceability in the Hook → Option A

> "Currently option A is used. Let's stick to that."

`Hook` datum stores only a total balance. Per-client usage is
reconstructed off-chain by indexing events. No on-chain `{client →
lovelace}` map.

### Allowed-pair list in Config → not needed on-chain

> "All pairs are allowed by default, contract only verifies the
> signature."
> "That list is not required, as the map takes care that no symbol is
> added twice. And this list is maintained in off-chain service level."

Impact:

- Remove `allowed pairs` from the receiver configuration.
- The receiver does not enforce which pairs are valid. The signer set
  implicitly authorizes any pair by signing the Intent.
- The "one pair UTxO per symbol" invariant is enforced structurally (one
  UTxO per symbol at the derived address), not by a whitelist.
- Pair subscription / filtering is an off-chain concern (DIA service
  level).

### Still pending

- **Q4 Fee flow.** No explicit answer captured in the review comments.
  Still need Option A (atomic update + periodic refill) vs Option B
  (everything split) confirmed. Default remains Option A.
- **Fee calculation formula.** Estimation of execution cost + tx size +
  safety margin, possibly parameterized by number of pairs per tx.
  Research item for the implementation phase.

### Net architecture after these answers

Shared per chain:

- `ProtocolFeeHook` — single UTxO, datum = total balance only.

Per client:

- `Receiver` — one per-client parameterized script. Datum/params carry
  `signers` (secp256k1 public keys), `fee_per_tx_lovelace`, `domain`,
  balance. No separate `Config` UTxO. No identity NFT.
- N `Pair` UTxOs — one per subscribed pair, linked to the receiver by
  its script hash.

Update tx (Option A, subject to Q4 confirmation):

- Anyone can submit. Inputs: Pair + `Receiver` + `Hook` + own ADA for
  network fee.
- Redeemer: secp256k1-signed Intent validated against the receiver's
  configured signer keys.
- Outputs: Pair (new price), `Receiver` (balance − fee), `Hook`
  (balance + fee).
