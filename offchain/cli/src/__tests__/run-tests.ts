import assert from "node:assert/strict";
import {
  ensureCompatibleBatch,
  resolvePairArtifact,
} from "../transactions/update-batch.js";
import { createProtocolStateArtifact } from "../init/protocol-init.js";
import { createClientStateArtifact } from "../init/client-init.js";
import {
  deriveCompressedPublicKeyFromPrivateKey,
  recoverDiaOracleIntentWitness,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  signDiaOracleIntentInput,
} from "../core/dia-intent.js";
import { createEthereumWallet } from "../oracle/ethereum-wallet-create.js";
import { createWallet } from "../wallet/wallet-create.js";
import type {
  ConfigStateArtifact,
  ClientStateArtifact,
  PairStateArtifact,
} from "../core/state.js";

testCardanoWalletCreate();
testEthereumWalletCreate();
testIntentSigning();
testBatchSnapshotRefresh();
testCompatibleBatchRules();
testProtocolStateInit();
testClientStateInit();

console.log("CLI tests passed");

function testCardanoWalletCreate(): void {
  const wallet = createWallet();
  assert.equal(typeof wallet.mnemonic, "string");
  assert(wallet.address.startsWith("addr_test1"));
  assertHexString(wallet.paymentKeyHash);
  assert.equal(wallet.paymentKeyHash.length, 56);
  assert.equal(wallet.env.CARDANO_WALLET_SEED, wallet.mnemonic);
}

function testEthereumWalletCreate(): void {
  const wallet = createEthereumWallet();
  assertHexString(wallet.privateKey);
  assertHexString(wallet.publicKey);
  assert.equal(wallet.publicKey.length, 66);
  assert.equal(wallet.env.DIA_EVM_PRIVATE_KEY, wallet.privateKey);
  assert(wallet.address.startsWith("0x"));
}

function testIntentSigning(): void {
  const domain = {
    name: "DIA Oracle",
    version: "1.0",
    sourceChainId: "100640",
    verifyingContract: "0xF8c614A483A0427A13512F52ac72A576678bE317",
  };
  const signed = signDiaOracleIntentInput({
    domain,
    intent: {
      intentType: "OracleUpdate",
      version: "1.0",
      chainId: "100640",
      nonce: "1776186346664217710",
      expiry: "1779705275",
      symbol: "USDC/USD",
      price: "100045678",
      timestamp: "1777113276",
      source: "DIA Oracle",
    },
    privateKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  const recovered = recoverDiaOracleIntentWitness(
    normalizeDiaEip712Domain(domain),
    normalizeDiaOracleIntent(signed.intent),
  );

  assert.equal(recovered.signerPublicKey, signed.signerPublicKey);
  assert.equal(recovered.signerAddress, signed.signerAddress.slice(2).toLowerCase());
  assert.equal(recovered.intentHash, signed.intentHash);
}

function testBatchSnapshotRefresh(): void {
  const pair = samplePairArtifact("aa");
  const protocol = sampleConfigArtifact();
  const client = sampleClientArtifact();
  client.receiver = {
    ...sampleReceiverArtifact(),
    receiverState: {
      balanceLovelace: "33000000",
      minUtxoLovelace: "3000000",
    },
    receiverUtxo: {
      current: {
        txHash: "client-receiver-tx",
        outputIndex: 3,
      },
    },
  };
  client.datum.receiverCbor = "client-receiver-cbor";

  protocol.configState.protocolFeeLovelace = "2500000";
  protocol.configUtxo.current = {
    txHash: "protocol-config-tx",
    outputIndex: 1,
  };
  protocol.paymentHookState = {
    ...samplePaymentHookState(),
    accruedFeesLovelace: "9000000",
  };
  protocol.paymentHookUtxo = {
    current: {
      txHash: "protocol-hook-tx",
      outputIndex: 2,
    },
  };
  protocol.datum.configCbor = "protocol-config-cbor";
  protocol.datum.paymentHookCbor = "protocol-hook-cbor";

  const refreshed = resolvePairArtifact(pair, client, protocol);

  assert.equal(refreshed.configState.protocolFeeLovelace, "2500000");
  assert.equal(refreshed.configUtxo.current.txHash, "protocol-config-tx");
  assert.equal(refreshed.paymentHookState.accruedFeesLovelace, "9000000");
  assert.equal(refreshed.paymentHookUtxo.current.txHash, "protocol-hook-tx");
  assert.equal(refreshed.receiver?.receiverState.balanceLovelace, "33000000");
  assert.equal(refreshed.receiver?.receiverUtxo.current.txHash, "client-receiver-tx");
  assert.equal(refreshed.datum.configCbor, "protocol-config-cbor");
  assert.equal(refreshed.datum.paymentHookCbor, "protocol-hook-cbor");
  assert.equal(refreshed.datum.receiverCbor, "client-receiver-cbor");
}

function testCompatibleBatchRules(): void {
  const protocol = sampleConfigArtifact();
  const client = sampleClientArtifact();
  client.receiver = sampleReceiverArtifact();
  const first = resolvePairArtifact(samplePairArtifact("aa"), client, protocol);
  const second = resolvePairArtifact(samplePairArtifact("bb"), client, protocol);

  assert.doesNotThrow(() => ensureCompatibleBatch([first, second]));
  assert.throws(
    () => ensureCompatibleBatch([first, first]),
    /Duplicate pair state included in batch/,
  );
  assert.throws(
    () =>
      ensureCompatibleBatch([
        first,
        {
          ...second,
          receiver: {
            ...second.receiver,
            receiverUnit: `${"33".repeat(28)}444946464552454e54`,
          },
        },
      ]),
    /same client deployment/,
  );
}

function testProtocolStateInit(): void {
  const state = createProtocolStateArtifact({
    source: "seed",
    walletAddress: "addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j",
    referenceHolderAddress: "addr_test1referenceholder",
  });

  assert.equal(state.referenceHolderAddress, "addr_test1referenceholder");
  assert.equal(state.bootstrapRefs.config.txHash, "");
  assert.equal(state.referenceScripts?.global?.config.txHash, "");
  assert.equal(state.configState.validConfigSigners.length, 1);
  const expectedAuthorizedDiaPublicKey = process.env.DIA_EVM_PRIVATE_KEY?.trim()
    ? deriveCompressedPublicKeyFromPrivateKey(process.env.DIA_EVM_PRIVATE_KEY)
    : "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807";
  assert.equal(state.configState.authorizedDiaPublicKeys[0], expectedAuthorizedDiaPublicKey);
  assert.equal(state.configState.domain.name, "DIA Oracle");
  assert.equal(state.configState.protocolFeeLovelace, "2000000");
  assert.equal(state.datum.configCbor, "");
  assert.equal(state.datum.paymentHookCbor, "");
  assert.equal(
    state.drafts?.configParameterize?.configAssetName,
    "4449415f434f4e464947",
  );
  assert.equal(
    state.drafts?.paymentHookParameterize?.paymentHookAssetName,
    "4449415f5041594d454e545f484f4f4b",
  );
  assert.equal(
    state.drafts?.paymentHookParameterize?.minUtxoLovelace,
    "3000000",
  );
}

function testClientStateInit(): void {
  const protocol = sampleConfigArtifact();
  protocol.referenceScripts = {
    global: {
      config: {
        txHash: "global-config",
        outputIndex: 0,
        scriptHash: "11".repeat(28),
      },
      coordinator: {
        txHash: "global-coordinator",
        outputIndex: 1,
        scriptHash: "22".repeat(28),
      },
      paymentHook: {
        txHash: "global-hook",
        outputIndex: 2,
        scriptHash: "33".repeat(28),
      },
    },
  };
  const client = createClientStateArtifact("client-a", {
    clientId: "client-a",
    receiverAssetLabel: "DIA_RECEIVER_CLIENT_A",
    receiverAssetName: "4449415f52454345495645525f434c49454e545f41",
    minUtxoLovelace: "3000000",
  });

  assert.equal(client.receiver, undefined);
  assert.equal(client.referenceScripts?.client?.receiver.txHash, "");
  assert.equal(client.scripts.pairPolicyId, null);
  assert.equal(
    client.drafts?.receiverParameterize?.receiverAssetName,
    "4449415f52454345495645525f434c49454e545f41",
  );
  assert.equal(
    client.drafts?.receiverParameterize?.receiverAssetLabel,
    "DIA_RECEIVER_CLIENT_A",
  );
}

function assertHexString(value: unknown): void {
  if (typeof value !== "string") {
    assert.fail("value must be a string");
  }
  assert(value.trim().length > 0, "string must not be empty");
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  assert(/^[0-9a-fA-F]+$/.test(normalized), `${value} must be hex`);
  assert.equal(normalized.length % 2, 0, `${value} must have even hex length`);
}

function sampleConfigArtifact(): ConfigStateArtifact {
  return {
    wallet: {
      source: "seed",
      address: "addr_test1sample",
    },
    referenceHolderAddress: "addr_test1referenceholder",
    bootstrapRefs: {
      config: {
        txHash: "config-bootstrap",
        outputIndex: 0,
      },
      paymentHook: {
        txHash: "hook-bootstrap",
        outputIndex: 1,
      },
    },
    scripts: sampleScripts(),
    configState: sampleConfigState(),
    configUtxo: {
      current: {
        txHash: "config-current",
        outputIndex: 0,
      },
    },
    paymentHookState: samplePaymentHookState(),
    paymentHookUtxo: {
      current: {
        txHash: "hook-current",
        outputIndex: 0,
      },
    },
    compiledScripts: {
      configMintPolicy: "aa",
      configValidator: "bb",
      coordinatorValidator: "cc",
      paymentHookMintPolicy: "dd",
      paymentHookValidator: "ee",
    },
    datum: {
      configCbor: "config-cbor",
      paymentHookCbor: "hook-cbor",
    },
    drafts: {
      configParameterize: {
        configAssetLabel: "DIA_CONFIG",
        configAssetName: "4449415f434f4e464947",
      },
      paymentHookParameterize: {
        paymentHookAssetLabel: "DIA_PAYMENT_HOOK",
        paymentHookAssetName: "4449415f5041594d454e545f484f4f4b",
        withdrawAddress: "addr_test1sample",
        minUtxoLovelace: "3000000",
      },
    },
  };
}

function sampleClientArtifact(): ClientStateArtifact {
  return {
    clientId: "client-a",
    scripts: {
      pairPolicyId: "11".repeat(28),
      pairValidatorHash: "11".repeat(28),
      pairValidatorAddress: "addr_test1pair",
    },
    compiledScripts: {
      receiverMintPolicy: "ff",
      receiverValidator: "11",
      pairMintPolicy: "22",
      pairValidator: "33",
    },
    referenceScripts: {
      client: {
        receiver: {
          txHash: "client-receiver-ref",
          outputIndex: 0,
          scriptHash: "55".repeat(28),
        },
        pair: {
          txHash: "client-pair-ref",
          outputIndex: 1,
          scriptHash: "11".repeat(28),
        },
      },
    },
    receiver: sampleReceiverArtifact(),
    datum: {
      receiverCbor: "receiver-cbor",
    },
  };
}

function sampleReceiverArtifact() {
  return {
    clientId: "client-a",
    bootstrapRef: {
      txHash: "receiver-bootstrap",
      outputIndex: 0,
    },
    receiverAssetName: "4449415f5245434549564552",
    receiverPolicyId: "22".repeat(28),
    receiverUnit: `${"22".repeat(28)}4449415f5245434549564552`,
    receiverValidatorHash: "55".repeat(28),
    receiverValidatorAddress: "addr_test1receiver",
    receiverState: {
      balanceLovelace: "10000000",
      minUtxoLovelace: "3000000",
    },
    receiverUtxo: {
      current: {
        txHash: "receiver-current",
        outputIndex: 0,
      },
    },
  };
}

function samplePairArtifact(pairSuffix: string): PairStateArtifact {
  const pairUnit = `${"11".repeat(28)}${pairSuffix.repeat(4)}`;

  return {
    wallet: {
      source: "seed",
      address: "addr_test1sample",
    },
    pair: {
      tokenName: pairSuffix.repeat(4),
      pairId: "555344432f555344",
      pairUnit,
      pairValidatorAddress: "addr_test1pair",
      stateUtxo: {
        txHash: `pair-current-${pairSuffix}`,
        outputIndex: 0,
      },
    },
    pairState: {
      pairId: "555344432f555344",
      price: "99992561",
      timestamp: "1760960522",
      nonce: "1760960522308165264",
      intentHash: "44".repeat(32),
      signer: "f64d333c19b007519c7b9316680ed26578f98c08",
      minUtxoLovelace: "5000000",
      intent: {
        intentType: "OracleUpdate",
        version: "1.0",
        chainId: "100640",
        nonce: "1760960522308165264",
        expiry: "1760964122",
        symbol: "USDC/USD",
        price: "99992561",
        timestamp: "1760960522",
        source: "DIA Oracle",
        signature: `0x${"66".repeat(64)}`,
        signer: "0xf64d333c19b007519c7b9316680ed26578f98c08",
      },
    },
    datum: {
      pairCbor: "pair-cbor",
    },
  };
}

function sampleScripts(): ConfigStateArtifact["scripts"] {
  return {
    configPolicyId: "aa".repeat(28),
    configUnit: `${"aa".repeat(28)}4449415f434f4e464947`,
    configValidatorHash: "aa".repeat(28),
    configValidatorAddress: "addr_test1config",
    coordinatorHash: "33".repeat(28),
    coordinatorRewardAddress: "stake_test1coordinator",
    paymentHookPolicyId: "44".repeat(28),
    paymentHookUnit: `${"44".repeat(28)}4449415f5041594d454e545f484f4f4b`,
    paymentHookValidatorHash: "44".repeat(28),
    paymentHookValidatorAddress: "addr_test1hook",
  };
}

function sampleConfigState(): ConfigStateArtifact["configState"] {
  return {
    validConfigSigners: ["99".repeat(28)],
    authorizedDiaPublicKeys: [
      "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807",
    ],
    domain: {
      name: "DIA Oracle",
      version: "1.0",
      sourceChainId: "100640",
      verifyingContract: "f8c614a483a0427a13512f52ac72a576678be317",
    },
    protocolFeeLovelace: "2000000",
    paymentHookRef: {
      policyId: "44".repeat(28),
      assetName: "4449415f5041594d454e545f484f4f4b",
      unit: `${"44".repeat(28)}4449415f5041594d454e545f484f4f4b`,
    },
    updateCoordinatorCredential: {
      type: "Script",
      hash: "33".repeat(28),
    },
    minUtxoLovelace: "5000000",
  };
}

function samplePaymentHookState(): NonNullable<ConfigStateArtifact["paymentHookState"]> {
  return {
    withdrawAddress: "addr_test1withdraw",
    minUtxoLovelace: "3000000",
    accruedFeesLovelace: "0",
    lifetimeCollectedLovelace: "0",
    lifetimeWithdrawnLovelace: "0",
  };
}
