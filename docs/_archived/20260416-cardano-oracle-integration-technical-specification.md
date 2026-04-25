# Cardano Oracle Integration – Technical Specification 

## 1\. Overview

This document defines the Cardano-native implementation of the **Oracle price data receiver**, based on the requirement document: *[Cardano Integration Requirement \[PF\]](https://docs.google.com/document/d/1DWZbhp9xSx57Zq3wiMBphAhglVJSc0H5x9JiH4FkZRY/edit?tab=t.x8rozqtmoexu)*

It replaces EVM mutable storage and EIP-712 signatures with **UTxO-based state**, **Ed25519/Blake2b-256 cryptography**, and the **Extended UTxO model**.

### Core Components

- **Config Contract** – Stores configuration, domain data, authorized signers, accepted pairs, and fee policy. It authorizes new pairs and enforces configuration updates.  
- **Oracle Receiver Contract** – Stores per-asset pair price data, verifies signatures, enforces freshness, and fee payments. It mints pair NFTs when a new pair is authorized.  
- **Bridge** – Delivers signed oracle updates from the source chain (OracleIntentRegistry) to Cardano.  
- **Indexer** – Exposes oracle data for dApps and users.

---

## 2\. Architecture

- **Config Contract:** A single NFT-guarded UTxO holding configuration data.  
- **Oracle Receiver Contract:** Multiple NFT-guarded UTxOs, one per asset pair.  
- **Bridge:** Reads signed price data from the source OracleIntentRegistry and constructs Cardano transactions.  
- **Indexer:** Reads UTxOs to return latest price data for any registered pair.

Each pair (e.g. ADA/USD, BTC/USD) is represented by a unique NFT and UTxO, allowing concurrent and independent updates.  
New pairs are created atomically by **coordinated interaction between both contracts** in the same transaction.

---

## 3\. Contract A — Config Contract

### Datum Structure

- valid\_config\_signers: \[PubKeyHash\]  
- valid\_oracle\_signers: \[PubKeyHash\]  
- fee\_addresses: \[Address\]  
- fee\_amount: Int  
- domain\_data: Domain  
- allowed\_pairs: \[PairEntry\]

### Domain Structure

- name: ByteArray  
- version: ByteArray  
- chain\_tag: ByteArray  
- script\_hash: ByteArray

### PairEntry Structure

- token\_name: ByteArray — NFT token name minted by Oracle Receiver for this pair.  
- pair\_code: ByteArray — encoded string identifier (e.g. “ADA/USD”).

### Actions

1. **Mint Config NFT**  
     
   - One-time bootstrap transaction using a hard-coded input.  
   - Creates the single Config UTxO.

   

2. **Update Configuration**  
     
   - Consumes the existing Config UTxO and recreates it (same NFT).  
   - Must be signed by at least one valid\_config\_signer.  
   - Allows:  
     - Adding new pairs (PairEntry),  
     - Updating valid signers,  
     - Updating fee or domain parameters.

### On-Chain Checks

- Exactly one Config UTxO consumed and one produced (same NFT).  
- Signature from at least one valid\_config\_signer required.  
- Datum structure verified.  
- For **new pair creation**:  
  - The Config input datum **does not contain** the new PairEntry.  
  - The Config output datum **contains** the new PairEntry.  
  - The transaction **must also include**:  
    - Minting of the NFT with token\_name matching the new PairEntry.  
    - A new UTxO under the Oracle Receiver script holding that NFT and a valid initial datum.  
  - The minting policy hash must match the Oracle Receiver’s policy.  
  - These conditions ensure that only valid Config signers can authorize new pairs, and that the minting happens atomically in the same transaction.

## 4\. Contract B — Oracle Receiver Contract

### UTxO Model

- One NFT per asset pair.  
- One live UTxO per pair (holds latest oracle data).  
- NFT token\_name must match a token\_name entry in Config.allowed\_pairs.  
- Each pair NFT is minted by this contract using its own minting policy.

### Datum Structure

- pair\_id: ByteArray — corresponds to Config.PairEntry.pair\_code.  
- price: Int — latest price.  
- timestamp: Int — UNIX timestamp of the update.  
- nonce: Int — incrementing counter to prevent replays.  
- signature: ByteArray — Ed25519 signature.  
- signer: PubKeyHash — oracle signer key.  
- raw\_data: ByteArray — CBOR-encoded or opaque payload signed off-chain.

### Payload Format

The Solidity reference uses:

struct PriceIntent {  
    bytes32 asset;  
    uint256 price;  
    uint256 timestamp;  
    uint256 nonce;  
}

The Cardano version encodes the same fields in CBOR before signing.

### Actions

1. **Mint Pair Token Identifier (Pair Creation)**  
     
   - Occurs only in a transaction that also updates the Config Contract.  
   - The Config output datum must contain the new PairEntry added in this transaction.  
   - The token\_name must match that new entry.  
   - The NFT is minted under the Oracle Receiver minting policy.  
   - The initial Oracle datum must be valid (timestamp, nonce, and price fields initialized).  
   - Requires reference to the Config UTxO for verification.

   

2. **Update Price Data**  
     
   - Consumes current pair UTxO, produces a new one (same NFT).  
   - References Config UTxO.  
   - Redeemer includes payload, signature, and signer.

### On-Chain Checks

- The NFT token\_name exists in Config.allowed\_pairs.  
- signer is in Config.valid\_oracle\_signers.  
- Signature verified using:

digest \= blake2b\_256(0x1901 || blake2b\_256(domain\_data) || blake2b\_256(payload))

verify\_ed25519\_signature(signer, digest, signature) \== true

- new.timestamp \> old.timestamp and new.nonce \> old.nonce.  
- Transaction pays ≥ fee\_amount to all fee\_addresses.  
- One input/output pair for the NFT (continuity check).  
- For pair creation:  
  - The pair must appear **new** in Config (added in Config output but not in Config input).  
  - The minting policy hash matches this validator’s minting policy.

## 5\. Multi-Pair / Multi-Intent Updates

The EVM contract supports batch updates through registerMultipleIntents.  
In Cardano this is realized as a **multi-input transaction**:

- Each input spends one pair’s UTxO (Oracle Receiver).  
- A single Config reference UTxO is included for all verifications.  
- Validation for all pairs occurs independently but atomically within one transaction.

**Advantages:**

- Parallel processing of price updates per pair.  
- No shared state contention.  
- Atomic execution of all oracle updates.

## 6\. Off-Chain Components

### Bridge

- Collects signed PriceIntent data from the OracleIntentRegistry (source chain).  
- For each asset pair:  
  1. Finds the NFT/UTxO for that pair.  
  2. Builds a transaction consuming it.  
  3. Includes redeemer with payload, signer, and signature.  
  4. Adds required fee outputs.  
- Optionally groups multiple pairs in a single multi-intent transaction.

### Indexer

- Watches all UTxOs under the Oracle Receiver script.  
- Maps each pair\_code → token\_name → UTxO.  
- API:  
  - getPairs() → list of Config.allowed\_pairs.  
  - getValue(pair\_code) → latest datum (price, timestamp, signer).  
- Uses Config UTxO as reference for mapping.  
- Allows historical queries by following previous UTxOs.

### Deployment Tools

- **TypeScript CLI / Go scripts** for:  
  - Contract deployment (Config \+ Receiver).  
  - NFT minting for each pair.  
  - Setting domain data and signers.  
  - Updating Config values.  
  - Verifying deployments on testnet/mainnet.

## 7\. Example Validator (Aiken)

use aiken/builtin.{ verify\_ed25519\_signature, blake2b\_256 }  
use aiken/transaction.{ ScriptContext }  
validator oracle\_update {  
    spend(old\_datum, redeemer, \_ctx: ScriptContext) {  
        let digest \= blake2b\_256(  
            concat(\#"1901", blake2b\_256(redeemer.domain), blake2b\_256(redeemer.payload))

        )  
        expect verify\_ed25519\_signature(redeemer.signer, digest, redeemer.signature)  
        expect redeemer.timestamp \> old\_datum.timestamp  
        expect redeemer.nonce \> old\_datum.nonce  
    }  
}

## 8\. Differences vs Original EVM Design

| Feature | EVM | Cardano | Adjustment |
| :---- | :---- | :---- | :---- |
| Signature | secp256k1 \+ keccak256 | Ed25519 \+ blake2b-256 | Native Aiken builtin |
| Mutable storage | Persistent vars | Immutable UTxOs | Single NFT per pair |
| setDomainSeparator / setSignerAuthorization | Function calls | Config update | Replace Config UTxO |
| getValue() | On-chain getter | Off-chain indexer | Read UTxO datum |
| Events | EVM logs | Tx metadata / datum | Off-chain indexing |
| Internal calls (ProtocolFeeHook) | Contract call | Native enforcement | Fee outputs verified in validator |
| Batch (registerMultipleIntents) | Loop | Multi-input tx | Atomic per-pair validation |
| Gas metrics | gasUsed | lovelace fees | Track tx cost |
| Replay protection | Nonce mapping | Nonce/timestamp | Validator check |
| Pair registration | Simple mapping | Config \+ Oracle coordination | Atomic joint datums update |

## 9\. Domain Data Reference

| Field | Example | Description |
| :---- | :---- | :---- |
| name | "OracleIntentRegistry" | Signing domain name |
| version | "1" | Schema version |
| chain\_tag | "cardano-mainnet" | Network identifier |
| script\_hash | hash of Oracle Receiver script | Binds signatures to this contract |

## 10\. Security Properties

- One NFT-locked UTxO per pair (no forks or duplicates).  
- Domain hash binds signatures to network and contract.  
- Monotonic timestamp \+ nonce prevents replay.  
- Fee outputs enforced in every update.  
- Only trusted signers can update Config or oracle data.  
- New pairs require joint validation from both contracts in a single transaction.  
- Oracle minting policy ensures pair authenticity.

## 11\. Deliverables

### Deliverables Summary Table

| Category | Deliverable | Description | Purpose |
| :---- | :---- | :---- | :---- |
| **On-Chain** | config\_validator.ak | Aiken smart contract handling configuration, signer lists, fees, and pair authorization. | Manages global oracle configuration and approves new pairs. |
| **On-Chain** | oracle\_receiver.ak | Aiken smart contract that stores and validates oracle price data. | Verifies signatures, updates per-pair price data, enforces fee payment. |
| **On-Chain** | Config Minting Policy | Defines minting logic for the Config NFT, executed once during deployment. | Ensures only one Config UTxO exists and is globally unique. |
| **On-Chain** | Oracle Receiver Minting Policy | Defines minting logic for Pair NFTs, executed when a new PairEntry is added in Config. | Ensures exactly one NFT per authorized pair exists. |
| **Off-Chain** | Go Bridge | Program that collects signed PriceIntent data and builds Cardano transactions invoking oracle\_update. | Automates on-chain oracle updates from external feeds. |
| **Off-Chain** | TypeScript CLI Tool | CLI to deploy, configure, and verify smart contracts. Includes commands for domain setup, minting, signer config, and fee management. | Deployment, configuration, and maintenance automation. |
| **Off-Chain** | Indexer Service | Monitors Oracle Receiver UTxOs and exposes getPairs and getValue endpoints. | Data access API for dApps, dashboards, and monitoring. |
| **Documentation** | README.md | Step-by-step deployment guide for testnet/mainnet with network setup and sample .env. | Developer onboarding and reproducibility. |
| **Documentation** | Key Management Guide | Instructions to generate and convert keys for deployer and oracle signers. | Ensures proper key setup and format consistency. |
| **Documentation** | CLI Reference Manual | Explains all CLI commands, parameters, and network options. | Operational documentation for dev and ops teams. |
| **Documentation** | Example Workflows | Demonstrates: initial deployment, new pair creation (Config \+ Oracle), price updates, and monitoring. | Practical end-to-end usage examples. |
| **Testing** | Unit Tests | Validate signature verification, nonce/timestamp monotonicity, fee outputs, config authorization, and multi-intent logic. | Verifies correctness of on-chain logic. |
| **Testing** | Integration Tests | End-to-end flow: Bridge → On-chain validation → Indexer readback. | Confirms full system integration on testnet. |
| **Testing** | Deployment Tests | Verifies deployment and execution on testnet and at least one mainnet run. | Confirms production readiness and network compatibility. |
| **Monitoring** | Monitoring Script / Service | Reads Config and Oracle UTxOs, tracks fees, balances, and updates via node or blockfrost API. | Enables runtime observability, alerts, and data freshness checks. |

### Smart Contracts

- config\_validator.ak  
- oracle\_receiver.ak

### Off-Chain Scripts

- Go Bridge:  
  - Replaces EVM \`handleIntentUpdate\`.    
  - Collects signed oracle data, builds Cardano txs, invokes \`oracle\_update\`.    
- TypeScript CLI  
  - Deploys, configures, and verifies smart contracts.    
  - Commands for:  
    - Export Smart Contracts  
    - Minting Config and Pair NFTs  
    - Domain data setup (name, version, chain\_tag, script\_hash)  
    - Create Cardano wallet keys or reuse existing keys to use as signers  
    - Fee & signer configuration  
    - Pair creation  
    - Compatible with testnet and mainnet environments.

### Documentation

- README:  
  - Step-by-step deployment guide for testnet and mainnet.    
  - Includes network setup, wallet creation, and sample \`.env\` file.    
- Key Management Guide:   
  - How to generate and convert keys for deployer/oracle signers.    
- CLI Reference Manual:  
  - Explanation of all available commands, parameters, and network options.    
- Example Workflows:  
  - Example transactions for:  
    - Initial deployment    
    - New pair creation (Config \+ Oracle coordinated)    
    - Oracle data update    
  - Example logs for debugging and monitoring.

### Testing

- **Unit tests:**  
  - Signature verification (valid/invalid signer)  
  - Nonce and timestamp monotonicity  
  - Fee output validation  
  - Config update authorization  
  - New pair joint transaction validation  
  - Multi-intent (multi-input) transaction validation  
      
- **Integration Tests:**

  These tests validate the complete \*\*end-to-end flow\*\* across all components:


  1\. Bridge → On-Chain → Indexer:

* The Bridge collects a signed \`PriceIntent\` from the source system.  
* It builds and submits a Cardano transaction calling \`oracle\_receiver.ak\`.  
* The transaction consumes the pair’s UTxO, validates signatures and fees, and produces the updated datum on-chain.  
* The Indexer detects the new UTxO and reads the updated values (\`price\`, \`timestamp\`, \`signer\`).  
    
  2\. Expected Outcome:  
* The transaction is confirmed successfully on-chain.  
* The updated datum fields match the payload provided by the Bridge.  
* The Indexer returns the same data through its API or CLI query.  
    
  3\. Evidence:  
* Transaction hash (\`tx\_hash\`) confirmed on testnet.  
* Block and slot information.  
* Queried datum values after the update.  
* Indexer logs showing synchronized data.  
    
  These tests demonstrate that the full Oracle update loop works correctly in a live Cardano network.  
    
- **Deployment Tests**

  These tests verify that all smart contracts and minting policies can be \*\*successfully deployed and executed\*\* in both testnet and mainnet environments.


  1\. Scope:

* Deploy \`config\_validator.ak\` and \`oracle\_receiver.ak\`.  
* Create the initial Config UTxO.  
* Authorize and create a new pair (Config update \+ Oracle NFT mint).  
* Perform at least one valid oracle data update.  
    
  2\. Environment:  
* Must be run on Cardano testnet (preview or preprod).  
* At least one confirmed execution on mainnet (Protofire requirement).  
    
  3\. Evidence:  
* Transaction hashes and confirmations for:  
  * Contract deployment  
  * Config creation  
  * Pair creation  
  * Price update  
* Script addresses and Policy IDs used.  
* On-chain verification through explorer or indexer.  
    
  These deployment tests ensure that the scripts behave identically across networks and that all transactions are valid, confirming full operational readiness.

### Monitoring

On Cardano, monitoring is **off-chain only**.  
A monitoring service or script should:

1. Query the **Config UTxO** to obtain the list of allowed pairs.  
2. For each pair:  
   - Locate the current UTxO holding its NFT under the Oracle Receiver script.  
   - Read datum fields: price, timestamp, signer.  
   - Check the last updated slot/time (to detect stale data).  
3. Track ADA balance of oracle and fee addresses.  
4. Log transaction hashes and fees for updates.  
5. Supports alerting for stale prices or failed updates.  
6. Optionally store historical values for analytics or alerting.  
7. Uses node or blockfrost APIs.

There is **no gas price concept** in Cardano; monitoring uses actual *lovelace fees* per transaction.

## 12\. Summary

This Cardano-native design fully reproduces the EVM OracleReceiver logic using Extended UTxO primitives.

Each asset pair is isolated in its own NFT-locked UTxO.

All EIP-712 functionality is mirrored through Ed25519 signatures and domain-hash binding.

New pair registration is a **joint operation** between Config and Oracle Receiver, guaranteeing secure and atomic creation.

Batch updates, authorization, freshness, and fee validation are preserved.

Monitoring, deployment, and indexing are adapted to Cardano’s native model.

## 13\. On-Chain Limits

### Limit on Number of Pairs in Config Datum

The Config contract stores all valid pairs inside the field allowed\_pairs.  
Each pair adds bytes to the datum, and Cardano limits the total transaction and datum size.

**Realistic Limit**

- Each PairEntry (token\_name \+ pair\_code) adds around 150–300 bytes.  
- The Config datum can safely include about **20–50 pairs maximum** before reaching size or cost limits.

**Why It Matters**

- If too many pairs are added, updating the Config UTxO could exceed transaction size limits and fail to validate.

**Recommendation**

- Use multiple Config contracts (each with its own NFT) if the total pairs exceed the safe range.  
- Keep identifiers short and remove deprecated pairs when possible.

### Limit on Number of Pair Updates (Multi-Intent Transactions)

Each oracle update consumes one UTxO and creates one new one.  
When updating several pairs in one transaction (multi-intent update), Cardano enforces transaction and execution limits.

**Realistic Limit**

- Each additional pair adds one input, one output, and a redeemer.  
- The safe maximum is around **3–5 pairs per transaction** depending on datum size and network parameters.

**Why It Matters**

- Adding too many pairs in one transaction can exceed script memory or transaction size, causing validation failure.

**Recommendation**

- The Bridge should split large update batches into smaller groups of 3–5 pairs.  
- The Indexer can merge results from multiple transactions off-chain.

### Summary

| Limit Type | Description | Practical Limit | Mitigation |
| :---- | :---- | :---- | :---- |
| Config datum size | Total number of pairs stored in allowed\_pairs | \~50–100 pairs | Split into multiple Config contracts |
| Multi-intent updates | Number of pairs updated in one transaction | \~3–5 pairs | Batch updates across several transactions |

