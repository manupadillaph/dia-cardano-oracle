# Product Requirements Document: Cardano Integration

## 1\. Overview

This document outlines the requirements for developing an Oracle price data receiver for the Cardano blockchain. The receiver will be designed to accept EIP712-signed oracle updates, ensuring data integrity and authenticity.

## 2\. Background

The system leverages an existing OracleIntentRegistry on a source chain, which continuously feeds signed price data. A bridge component will then facilitate the secure delivery of this signed data to the destination chain. In this case, Cardano will be the destination chain.

In the following sections we outline several artifacts that are required to be developed for a successful integration into the destination chain.

## 3\. Destination Chain Oracle Smart Contract: PushOracleReceiverV2

The `PushOracleReceiverV2` smart contract on the destination chain must fulfill the following requirements:

- **Signature Verification:**
  - Accept EIP712-signed data.

  - Verify that the incoming data is signed by an authorized key, as configured within the smart contract.

- **Data Retrieval:**
  - Implement a `getValue` function to return the latest asset value to any caller on the destination chain (e.g. dApps, end users etc)

- **Intent Update Handling:**
  - Implement a `handleIntentUpdate` function to accept signed Intent Data.

  - Ensure that the intent is signed by one of the trusted signers.

  - Be capable of retrieving signed data based on an intent hash (e.g., from the “logs” section of this transaction: `https://testnet-explorer.diadata.org/tx/0x82af92bdfb51bc1049cf832b1d85f219b033aea6c1cc38cd1857872c0a3cea55`).

  - Accept only new price updates; old prices should trigger a "stale intent" event, as defined in `IPushOracleReceiverV2`.

  - Skip processing if the same intent hash is submitted multiple times.

- **Configuration Functions:**
  - `setDomainSeparator`: A function to set the domain separator based on the `OracleIntentRegistry`. The `createDomainSeparator` function from `contracts/contracts/libs/OracleIntentUtils.sol` should serve as a reference for the signature domain separator struct order.

  function createDomainSeparator(

          string memory domainName,

          string memory domainVersion,

          uint256 chainId,

          address verifyingContract

      ) internal pure returns (bytes32) {

          return keccak256(

              abi.encode(

                  keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"),

                  keccak256(bytes(domainName)),

                  keccak256(bytes(domainVersion)),

                  chainId,

                  verifyingContract,

                  bytes32(0)

              )

          );

  - `setSignerAuthorization`: A function to add trusted signers.

  - `setPaymentHook`: A setter for the `ProtocolFeeHook` smart contract.

- **Batch Processing:**
  - `registerMultipleIntents`: A function to accept multiple events within a single transaction.

- **Fee Management:**
  - Transfer protocol fees based on the quote provided by the `ProtocolFeeHook`.

- **Event Naming:**
  - Utilize the same event names as defined in `contracts/contracts/interfaces/oracle/IPushOracleReceiverV2.sol`.

- **Scope Exclusion:**
  - Hyperlane-related functionalities (e.g., `trustedmailbox`, `ISM`) are explicitly out of scope for this requirement.

## 4\. Destination Chain Fee Manager Contract: ProtocolFeeHook

- A clone of the `ProtocolFeeHook` contract (from `contracts/contracts/ProtocolFeeHook.sol`) is required.

## 5\. Go Code Snippet

- The Go code snippet, to be used within the Bridge, must call the `handleIntentUpdate` function of `PushOracleReceiverV2`.

## 6\. Node.js/TypeScript Snippet

The Node.js/TypeScript snippet should support the following:

1. **Smart Contract Verification:** Verify the deployed smart contract.

2. **Smart Contract Configuration:**
   - Set the `ProtocolFeeHook`.

   - Set the `Domainseparator`.

   - Configure trusted signers.

3. **Smart Contract Deployment:** Deploy the smart contract.

4. **Cardano Key Management:**
   - Create Cardano keys or reuse existing keys generated via `https://getfoundry.sh/cast/reference/wallet/private-key/`.

This snippet will be instrumental in extending `forge-wrapper`, a CLI tool for deploying, configuring, and verifying smart contracts.

## 7\. Documentation

- Wallet creation how-to, including storage format conversions that might need to be made for the deployer and/or feeder software

- README with example run for deploy on testnet/devnet

- Requirement to deploy at least once on mainnet, by Protofire (to detect any mainnet specific issue)

- Step-by-step description of deployment requirements

- Explanations on all options of the deployer (e.g., subchains, network URLs, etc.)

- Unit tests for deployment functions

## 8\. Monitoring

- A script is required to monitor transactions.

- Access to current gas amount of the feeder wallet

- Function to get the latest gas price

- Last transaction metadata (including gas usage/price)

- If possible: extend to last n transactions (e.g., with access to an indexer API)

- Query current values of the oracle (price, timestamp)

- Unit tests for all monitoring functions

## 9\. Reference Smart Contracts

The following GitHub repositories serve as reference implementations:

- `PushOracleReceiverV2.sol`: [https://github.com/diadata-org/Spectra-interoperability/blob/logging/contracts/contracts/PushOracleReceiverV2.sol](https://github.com/diadata-org/Spectra-interoperability/blob/logging/contracts/contracts/PushOracleReceiverV2.sol)

- `ProtocolFeeHook.sol`: [https://github.com/diadata-org/Spectra-interoperability/blob/logging/contracts/contracts/ProtocolFeeHook.sol](https://github.com/diadata-org/Spectra-interoperability/blob/logging/contracts/contracts/ProtocolFeeHook.sol)

- `OracleIntentRegistry.sol`: [https://github.com/diadata-org/Spectra-interoperability/blob/logging/contracts/contracts/OracleIntentRegistry.sol](https://github.com/diadata-org/Spectra-interoperability/blob/logging/contracts/contracts/OracleIntentRegistry.sol)

- `OracleIntentUtils.sol`: [https://github.com/diadata-org/Spectra-interoperability/blob/logging/contracts/contracts/libs/OracleIntentUtils.sol](https://github.com/diadata-org/Spectra-interoperability/blob/logging/contracts/contracts/libs/OracleIntentUtils.sol)

Oracle Deployer/Smart Contract

- Wallet creation how-to, including storage format conversions that might need to be made for the deployer and/or feeder software

- README with example run for deploy on testnet/devnet

- Requirement to deploy at least once on mainnet, by Protofire (to detect any mainnet specific issue)

- Step-by-step description of how it was done

- Explanations on all options of the deployer (e.g., subchains, network URLs, etc.)

- Unit tests for deployment functions
