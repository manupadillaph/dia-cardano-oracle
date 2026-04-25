import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyLiveSnapshots,
  ensureCompatibleBatch,
} from "../transactions/13-update-batch.js";
import {
  recoverDiaOracleIntentWitness,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  signDiaOracleIntentInput,
} from "../core/dia-intent.js";
import { createEthereumWallet } from "../oracle/01-ethereum-wallet-create.js";
import type {
  ConfigStateArtifact,
  PairStateArtifact,
} from "../core/state.js";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const previewExamples = path.join(cliRoot, "examples/preview");

await testPreviewExampleShapes();
testEthereumWalletCreate();
testIntentSigning();
testBatchSnapshotRefresh();
testCompatibleBatchRules();

console.log("CLI tests passed");

async function testPreviewExampleShapes(): Promise<void> {
  const expectedFiles = [
    "01-oracle-intent-sign.example.json",
    "02-config-parameterize.example.json",
    "03-config-reference-scripts.example.json",
    "04-config-bootstrap.example.json",
    "05-payment-hook-parameterize.example.json",
    "06-payment-hook-reference-script.example.json",
    "07-payment-hook-bootstrap.example.json",
    "08-receiver-parameterize.example.json",
    "09-client-reference-scripts.example.json",
    "10-receiver-bootstrap.example.json",
    "11-pair-bootstrap.example.json",
    "12-update.example.json",
    "13-config-update.example.json",
    "14-update-batch.example.json",
    "15-receiver-top-up.example.json",
    "16-receiver-withdraw.example.json",
    "17-payment-hook-withdraw.example.json",
  ];

  for (const file of expectedFiles) {
    const value = await readJson(path.join(previewExamples, file));
    assert.equal(typeof value, "object", `${file} must contain a JSON object`);
    assert.notEqual(value, null, `${file} must contain a JSON object`);
  }

  assertIntentSign(await readJson(path.join(previewExamples, expectedFiles[0]!)));
  assertConfigBootstrap(await readJson(path.join(previewExamples, expectedFiles[1]!)));
  assertReferenceScriptInput(await readJson(path.join(previewExamples, expectedFiles[2]!)));
  assertConfigBootstrap(await readJson(path.join(previewExamples, expectedFiles[3]!)));
  assertPaymentHookBootstrap(
    await readJson(path.join(previewExamples, expectedFiles[4]!)),
  );
  assertReferenceScriptInput(await readJson(path.join(previewExamples, expectedFiles[5]!)));
  assertPaymentHookBootstrap(
    await readJson(path.join(previewExamples, expectedFiles[6]!)),
  );
  assertReceiverBootstrap(await readJson(path.join(previewExamples, expectedFiles[7]!)));
  assertReferenceScriptInput(await readJson(path.join(previewExamples, expectedFiles[8]!)));
  assertReceiverBootstrap(await readJson(path.join(previewExamples, expectedFiles[9]!)));
  assertPairBootstrap(await readJson(path.join(previewExamples, expectedFiles[10]!)));
  assertUpdate(await readJson(path.join(previewExamples, expectedFiles[11]!)));
  assertConfigUpdate(await readJson(path.join(previewExamples, expectedFiles[12]!)));
  assertBatchUpdate(await readJson(path.join(previewExamples, expectedFiles[13]!)));
  assertAmountOnly(await readJson(path.join(previewExamples, expectedFiles[14]!)));
  assertAmountOnly(await readJson(path.join(previewExamples, expectedFiles[15]!)));
  assertAmountOnly(await readJson(path.join(previewExamples, expectedFiles[16]!)));
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
  const client = sampleConfigArtifact();
  client.receiver = {
    ...pair.receiver!,
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
    ...pair.paymentHookState,
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

  const refreshed = applyLiveSnapshots(pair, protocol, client);

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
  const first = samplePairArtifact("aa");
  const second = samplePairArtifact("bb");

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
            ...second.receiver!,
            receiverUnit: `${"33".repeat(28)}444946464552454e54`,
          },
        },
      ]),
    /same client deployment/,
  );
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function assertProtocolReferenceScripts(value: unknown): void {
  const input = objectOf(value);
  assertHexString(input.configAssetName);
  assertHexString(input.paymentHookAssetName);
  assertStringArray(input.authorizedDiaPublicKeys);
  assertDomain(input.domain);
  assertIntegerString(input.protocolFeeLovelace);
  assertIntegerString(input.configMinUtxoLovelace);
  assertIntegerString(input.paymentHookMinUtxoLovelace);
}

function assertIntentSign(value: unknown): void {
  const input = objectOf(value);
  assertDomain(input.domain);
  assertUnsignedIntent(input.intent);
}

function assertReferenceScriptInput(value: unknown): void {
  const input = objectOf(value);
  assertIntegerString(input.lovelacePerOutput);
}

function assertConfigBootstrap(value: unknown): void {
  const input = objectOf(value);
  assertHexString(input.configAssetName);
  assertStringArray(input.authorizedDiaPublicKeys);
  assertDomain(input.domain);
  assertIntegerString(input.protocolFeeLovelace);
  assertIntegerString(input.minUtxoLovelace);
}

function assertPaymentHookBootstrap(value: unknown): void {
  const input = objectOf(value);
  assertHexString(input.paymentHookAssetName);
  assertIntegerString(input.minUtxoLovelace);
}

function assertClientReferenceScripts(value: unknown): void {
  const input = objectOf(value);
  assertString(input.clientId);
  assertIntegerString(input.lovelacePerOutput);
  assertHexString(input.receiverAssetName);
  assertIntegerString(input.initialBalanceLovelace);
  assertIntegerString(input.minUtxoLovelace);
}

function assertReceiverBootstrap(value: unknown): void {
  const input = objectOf(value);
  assertString(input.clientId);
  assertHexString(input.receiverAssetName);
  assertIntegerString(input.initialBalanceLovelace);
  assertIntegerString(input.minUtxoLovelace);
}

function assertPairBootstrap(value: unknown): void {
  const input = objectOf(value);
  assertIntent(input.intent);
  assertIntegerString(input.minUtxoLovelace);
}

function assertUpdate(value: unknown): void {
  assertIntent(objectOf(value).intent);
}

function assertBatchUpdate(value: unknown): void {
  const input = objectOf(value);
  assertString(input.protocolStatePath);
  assertString(input.clientStatePath);
  assert(Array.isArray(input.updates), "updates must be an array");
  assert(input.updates.length > 0, "updates must not be empty");
  for (const entry of input.updates) {
    const update = objectOf(entry);
    assertString(update.statePath);
    assertIntent(update.intent);
  }
}

function assertConfigUpdate(value: unknown): void {
  const input = objectOf(value);
  assertIntegerString(input.protocolFeeLovelace);
  assertStringArray(input.authorizedDiaPublicKeys);
  assertDomain(input.domain);
}

function assertAmountOnly(value: unknown): void {
  assertIntegerString(objectOf(value).amountLovelace);
}

function assertIntent(value: unknown): void {
  const intent = objectOf(value);
  assertString(intent.intentType);
  assertString(intent.version);
  assertIntegerString(intent.chainId);
  assertIntegerString(intent.nonce);
  assertIntegerString(intent.expiry);
  assertString(intent.symbol);
  assertIntegerString(intent.price);
  assertIntegerString(intent.timestamp);
  assertString(intent.source);
  assertHexString(intent.signature);
  assertHexString(intent.signer);
}

function assertUnsignedIntent(value: unknown): void {
  const intent = objectOf(value);
  assertString(intent.intentType);
  assertString(intent.version);
  assertIntegerString(intent.chainId);
  assertIntegerString(intent.nonce);
  assertIntegerString(intent.expiry);
  assertString(intent.symbol);
  assertIntegerString(intent.price);
  assertIntegerString(intent.timestamp);
  assertString(intent.source);
}

function assertDomain(value: unknown): void {
  const domain = objectOf(value);
  assertString(domain.name);
  assertString(domain.version);
  assertIntegerString(domain.sourceChainId);
  assertHexString(domain.verifyingContract);
}

function objectOf(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    assert.fail("value must be a string");
  }
  assert(value.trim().length > 0, "string must not be empty");
}

function assertStringArray(value: unknown): asserts value is string[] {
  assert(Array.isArray(value), "value must be an array");
  assert(value.length > 0, "array must not be empty");
  for (const item of value) {
    assertString(item);
  }
}

function assertIntegerString(value: unknown): void {
  assertString(value);
  assert(/^\d+$/.test(value), `${value} must be a non-negative integer string`);
}

function assertHexString(value: unknown): void {
  assertString(value);
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
    datum: {
      configCbor: "config-cbor",
      paymentHookCbor: "hook-cbor",
    },
  };
}

function samplePairArtifact(pairSuffix: string): PairStateArtifact {
  const pairUnit = `${"11".repeat(28)}${pairSuffix.repeat(4)}`;
  const receiver = {
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

  return {
    wallet: {
      source: "seed",
      address: "addr_test1sample",
    },
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
    receiver,
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
      configCbor: "config-cbor",
      paymentHookCbor: "hook-cbor",
      receiverCbor: "receiver-cbor",
      pairCbor: "pair-cbor",
    },
  };
}

function sampleScripts(): PairStateArtifact["scripts"] {
  return {
    configPolicyId: "aa".repeat(28),
    configUnit: `${"aa".repeat(28)}4449415f434f4e464947`,
    configValidatorHash: "aa".repeat(28),
    configValidatorAddress: "addr_test1config",
    pairPolicyId: "11".repeat(28),
    pairValidatorHash: "11".repeat(28),
    pairValidatorAddress: "addr_test1pair",
    coordinatorHash: "33".repeat(28),
    coordinatorRewardAddress: "stake_test1coordinator",
    paymentHookPolicyId: "44".repeat(28),
    paymentHookUnit: `${"44".repeat(28)}4449415f5041594d454e545f484f4f4b`,
    paymentHookValidatorHash: "44".repeat(28),
    paymentHookValidatorAddress: "addr_test1hook",
  };
}

function sampleConfigState(): PairStateArtifact["configState"] {
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

function samplePaymentHookState(): PairStateArtifact["paymentHookState"] {
  return {
    withdrawAddress: "addr_test1withdraw",
    minUtxoLovelace: "3000000",
    accruedFeesLovelace: "0",
    lifetimeCollectedLovelace: "0",
    lifetimeWithdrawnLovelace: "0",
  };
}
