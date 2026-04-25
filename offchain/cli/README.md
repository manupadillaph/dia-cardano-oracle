# DIA Cardano Oracle CLI

TypeScript CLI for deploying and operating the DIA Cardano Oracle contracts on Cardano `Preview`.

## Architecture

The CLI operates the Receiver-based architecture described in [`docs/architecture/cardano-oracle-architecture.md`](../../docs/architecture/cardano-oracle-architecture.md):

- one global `config_state`
- one global `update_coordinator`
- one global `payment_hook`
- one `receiver` per client
- one `pair_state` per subscribed price pair

## Environment

Create `.env` from `.env.example` and set:

- `CARDANO_NETWORK=Preview`
- `BLOCKFROST_PROJECT_ID`
- optional `BLOCKFROST_API_URL`
- optional `KOIOS_API_URL`
- either `CARDANO_WALLET_SEED` or `CARDANO_PRIVATE_KEY`
- optional `DIA_EVM_PRIVATE_KEY` for signing Preview EIP-712 oracle intents

UTxOs, submission, and confirmation use Blockfrost. Protocol parameters are normalized from Koios for Conway / Plutus V3 transaction building.

## Step 1: Install

```sh
cd offchain/cli
npm install
```

## Step 2: Inspect Contracts

Input: compiled Aiken blueprint from `contracts/aiken/plutus.json`.

```sh
npm run cli -- blueprint:list
npm run cli -- preview:reference-holder
```

## Step 3: Inspect Network

Input: `.env`.

```sh
npm run cli -- preview:protocol
```

## Step 4: Inspect Wallet

Input: `.env`.

```sh
npm run cli -- preview:wallet
npm run cli -- preview:wallet:utxos
npm run cli -- preview:wallet:defaults
```

To create a new wallet:

```sh
npm run cli -- preview:wallet:create
```

Set `CARDANO_WALLET_SEED` in `.env` with the generated mnemonic, then inspect the funded wallet:

```sh
npm run cli -- preview:wallet
npm run cli -- preview:wallet:utxos
npm run cli -- preview:wallet:defaults
```

Fund the configured address on `Preview Testnet`:

<https://docs.cardano.org/cardano-testnets/tools/faucet>

The deployment wallet must have enough pure ADA UTxOs for:

- global reference-script publication
- config bootstrap
- payment-hook bootstrap
- client reference-script publication
- receiver bootstrap
- pair bootstrap

One-shot UTxOs required by script parameters are created by explicit CLI steps and stored in the state artifacts. No manual UTxO selection is required.

## Signed OracleIntent Inputs

Oracle updates require a signed DIA `OracleIntent`. The signature is an Ethereum/EIP-712 signature over the exact intent payload. If `symbol`, `price`, `timestamp`, `nonce`, `expiry`, `source`, or domain values change, a new signature is required.

Production updates should use DIA-provided signed intents. For Preview validation, the CLI can sign an intent with an Ethereum private key configured as `DIA_EVM_PRIVATE_KEY`:

```sh
npm run cli -- preview:ethereum-wallet:create
```

Set `DIA_EVM_PRIVATE_KEY` in `.env` with the generated Ethereum private key. The generated `publicKey` is the value that must be present in `authorizedDiaPublicKeys` before updates signed by that key can be submitted.

```sh
npm run cli -- preview:intent:sign --input ./examples/preview/01-oracle-intent-sign.example.json --out ./tmp/usdc-usd.update.json
```

Output: a JSON object with:

- `intent`: update input compatible with `preview:update`
- `witness.signerPublicKey`: compressed EIP-712 signer public key to authorize in Config
- `witness.signerAddress`: Ethereum signer address recorded in the intent
- `witness.intentHash`: EIP-712 hash checked by the contracts

The recovered `witness.signerPublicKey` must be present in `authorizedDiaPublicKeys` before submitting an update. If the key is not already authorized, run the Config update step before submitting that signed intent.

## Artifact Rules

Every transaction command reads an input JSON with `--input` and writes the latest operational state with `--out`.

Use these state artifacts as the source for the next command:

- `./state/preview/config-bootstrap.json`: global protocol artifact.
- `./state/preview/clients/<client>.json`: client artifact.
- `./state/preview/clients/<client>/pairs/<pair>.json`: pair artifact.

The global artifact is created in Step 5 and updated by protocol-level operations:

- Step 5 parameterizes the Config and Coordinator scripts, stores `bootstrapRefs.config`, and writes Config script metadata.
- Step 6 publishes the Config and Coordinator reference scripts.
- Step 7 consumes `bootstrapRefs.config`, mints the Config NFT, and creates the Config UTxO.
- Step 8 parameterizes the PaymentHook scripts, stores `bootstrapRefs.paymentHook`, and writes PaymentHook script metadata.
- Step 9 publishes the PaymentHook reference script.
- Step 10 consumes `bootstrapRefs.paymentHook`, mints the PaymentHook NFT, updates Config with the PaymentHook reference, and registers the Coordinator stake credential.
- Step 16 updates Config state and Config UTxO.
- Step 20 updates PaymentHook fee state and PaymentHook UTxO.

The client artifact is created in Step 11 and updated by client-level operations:

- Step 11 parameterizes the Receiver and Pair scripts, stores `receiver.bootstrapRef`, and writes client script metadata.
- Step 12 publishes the Receiver and Pair reference scripts.
- Step 13 consumes `receiver.bootstrapRef`, mints the Receiver NFT, and creates the Receiver UTxO.
- Step 18 updates the Receiver balance after a top-up.
- Step 19 updates the Receiver balance after a withdrawal.

The pair artifact is created in Step 14 and updated by price updates:

- Step 14 creates the Pair UTxO and initial Pair state.
- Step 15 updates one Pair state file.
- Step 17 updates each `statePath` listed in the batch input.

Config, PaymentHook, and Receiver scripts are parameterized before they are published. The CLI derives the policy ids, validator hashes, addresses, initial datum CBOR, and script parameters, then writes those values into the state artifact.

Parameterization inputs:

- Config scripts use `bootstrapOutRef` and `configAssetName`.
- PaymentHook scripts use `bootstrapOutRef`, `paymentHookAssetName`, Config policy/id data, and Coordinator credential hash.
- Receiver scripts use `bootstrapOutRef`, `receiverAssetName`, and Config policy/id data.
- Pair scripts use Config policy/id data and Receiver validator hash.

The `bootstrapOutRef` parameters come from one-shot UTxOs created by the corresponding parameterization command. Those UTxOs are consumed later by the matching bootstrap command when the NFT is minted.

Reference scripts published by this CLI are the reusable scripts used by protocol operations after deployment:

- Config spend validator.
- Coordinator withdraw validator.
- PaymentHook spend validator.
- Receiver spend validator for one client.
- Pair spend validator for one client.

One-shot minting policies are used only by their bootstrap transaction and are not published as reference scripts.

## Step 5: Parameterize Config Scripts

Operation: parameterize Config minting policy, Config validator, and Coordinator validator.

Input JSON: `./examples/preview/02-config-parameterize.example.json`

Writes: `./state/preview/config-bootstrap.json`

```sh
npm run cli -- preview:config:parameterize --input ./examples/preview/02-config-parameterize.example.json --out ./state/preview/config-bootstrap.json
```

## Step 6: Publish Config Reference Scripts

Operation: create two on-chain UTxOs at the protocol ReferenceHolder address, with reference scripts attached: Config spend validator and Coordinator withdraw validator.

Input JSON: `./examples/preview/03-config-reference-scripts.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

The ReferenceHolder address is derived from the compiled `reference_holder` validator in `contracts/aiken/plutus.json`. It is a script address, not the deploy wallet address.

```sh
npm run cli -- preview:reference-holder
```

The `reference_holder` validator rejects spend attempts. ADA placed in these reference-script UTxOs is locked with the scripts and is not part of the deploy wallet balance.

```sh
npm run cli -- preview:config:reference-scripts --input ./examples/preview/03-config-reference-scripts.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 7: Bootstrap Config

Operation: mint the Config NFT and create the global Config UTxO.

Input JSON: `./examples/preview/04-config-bootstrap.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

The command consumes the Config one-shot UTxO created during Step 5 parameterization.

```sh
npm run cli -- preview:config:bootstrap --input ./examples/preview/04-config-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 8: Parameterize PaymentHook Scripts

Operation: parameterize PaymentHook minting policy and PaymentHook validator.

Input JSON: `./examples/preview/05-payment-hook-parameterize.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

```sh
npm run cli -- preview:payment-hook:parameterize --input ./examples/preview/05-payment-hook-parameterize.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 9: Publish PaymentHook Reference Script

Operation: create one on-chain UTxO at the protocol ReferenceHolder address, with the PaymentHook spend validator reference script attached.

Input JSON: `./examples/preview/06-payment-hook-reference-script.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

The ReferenceHolder address is derived from the compiled `reference_holder` validator in `contracts/aiken/plutus.json`. It is a script address, not the deploy wallet address.

```sh
npm run cli -- preview:reference-holder
```

The `reference_holder` validator rejects spend attempts. ADA placed in this reference-script UTxO is locked with the script and is not part of the deploy wallet balance.

```sh
npm run cli -- preview:payment-hook:reference-script --input ./examples/preview/06-payment-hook-reference-script.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 10: Bootstrap PaymentHook

Operation: mint the PaymentHook NFT, create the PaymentHook UTxO, update Config with the PaymentHook reference, and register the Coordinator stake credential.

Input JSON: `./examples/preview/07-payment-hook-bootstrap.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

The command consumes the PaymentHook one-shot UTxO created during Step 8 parameterization.

```sh
npm run cli -- preview:payment-hook:bootstrap --input ./examples/preview/07-payment-hook-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 11: Parameterize Client Receiver Scripts

Operation: parameterize Receiver minting policy, Receiver validator, Pair minting policy, and Pair validator for one client.

Input JSON: `./examples/preview/08-receiver-parameterize.example.json`

State input: `./state/preview/config-bootstrap.json`

Writes: `./state/preview/clients/client-a.json`

```sh
npm run cli -- preview:receiver:parameterize --input ./examples/preview/08-receiver-parameterize.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/clients/client-a.json
```

## Step 12: Publish Client Reference Scripts

Operation: create two on-chain UTxOs at the protocol ReferenceHolder address, with reference scripts attached: Receiver spend validator and Pair spend validator for one client.

Input JSON: `./examples/preview/09-client-reference-scripts.example.json`

State input: `./state/preview/clients/client-a.json`

Updates: `./state/preview/clients/client-a.json`

The ReferenceHolder address is derived from the compiled `reference_holder` validator in `contracts/aiken/plutus.json`. It is a script address, not the deploy wallet address.

```sh
npm run cli -- preview:reference-holder
```

The `reference_holder` validator rejects spend attempts. ADA placed in these reference-script UTxOs is locked with the scripts and is not part of the deploy wallet balance.

```sh
npm run cli -- preview:reference-scripts:publish-client --input ./examples/preview/09-client-reference-scripts.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a.json
```

## Step 13: Bootstrap Client Receiver

Operation: mint the Receiver NFT and create the client Receiver UTxO.

Input JSON: `./examples/preview/10-receiver-bootstrap.example.json`

State input: `./state/preview/clients/client-a.json`

Updates: `./state/preview/clients/client-a.json`

The command consumes the Receiver one-shot UTxO created during Step 11 parameterization.

```sh
npm run cli -- preview:receiver:bootstrap --input ./examples/preview/10-receiver-bootstrap.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a.json
```

## Step 14: Bootstrap Pair

Operation: mint the Pair NFT and create the initial Pair UTxO for a subscribed symbol.

Input JSON: `./examples/preview/11-pair-bootstrap.example.json`

State input: `./state/preview/clients/client-a.json`

Writes: `./state/preview/clients/client-a/pairs/usdc-usd.json`

The signed intent in the input identifies the pair symbol and the authorized EIP-712 signer. The initial on-chain Pair state starts with zero price, zero timestamp, and zero nonce.

```sh
mkdir -p ./state/preview/clients/client-a/pairs
npm run cli -- preview:pair:bootstrap --input ./examples/preview/11-pair-bootstrap.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a/pairs/usdc-usd.json
```

## Step 15: Submit Single Update

Operation: update one Pair UTxO with a signed DIA `OracleIntent`.

Input JSON: `./examples/preview/12-update.example.json`

State input: `./state/preview/clients/client-a/pairs/usdc-usd.json`

Updates: `./state/preview/clients/client-a/pairs/usdc-usd.json`

The example uses a signed DIA fixture intent. That signature is valid only for that exact payload.

```sh
npm run cli -- preview:update --input ./examples/preview/12-update.example.json --state ./state/preview/clients/client-a/pairs/usdc-usd.json --out ./state/preview/clients/client-a/pairs/usdc-usd.json
```

## Step 16: Update Config

Operation: update Config parameters such as protocol fee, authorized DIA public keys, domain data, or config signers.

Input JSON: `./examples/preview/13-config-update.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

The Preview example authorizes an additional Ethereum/EIP-712 test signer. This enables later Preview updates with freshly signed payloads.

```sh
npm run cli -- preview:config:update --input ./examples/preview/13-config-update.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 17: Submit Batch Update

Operation: update one or more Pair UTxOs in one transaction.

Input JSON: `./examples/preview/14-update-batch.example.json`

Each batch entry contains a `statePath` and a signed DIA `OracleIntent`.

Updates: each `statePath` declared in the batch input.

The example batch intent is signed by the Ethereum/EIP-712 test signer authorized in Step 16.

```sh
npm run cli -- preview:update:batch --input ./examples/preview/14-update-batch.example.json
```

## Step 18: Top Up Receiver

Operation: add ADA to the client Receiver balance.

Input JSON: `./examples/preview/15-receiver-top-up.example.json`

State input: `./state/preview/clients/client-a.json`

Updates: `./state/preview/clients/client-a.json`

```sh
npm run cli -- preview:receiver:top-up --input ./examples/preview/15-receiver-top-up.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a.json
```

## Step 19: Withdraw From Receiver

Operation: withdraw ADA from the client Receiver balance.

Input JSON: `./examples/preview/16-receiver-withdraw.example.json`

State input: `./state/preview/clients/client-a.json`

Updates: `./state/preview/clients/client-a.json`

```sh
npm run cli -- preview:receiver:withdraw --input ./examples/preview/16-receiver-withdraw.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a.json
```

## Step 20: Withdraw Protocol Fees

Operation: withdraw accrued protocol fees from PaymentHook.

Input JSON: `./examples/preview/17-payment-hook-withdraw.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

```sh
npm run cli -- preview:payment-hook:withdraw --input ./examples/preview/17-payment-hook-withdraw.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Build Only

Every transaction command supports `--build-only`.

Example:

```sh
npm run cli -- preview:config:reference-scripts --input ./examples/preview/03-config-reference-scripts.example.json --state ./state/preview/config-bootstrap.json --build-only --out ./tmp/config-reference-scripts.build-only.json
```

## Preview Input Files

- `01-oracle-intent-sign.example.json`: unsigned EIP-712 intent payload for Preview signing
- `02-config-parameterize.example.json`: Config script parameterization input
- `03-config-reference-scripts.example.json`: Config and Coordinator reference-script input
- `04-config-bootstrap.example.json`: Config bootstrap input
- `05-payment-hook-parameterize.example.json`: PaymentHook script parameterization input
- `06-payment-hook-reference-script.example.json`: PaymentHook reference-script input
- `07-payment-hook-bootstrap.example.json`: PaymentHook bootstrap input
- `08-receiver-parameterize.example.json`: Receiver and Pair script parameterization input
- `09-client-reference-scripts.example.json`: Receiver and Pair reference-script input
- `10-receiver-bootstrap.example.json`: Receiver bootstrap input
- `11-pair-bootstrap.example.json`: Pair bootstrap input
- `12-update.example.json`: single DIA update input
- `13-config-update.example.json`: Config update input
- `14-update-batch.example.json`: batch DIA update input
- `15-receiver-top-up.example.json`: Receiver top-up input
- `16-receiver-withdraw.example.json`: Receiver withdraw input
- `17-payment-hook-withdraw.example.json`: PaymentHook fee withdrawal input

## Source File Order

Deploy modules in `src/deploys/`:

- `01-config-parameterize.ts`
- `02-config-reference-scripts.ts`
- `03-config-bootstrap.ts`
- `04-payment-hook-parameterize.ts`
- `05-payment-hook-reference-script.ts`
- `06-payment-hook-bootstrap.ts`
- `07-receiver-parameterize.ts`
- `08-client-reference-scripts.ts`
- `09-receiver-bootstrap.ts`
- `10-pair-bootstrap.ts`

Transaction modules in `src/transactions/`:

- `11-update.ts`
- `12-config-update.ts`
- `13-update-batch.ts`
- `14-receiver-top-up.ts`
- `15-receiver-withdraw.ts`
- `16-payment-hook-withdraw.ts`

Oracle helper modules in `src/oracle/`:

- `01-ethereum-wallet-create.ts`
- `02-intent-sign.ts`

## State Files

- `state/preview/config-bootstrap.json`: global protocol state
- `state/preview/clients/<client>.json`: client Receiver state and client reference scripts
- `state/preview/clients/<client>/pairs/*.json`: pair state, latest oracle value, Receiver snapshot, PaymentHook snapshot

Persist the output of each command to the state path shown in the step. Later commands read those state artifacts.
