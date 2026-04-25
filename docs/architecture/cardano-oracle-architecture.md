# Cardano Oracle Architecture

This document is the single architecture reference for the Cardano port of DIA's push-oracle contracts. It defines the contract set, UTxO model, datums, transaction shapes, deployment sequence, and open items pending DIA confirmation.

Reference inputs to this document:

- [Cardano Integration Requirement [PF]](../../specs/requirements/cardano-integration-requirement-pf.md)
- [Final Cardano Milestones](../milestones/final-cardano-milestones.md)

---

## 1. Contracts (scripts)

### 1.1 Scripts and compile-time parameters

| # | Script | Kind | Instances | Compile-time parameters |
|---|---|---|---|---|
| 1 | `config_state` | multivalidator (mint + spend) | 1 global | `bootstrap_ref_config: OutputReference`, `config_asset_name: AssetName` |
| 2 | `update_coordinator` | stake withdraw | 1 global | `config_policy_id: PolicyId`, `config_asset_name: AssetName` |
| 3 | `payment_hook` | multivalidator (mint + spend) | 1 global | `bootstrap_ref_hook: OutputReference`, `hook_asset_name: AssetName`, `config_policy_id`, `config_asset_name`, `coordinator_credential: Credential` |
| 4 | `receiver` | multivalidator (mint + spend) | 1 per client | `receiver_ref: OutputReference`, `receiver_asset_name: AssetName`, `config_policy_id`, `config_asset_name` |
| 5 | `pair_state` | multivalidator (mint + spend) | 1 per client | `config_policy_id`, `config_asset_name`, `receiver_hash: ScriptHash` |
| 6 | `reference_holder` | spend validator | 1 global | none |

Notes:

- The reusable global validators (`config_state` spend, `update_coordinator` withdraw, `payment_hook` spend) are published as reference scripts. One-shot minting policies are used only by their bootstrap transactions.
- `receiver` is recompiled every time DIA onboards a new client. A fresh `receiver_ref` per client yields a different script hash and therefore a different address. The client is not an admin of their Receiver: they only prepay ADA and consume prices off-chain, matching the EVM behaviour. Every privileged action on the Receiver is signed by DIA admin (the `config_admins`).
- `pair_state` is recompiled per client too, parametrized by that client's `receiver_hash`, so every client's pairs live in their own address, isolated from other clients' pairs.
- `update_coordinator` runs once per update transaction using the `withdraw 0` trigger. It centralizes the shared logic (DIA signature check, fee movement, continuity) so the per-UTxO validators do not duplicate those checks.
- `reference_holder` is used only as the address for reference-script UTxOs. It rejects spend attempts so these UTxOs are not spendable by the deploy wallet.

### 1.2 Compile-time dependency graph

```mermaid
flowchart LR
  BRC([bootstrap_ref_config<br/>wallet UTxO]):::wallet --> Config[config_state]:::script
  Config -- config_policy_id, config_asset_name --> Coord[update_coordinator]:::script
  Coord -- coordinator_credential --> Hook[payment_hook]:::script
  Config -- config_policy_id, config_asset_name --> Hook
  BRH([bootstrap_ref_hook<br/>wallet UTxO]):::wallet --> Hook

  Config -. config refs .-> Receiver[receiver of client X]:::script
  RR([receiver_ref<br/>wallet UTxO per client]):::wallet --> Receiver
  Receiver -- receiver_hash --> Pair[pair_state of client X]:::script
  Config -. config refs .-> Pair

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
```

Solid arrows are compile-time inputs that change the script hash. Dashed arrows mark parameters that only pin the script to a given Config instance but follow directly from the global compilation.

### 1.3 Setup sequence

**Global setup, done once by DIA.**

1. Reserve a wallet UTxO to be `bootstrap_ref_config` and pick `config_asset_name`.
2. Compile `config_state` with `(bootstrap_ref_config, config_asset_name)`. Record `config_policy_id` (= the hash of the compiled script, since this is a multivalidator).
3. Compile `update_coordinator` with `(config_policy_id, config_asset_name)`. Record `coordinator_credential` (the stake credential of this withdraw validator).
4. Reserve a wallet UTxO to be `bootstrap_ref_hook` and pick `hook_asset_name`.
5. Compile `payment_hook` with `(bootstrap_ref_hook, hook_asset_name, config_policy_id, config_asset_name, coordinator_credential)`.
6. Publish the three compiled scripts as reference-script UTxOs so later transactions can cite them instead of embedding the binary.
7. Submit tx **5.1 Config bootstrap** (consumes `bootstrap_ref_config`, mints the Config NFT, creates the Config UTxO with its initial datum).
8. Submit tx **5.2 PaymentHook bootstrap** (consumes `bootstrap_ref_hook`, mints the Hook NFT, updates the Config datum to point at the Hook and the coordinator, and carries a stake-registration certificate for `coordinator_credential`).

**Per-client onboarding, done once per client by DIA.**

1. Reserve a wallet UTxO to be `receiver_ref` for this client and pick `receiver_asset_name`.
2. Compile `receiver` with `(receiver_ref, receiver_asset_name, config_policy_id, config_asset_name)`. Record `receiver_hash`.
3. Compile `pair_state` with `(config_policy_id, config_asset_name, receiver_hash)`. Record this client's `pair_policy_id`.
4. Publish both as reference-script UTxOs for this client.
5. Submit tx **5.4 Receiver bootstrap** (consumes `receiver_ref`, mints the Receiver NFT, creates the Receiver UTxO with its initial balance).
6. For each pair the client subscribes to, submit tx **5.7 Pair bootstrap** (mints the Pair NFT for that `pair_id`, creates the initial Pair UTxO).

### 1.4 Reference-script deployment (global)

```mermaid
flowchart LR
  Admin([DIA Admin Wallet]):::wallet

  Admin --> TX1((Publish Config<br/>reference scripts)):::tx
  Admin --> TX2((Publish PaymentHook<br/>reference script)):::tx

  TX1 --> RSC[Reference-script UTxO<br/>script: config_state spend<br/>at reference_holder addr]:::script
  TX1 --> RSK[Reference-script UTxO<br/>script: update_coordinator withdraw<br/>at reference_holder addr]:::script
  TX2 --> RSH[Reference-script UTxO<br/>script: payment_hook spend<br/>at reference_holder addr]:::script
  TX1 --> Change1([Admin change]):::wallet
  TX2 --> Change2([Admin change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** once per chain. Config and Coordinator reference scripts are published after Config parameterization. PaymentHook reference script is published after PaymentHook parameterization.
- **Inputs:** admin wallet UTxOs funding the min-UTxO of each reference-script output.
- **Outputs:** three reference-script UTxOs, each carrying the reusable compiled script binary in its `reference_script` field. No datum, no mint, no redeemer.
- **Address:** the `reference_holder` script address.
- **Minting policies:** Config and PaymentHook minting policies are one-shot bootstrap scripts and are not published as reference scripts.

### 1.5 Reference-script deployment (per client, per-client step 4 above)

```mermaid
flowchart LR
  Admin([DIA Admin Wallet]):::wallet

  Admin --> TX((Publish client<br/>reference scripts)):::tx

  TX --> RSR[Reference-script UTxO<br/>script: receiver spend of client X<br/>at reference_holder addr]:::script
  TX --> RSP[Reference-script UTxO<br/>script: pair_state spend of client X<br/>at reference_holder addr]:::script
  TX --> Change([Admin change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** once per onboarded client, before **5.4 Receiver bootstrap** for that client.
- **Inputs:** admin wallet UTxOs.
- **Outputs:** two reference-script UTxOs carrying the client-specific `receiver` and `pair_state` binaries.
- **Isolation:** the binaries embed `receiver_ref` and `receiver_hash` respectively, so each client has its own pair of reference-script UTxOs with distinct hashes; they cannot be reused across clients.
- **Minting policies:** Receiver and Pair minting policies are one-shot/bootstrap scripts and are not published as reference scripts.

---

## 2. Identity tokens (state tokens)

All are NFTs (quantity 1, fixed asset name).

| Token | Minting policy | Minted on | Purpose |
|---|---|---|---|
| Config NFT | `config` | Config bootstrap | Marks the canonical Config UTxO |
| PaymentHook NFT | `payment_hook` | Hook bootstrap | Marks the canonical Hook UTxO |
| Receiver NFT | `receiver` | Receiver bootstrap (per client) | Marks the canonical Receiver UTxO for that client |
| Pair NFT | `pair_state` | Pair bootstrap (per pair) | Marks the canonical Pair UTxO for that client and pair |

Per DIA's request, these NFTs are not a "client identity" mechanism. They are state tokens required by the eUTxO model to identify the live UTxO of each state. Client identity remains the script hash of the client's Receiver (same principle as the EVM contract address being the client identifier).

---

## 3. UTxOs per script address

With `C` onboarded clients, client `i` subscribed to `N_i` pairs, the on-chain footprint is:

| Script address | State UTxOs at steady state | Reference-script UTxOs |
|---|---|---|
| `config_state` spend | 1 (Config UTxO) | 1 |
| `payment_hook` spend | 1 (PaymentHook UTxO) | 1 |
| `update_coordinator` | 0 (withdraw validator, no state UTxO) | 1 |
| `receiver` spend of client `i` | 1 (Receiver UTxO of client `i`) | 1 per client |
| `pair_state` spend of client `i` | `N_i` (one per subscribed pair) | 1 per client |

Totals:

- **Global state UTxOs:** `1` Config + `1` Hook = `2`.
- **Per-client state UTxOs:** `1` Receiver + `N_i` Pairs for client `i`.
- **Total live state UTxOs on the chain:** `2 + sum_i (1 + N_i)`.
- **Reference-script UTxOs:** `3` global + `2` per client. These are one-off immutable UTxOs, not "live state"; they only exist so consumers can cite the script hash instead of embedding the binary in every tx.

Reference-script UTxOs are typically parked at an address whose spend always fails, so the binary is immutable. That address is a deployment detail, not part of the protocol logic.

---

## 4. Datums

### 4.1 Config datum

```
{
  config_admins:              [PubKeyHash],          -- Cardano keys allowed to sign config changes and privileged Receiver actions
  authorized_dia_public_keys: [ByteArray(33)],       -- DIA secp256k1 compressed pubkeys that sign Intents
  domain: {
    name:               ByteArray,
    version:            ByteArray,
    source_chain_id:    Int,
    verifying_contract: ByteArray,
  },
  protocol_fee_lovelace: Int,                       -- fee moved Receiver -> Hook on each update
  payment_hook_ref:      ScriptHash,                -- active hook
  coordinator_cred:      Credential,                -- active update_coordinator stake credential
  min_utxo_lovelace:     Int,
}
```

Config does not carry a global pair allow-list.

### 4.2 PaymentHook datum

```
{
  withdraw_address:          Address,   -- payout target for withdrawals
  accrued_fees_lovelace:     Int,       -- current accumulated balance
  lifetime_collected_lovelace: Int,     -- historical collected
  lifetime_withdrawn_lovelace: Int,     -- historical withdrawn
  min_utxo_lovelace:         Int,
}
```

Invariant: `utxo.lovelace == min_utxo_lovelace + accrued_fees_lovelace`.

### 4.3 Receiver datum (per client)

```
{
  balance_lovelace:    Int,   -- prepaid pool
  min_utxo_lovelace:   Int,
}
```

Invariant: `utxo.lovelace == min_utxo_lovelace + balance_lovelace`.

Signers, fees and admins live in Config. The client has no on-chain representation inside the Receiver: their identity is the script address, derived from the bootstrap `OutputReference`. The `client -> address` mapping is kept off-chain.

### 4.4 Pair datum (per client, per pair)

```
{
  pair_id:            ByteArray,          -- e.g. "BTC/USD"
  price:              Int,
  timestamp:          Int,
  nonce:              Int,
  last_intent_hash:   ByteArray(32),      -- EIP-712 digest of the last applied Intent
  last_signer:        ByteArray(20),      -- Ethereum-style address from the last applied Intent
  min_utxo_lovelace:  Int,
}
```

Replay protection: `new.timestamp > old.timestamp && new.nonce > old.nonce`.

Binding to the client's Receiver is enforced by the `pair_state` script being parametrized by `receiver_hash`. `pair_id` is kept in the datum for cheap off-chain indexing, since the Pair NFT asset name is a one-way hash of `pair_id`.

---

## 5. Transactions

For each tx: inputs, reference inputs, mint, outputs, redeemers, required signers, what it validates.

**Diagram conventions.**

```mermaid
flowchart LR
  W([Wallet UTxO]):::wallet
  S[Script UTxO]:::script
  Ref[Reference input]:::script
  Red[/Redeemer or mint policy/]:::redeemer
  TX((Transaction)):::tx

  W -->|spent input| TX
  S -->|spent input| TX
  Ref -.->|reference input| TX
  Red -.->|attached validator| TX
  TX -->|output| Sout[Script UTxO out]:::script
  TX -->|output| Wout([Wallet UTxO out]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- Rounded nodes = wallet (PubKey) UTxOs.
- Sharp rectangles = script UTxOs (with datum).
- Parallelograms = redeemers / mint policies / withdraw scripts.
- Solid arrows = inputs being consumed or outputs being produced.
- Dashed arrows = reference inputs or attached validator / policy / withdrawal scripts.

### 5.1 Config bootstrap

```mermaid
flowchart LR
  Admin([DIA Admin Wallet]):::wallet
  OneShot([One-shot UTxO<br/>bootstrap_ref]):::wallet
  MintV[/config_state mint<br/>Bootstrap/]:::redeemer

  Admin --> TX((Config<br/>bootstrap)):::tx
  OneShot --> TX
  MintV -.-> TX

  TX -- mint +1 Config NFT --> ConfigOut[Config UTxO<br/>value: minUTxO + Config NFT<br/>datum: initial Config]:::script
  TX --> Change([Admin change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** once per chain.
- **Inputs:**
  - DIA admin wallet (pays network fee + min UTxO).
  - The specific UTxO referenced by the policy's one-shot `OutputReference` parameter.
- **Reference inputs:** —
- **Mint:** `+1` Config NFT.
- **Outputs:** Config UTxO (address = `config` spend, value = `min_utxo_lovelace` + Config NFT, datum = initial Config datum).
- **Mint redeemer:** `Bootstrap`.
- **Signers:** at least one of the `config_admins` listed in the output datum.
- **Validates:**
  - The parametrized output reference is consumed (one-shot guarantee).
  - Exactly one Config NFT is minted with the expected asset name.
  - Exactly one output at the Config address holds the NFT and a well-formed datum.
  - The datum references a valid `coordinator_cred` and `payment_hook_ref` (or placeholders if those get set later, preferably already set).

### 5.2 PaymentHook bootstrap

```mermaid
flowchart LR
  Admin([DIA Admin Wallet]):::wallet
  OneShot([One-shot UTxO]):::wallet
  ConfigIn[Config UTxO<br/>datum: Config v1]:::script
  ConfigV[/config_state spend<br/>AdminUpdate/]:::redeemer
  HookV[/payment_hook mint<br/>Bootstrap/]:::redeemer

  Admin --> TX((PaymentHook<br/>bootstrap)):::tx
  OneShot --> TX
  ConfigIn --> TX
  ConfigV -.-> TX
  HookV -.-> TX

  TX --> ConfigOut[Config UTxO<br/>datum: Config v2<br/>+payment_hook_ref<br/>+coordinator_cred]:::script
  TX -- mint +1 Hook NFT --> HookOut[PaymentHook UTxO<br/>value: minUTxO + Hook NFT<br/>datum: accrued=0, lifetime=0]:::script
  TX --> Change([Admin change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

Side effect: the same tx carries a stake registration certificate for `update_coordinator`.

- **Frequency:** once per chain.
- **Inputs:**
  - DIA admin wallet.
  - The parametrized one-shot UTxO.
  - Config UTxO.
- **Reference inputs:** —
- **Mint:** `+1` PaymentHook NFT.
- **Outputs:**
  - Config UTxO recreated (same NFT, datum updated with `payment_hook_ref` and `coordinator_cred` if applicable).
  - PaymentHook UTxO (value = `min_utxo_lovelace` + Hook NFT, datum with `accrued_fees_lovelace = 0`).
- **Hook mint redeemer:** `Bootstrap`.
- **Config spend redeemer:** `AdminUpdate`.
- **Signers:** `config_admins`.
- **Validates:**
  - Config input NFT preserved in the output.
  - Config datum changes are limited to `payment_hook_ref` / `coordinator_cred`.
  - Hook NFT minted exactly once and placed at the new Hook UTxO.
  - Hook datum initialized: `accrued_fees = 0`, `lifetime_collected = 0`, `lifetime_withdrawn = 0`.
  - Side effect: the coordinator stake credential is registered via a registration certificate in the same tx.

### 5.3 Config update

```mermaid
flowchart LR
  Admin([DIA Admin Wallet]):::wallet
  ConfigIn[Config UTxO<br/>datum: Config v1]:::script
  ConfigV[/config_state spend<br/>AdminUpdate/]:::redeemer

  Admin --> TX((Config<br/>update)):::tx
  ConfigIn --> TX
  ConfigV -.-> TX

  TX --> ConfigOut[Config UTxO<br/>datum: Config v2]:::script
  TX --> Change([Admin change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** rare (rotate signers, change fee, change domain, change hook, change coordinator).
- **Inputs:** Config UTxO.
- **Reference inputs:** —
- **Mint:** —
- **Outputs:** Config UTxO recreated (same NFT, modified datum).
- **Spend redeemer:** `AdminUpdate`.
- **Signers:** `config_admins`.
- **Validates:**
  - Config NFT continuity.
  - `min_utxo_lovelace` preserved.
  - Output datum is well-formed.
  - Any datum change requires an admin signature (checked against the input datum).

### 5.4 Receiver bootstrap (per client)

```mermaid
flowchart LR
  Admin([DIA Admin Wallet<br/>+ optional initial_balance]):::wallet
  OneShot([One-shot UTxO<br/>receiver_ref]):::wallet
  ConfigRef[Config UTxO]:::script
  Policy[/receiver mint<br/>Bootstrap/]:::redeemer

  Admin --> TX((Receiver<br/>bootstrap)):::tx
  OneShot --> TX
  ConfigRef -.-> TX
  Policy -.-> TX

  TX -- mint +1 Receiver NFT --> ReceiverOut[Receiver UTxO<br/>value: minUTxO + initial_balance + Receiver NFT<br/>datum: balance_lovelace, min_utxo_lovelace]:::script
  TX --> Change([Admin change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** once per client.
- **Inputs:**
  - DIA admin wallet (pays network fee + min UTxO; may also include `initial_balance` if DIA pre-funds the client).
  - The parametrized one-shot UTxO for this Receiver.
- **Reference inputs:** Config UTxO (required to check the signer is in `config_admins`).
- **Mint:** `+1` Receiver NFT (policy = `receiver` parametrized for this client).
- **Outputs:** Receiver UTxO (address = `receiver<client>` spend, value = `min_utxo_lovelace + initial_balance` + Receiver NFT, datum = `{ balance_lovelace = initial_balance, min_utxo_lovelace }`).
- **Mint redeemer:** `Bootstrap`.
- **Signers:** at least one `Config.config_admins` (DIA admin).
- **Validates:**
  - The parametrized output reference is consumed.
  - Exactly one Receiver NFT is minted with the expected asset name.
  - Exactly one output at the Receiver address holds the NFT.
  - Invariant `utxo.lovelace == min_utxo_lovelace + balance_lovelace`.
  - Signer is one of `config_admins` (read from the reference input).

### 5.5 Receiver top-up

```mermaid
flowchart LR
  Funder([Funder Wallet<br/>top_up ADA]):::wallet
  ReceiverIn[Receiver UTxO<br/>balance v1]:::script
  ReceiverV[/receiver spend<br/>TopUp/]:::redeemer

  Funder --> TX((Receiver<br/>top-up)):::tx
  ReceiverIn --> TX
  ReceiverV -.-> TX

  TX --> ReceiverOut[Receiver UTxO<br/>balance v2 = v1 + top_up]:::script
  TX --> Change([Funder change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** ad-hoc. Permissionless (matches EVM `receive()`).
- **Inputs:**
  - Receiver UTxO.
  - Wallet contributing the funds (the client, or anyone).
- **Reference inputs:** —
- **Mint:** —
- **Outputs:** Receiver UTxO recreated (same NFT, datum with `balance_lovelace += top_up`, `utxo.lovelace` increased by `top_up`).
- **Spend redeemer:** `TopUp`.
- **Signers:** none required by the validator (the tx is signed by whoever provides the funding input).
- **Validates:**
  - Receiver NFT continuity.
  - `min_utxo_lovelace` in the datum does not change.
  - `new.balance_lovelace == old.balance_lovelace + (new.utxo.lovelace - old.utxo.lovelace)`.
  - `new.utxo.lovelace >= old.utxo.lovelace` (cannot withdraw through this path).

### 5.6 Receiver withdraw (equivalent to EVM `retrieveLostTokens`)

```mermaid
flowchart LR
  Admin([DIA Admin Wallet]):::wallet
  ReceiverIn[Receiver UTxO<br/>balance v1]:::script
  ConfigRef[Config UTxO]:::script
  ReceiverV[/receiver spend<br/>Withdraw amount recipient/]:::redeemer

  Admin --> TX((Receiver<br/>withdraw)):::tx
  ReceiverIn --> TX
  ConfigRef -.-> TX
  ReceiverV -.-> TX

  TX --> ReceiverOut[Receiver UTxO<br/>balance v2 = v1 - amount]:::script
  TX --> Recipient([Recipient Wallet<br/>+ amount]):::wallet
  TX --> Change([Admin change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** rare.
- **Inputs:** Receiver UTxO, DIA admin wallet (network fee).
- **Reference inputs:** Config UTxO.
- **Outputs:** Receiver UTxO recreated (smaller balance), payout to the address the admin specifies.
- **Spend redeemer:** `Withdraw { amount, recipient }`.
- **Signers:** at least one `Config.config_admins`.
- **Validates:**
  - Receiver NFT continuity.
  - `amount <= old.balance_lovelace`.
  - `new.balance_lovelace == old.balance_lovelace - amount`.
  - `new.utxo.lovelace == old.utxo.lovelace - amount` (exactly `amount` goes to `recipient`).
  - Signer is one of `config_admins`.

### 5.7 Pair bootstrap (per client × pair)

The client-to-Pair binding is enforced by `pair_state` being parametrized by `receiver_hash`: client X's Pair minting policy has a different hash from client Y's.

```mermaid
flowchart LR
  Admin([DIA Admin Wallet]):::wallet
  ConfigRef[Config UTxO]:::script
  PairV[/pair_state mint<br/>Bootstrap pair_id/]:::redeemer

  Admin --> TX((Pair<br/>bootstrap)):::tx
  ConfigRef -.-> TX
  PairV -.-> TX

  TX -- mint +1 Pair NFT --> PairOut[Pair UTxO<br/>value: minUTxO + Pair NFT<br/>datum: pair_id, price=0, ts=0, nonce=0]:::script
  TX --> Change([Admin change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** once per (client, pair).
- **Inputs:** DIA admin wallet (pays network fee + min UTxO of the Pair).
- **Reference inputs:** Config UTxO (to check admin signature).
- **Mint:** `+1` Pair NFT (policy = `pair_state` parametrized by `receiver_hash` of this client; asset name derived from `pair_id`).
- **Outputs:** Pair UTxO (address = `pair_state` spend for this client, value = `min_utxo_lovelace` + Pair NFT, initial datum with `pair_id`, `price = 0`, `timestamp = 0`, `nonce = 0`).
- **Mint redeemer:** `Bootstrap { pair_id }`.
- **Signers:** at least one `Config.config_admins`.
- **Validates (mint policy):**
  - Signer is one of `config_admins` (read from the Config reference input).
  - Exactly one Pair NFT is minted.
  - Pair NFT asset name correctly derived from `pair_id`.
  - Exactly one output at the Pair address holds the NFT and a well-formed initial datum.

### 5.8 Price update (single) — main tx

```mermaid
flowchart LR
  Updater([Updater Wallet<br/>pays network fee]):::wallet
  PairIn[Pair UTxO<br/>price,ts,nonce v1]:::script
  ReceiverIn[Receiver UTxO<br/>balance v1]:::script
  HookIn[PaymentHook UTxO<br/>accrued v1]:::script
  ConfigRef[Config UTxO]:::script

  PairV[/pair_state spend<br/>ApplyUpdate/]:::redeemer
  ReceiverV[/receiver spend<br/>PayFee/]:::redeemer
  HookV[/payment_hook spend<br/>ApplyFee/]:::redeemer
  Coord[/update_coordinator withdraw<br/>ApplySingle intent/]:::redeemer

  Updater --> TX((Price update<br/>single)):::tx
  PairIn --> TX
  ReceiverIn --> TX
  HookIn --> TX
  ConfigRef -.-> TX
  PairV -.-> TX
  ReceiverV -.-> TX
  HookV -.-> TX
  Coord -.-> TX

  TX --> PairOut[Pair UTxO<br/>price,ts,nonce v2<br/>last_intent_hash<br/>last_signer]:::script
  TX --> ReceiverOut[Receiver UTxO<br/>balance v2 = v1 - fee]:::script
  TX --> HookOut[PaymentHook UTxO<br/>accrued v2 = v1 + fee]:::script
  TX --> Change([Updater change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** high (heartbeat / deviation).
- **Inputs:**
  - Pair UTxO being updated.
  - Receiver UTxO (client's balance).
  - PaymentHook UTxO.
  - Updater wallet (pays network fee; permissionless, does not need to be DIA).
- **Reference inputs:** Config UTxO.
- **Mint:** —
- **Withdrawals:** `update_coordinator` (withdraw 0 trigger).
- **Outputs:**
  - Pair UTxO recreated (same NFT, datum updated with new `price`, `timestamp`, `nonce`, `last_intent_hash`, `last_signer`).
  - Receiver UTxO recreated (same NFT, `balance_lovelace -= protocol_fee_lovelace`, `utxo.lovelace -= fee`).
  - PaymentHook UTxO recreated (same NFT, `accrued_fees += fee`, `lifetime_collected += fee`, `utxo.lovelace += fee`).
- **Coordinator withdraw redeemer:** `ApplySingle { witness }`, where the witness carries the Receiver NFT id, the Cardano pair policy id, the Pair NFT asset name, the DIA `OracleIntent`, and the recovered DIA signer public key.
- **Pair spend redeemer:** `ApplyUpdate`.
- **Receiver spend redeemer:** `PayFee`.
- **Hook spend redeemer:** `ApplyFee`.
- **Cardano signers:** none required by the validators (permissionless submission).
- **Validates (coordinator, once per tx):**
  - Reads Config through the reference input.
  - DIA Intent signature valid per DIA `OracleIntentUtils` (ECDSA secp256k1 over EIP-712 digest). Signer pubkey ∈ `Config.authorized_dia_public_keys`, Pair NFT asset name = `blake2b_256(intent.symbol)`, `intent.timestamp > old.timestamp`, `intent.nonce > old.nonce`.
  - `fee == Config.protocol_fee_lovelace`.
  - `new_receiver.balance == old_receiver.balance - fee`.
  - `new_hook.accrued_fees == old_hook.accrued_fees + fee`.
  - `new_hook.lifetime_collected == old_hook.lifetime_collected + fee`.
  - All NFTs remain continuous.
  - All `min_utxo_lovelace` preserved.
- **Validates (each local validator):** only that the coordinator withdrawal is present in the tx (defers to the coordinator).

### 5.9 Price update (batch)

```mermaid
flowchart LR
  Updater([Updater Wallet]):::wallet
  Pair1In[Pair UTxO 1]:::script
  PairKIn[Pair UTxO K]:::script
  ReceiverIn[Receiver UTxO<br/>balance v1]:::script
  HookIn[PaymentHook UTxO<br/>accrued v1]:::script
  ConfigRef[Config UTxO]:::script

  PairV[/pair_state spend<br/>ApplyUpdate/]:::redeemer
  ReceiverV[/receiver spend<br/>PayFee/]:::redeemer
  HookV[/payment_hook spend<br/>ApplyFee/]:::redeemer
  Coord[/update_coordinator withdraw<br/>ApplyBatch intents/]:::redeemer

  Updater --> TX((Price update<br/>batch K pairs)):::tx
  Pair1In --> TX
  PairKIn --> TX
  ReceiverIn --> TX
  HookIn --> TX
  ConfigRef -.-> TX
  PairV -.-> TX
  ReceiverV -.-> TX
  HookV -.-> TX
  Coord -.-> TX

  TX --> Pair1Out[Pair UTxO 1 v2]:::script
  TX --> PairKOut[Pair UTxO K v2]:::script
  TX --> ReceiverOut[Receiver UTxO<br/>balance v2 = v1 - K*fee]:::script
  TX --> HookOut[PaymentHook UTxO<br/>accrued v2 = v1 + K*fee]:::script
  TX --> Change([Updater change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** high, variant of 5.8.
- **Inputs:** K Pair UTxOs (same client, different pairs) + Receiver UTxO + Hook UTxO + updater wallet.
- **Reference inputs:** Config UTxO.
- **Withdrawals:** `update_coordinator` with `ApplyBatch { [intent] }`.
- **Outputs:** K Pair UTxOs recreated, Receiver UTxO recreated (`balance -= K * fee`), Hook UTxO (`accrued += K * fee`).
- **Validates:** same as 5.8 but per intent; the coordinator iterates over the list.

### 5.10 PaymentHook withdraw

```mermaid
flowchart LR
  Admin([DIA Admin Wallet]):::wallet
  HookIn[PaymentHook UTxO<br/>accrued v1]:::script
  ConfigRef[Config UTxO]:::script
  HookV[/payment_hook spend<br/>Withdraw amount/]:::redeemer

  Admin --> TX((PaymentHook<br/>withdraw)):::tx
  HookIn --> TX
  ConfigRef -.-> TX
  HookV -.-> TX

  TX --> HookOut[PaymentHook UTxO<br/>accrued v2 = v1 - amount<br/>lifetime_withdrawn += amount]:::script
  TX --> Target([withdraw_address<br/>+ amount]):::wallet
  TX --> Change([Admin change]):::wallet

  classDef wallet fill:#fff8dc,stroke:#aa8800,color:#111
  classDef script fill:#e8f0ff,stroke:#3355aa,stroke-width:1.5px,color:#111
  classDef redeemer fill:#f8f8f8,stroke:#666,stroke-dasharray:3 2,color:#111
  classDef tx fill:#ffffff,stroke:#000,stroke-width:2px,color:#111
```

- **Frequency:** low (manual).
- **Inputs:** PaymentHook UTxO, DIA admin wallet (network fee).
- **Reference inputs:** Config UTxO.
- **Mint:** —
- **Outputs:**
  - PaymentHook UTxO recreated (same NFT, `accrued_fees_lovelace = 0`, `lifetime_withdrawn += withdrawn`, `utxo.lovelace = min_utxo_lovelace`).
  - `withdrawn` ADA paid to `Hook.withdraw_address`.
- **Spend redeemer:** `Withdraw { amount }`.
- **Signers:** `config_admins` (per the referenced Config).
- **Validates:**
  - Hook NFT continuity.
  - `amount <= old.accrued_fees_lovelace`.
  - `new.accrued_fees = old.accrued_fees - amount`.
  - `new.lifetime_withdrawn = old.lifetime_withdrawn + amount`.
  - `new.utxo.lovelace == min_utxo_lovelace + new.accrued_fees`.
  - Actual payout to `withdraw_address` of `amount`.
  - Signed by one of `config_admins`.

---

## 6. Finalized design decisions

1. **Config is shared.** One global Config UTxO is read as a reference input by Receivers, Pair states, PaymentHook, and the coordinator.
2. **Fees live in Config.** `protocol_fee_lovelace` is admin-tunable in Config and is charged per updated pair.
3. **Pair NFT asset names are hashed.** Pair asset name = `blake2b_256(pair_id)`, where `pair_id` is the UTF-8 bytes of the DIA symbol such as `USDC/USD`.
