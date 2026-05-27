# DIA Cardano Oracle CLI

TypeScript CLI for deploying and operating the DIA Cardano Oracle contracts on Cardano `Preview` and `Mainnet`.

The active network is selected by the `CARDANO_NETWORK` env var (`Preview` or
`Mainnet`). Every CLI command, state directory, evidence directory, and step ID
written into state JSONs is derived from that single variable — no code changes
or alternate command set are needed to target a different network. Set
`CARDANO_NETWORK` and the matching Blockfrost project id in `.env`, generate or
fund the right wallet, and re-run.

## Overview

The CLI uses three kinds of inputs and outputs:

- **state artifacts**: persistent protocol, client, and pair state files —
  one source of truth per artifact.
- **generated payloads**: ephemeral intents, config-update drafts, and batch
  manifests consumed by transaction commands.
- **direct CLI flags**: simple ADA values such as `--amount-lovelace`.

Both kinds of files live under `./state/<network>/`, where `<network>` is the
lowercase value of `CARDANO_NETWORK` (`preview` or `mainnet`).

### Folder structure

```text
offchain/cli/
├── src/
│   ├── index.ts            # CLI entrypoint and command dispatcher
│   ├── init/               # protocol/client init, config-update + batch generators
│   ├── deploys/            # parameterize + bootstrap + reference-script publish
│   ├── oracle/             # EIP-712 intent create/sign, EVM wallet helper
│   ├── transactions/       # update, batch, settle, top-up, withdraw, burn, reclaim, min-utxo
│   ├── preflight/          # invariant checks shared by tx builders
│   ├── core/               # config (env), state I/O, primitives, Lucid wiring
│   ├── wallet/             # Cardano wallet creation
│   └── emulator/           # in-process emulator flow + benchmark
├── scripts/
│   ├── run-all-cli.sh      # full end-to-end runbook (Preview or Mainnet)
│   ├── fee-benchmark.sh    # batch-size capacity benchmark
│   └── ...                 # contracts/node test runners used by the runbook
├── .env                    # CARDANO_NETWORK, Blockfrost, wallet seeds
└── state/<network>/        # all runtime artifacts (see below)
    ├── config-bootstrap.json                       # protocol artifact (Config + PaymentHook + global ref-scripts)
    ├── clients/
    │   ├── <client>.json                           # client artifact (Receiver + client ref-scripts)
    │   └── <client>/pairs/<pair>.json              # pair artifacts (one per live pair)
    ├── intents/<pair>.{unsigned,signed}.json       # EIP-712 oracle intents
    ├── config-updates/config-update.json           # generated Config-update drafts
    └── update-batches/update-batch.manifest.json   # generated batch manifests
```

The normal flow is:

1. create wallets
2. initialize protocol state
3. parameterize and bootstrap protocol contracts
4. initialize client state
5. parameterize and bootstrap receiver contracts
6. create and sign intents
7. submit single or batch oracle updates
8. run maintenance transactions

## Prerequisites

- **Node.js 20+** with `npm`.
- **Compiled on-chain contracts.** This CLI reads
  [`contracts/aiken/plutus.json`](../../contracts/aiken/plutus.json) to derive
  script hashes, addresses, and policy ids. The file is committed, so a
  fresh clone works out of the box. If you have modified the contracts,
  rebuild it with `aiken build` first — see
  [`contracts/aiken/README.md`](../../contracts/aiken/README.md).
- **A Blockfrost project id** for the network you target (Preview *or* Mainnet),
  or a Koios endpoint.
- **A funded wallet seed for that network.** The CLI can create one for you in
  step 3 below; fund it from the Preview faucet (Preview) or send real ADA
  (Mainnet) before continuing past step 5.

## Environment

Create `.env` from `.env.example`. **Every per-network variable is suffixed
`_TESTNET` (used when `CARDANO_NETWORK=Preview`) or `_MAINNET` (used when
`CARDANO_NETWORK=Mainnet`).** A single `.env` carries both environments' creds
side by side; switching networks is one line.

Unsuffixed variables (selector / network-agnostic):

- `CARDANO_NETWORK` — `Preview` or `Mainnet`. Drives state/evidence dirs, step
  IDs, and which `*_TESTNET` / `*_MAINNET` block the CLI reads.
- `CARDANO_PROVIDER` — `Blockfrost` (default) or `Koios`.
- `DIA_DOMAIN_NAME`, `DIA_DOMAIN_VERSION` — EIP-712 domain (network-independent).

Per-network variables (set BOTH the `_TESTNET` and `_MAINNET` variant of each;
`.env.example` ships with the canonical confirmed values pre-filled):

| Base name | Purpose |
|---|---|
| `BLOCKFROST_PROJECT_ID_*` | Blockfrost project id matching the network |
| `BLOCKFROST_API_URL_*` | Blockfrost REST endpoint |
| `KOIOS_API_URL_*` | Koios endpoint (used only when `CARDANO_PROVIDER=Koios`) |
| `CARDANO_WALLET_SEED_*` | Mnemonic of the funder wallet |
| `CARDANO_PRIVATE_KEY_*` | Alt. to seed; one of the two must be set |
| `DIA_SOURCE_CHAIN_ID_*` | DIA chain id (Testnet=`10050`, Mainnet=`1050`) |
| `DIA_RPC_URL_*` | DIA EVM JSON-RPC endpoint |
| `DIA_WS_URL_*` | DIA WebSocket endpoint base |
| `DIA_REGISTRY_ADDRESS_*` | `OracleIntentRegistry` address |
| `DIA_EXPLORER_URL_*` | DIA explorer base URL |
| `DIA_EVM_PRIVATE_KEY_*` | Signs EIP-712 OracleIntents on that network |
| `DIA_WS_CREDENTIAL_*` | Conduit path-style credential for the WS endpoint |

So a fresh setup looks like: `cp .env.example .env`, fill the two
`BLOCKFROST_PROJECT_ID_*` values + the two `CARDANO_WALLET_SEED_*` values +
the two `DIA_EVM_PRIVATE_KEY_*` and `DIA_WS_CREDENTIAL_*` values, leave the
rest as-is. Set `CARDANO_NETWORK=Preview` (or `Mainnet`) to choose which side
the CLI uses today.

## Install

```sh
cd offchain/cli
npm install
```

## Wallet Setup

### 1. Inspect contracts

```sh
npm run cli -- blueprint:list
npm run cli -- reference-holder --state ./state/<network>/config-bootstrap.json
```

`reference-holder` requires a parameterized state artifact (run after `config:parameterize`).

### 2. Inspect network

```sh
npm run cli -- protocol
```

### 3. Create a Cardano wallet

```sh
npm run cli -- wallet:create
```

Set `CARDANO_WALLET_SEED_TESTNET` (or `_MAINNET`, depending on `CARDANO_NETWORK`) in `.env` with the generated mnemonic. The command also prints the derived `paymentKeyHash`, which is the default config-admin signer used later by `protocol:init`.

### 4. Create an Ethereum wallet

```sh
npm run cli -- ethereum-wallet:create
```

Set `DIA_EVM_PRIVATE_KEY_TESTNET` (or `_MAINNET`, depending on `CARDANO_NETWORK`) in `.env` with the generated private key. The printed compressed `publicKey` becomes the default authorized DIA signer used later by `protocol:init`.

### 5. Fund and inspect the Cardano wallet

```sh
npm run cli -- wallet
npm run cli -- wallet:utxos
npm run cli -- wallet:defaults
```

Fund the configured address:

- On `CARDANO_NETWORK=Preview`, use the Cardano Preview faucet:
  <https://docs.cardano.org/cardano-testnets/tools/faucet>
- On `CARDANO_NETWORK=Mainnet`, send real ADA from an exchange or another
  wallet. Confirm the destination address matches `wallet:defaults` for the
  same `.env` you will run the CLI with.

The deployment wallet needs enough pure ADA UTxOs for:

- Config bootstrap
- Config reference scripts
- PaymentHook bootstrap
- PaymentHook reference script
- Receiver bootstrap
- Client reference scripts
- first pair update/create and later updates

## Protocol Deployment

### 6. Initialize the protocol artifact

Creates `./state/<network>/config-bootstrap.json` with:

- Config defaults
- Config asset label/name
- PaymentHook defaults
- empty compiled scripts
- empty transaction history

```sh
npm run cli -- protocol:init
```

### 7. Parameterize Config scripts

Selects a pure ADA wallet UTxO and derives the Config, Coordinator, and ReferenceHolder scripts offline. Saves compiled scripts and the `referenceHolderAddress` to the artifact.

```sh
npm run cli -- config:parameterize \
  --state ./state/<network>/config-bootstrap.json
```

No transaction is submitted here.

### 8. Bootstrap Config

Consumes the selected wallet UTxO, mints the Config NFT, and creates the Config UTxO.

```sh
npm run cli -- config:bootstrap \
  --state ./state/<network>/config-bootstrap.json
```

### 9. Publish Config reference scripts

Creates the Config and Coordinator reference scripts at `reference_holder`.

```sh
npm run cli -- config:reference-scripts \
  --state ./state/<network>/config-bootstrap.json
```

### 10. Parameterize PaymentHook scripts

Selects a pure ADA wallet UTxO and derives the PaymentHook scripts offline.

```sh
npm run cli -- payment-hook:parameterize \
  --state ./state/<network>/config-bootstrap.json
```

No transaction is submitted here.

### 11. Bootstrap PaymentHook

Consumes the selected wallet UTxO, mints the PaymentHook NFT, updates Config, and registers the Coordinator stake credential.

```sh
npm run cli -- payment-hook:bootstrap \
  --state ./state/<network>/config-bootstrap.json
```

### 12. Publish PaymentHook reference script

```sh
npm run cli -- payment-hook:reference-script \
  --state ./state/<network>/config-bootstrap.json
```

## Client Deployment

### 13. Initialize the client artifact

Creates `./state/<network>/clients/client-a.json` and captures:

- `clientId`
- receiver asset label/name
- receiver min UTxO

```sh
npm run cli -- client:init
```

### 14. Parameterize Receiver and Pair scripts

Selects a pure ADA wallet UTxO and derives Receiver and Pair scripts offline.

```sh
npm run cli -- receiver:parameterize \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --state ./state/<network>/clients/client-a.json
```

No transaction is submitted here.

### 15. Bootstrap the Receiver

Creates the on-chain Receiver UTxO with `balanceLovelace = 0`. The client funds it later with `receiver:top-up` before the first price update.

```sh
npm run cli -- receiver:bootstrap \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --state ./state/<network>/clients/client-a.json
```

### 16. Publish client reference scripts

Publishes the Receiver spend validator, Pair spend validator, and Pair minting policy at `reference_holder` in a single transaction (outputs 0, 1, 2 respectively).

```sh
npm run cli -- reference-scripts:publish-client \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --state ./state/<network>/clients/client-a.json
```

### 17. Top up the Receiver

This is the client funding step. The Receiver was bootstrapped with `balanceLovelace = 0`; before any pair create/update transaction, the client must add ADA to pay oracle update fees. On Preview (and in this Mainnet single-wallet runbook) the same configured wallet plays admin, updater, and client roles; in a production multi-tenant deployment the top-up would come from a separate per-client wallet.

```sh
npm run cli -- receiver:top-up \
  --amount-lovelace 100000000 \
  --protocol-state ./state/preview_run_20260516-090057/config-bootstrap.json \
  --state ./state/preview_run_20260516-090057/clients/client-a.json
```

## Oracle Intent Flow

Every Pair UTxO is created from a real signed oracle intent. There is no separate Pair bootstrap transaction and no placeholder datum with zero price/timestamp/nonce.

There are three intent commands:

- `intent:create`
  Generates an unsigned intent file.
- `intent:sign`
  Signs an existing unsigned intent file.
- `intent:create-and-sign`
  Prompts and immediately signs.

### 18. Create an unsigned intent

```sh
npm run cli -- intent:create \
  --state ./state/<network>/config-bootstrap.json \
  --out ./state/<network>/intents/usdc-usd.unsigned.json
```

### 19. Sign the intent

```sh
npm run cli -- intent:sign \
  --input ./state/<network>/intents/usdc-usd.unsigned.json \
  --out ./state/<network>/intents/usdc-usd.signed.json
```

### 20. Create and sign in one step

```sh
npm run cli -- intent:create-and-sign \
  --state ./state/<network>/config-bootstrap.json \
  --out ./state/<network>/intents/usdt-usd.signed.json
```

For every later update, generate a fresh signed intent with a new nonce, timestamp, expiry, and price.

## Live Updates

### 21. Submit one update

`update` is pair-aware:

- If the pair artifact does not exist yet, it mints the Pair NFT and creates the first Pair UTxO. Pair creation is admin-gated — the configured wallet must be a `config_admins` signer.
- If the pair artifact already exists, it consumes the current Pair UTxO and writes the next datum. Updates are not admin-gated.
- New Pair UTxOs inherit the current `configState.minUtxoLovelace`; existing Pair UTxOs can later be adjusted with `pair:update-min-utxo`.

```sh
npm run cli -- update \
  --intent ./state/<network>/intents/usdc-usd.signed.json \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --client-state ./state/<network>/clients/client-a.json \
  --state ./state/<network>/clients/client-a/pairs/usdc-usd.json
```

### 22. Create a Config update draft

Generates a structured draft instead of asking you to hand-write JSON.

```sh
npm run cli -- config:update:create \
  --state ./state/<network>/config-bootstrap.json \
  --out ./state/<network>/config-updates/config-update.json
```

### 23. Submit a Config update

```sh
npm run cli -- config:update \
  --input ./state/<network>/config-updates/config-update.json \
  --state ./state/<network>/config-bootstrap.json
```

### 24. Create a batch manifest

You do not hand-write the batch file. The CLI asks which pair state paths and signed intent files to include. A pair state path may point to an existing pair artifact or to the artifact path that should be created by the batch.

```sh
npm run cli -- update:batch:create \
  --pairs-dir ./state/<network>/clients/client-a/pairs \
  --intents-dir ./state/<network>/intents \
  --out ./state/<network>/update-batches/update-batch.manifest.json
```

The generated manifest stores:

- `statePath`
- `intentPath`

for each pair update entry.

### 25. Submit a batch update

`update:batch` can update existing pairs and create missing pairs in the same transaction. New pairs inherit `minUtxoLovelace` from `configState.minUtxoLovelace` automatically. If any pair in the manifest is being created, the configured wallet must be a `config_admins` signer; pure-update batches do not need admin authorisation.

```sh
npm run cli -- update:batch \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --client-state ./state/<network>/clients/client-a.json \
  --manifest ./state/<network>/update-batches/update-batch.manifest.json \
  --out ./state/<network>/update-batches/update-batch.result.json
```

### 25b. Settle accrued fees

After price updates accrue fees on the Receiver, use `settle` to drain `accrued_to_hook_lovelace` from the Receiver and credit it to the PaymentHook in a single transaction. This is an admin-initiated operation.

```sh
npm run cli -- settle \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --client-state ./state/<network>/clients/client-a.json
```

This moves all accrued fees from the Receiver to the PaymentHook and updates both state artifacts.

> **Single-receiver limitation.** The on-chain `update_coordinator.ApplySettle`
> path supports a `SettleManifest` of multiple receivers in one transaction.
> The current CLI implementation builds a one-element manifest from the loaded
> client artifact and the settle preflight rejects any other length. If you
> need to drain multiple clients in one tx, extend `settle.ts` and the
> preflight to accept a multi-client manifest; the on-chain validators already
> handle it.

## Maintenance Transactions

### 26. Withdraw from the Receiver

```sh
npm run cli -- receiver:withdraw \
  --amount-lovelace 2000000 \
  --recipient-address <addr_test...> \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --state ./state/<network>/clients/client-a.json
```

If `--recipient-address` is omitted, the configured wallet address is used.

### 27. Withdraw protocol fees from PaymentHook

```sh
npm run cli -- payment-hook:withdraw \
  --amount-lovelace 2000000 \
  --state ./state/<network>/config-bootstrap.json
```

### 28. Update min UTxO for Receiver (admin only)

Updates the `min_utxo_lovelace` field on a Receiver UTxO using the dedicated `UpdateMinUtxo` redeemer. Requires the wallet to be a Config signer.

```sh
npm run cli -- receiver:update-min-utxo \
  --new-min-utxo-lovelace 3000000 \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --state ./state/<network>/clients/client-a.json
```

The Receiver UTxO must be adjusted to hold the new minimum ADA. The `balance_lovelace` and `accrued_to_hook_lovelace` fields remain unchanged.

### 29. Update min UTxO for Pair (admin only)

Updates the `min_utxo_lovelace` field on a Pair UTxO using the dedicated `UpdateMinUtxo` redeemer. Requires the wallet to be a Config signer.

```sh
npm run cli -- pair:update-min-utxo \
  --new-min-utxo-lovelace 3000000 \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --client-state ./state/<network>/clients/client-a.json \
  --state ./state/<network>/clients/client-a/pairs/usdc-usd.json
```

All Pair datum fields except `min_utxo_lovelace` remain unchanged.

### 29b. Burn a Pair (admin only)

Burns the Pair NFT of an existing pair and recovers the locked min-ADA back to the admin wallet. Requires a `config_admins` signer.

```sh
npm run cli -- pair:burn \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --client-state ./state/<network>/clients/client-a.json \
  --state ./state/<network>/clients/client-a/pairs/usdc-usd.json
```

A subsequent `update` for the same symbol will mint a fresh Pair NFT and rebuild pair state from a new signed intent. See architecture §5.13 for the on-chain validation.

### 29c. Deduplicate Pair UTxOs (admin only)

Scans the pair validator address for duplicate Pair NFT UTxOs — multiple UTxOs
carrying the same pair unit (`pairPolicyId + assetName`). This can happen when
the feeder submits a valid update tx but crashes before writing local state, and
a subsequent restart incorrectly evaluates `isCreate = true`, minting a second
Pair NFT for the same symbol.

The command keeps the UTxO with the highest datum nonce (most recent update) and
burns all others. Idempotent: exits cleanly when no duplicates are found. Requires
a `config_admins` signer.

```sh
npm run cli -- pair:dedup \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --client-state ./state/<network>/clients/client-a.json
```

The feeder logs a `WARN [duplicate-pairs]` entry with the exact command to run
whenever it detects more than one Pair UTxO for the same symbol at startup.

### 30. Update min UTxO for Config (admin only)

Updates `min_utxo_lovelace` on the Config UTxO through the general `AdminUpdate` flow (no dedicated `UpdateMinUtxo` redeemer; see architecture §5.3 + §5.12). Requires a Config signer.

```sh
npm run cli -- config:update \
  --input ./state/<network>/config-updates/min-utxo-update.json \
  --state ./state/<network>/config-bootstrap.json
```

### 31. Update min UTxO for PaymentHook (admin only)

Updates `min_utxo_lovelace` on the PaymentHook UTxO through the general `AdminUpdate` flow (see architecture §5.12). Requires a Config signer.

```sh
npm run cli -- payment-hook:update \
  --input ./state/<network>/hook-updates/min-utxo-update.json \
  --state ./state/<network>/config-bootstrap.json
```

The PaymentHook UTxO output must hold `new_min_utxo + accrued_fees_lovelace` total lovelace.

### 32. Reclaim reference-script UTxOs

Spends reference-script UTxO(s) at the `reference_holder` address and returns the locked ADA to the admin wallet. Used when upgrading contracts: reclaim, then re-publish the new version.

`--script` maps 1:1 to publish commands — if a publish command put N UTxOs on-chain, its reclaim name spends exactly those same N UTxOs in one transaction. Cleared entries are reset to `{ txHash: "", outputIndex: 0, scriptHash: "" }` in the artifact.

Requires a Config signer wallet. Uses the live Config UTxO as a reference input.

There are 6 reference-script UTxOs in total:

| UTxO | What's stored there | Published by | Output index |
| --- | --- | --- | --- |
| `global.config` | `config_state` spend validator | `config:reference-scripts` | 0 |
| `global.coordinator` | `update_coordinator` withdrawal validator | `config:reference-scripts` | 1 |
| `global.paymentHook` | `payment_hook` spend validator | `payment-hook:reference-script` | 0 |
| `client.receiver` | `receiver` spend validator (per client) | `reference-scripts:publish-client` | 0 |
| `client.pair` | `pair_state` spend validator (per client) | `reference-scripts:publish-client` | 1 |
| `client.pairMint` | `pair_state` minting policy (per client) | `reference-scripts:publish-client` | 2 |

Minting policies (`config_state` mint, `payment_hook` mint, `receiver` mint) are one-shot bootstrap scripts — they are NOT stored at `reference_holder`.

Reclaim `--script` values and what each reclaims in one transaction:

| `--script` | UTxOs reclaimed |
| --- | --- |
| `config` | global.config + global.coordinator (2 UTxOs — same as publish) |
| `payment-hook` | global.paymentHook (1 UTxO) |
| `client` | client.receiver + client.pair + client.pairMint (3 UTxOs — same as publish) |

**Global scripts:**

```sh
# Reclaims config + coordinator together (they were published in the same tx):
npm run cli -- reclaim-reference-script \
  --script config \
  --state ./state/<network>/config-bootstrap.json

# Reclaims payment-hook alone:
npm run cli -- reclaim-reference-script \
  --script payment-hook \
  --state ./state/<network>/config-bootstrap.json
```

**Client scripts:**

```sh
# Reclaims receiver + pair + pairMint together (they were published in the same tx):
npm run cli -- reclaim-reference-script \
  --script client \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --state ./state/<network>/clients/client-a.json
```

After reclaiming, re-publish with the standard publish command:

```sh
# After reclaiming config (republishes config + coordinator in one tx):
npm run cli -- config:reference-scripts \
  --state ./state/<network>/config-bootstrap.json

# After reclaiming payment-hook:
npm run cli -- payment-hook:reference-script \
  --state ./state/<network>/config-bootstrap.json

# After reclaiming client (republishes receiver + pair + pairMint in one tx):
npm run cli -- reference-scripts:publish-client \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --state ./state/<network>/clients/client-a.json
```

## Build Only

Every transaction-submitting command supports `--build-only`. In this mode the
CLI builds the transaction, runs all validators locally, and prints the
result, but **does not submit it to the network**. The state file (`--state`)
is **not** overwritten in this mode, since the result is a build artifact and
not the new on-chain state.

Use it for inspection, offline auditing, or signing flows where the build,
the signing, and the submission happen on different machines.

If you want to capture the build output to a file, redirect stdout:

```sh
npm run cli -- update \
  --intent ./state/<network>/intents/usdc-usd.signed.json \
  --protocol-state ./state/<network>/config-bootstrap.json \
  --client-state ./state/<network>/clients/client-a.json \
  --state ./state/<network>/clients/client-a/pairs/usdc-usd.json \
  --build-only \
  > ./state/<network>/builds/update.build-only.json
```

Parameterization commands are offline by design and never submit transactions,
so they do not take `--build-only`.

## Artifact rules

The folder tree at the top of this README lists every directory and file the
CLI reads or writes. The operational rules that govern how those files compose:

- **Protocol-level commands** read and update `config-bootstrap.json` (Config,
  Coordinator, PaymentHook, global reference scripts, global tx history).
- **Client-level commands** read and update `clients/<client>.json` (Receiver
  scripts/state/UTxO, client reference scripts, client tx history) and receive
  `--protocol-state` explicitly when they need protocol context.
- **Pair-level commands** read and update `clients/<client>/pairs/<pair>.json`
  (Pair scripts/state/UTxO, pair datum, pair tx history) and receive
  `--client-state`/`--protocol-state` explicitly when they need parent context.
- **Intents, config-update drafts, and batch manifests** are generated before
  they are consumed; they live under `state/<network>/` next to the artifacts
  that produce or consume them.

Every artifact keeps the same shape per level:

- `bootstrapRefs` — selected wallet UTxOs used at bootstrap.
- `scripts` — derived ids, addresses, hashes.
- `compiledScripts` — serialized scripts (protocol artifact stores
  Config/Coordinator/ReferenceHolder/PaymentHook; client artifact stores only
  Receiver/Pair).
- `datum` — current datum CBOR.
- `referenceScripts` — pointers to published reference-script UTxOs.
- `transactions` — append-only tx history with network-tagged step IDs
  (`preview:foo` on Preview, `mainnet:foo` on Mainnet).

Child artifacts never embed parent paths; the parent path is always a CLI flag.
