# DIA Cardano Oracle CLI

TypeScript CLI for deploying and operating the DIA Cardano Oracle contracts on Cardano `Preview`.

## Overview

This CLI now uses three kinds of files:

- `state artifacts`: persistent protocol, client, and pair state files under `./state/preview`
- `generated payloads`: unsigned intents, signed intents, config-update drafts, and batch manifests under `./state/preview`
- direct CLI flags: simple ADA values such as `--amount-lovelace`, `--min-utxo-lovelace`, and `--lovelace-per-output`

The normal flow is:

1. create wallets
2. initialize protocol state
3. parameterize and bootstrap protocol contracts
4. initialize client state
5. parameterize and bootstrap receiver contracts
6. create and sign intents
7. submit single or batch oracle updates
8. run maintenance transactions

## Environment

Create `.env` from `.env.example` and set:

- `CARDANO_NETWORK=Preview`
- `BLOCKFROST_PROJECT_ID`
- optional `BLOCKFROST_API_URL`
- optional `KOIOS_API_URL`
- either `CARDANO_WALLET_SEED` or `CARDANO_PRIVATE_KEY`
- optional `DIA_EVM_PRIVATE_KEY` for signing Preview EIP-712 oracle intents

By default the CLI uses Blockfrost for UTxOs, protocol parameters, submission, and confirmation. Set `CARDANO_PROVIDER=Koios` to use Koios as the Lucid provider instead.

## Install

```sh
cd offchain/cli
npm install
```

## Artifacts

Persistent state files:

- `./state/preview/config-bootstrap.json`
  Protocol artifact. Global Config, Coordinator, and PaymentHook deployment state.
- `./state/preview/clients/<client>.json`
  Client artifact. Stores Receiver/Pair client state only; it does not copy global Config or PaymentHook state.
- `./state/preview/clients/<client>/pairs/<pair>.json`
  Pair artifact. Created by the first successful `preview:update` for a pair. Stores one live pair and its update history; it does not copy protocol or receiver snapshots.

Generated payload files:

- `./state/preview/intents/<pair>.unsigned.json`
  Unsigned EIP-712 oracle intent.
- `./state/preview/intents/<pair>.signed.json`
  Signed oracle intent used by `preview:update` or batch manifests.
- `./state/preview/config-updates/config-update.preview.json`
  Generated Config update draft for `preview:config:update`.
- `./state/preview/update-batches/update-batch.manifest.json`
  Generated batch manifest for `preview:update:batch`.

## Wallet Setup

### 1. Inspect contracts

```sh
npm run cli -- blueprint:list
npm run cli -- preview:reference-holder
```

### 2. Inspect network

```sh
npm run cli -- preview:protocol
```

### 3. Create a Cardano wallet

```sh
npm run cli -- preview:wallet:create
```

Set `CARDANO_WALLET_SEED` in `.env` with the generated mnemonic. The command also prints the derived `paymentKeyHash`, which is the default config-admin signer used later by `preview:protocol:init`.

### 4. Create an Ethereum wallet

```sh
npm run cli -- preview:ethereum-wallet:create
```

Set `DIA_EVM_PRIVATE_KEY` in `.env` with the generated private key. The printed compressed `publicKey` becomes the default authorized DIA signer used later by `preview:protocol:init`.

### 5. Fund and inspect the Cardano wallet

```sh
npm run cli -- preview:wallet
npm run cli -- preview:wallet:utxos
npm run cli -- preview:wallet:defaults
```

Fund the configured address on `Preview Testnet`:

<https://docs.cardano.org/cardano-testnets/tools/faucet>

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

Creates `./state/preview/config-bootstrap.json` with:

- Config defaults
- Config asset label/name
- PaymentHook defaults
- reference holder address
- empty compiled scripts
- empty transaction history

```sh
npm run cli -- preview:protocol:init
```

### 7. Parameterize Config scripts

Selects a pure ADA wallet UTxO and derives the Config and Coordinator scripts offline.

```sh
npm run cli -- preview:config:parameterize \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/config-bootstrap.json
```

No transaction is submitted here.

### 8. Bootstrap Config

Consumes the selected wallet UTxO, mints the Config NFT, and creates the Config UTxO.

```sh
npm run cli -- preview:config:bootstrap \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/config-bootstrap.json
```

### 9. Publish Config reference scripts

Creates the Config and Coordinator reference scripts at `reference_holder`.

```sh
npm run cli -- preview:config:reference-scripts \
  --lovelace-per-output 3000000 \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/config-bootstrap.json
```

### 10. Parameterize PaymentHook scripts

Selects a pure ADA wallet UTxO and derives the PaymentHook scripts offline.

```sh
npm run cli -- preview:payment-hook:parameterize \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/config-bootstrap.json
```

No transaction is submitted here.

### 11. Bootstrap PaymentHook

Consumes the selected wallet UTxO, mints the PaymentHook NFT, updates Config, and registers the Coordinator stake credential.

```sh
npm run cli -- preview:payment-hook:bootstrap \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/config-bootstrap.json
```

### 12. Publish PaymentHook reference script

```sh
npm run cli -- preview:payment-hook:reference-script \
  --lovelace-per-output 3000000 \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/config-bootstrap.json
```

## Client Deployment

### 13. Initialize the client artifact

Creates `./state/preview/clients/client-a.json` and captures:

- `clientId`
- receiver asset label/name
- receiver min UTxO

```sh
npm run cli -- preview:client:init
```

### 14. Parameterize Receiver and Pair scripts

Selects a pure ADA wallet UTxO and derives Receiver and Pair scripts offline.

```sh
npm run cli -- preview:receiver:parameterize \
  --protocol-state ./state/preview/config-bootstrap.json \
  --state ./state/preview/clients/client-a.json \
  --out ./state/preview/clients/client-a.json
```

No transaction is submitted here.

### 15. Bootstrap the Receiver

Creates the on-chain Receiver UTxO with `balanceLovelace = 0`. The client funds it later with `preview:receiver:top-up` before the first price update.

```sh
npm run cli -- preview:receiver:bootstrap \
  --protocol-state ./state/preview/config-bootstrap.json \
  --state ./state/preview/clients/client-a.json \
  --out ./state/preview/clients/client-a.json
```

### 16. Publish client reference scripts

Publishes the Receiver and Pair validators at `reference_holder`.

```sh
npm run cli -- preview:reference-scripts:publish-client \
  --lovelace-per-output 3000000 \
  --protocol-state ./state/preview/config-bootstrap.json \
  --state ./state/preview/clients/client-a.json \
  --out ./state/preview/clients/client-a.json
```

### 17. Top up the Receiver

This is the client funding step. The Receiver was bootstrapped with `balanceLovelace = 0`; before any pair create/update transaction, the client must add ADA to pay oracle update fees. On Preview you can use the same configured wallet for testing.

```sh
npm run cli -- preview:receiver:top-up \
  --amount-lovelace 5000000 \
  --protocol-state ./state/preview/config-bootstrap.json \
  --state ./state/preview/clients/client-a.json \
  --out ./state/preview/clients/client-a.json
```

## Oracle Intent Flow

Every Pair UTxO is created from a real signed oracle intent. There is no separate Pair bootstrap transaction and no placeholder datum with zero price/timestamp/nonce.

There are three intent commands:

- `preview:intent:create`
  Generates an unsigned intent file.
- `preview:intent:sign`
  Signs an existing unsigned intent file.
- `preview:intent:create-and-sign`
  Prompts and immediately signs.

### 18. Create an unsigned intent

```sh
npm run cli -- preview:intent:create \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/intents/usdc-usd.unsigned.json
```

### 19. Sign the intent

```sh
npm run cli -- preview:intent:sign \
  --input ./state/preview/intents/usdc-usd.unsigned.json \
  --out ./state/preview/intents/usdc-usd.signed.json
```

### 20. Create and sign in one step

```sh
npm run cli -- preview:intent:create-and-sign \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/intents/usdt-usd.signed.json
```

For every later update, generate a fresh signed intent with a new nonce, timestamp, expiry, and price.

## Live Updates

### 21. Submit one update

`preview:update` is pair-aware:

- If the pair artifact does not exist yet, it mints the Pair NFT and creates the first Pair UTxO with the signed intent's real price datum.
- If the pair artifact already exists, it consumes the current Pair UTxO and writes the next datum.
- `--min-utxo-lovelace` is required only for the first update/create of a pair.

```sh
npm run cli -- preview:update \
  --intent ./state/preview/intents/usdc-usd.signed.json \
  --min-utxo-lovelace 5000000 \
  --protocol-state ./state/preview/config-bootstrap.json \
  --client-state ./state/preview/clients/client-a.json \
  --state ./state/preview/clients/client-a/pairs/usdc-usd.json \
  --out ./state/preview/clients/client-a/pairs/usdc-usd.json
```

### 22. Create a Config update draft

Generates a structured draft instead of asking you to hand-write JSON.

```sh
npm run cli -- preview:config:update:create \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/config-updates/config-update.preview.json
```

### 23. Submit a Config update

```sh
npm run cli -- preview:config:update \
  --input ./state/preview/config-updates/config-update.preview.json \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/config-bootstrap.json
```

### 24. Create a batch manifest

You do not hand-write the batch file. The CLI asks which pair state paths and signed intent files to include. A pair state path may point to an existing pair artifact or to the artifact path that should be created by the batch.

```sh
npm run cli -- preview:update:batch:create \
  --pairs-dir ./state/preview/clients/client-a/pairs \
  --intents-dir ./state/preview/intents \
  --out ./state/preview/update-batches/update-batch.manifest.json
```

The generated manifest stores:

- `statePath`
- `intentPath`

for each pair update entry.

### 25. Submit a batch update

`preview:update:batch` can update existing pairs and create missing pairs in the same transaction. Pass `--min-utxo-lovelace` when the manifest includes any pair artifact path that does not exist yet.

```sh
npm run cli -- preview:update:batch \
  --protocol-state ./state/preview/config-bootstrap.json \
  --client-state ./state/preview/clients/client-a.json \
  --manifest ./state/preview/update-batches/update-batch.manifest.json \
  --min-utxo-lovelace 5000000 \
  --out ./state/preview/update-batches/update-batch.result.json
```

## Maintenance Transactions

### 26. Withdraw from the Receiver

```sh
npm run cli -- preview:receiver:withdraw \
  --amount-lovelace 2000000 \
  --recipient-address <addr_test...> \
  --protocol-state ./state/preview/config-bootstrap.json \
  --state ./state/preview/clients/client-a.json \
  --out ./state/preview/clients/client-a.json
```

If `--recipient-address` is omitted, the configured wallet address is used.

### 27. Withdraw protocol fees from PaymentHook

```sh
npm run cli -- preview:payment-hook:withdraw \
  --amount-lovelace 2000000 \
  --state ./state/preview/config-bootstrap.json \
  --out ./state/preview/config-bootstrap.json
```

## Build Only

Every transaction-submitting command supports `--build-only`.

Example:

```sh
npm run cli -- preview:update \
  --intent ./state/preview/intents/usdc-usd.signed.json \
  --min-utxo-lovelace 5000000 \
  --protocol-state ./state/preview/config-bootstrap.json \
  --client-state ./state/preview/clients/client-a.json \
  --state ./state/preview/clients/client-a/pairs/usdc-usd.json \
  --build-only \
  --out ./state/preview/builds/update.build-only.json
```

Parameterization commands remain offline and never submit transactions.

## Artifact Notes

Operationally, the important rule is:

- protocol-level commands read and update `config-bootstrap.json`
- client-level commands read and update `clients/<client>.json` and receive `--protocol-state` explicitly when they need protocol context
- pair-level commands read and update `clients/<client>/pairs/<pair>.json` and receive `--client-state`/`--protocol-state` explicitly when they need parent context
- intents, config-update drafts, and batch manifests are generated before they are consumed

Artifacts are deliberately thin:

- `config-bootstrap.json` is the only source of truth for Config, Coordinator, PaymentHook, global reference scripts, and global tx history.
- `clients/<client>.json` keeps client defaults, Receiver scripts/state/UTxO, client reference scripts, and client tx history.
- `pairs/<pair>.json` keeps Pair scripts/state/UTxO, pair datum, and pair tx history.
- Commands that need global or client context receive those artifact paths as CLI parameters instead of storing paths inside child artifacts.

Depending on the artifact level, they keep:

- selected bootstrap UTxOs in `bootstrapRefs`
- derived ids and addresses in `scripts`
- serialized scripts in `compiledScripts`: protocol artifacts keep only Config/Coordinator/PaymentHook scripts, and client artifacts keep only Receiver/Pair scripts
- current datum CBOR in `datum`
- published reference script pointers in `referenceScripts`
- transaction history in `transactions`

## Source Files

Init and generator modules:

- `src/init/protocol-init.ts`
- `src/init/client-init.ts`
- `src/init/config-update-create.ts`
- `src/init/batch-update-create.ts`

Deployment modules:

- `src/deploys/config-parameterize.ts`
- `src/deploys/config-reference-scripts.ts`
- `src/deploys/config-bootstrap.ts`
- `src/deploys/payment-hook-parameterize.ts`
- `src/deploys/payment-hook-reference-script.ts`
- `src/deploys/payment-hook-bootstrap.ts`
- `src/deploys/receiver-parameterize.ts`
- `src/deploys/client-reference-scripts.ts`
- `src/deploys/receiver-bootstrap.ts`

Intent and signing modules:

- `src/oracle/ethereum-wallet-create.ts`
- `src/oracle/intent-sign.ts`
- `src/oracle/intent-create.ts`

Transaction modules:

- `src/transactions/update.ts`
- `src/transactions/config-update.ts`
- `src/transactions/update-batch.ts`
- `src/transactions/receiver-top-up.ts`
- `src/transactions/receiver-withdraw.ts`
- `src/transactions/payment-hook-withdraw.ts`
