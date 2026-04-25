# Multi-tenant architecture — Cardano port, proposal and open questions

Port target: `PushOracleReceiverV2.sol` + `ProtocolFeeHook.sol` from
`diadata-org/Spectra-interoperability` (branch `intentbased`).

Two signals conflict in the public docs:

- `deployed_contracts.json` lists **one** `PushOracleReceiver` / `ProtocolFeeHook`
  per destination chain.
- `docs.diadata.org/introduction/intro-to-dia-oracles/request-an-oracle` says
  *"DIA deploys bespoke oracles per dApp"*.

I could not find documentation that explicitly resolves whether Spectra V2
runs one shared receiver per chain or one receiver per client/dApp.
I am proceeding on the assumption of the latter (multi-tenant) and want this
confirmed before implementation starts.

---

## Proposed architecture (multi-tenant)

### Shared per chain (1 instance, operated by DIA)

- `ProtocolFeeHook` UTxO — accumulates fees from all client updates.
- Script validators codebase (receiver, pair, hook, optional coordinator) —
  single compiled deployment; all clients share the same script addresses.

### Per client (N instances)

Per-client state has two pieces:

- **`Receiver` UTxO** — holds the client's prepaid lovelace balance used to
  pay protocol fees on each of their price updates. Direct equivalent of
  `PushOracleReceiverV2` in EVM, where the contract's own `address.balance`
  is the client's prepaid pool. **The `Receiver` script must be parameterized
  per client**, so each client has a unique on-chain address to which they
  send top-ups. Sharing a script address across clients would force every
  top-up to spend-and-recreate a specific UTxO identified by NFT, which is
  awkward for clients and breaks parity with the EVM model where each client
  simply sends funds to their own contract address.

- **`Config` UTxO** — signers, domain, allowed pairs, fee amount. Used as a
  read-only reference input on every price update, spent only on governance
  actions (rotate signers, adjust fee, update allowed pair list). Does not
  receive funds directly.

Plus N `Pair` UTxOs per client — one per subscribed pair (`BTC/USD`,
`ETH/USD`, …), linked to the client's `Receiver` by the identity NFT.

### Script layout — Config only

Two viable layouts for the `Config` script (not `Receiver`, which is always
per-client):

- **Variant A — Shared Config script**
  One `Config` script address, N `Config` UTxOs (one per client,
  distinguished by the per-client identity NFT in the datum).
  Deployment: 1 Config script + N per-client Receiver scripts.

- **Variant B — Per-client Config script**
  N parameterized `Config` scripts, one per client. Each client's `Config`
  UTxO lives at its own address.
  Deployment: 2N scripts total (N Config + N Receiver).

My default for Config is **Variant A** (shared). Config UTxOs do not
receive funds, so co-locating them is safe. One compiled artifact, lower
deployment and reference-script overhead. Variant B is only worth the extra
weight if DIA wants full address isolation per client for every piece of
state.

### External wallets

- **Updater wallet** (DIA) — pays ADA tx fees for each on-chain update.
- **Spectra gas wallet** (DIA) — receives periodic manual withdrawals from
  the `ProtocolFeeHook`.
- **Client funding wallet** — where each client's top-ups originate.

---

## Transaction types

| Type | Frequency | Signer | Effect |
| --- | --- | --- | --- |
| Onboard new client | Once per client | DIA admin (+ client) | Mint identity NFT, create client's `Receiver` state, initial top-up |
| Client top-up | Ad-hoc | Client | Adds lovelace to client's `Receiver` |
| Price update | High (heartbeat / deviation) | DIA updater wallet | Atomic tx: spends Pair + client's `Receiver` + Hook; recreates all three with new price, reduced `Receiver` balance, increased Hook balance |
| Hook withdrawal | Low (manual) | DIA admin | Hook → Spectra gas wallet |
| Config change | Rare | Client admin / DIA | Updates signers / pairs / fee per client |

---

## Open design decision: tx fee payment pattern

EVM model (from `handle()` in `PushOracleReceiverV2`):

- Hyperlane relayer (a DIA EOA) pays destination-chain gas upfront.
- Inside `handle()`, the receiver deducts a protocol fee from its own balance
  and forwards it to `ProtocolFeeHook`.
- Relayer is reimbursed off-chain, later, from manual `withdrawFees(…)` on the
  hook into the Spectra gas wallet.

Two independent flows: (a) tx-gas paid upfront and reimbursed later,
(b) protocol-fee deducted per update.

Cardano constraint: the ledger deducts the tx fee from inputs **before**
script execution. The tx fee cannot be "pulled from the hook" inside the
same tx — the updater wallet must already hold enough ADA to cover it before
submitting.

Three patterns are possible:

- **Pattern 1 — EVM mirror**
  Updater wallet pays ADA tx fee. Same tx deducts `protocol_fee_per_tx_lovelace`
  from the client's `Receiver` into the Hook. Updater wallet is refilled
  off-chain from periodic Hook withdrawals → Spectra gas wallet → updater.

- **Pattern 2 — Direct reimbursement**
  Updater wallet pays ADA tx fee. Same tx sends the deducted protocol fee
  straight to the updater wallet (skipping Hook as a per-tx stop). Hook only
  holds reserves / shared costs.

- **Pattern 3 — Hook-routed reimbursement each tx**
  Updater wallet pays ADA tx fee. Same tx: `Receiver` → Hook, and Hook →
  updater in the same tx. Variant of 1 that keeps the Hook as accumulator
  but self-refills the updater on every update.

My default proposal is **Pattern 1** (EVM parity, single aggregation point,
simpler off-chain accounting), unless DIA has a preference.

---

## Open questions for DIA

1. **Confirm the deployment model**
   (A) One shared `PushOracleReceiverV2` per chain, operated by DIA, all
       consuming dApps read from the same `updates` mapping. No per-dApp
       contract instance.
   (B) One `PushOracleReceiverV2` **per client/dApp**. N instances per chain,
       each with its own address, prepaid balance, signer set, and feeds.
       `ProtocolFeeHook` is the only per-chain singleton.
   Which one applies to Spectra V2?

2. **Client identity on-chain**
   Assuming (B), is the client identified only by the receiver's contract
   address, or is there also a registry / explicit client ID scheme that
   should be preserved on Cardano?
   My proposal for Cardano: a per-client identity NFT (policy ID + asset
   name) locked in the client's state, acting as the canonical identifier.

3. **Updater ↔ receiver linkage at update time**
   In EVM the link is implicit via Hyperlane message routing plus signature
   verification inside `handle()`. Cardano has no Hyperlane layer — the
   updater wallet submits the update tx directly, targeting a specific
   client's UTxO.
   Is it acceptable that on Cardano the linkage is exclusively
   (a) updater knows the client's receiver UTxO off-chain, plus
   (b) a signature over domain-separated data validated by the receiver's
   configured signer set?

4. **Client-to-update traceability**
   In EVM, per-update events are emitted, but there is no on-chain per-client
   accounting. How is per-client usage reconciled off-chain between each
   client's receiver balance and the Spectra gas wallet? Any invariant DIA
   relies on that should be preserved in Cardano?

5. **Fee-flow pattern**
   Pattern 1 (EVM mirror, recommended), Pattern 2 (direct reimbursement), or
   Pattern 3 (hook-routed reimbursement each tx)?

6. **Onboarding flow**
   Who deploys a new client's Receiver on Cardano — DIA, the client, or
   either? What controls the permission to mint a new client identity NFT?

7. **Config script layout**
   The `Receiver` script is always per-client (each client needs a unique
   funding address). For the `Config` script, any preference between
   Variant A (one shared script, N Config UTxOs distinguished by NFT —
   my default) or Variant B (N parameterized Config scripts, one per
   client)?

---

## Items not blocked by the above

These hold under any answer to the questions above and can be frozen now:

- `ProtocolFeeHook` is one per chain, shared. Manual `withdrawFees` only.
- Withdrawals go to an externally-managed Spectra gas wallet (off-chain EOA).
- Update fee is an admin-tunable `protocol_fee_per_tx_lovelace` configured
  per client receiver, analogous to EVM's `gasUsedPerTx * tx.gasprice`
  (Cardano has no equivalent gas market; a fixed tunable lovelace amount is
  the only meaningful translation).
