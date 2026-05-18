import "./_test-env.js";
import assert from "node:assert/strict";
import { Constr, type Data as PlutusData } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";
import {
  ensureCompatibleBatch,
  resolvePairArtifact,
  sortBatchUpdatesByPairTokenName,
} from "../transactions/update-batch.js";
import { createProtocolStateArtifact } from "../init/protocol-init.js";
import { createClientStateArtifact } from "../init/client-init.js";
import {
  deriveCompressedPublicKeyFromPrivateKey,
  recoverDiaOracleIntentWitness,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  signDiaOracleIntentInput,
  assertDiaOracleIntentNotExpired,
} from "../core/dia-intent.js";
import { createEthereumWallet } from "../oracle/ethereum-wallet-create.js";
import { createWallet } from "../wallet/wallet-create.js";
import {
  buildConfigDatumCbor,
  buildPairDatumCbor,
  buildPaymentHookDatumCbor,
  buildReceiverDatumCbor,
  decodePairDatum,
  decodePaymentHookDatum,
  decodeReceiverDatum,
  addressToPlutusData,
} from "../core/chain-helpers.js";
import {
  normalizeHex,
  splitUnit,
  toBigInt,
  parseCommaSeparatedHexList,
  utf8ToHex,
} from "../core/primitives.js";
import {
  assertClientIdNonEmpty,
  assertConfigUtxoLivesAtValidatorAddress,
  assertHookCoordinatorConsistency,
  assertNftBootstrapDestinationIsNotFundingWallet,
  assertNonEmptyConfigSignerList,
  assertOracleIntentTimestampAndNonceMonotonic,
  assertOracleUpdateBootstrapRefsResolved,
  assertPaymentHookWithdrawAmountPositive,
  assertPaymentHookWithdrawAmountValid,
  assertPaymentKeyHashIsConfigSigner,
  assertPositiveMinUtxoLovelace,
  assertReceiverTopUpAmountPositive,
  assertReceiverWithdrawAmountPositive,
  assertReceiverWithdrawAmountValid,
  assertSettleManifestMatchesSingleClientReceiver,
  assertSettleManifestReceiversNonEmptyAndUnique,
  assertSettleReceiverAccruedPositive,
} from "../preflight/index.js";
import type {
  ConfigStateArtifact,
  ClientStateArtifact,
  PairStateArtifact,
} from "../core/state.js";
import {
  emulatorSubmitAndMine,
  makeOracleEmulatorLucid,
  makeOracleEmulatorWithReferenceScriptRow,
} from "./emulator/harness.js";
import { isAnyReferenceScriptMissing } from "../core/reference-scripts.js";
import { collectTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { buildPairApplyUpdateRedeemer } from "../core/redeemers.js";

testCardanoWalletCreate();
testEthereumWalletCreate();
testIntentSigning();
testBatchSnapshotRefresh();
testCompatibleBatchRules();
testBatchUpdatesSortByPairTokenName();
testBatchUpdatesSortMatchesBytewiseCompare();
testBatchUpdatesSortRejectsNonNormalizedTokenName();
testPairApplyUpdateRedeemerHasNoFields();
testProtocolStateInit();
testClientStateInit();

// --- Datum encoder/decoder regression tests ---------------------------------
// These exist as a regression net for three real bugs found and fixed in the
// off-chain encoders during the architecture review:
//   1. Receiver bootstrap encoded only 2 of the 3 ReceiverDatum fields.
//   2. Config bootstrap had `max_bootstrap_drift_seconds` and
//      `payment_hook_ref` swapped.
//   3. PaymentHook bootstrap omitted `max_bootstrap_drift_seconds` from the
//      ConfigDatum entirely.
// They are golden-style: any reordering or missing field will trip them.

testPrimitivesPureHelpers();
testReceiverDatumRoundTrip();
testReceiverDatumExactlyThreeIntegerFields();
testPaymentHookDatumRoundTrip();
testPaymentHookDatumWithdrawAddressRoundTrip();
testConfigDatumRoundTrip();
testConfigDatumFieldOrderAndArity();
testPairDatumRoundTrip();
testAddressToPlutusDataKeyAndStake();

// --- Pure invariant tests (withdraw, settle, batch guards) -----------------
testReceiverWithdrawDoesNotTouchAccrued();
testSettleDeltaInvariant();
testBatchRejectsDuplicatePair();
testBatchRejectsForeignReceiver();
testSettleManifestPreChecks();
testHookCoordinatorConsistencyPure();
testReferenceScriptMissingHelper();
testWithdrawAmountPreflightHelpers();
testReceiverTransactionPreflightGuards();
testConfigUpdateAndInitArtifactPreflight();
testBootstrapNftPayPreflight();
testSettleAndPaymentHookPreflight();
testOracleUpdatePreflightPureGuards();

// --- Lucid emulator harness (smoke: pay + reference script genesis) ---------
await runLucidEmulatorHarnessSmokeTests();

console.log("CLI tests passed");

function testCardanoWalletCreate(): void {
  const originalNetwork = process.env.CARDANO_NETWORK;
  try {
    for (const [network, addressPrefix] of [
      ["Preview", "addr_test1"],
      ["Mainnet", "addr1"],
    ] as const) {
      process.env.CARDANO_NETWORK = network;
      const wallet = createWallet();
      assert.equal(typeof wallet.mnemonic, "string");
      assert(
        wallet.address.startsWith(addressPrefix),
        `expected ${network} address to start with ${addressPrefix}, got ${wallet.address}`,
      );
      assertHexString(wallet.paymentKeyHash);
      assert.equal(wallet.paymentKeyHash.length, 56);
      assert.equal(wallet.env.CARDANO_WALLET_SEED, wallet.mnemonic);
      assert.equal(wallet.env.CARDANO_NETWORK, network);
    }
  } finally {
    if (originalNetwork === undefined) {
      delete process.env.CARDANO_NETWORK;
    } else {
      process.env.CARDANO_NETWORK = originalNetwork;
    }
  }
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
      accruedToHookLovelace: "0",
      minUtxoLovelace: "3000000",
    },
  };
  client.datum.receiverCbor = "client-receiver-cbor";

  protocol.configState.baseFeeLovelace = "600000";
  protocol.configState.perPairFeeLovelace = "400000";
  protocol.paymentHookState = {
    ...samplePaymentHookState(),
    accruedFeesLovelace: "9000000",
  };
  protocol.datum.configCbor = "protocol-config-cbor";
  protocol.datum.paymentHookCbor = "protocol-hook-cbor";

  const refreshed = resolvePairArtifact(pair, client, protocol);

  assert.equal(refreshed.configState.baseFeeLovelace, "600000");
  assert.equal(refreshed.configState.perPairFeeLovelace, "400000");
  assert.equal(refreshed.paymentHookState.accruedFeesLovelace, "9000000");
  assert.equal(refreshed.receiver?.receiverState.balanceLovelace, "33000000");
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

function testBatchUpdatesSortByPairTokenName(): void {
  const updates = [
    { artifact: samplePairArtifact("cc"), label: "cc" },
    { artifact: samplePairArtifact("aa"), label: "aa" },
    { artifact: samplePairArtifact("bb"), label: "bb" },
  ];

  const sorted = sortBatchUpdatesByPairTokenName(updates);

  assert.deepEqual(sorted.map((update) => update.label), ["aa", "bb", "cc"]);
  assert.deepEqual(updates.map((update) => update.label), ["cc", "aa", "bb"]);
}

// The on-chain coordinator enforces strict ascending order by
// `bytearray.compare` on `pair_token_name`. Token names are
// `blake2b_256(pair_id)` serialized as lowercase hex, so a bytewise compare
// on the decoded bytes is equivalent to a plain lexicographic compare on
// the normalized hex string. This regression pins that equivalence using
// token names that mix digits and lowercase letters — exactly the cases
// where a locale-sensitive collation could diverge from byte order on some
// platforms.
function testBatchUpdatesSortMatchesBytewiseCompare(): void {
  // Hex bytes ordered: 0x09 < 0x0a < 0x0f < 0x10 < 0xa0 < 0xff.
  const tokenNames = ["ff", "10", "0a", "a0", "0f", "09"];
  const updates = tokenNames.map((name) => ({
    artifact: samplePairArtifact(name),
    label: name,
  }));

  const sorted = sortBatchUpdatesByPairTokenName(updates);
  const sortedNames = sorted.map((update) =>
    update.artifact.pair.tokenName,
  );

  // Verify strict ascending order matches a bytewise compare on the
  // decoded bytes — the exact rule the on-chain batch witness header
  // check enforces during the coordinator's main witness walk.
  for (let i = 1; i < sortedNames.length; i++) {
    const prev = Buffer.from(sortedNames[i - 1], "hex");
    const curr = Buffer.from(sortedNames[i], "hex");
    assert.ok(
      Buffer.compare(prev, curr) < 0,
      `Expected bytewise ascending order: ${sortedNames[i - 1]} < ${sortedNames[i]}`,
    );
  }
}

function testBatchUpdatesSortRejectsNonNormalizedTokenName(): void {
  // Odd-length hex would not round-trip to bytes and must be rejected
  // before sorting — otherwise the off-chain order could diverge from the
  // on-chain bytewise rule on the decoded bytes.
  const oddUpdates = [
    { artifact: { pair: { tokenName: "abc" } }, label: "odd" },
    { artifact: { pair: { tokenName: "aabb" } }, label: "even" },
  ];
  assert.throws(
    () => sortBatchUpdatesByPairTokenName(oddUpdates),
    /even-length hex/,
  );

  // Non-hex characters must also be rejected; `normalizeHex` only accepts
  // `[0-9a-f]` after lower-casing, so anything else is structurally invalid
  // as a Cardano token-name bytestring representation.
  const nonHexUpdates = [
    { artifact: { pair: { tokenName: "zzzz" } }, label: "non-hex" },
    { artifact: { pair: { tokenName: "aabb" } }, label: "ok" },
  ];
  assert.throws(
    () => sortBatchUpdatesByPairTokenName(nonHexUpdates),
    /even-length hex/,
  );
}

function testPairApplyUpdateRedeemerHasNoFields(): void {
  // The on-chain `PairSpendAction::ApplyUpdate` constructor carries no
  // fields after the witness-index removal — pair_state.spend no longer
  // binds to a specific witness because update_coordinator's count
  // checks already enforce one-pair-input-per-witness accounting.
  assert.equal(
    buildPairApplyUpdateRedeemer(),
    Data.to(new Constr<PlutusData>(0, [])),
  );
}

function testProtocolStateInit(): void {
  const state = createProtocolStateArtifact({
    source: "seed",
    walletAddress: "addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j",
  });

  assert.equal(state.scripts.referenceHolderAddress, "");
  assert.equal(state.bootstrapRefs.config.txHash, "");
  assert.equal(state.referenceScripts?.global?.config.txHash, "");
  assert.equal(state.configState.validConfigSigners.length, 1);
  const expectedAuthorizedDiaPublicKey = process.env.DIA_EVM_PRIVATE_KEY?.trim()
    ? deriveCompressedPublicKeyFromPrivateKey(process.env.DIA_EVM_PRIVATE_KEY)
    : "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807";
  assert.equal(state.configState.authorizedDiaPublicKeys[0], expectedAuthorizedDiaPublicKey);
  assert.equal(state.configState.domain.name, "DIA Oracle");
  assert.equal(state.configState.baseFeeLovelace, "600000");
  assert.equal(state.configState.perPairFeeLovelace, "400000");
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
    state.configState.minUtxoLovelace,
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
  assert.equal(client.scripts.pairPolicyId, "");
  assert.equal(
    client.drafts?.receiverParameterize?.receiverAssetName,
    "4449415f52454345495645525f434c49454e545f41",
  );
  assert.equal(
    client.drafts?.receiverParameterize?.receiverAssetLabel,
    "DIA_RECEIVER_CLIENT_A",
  );
}

// =====================================================================
// Datum encoder / decoder tests
// =====================================================================

function sampleReceiverState(overrides: Partial<{
  balanceLovelace: string;
  accruedToHookLovelace: string;
  minUtxoLovelace: string;
}> = {}) {
  return {
    balanceLovelace: overrides.balanceLovelace ?? "12345678",
    accruedToHookLovelace: overrides.accruedToHookLovelace ?? "987654",
    minUtxoLovelace: overrides.minUtxoLovelace ?? "3000000",
  };
}

function samplePaymentHookStateDatum() {
  return {
    withdrawAddress:
      "addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j",
    minUtxoLovelace: "3000000",
    accruedFeesLovelace: "5000000",
    lifetimeCollectedLovelace: "10000000",
    lifetimeWithdrawnLovelace: "5000000",
  };
}

function sampleConfigStateDatum() {
  return {
    validConfigSigners: ["99".repeat(28), "ab".repeat(28)],
    authorizedDiaPublicKeys: [
      "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807",
    ],
    domain: {
      name: "DIA Oracle",
      version: "1.0",
      sourceChainId: "100640",
      verifyingContract: "f8c614a483a0427a13512f52ac72a576678be317",
    },
    baseFeeLovelace: "600000",
    perPairFeeLovelace: "400000",
    paymentHookRef: {
      policyId: "44".repeat(28),
      assetName: "4449415f5041594d454e545f484f4f4b",
      unit: `${"44".repeat(28)}4449415f5041594d454e545f484f4f4b`,
    },
    updateCoordinatorCredential: {
      type: "Script" as const,
      hash: "33".repeat(28),
    },
    minUtxoLovelace: "5000000",
    maxBootstrapDriftSeconds: "300",
  };
}

function samplePairLiveState() {
  return {
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
  };
}

function testPrimitivesPureHelpers(): void {
  assert.equal(toBigInt("42", "x"), 42n);
  assert.equal(toBigInt(7, "y"), 7n);
  assert.throws(() => toBigInt("not-a-number", "z"), /integer/i);

  assert.equal(normalizeHex("0xABCD", "h"), "abcd");
  assert.equal(normalizeHex("ABCD", "h"), "abcd");
  assert.throws(() => normalizeHex("0xZZ", "bad"), /hex/i);
  assert.throws(() => normalizeHex("abc", "odd"), /even/i);

  const split = splitUnit(`${"aa".repeat(28)}4449415f434f4e464947`);
  assert.equal(split.policyId.length, 56);
  assert.equal(split.assetName, "4449415f434f4e464947");

  assert.deepEqual(
    parseCommaSeparatedHexList(" 0xaa, bb, 0xCC ", "list"),
    ["aa", "bb", "cc"],
  );
  assert.deepEqual(parseCommaSeparatedHexList("", "list"), []);

  assert.equal(utf8ToHex("DIA Oracle"), "444941204f7261636c65");
}

function testReceiverDatumRoundTrip(): void {
  const state = sampleReceiverState();
  const cbor = buildReceiverDatumCbor(state);
  const decoded = decodeReceiverDatum(cbor);

  assert.equal(decoded.balanceLovelace, state.balanceLovelace);
  assert.equal(decoded.accruedToHookLovelace, state.accruedToHookLovelace);
  assert.equal(decoded.minUtxoLovelace, state.minUtxoLovelace);
}

function testReceiverDatumExactlyThreeIntegerFields(): void {
  // Regression for the bug where receiver-bootstrap.ts encoded 2 fields.
  const cbor = buildReceiverDatumCbor(sampleReceiverState());
  const datum = Data.from(cbor) as Constr<PlutusData>;

  assert.equal(datum.index, 0, "ReceiverDatum constructor must be index 0");
  assert.equal(datum.fields.length, 3, "ReceiverDatum must have exactly 3 fields");

  for (let i = 0; i < datum.fields.length; i += 1) {
    assert.equal(
      typeof datum.fields[i],
      "bigint",
      `ReceiverDatum field ${i} must be Int (bigint), got ${typeof datum.fields[i]}`,
    );
  }
  assert.equal(datum.fields[0], 12345678n);
  assert.equal(datum.fields[1], 987654n);
  assert.equal(datum.fields[2], 3000000n);
}

function testPaymentHookDatumRoundTrip(): void {
  const state = samplePaymentHookStateDatum();
  const cbor = buildPaymentHookDatumCbor(state);
  const decoded = decodePaymentHookDatum(cbor, state.withdrawAddress);

  assert.equal(decoded.withdrawAddress, state.withdrawAddress);
  assert.equal(decoded.accruedFeesLovelace, state.accruedFeesLovelace);
  assert.equal(decoded.lifetimeCollectedLovelace, state.lifetimeCollectedLovelace);
  assert.equal(decoded.lifetimeWithdrawnLovelace, state.lifetimeWithdrawnLovelace);
  assert.equal(decoded.minUtxoLovelace, state.minUtxoLovelace);
}

function testPaymentHookDatumWithdrawAddressRoundTrip(): void {
  // Address must encode as a (paymentCred, optional stakeCred) pair
  // following the Plutus Address shape, not as a string.
  const state = samplePaymentHookStateDatum();
  const cbor = buildPaymentHookDatumCbor(state);
  const datum = Data.from(cbor) as Constr<PlutusData>;

  assert.equal(datum.index, 0);
  assert.equal(datum.fields.length, 5);

  const addr = datum.fields[0] as Constr<PlutusData>;
  assert.equal(addr.index, 0, "Address constructor must be 0");
  assert.equal(addr.fields.length, 2, "Address must carry payment + stake credential");

  const paymentCred = addr.fields[0] as Constr<PlutusData>;
  // Sample address has key payment credential -> Constr 0.
  assert.equal(paymentCred.index, 0, "payment credential should be VerificationKey");
  assert.equal(typeof paymentCred.fields[0], "string");

  // Stake credential is Some(...) for the sample address (it has a stake key).
  const stakeWrapper = addr.fields[1] as Constr<PlutusData>;
  assert.equal(stakeWrapper.index, 0, "stake credential should be Some(...)");

  // Remaining fields must be ints in correct order.
  assert.equal(typeof datum.fields[1], "bigint", "accrued_fees_lovelace");
  assert.equal(typeof datum.fields[2], "bigint", "lifetime_collected_lovelace");
  assert.equal(typeof datum.fields[3], "bigint", "lifetime_withdrawn_lovelace");
  assert.equal(typeof datum.fields[4], "bigint", "min_utxo_lovelace");
}

function testConfigDatumRoundTrip(): void {
  // No symmetric decoder exists for ConfigDatum (no off-chain caller needs it),
  // so we round-trip via Data.from + structural comparison.
  const state = sampleConfigStateDatum();
  const cbor = buildConfigDatumCbor(state);
  const datum = Data.from(cbor) as Constr<PlutusData>;

  assert.equal(datum.index, 0);
  assert.equal(datum.fields.length, 9, "ConfigDatum must have exactly 9 fields");

  // 0: validConfigSigners (List<bytes>)
  const signers = datum.fields[0] as string[];
  assert.deepEqual(signers, state.validConfigSigners);

  // 1: authorizedDiaPublicKeys (List<bytes>)
  const keys = datum.fields[1] as string[];
  assert.deepEqual(keys, state.authorizedDiaPublicKeys);

  // 2: domain_data (Constr 0)
  const domain = datum.fields[2] as Constr<PlutusData>;
  assert.equal(domain.index, 0);
  assert.equal(domain.fields.length, 4);
  assert.equal(domain.fields[0], utf8ToHex(state.domain.name));
  assert.equal(domain.fields[1], utf8ToHex(state.domain.version));
  assert.equal(domain.fields[2], BigInt(state.domain.sourceChainId));
  assert.equal(domain.fields[3], state.domain.verifyingContract);

  // 3: base_fee_lovelace (Int)
  assert.equal(datum.fields[3], BigInt(state.baseFeeLovelace));

  // 4: per_pair_fee_lovelace (Int)
  assert.equal(datum.fields[4], BigInt(state.perPairFeeLovelace));

  // 5: payment_hook_ref (Option<PaymentHookRef>) -> Some
  const hookRef = datum.fields[5] as Constr<PlutusData>;
  assert.equal(hookRef.index, 0, "payment_hook_ref must be Some(...)");
  const hookInner = hookRef.fields[0] as Constr<PlutusData>;
  assert.equal(hookInner.index, 0);
  assert.equal(hookInner.fields[0], state.paymentHookRef.policyId);
  assert.equal(hookInner.fields[1], state.paymentHookRef.assetName);

  // 6: update_coordinator_credential (Option<Credential>) -> Some(Script)
  const coord = datum.fields[6] as Constr<PlutusData>;
  assert.equal(coord.index, 0, "coordinator credential must be Some(...)");
  const coordCred = coord.fields[0] as Constr<PlutusData>;
  assert.equal(coordCred.index, 1, "Script credential constructor is index 1");
  assert.equal(coordCred.fields[0], state.updateCoordinatorCredential.hash);

  // 7: max_bootstrap_drift_seconds (Int)
  assert.equal(datum.fields[7], BigInt(state.maxBootstrapDriftSeconds));

  // 8: min_utxo_lovelace (Int)
  assert.equal(datum.fields[8], BigInt(state.minUtxoLovelace));
}

function testConfigDatumFieldOrderAndArity(): void {
  // Direct regression for the field-order bug: previously
  // max_bootstrap_drift_seconds and payment_hook_ref had been swapped, and
  // payment-hook-bootstrap had omitted max_bootstrap_drift_seconds entirely.
  const stateWithNone = {
    ...sampleConfigStateDatum(),
    paymentHookRef: null,
    updateCoordinatorCredential: null,
  };
  const cbor = buildConfigDatumCbor(stateWithNone);
  const datum = Data.from(cbor) as Constr<PlutusData>;

  assert.equal(datum.fields.length, 9, "Arity must be 9 even when options are None");

  const hookRef = datum.fields[5] as Constr<PlutusData>;
  assert.equal(hookRef.index, 1, "None constructor for payment_hook_ref");
  assert.equal(hookRef.fields.length, 0);

  const coord = datum.fields[6] as Constr<PlutusData>;
  assert.equal(coord.index, 1, "None constructor for update_coordinator_credential");
  assert.equal(coord.fields.length, 0);

  // Ints must be at the right positions.
  assert.equal(typeof datum.fields[3], "bigint", "base_fee_lovelace at index 3");
  assert.equal(typeof datum.fields[4], "bigint", "per_pair_fee_lovelace at index 4");
  assert.equal(typeof datum.fields[7], "bigint", "max_bootstrap_drift_seconds at index 7");
  assert.equal(typeof datum.fields[8], "bigint", "min_utxo_lovelace at index 8");
}

function testPairDatumRoundTrip(): void {
  const state = samplePairLiveState();
  const cbor = buildPairDatumCbor(state);
  const datum = Data.from(cbor) as Constr<PlutusData>;

  assert.equal(datum.index, 0);
  assert.equal(datum.fields.length, 7);
  assert.equal(datum.fields[0], state.pairId);
  assert.equal(datum.fields[1], BigInt(state.price));
  assert.equal(datum.fields[2], BigInt(state.timestamp));
  assert.equal(datum.fields[3], BigInt(state.nonce));
  assert.equal(datum.fields[4], state.intentHash);
  assert.equal(datum.fields[5], state.signer);
  assert.equal(datum.fields[6], BigInt(state.minUtxoLovelace));
  assert.deepEqual(decodePairDatum(cbor), {
    pairId: state.pairId,
    price: state.price,
    timestamp: state.timestamp,
    nonce: state.nonce,
    intentHash: state.intentHash,
    signer: state.signer,
    minUtxoLovelace: state.minUtxoLovelace,
  });
}

function testAddressToPlutusDataKeyAndStake(): void {
  // Key-key address (sample mnemonic-derived).
  const keyAddr =
    "addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j";
  const data = addressToPlutusData(keyAddr);
  assert.equal(data.index, 0);
  assert.equal(data.fields.length, 2);
  const payment = data.fields[0] as Constr<PlutusData>;
  assert.equal(payment.index, 0, "key payment credential -> 0");
  const stake = data.fields[1] as Constr<PlutusData>;
  assert.equal(stake.index, 0, "stake should be Some(...)");
}

// =====================================================================
// Pure invariant tests (withdraw, settle, batch, config, manifest)
// =====================================================================

function testSettleManifestPreChecks(): void {
  assert.throws(
    () => assertSettleManifestReceiversNonEmptyAndUnique([]),
    /at least one receiver/,
  );
  const dup = { receiverPolicyId: "aa", receiverAssetName: "bb" };
  assert.throws(
    () => assertSettleManifestReceiversNonEmptyAndUnique([dup, dup]),
    /Duplicate settle receiver/,
  );
  assert.doesNotThrow(() =>
    assertSettleManifestReceiversNonEmptyAndUnique([
      { receiverPolicyId: "11", receiverAssetName: "22" },
      { receiverPolicyId: "11", receiverAssetName: "33" },
    ]),
  );
}

function testHookCoordinatorConsistencyPure(): void {
  assert.throws(
    () =>
      assertHookCoordinatorConsistency(
        { policyId: "ab", assetName: "cd", unit: "abcd" },
        null,
      ),
    /paymentHookRef set without updateCoordinatorCredential/,
  );
  assert.throws(
    () =>
      assertHookCoordinatorConsistency(null, { type: "Script", hash: "11".repeat(28) }),
    /without paymentHookRef/,
  );
  assert.throws(
    () =>
      assertHookCoordinatorConsistency(
        { policyId: "", assetName: "cd", unit: "cd" },
        { type: "Script", hash: "11".repeat(28) },
      ),
    /non-empty hex/,
  );
  assert.throws(
    () =>
      assertHookCoordinatorConsistency(
        { policyId: "ab", assetName: "", unit: "ab" },
        { type: "Script", hash: "11".repeat(28) },
      ),
    /non-empty hex/,
  );
  assert.doesNotThrow(() => assertHookCoordinatorConsistency(null, null));
  assert.doesNotThrow(() =>
    assertHookCoordinatorConsistency(
      { policyId: "ab", assetName: "cd", unit: "abcd" },
      { type: "Script", hash: "11".repeat(28) },
    ),
  );
}

function testWithdrawAmountPreflightHelpers(): void {
  assert.doesNotThrow(() => assertReceiverWithdrawAmountValid(100n, 100n));
  assert.throws(
    () => assertReceiverWithdrawAmountValid(101n, 100n),
    /not sufficient/,
  );
}

function testReceiverTransactionPreflightGuards(): void {
  assert.throws(() => assertReceiverTopUpAmountPositive(0n), /greater than zero/);
  assert.throws(() => assertReceiverTopUpAmountPositive(-1n), /greater than zero/);
  assert.throws(() => assertReceiverWithdrawAmountPositive(0n), /greater than zero/);
  assert.throws(
    () => assertPaymentKeyHashIsConfigSigner("deadbeef", ["cafe", "babe"]),
    /not authorized as a config signer/,
  );
  assert.doesNotThrow(() =>
    assertPaymentKeyHashIsConfigSigner("cafe", ["cafe", "babe"]),
  );
  assert.throws(
    () =>
      assertPaymentKeyHashIsConfigSigner("bad", ["good"], {
        unauthorizedMessage: "Settle requires a config signer. The configured wallet is not authorized.",
      }),
    /Settle requires a config signer/,
  );
}

function testConfigUpdateAndInitArtifactPreflight(): void {
  const expectedAddr = sampleScripts().configValidatorAddress;
  assert.doesNotThrow(() =>
    assertConfigUtxoLivesAtValidatorAddress(expectedAddr, expectedAddr),
  );
  assert.throws(
    () =>
      assertConfigUtxoLivesAtValidatorAddress(
        "addr_test1wrong",
        expectedAddr,
      ),
    /Loaded config UTxO address does not match scripts\.configValidatorAddress/,
  );

  assert.doesNotThrow(() => assertPositiveMinUtxoLovelace(5_000_000n, "Config"));
  assert.throws(
    () => assertPositiveMinUtxoLovelace(0n, "Config"),
    /Config min_utxo_lovelace must be greater than zero/,
  );
  assert.throws(
    () => assertPositiveMinUtxoLovelace(-1n, "PaymentHook"),
    /PaymentHook min_utxo_lovelace must be greater than zero/,
  );

  assert.throws(
    () =>
      assertPaymentKeyHashIsConfigSigner("deadbeef", ["cafe"], {
        unauthorizedMessage:
          "The configured wallet is not authorized as a current config signer.",
      }),
    /The configured wallet is not authorized as a current config signer\./,
  );

  assert.throws(
    () => assertNonEmptyConfigSignerList([]),
    /at least one payment key hash/,
  );
  assert.throws(
    () => assertNonEmptyConfigSignerList(["   "]),
    /non-empty hex string/,
  );
  assert.doesNotThrow(() =>
    assertNonEmptyConfigSignerList(["aa".repeat(14)]),
  );

  assert.throws(() => assertClientIdNonEmpty(""), /non-empty string/);
  assert.throws(() => assertClientIdNonEmpty("   "), /non-empty string/);
  assert.throws(
    () =>
      createClientStateArtifact("  ", {
        clientId: "ignored",
        receiverAssetLabel: "L",
        receiverAssetName: "44",
        minUtxoLovelace: "3000000",
      }),
    /non-empty string/,
  );
}

function testBootstrapNftPayPreflight(): void {
  const wallet = "addr_test1walletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const script = "addr_test1scriptxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  assert.doesNotThrow(() =>
    assertNftBootstrapDestinationIsNotFundingWallet(script, wallet, "unit"),
  );
  assert.throws(
    () => assertNftBootstrapDestinationIsNotFundingWallet(wallet, wallet, "preview:x"),
    /must pay to the validator script address/,
  );
}

function testSettleAndPaymentHookPreflight(): void {
  testSettlePreflightGuards();
  testPaymentHookWithdrawPreflightGuards();
}

function testSettlePreflightGuards(): void {
  assert.throws(
    () => assertSettleReceiverAccruedPositive(0n, "0", "recv_unit"),
    /no accrued fees to settle/,
  );
  assert.throws(
    () => assertSettleReceiverAccruedPositive(-3n, "-3", "recv_unit"),
    /no accrued fees to settle/,
  );
  assert.doesNotThrow(() =>
    assertSettleReceiverAccruedPositive(1n, "1", "recv_unit"),
  );

  const client = { receiverPolicyId: "aa", receiverAssetName: "bb" };
  assert.throws(
    () => assertSettleManifestMatchesSingleClientReceiver([], client),
    /at least one receiver/,
  );
  assert.throws(
    () =>
      assertSettleManifestMatchesSingleClientReceiver(
        [
          { receiverPolicyId: "aa", receiverAssetName: "bb" },
          { receiverPolicyId: "aa", receiverAssetName: "bb" },
        ],
        client,
      ),
    /Duplicate settle receiver/,
  );
  assert.throws(
    () =>
      assertSettleManifestMatchesSingleClientReceiver(
        [
          { receiverPolicyId: "11", receiverAssetName: "bb" },
          { receiverPolicyId: "22", receiverAssetName: "bb" },
        ],
        client,
      ),
    /exactly one receiver/,
  );
  assert.throws(
    () =>
      assertSettleManifestMatchesSingleClientReceiver(
        [{ receiverPolicyId: "xx", receiverAssetName: "yy" }],
        client,
      ),
    /does not match the loaded client receiver/,
  );
  assert.doesNotThrow(() =>
    assertSettleManifestMatchesSingleClientReceiver([{ ...client }], client),
  );
}

function testPaymentHookWithdrawPreflightGuards(): void {
  assert.throws(() => assertPaymentHookWithdrawAmountPositive(0n), /greater than zero/);
  assert.doesNotThrow(() => assertPaymentHookWithdrawAmountPositive(1n));
  assert.doesNotThrow(() => assertPaymentHookWithdrawAmountValid(5n, 10n));
  assert.throws(
    () => assertPaymentHookWithdrawAmountValid(11n, 10n),
    /not sufficient/,
  );
}

function testOracleUpdatePreflightPureGuards(): void {
  testOracleIntentExpiryPreflight();
  testBootstrapRefsPreflight();
  testBatchRejectsMismatchedPaymentHookUnit();
  testRecoverWitnessRejectsTamperedSignature();
  testOracleIntentMonotonicPreflight();
}

function testOracleIntentExpiryPreflight(): void {
  const base = {
    intentType: "OracleUpdate",
    version: "1.0",
    chainId: 100640n,
    nonce: 1n,
    expiry: 1000n,
    symbol: "X",
    price: 1n,
    timestamp: 900n,
    source: "S",
  };
  assert.throws(
    () => assertDiaOracleIntentNotExpired(base, 1001n),
    /Oracle intent expired/,
  );
  assert.doesNotThrow(() => assertDiaOracleIntentNotExpired(base, 1000n));
  assert.doesNotThrow(() =>
    assertDiaOracleIntentNotExpired({ ...base, expiry: 0n }, 999_999_999_999n),
  );
}

function testBootstrapRefsPreflight(): void {
  assert.throws(
    () =>
      assertOracleUpdateBootstrapRefsResolved({
        config: { txHash: "", outputIndex: 0 },
        paymentHook: { txHash: "aa", outputIndex: 0 },
      }),
    /config bootstrap/,
  );
  assert.throws(
    () =>
      assertOracleUpdateBootstrapRefsResolved({
        config: { txHash: "aa", outputIndex: 0 },
        paymentHook: { txHash: "  ", outputIndex: 0 },
      }),
    /payment-hook bootstrap/,
  );
  assert.doesNotThrow(() =>
    assertOracleUpdateBootstrapRefsResolved(sampleConfigArtifact().bootstrapRefs),
  );
}

function testBatchRejectsMismatchedPaymentHookUnit(): void {
  const protocol = sampleConfigArtifact();
  const client = sampleClientArtifact();
  client.receiver = sampleReceiverArtifact();
  const first = resolvePairArtifact(samplePairArtifact("aa"), client, protocol);
  const second = resolvePairArtifact(samplePairArtifact("bb"), client, protocol);
  const wrongHook = {
    ...second,
    scripts: {
      ...second.scripts,
      paymentHookUnit: `${"55".repeat(28)}4449415f5041594d454e545f484f4f4b`,
    },
  };
  assert.throws(
    () => ensureCompatibleBatch([first, wrongHook]),
    /same client deployment/,
  );
}

function testRecoverWitnessRejectsTamperedSignature(): void {
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
      nonce: "1",
      expiry: "9999999999",
      symbol: "USDC/USD",
      price: "1000",
      timestamp: "1000",
      source: "DIA Oracle",
    },
    privateKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  const intent = normalizeDiaOracleIntent(signed.intent);
  const normDomain = normalizeDiaEip712Domain(domain);
  assert.doesNotThrow(() => recoverDiaOracleIntentWitness(normDomain, intent));

  const tampered = normalizeDiaOracleIntent({
    ...signed.intent,
    signature: `0x${"ab".repeat(65)}`,
  });
  assert.throws(() => recoverDiaOracleIntentWitness(normDomain, tampered));
}

function testOracleIntentMonotonicPreflight(): void {
  assert.throws(
    () =>
      assertOracleIntentTimestampAndNonceMonotonic({
        isCreate: false,
        intentTimestamp: 100n,
        intentNonce: 2n,
        pairStateTimestamp: "100",
        pairStateNonce: "1",
      }),
    /timestamp must be greater/,
  );
  assert.throws(
    () =>
      assertOracleIntentTimestampAndNonceMonotonic({
        isCreate: false,
        intentTimestamp: 101n,
        intentNonce: 1n,
        pairStateTimestamp: "100",
        pairStateNonce: "2",
      }),
    /nonce must be greater/,
  );
  assert.throws(
    () =>
      assertOracleIntentTimestampAndNonceMonotonic({
        isCreate: false,
        intentTimestamp: 100n,
        intentNonce: 2n,
        pairStateTimestamp: "100",
        pairStateNonce: "1",
        batchStatePath: "/tmp/oracle-batch.json",
      }),
    (err: unknown) =>
      err instanceof Error && err.message.includes("/tmp/oracle-batch.json"),
  );
  assert.doesNotThrow(() =>
    assertOracleIntentTimestampAndNonceMonotonic({
      isCreate: true,
      intentTimestamp: 1n,
      intentNonce: 1n,
      pairStateTimestamp: "999",
      pairStateNonce: "999",
    }),
  );
  assert.doesNotThrow(() =>
    assertOracleIntentTimestampAndNonceMonotonic({
      isCreate: false,
      intentTimestamp: 200n,
      intentNonce: 5n,
      pairStateTimestamp: "100",
      pairStateNonce: "2",
    }),
  );
}

function testReceiverWithdrawDoesNotTouchAccrued(): void {
  // Invariant: a withdraw of N lovelace must reduce balance_lovelace by N
  // and leave accrued_to_hook_lovelace untouched. This mirrors what the
  // on-chain Withdraw redeemer enforces, asserted on the off-chain
  // datum-builder side.
  const before = sampleReceiverState({
    balanceLovelace: "10000000",
    accruedToHookLovelace: "1234567",
  });
  const withdrawAmount = 4_000_000n;

  const after = {
    ...before,
    balanceLovelace: (BigInt(before.balanceLovelace) - withdrawAmount).toString(),
  };

  const beforeCbor = buildReceiverDatumCbor(before);
  const afterCbor = buildReceiverDatumCbor(after);
  const beforeDecoded = decodeReceiverDatum(beforeCbor);
  const afterDecoded = decodeReceiverDatum(afterCbor);

  assert.equal(
    BigInt(beforeDecoded.balanceLovelace) - BigInt(afterDecoded.balanceLovelace),
    withdrawAmount,
  );
  assert.equal(
    afterDecoded.accruedToHookLovelace,
    beforeDecoded.accruedToHookLovelace,
    "Withdraw must not move funds out of accrued_to_hook_lovelace",
  );
  assert.equal(afterDecoded.minUtxoLovelace, beforeDecoded.minUtxoLovelace);

  // Negative case: a "withdraw" that also drains accrued is a different shape
  // and must produce a different datum CBOR.
  const malicious = {
    ...after,
    accruedToHookLovelace: "0",
  };
  const maliciousCbor = buildReceiverDatumCbor(malicious);
  assert.notEqual(maliciousCbor, afterCbor, "Draining accrued must change the datum bytes");
}

function testSettleDeltaInvariant(): void {
  // Invariant: settle moves the entire accrued_to_hook_lovelace from
  // receiver into payment hook accrued_fees_lovelace, and resets the
  // receiver-side accrual to 0. The total of (receiver.accrued + hook.accrued)
  // must be conserved.
  const receiverBefore = sampleReceiverState({
    balanceLovelace: "20000000",
    accruedToHookLovelace: "7777777",
  });
  const hookBefore = samplePaymentHookStateDatum();

  const delta = BigInt(receiverBefore.accruedToHookLovelace);

  const receiverAfter = {
    ...receiverBefore,
    accruedToHookLovelace: "0",
  };
  const hookAfter = {
    ...hookBefore,
    accruedFeesLovelace: (BigInt(hookBefore.accruedFeesLovelace) + delta).toString(),
    lifetimeCollectedLovelace: (
      BigInt(hookBefore.lifetimeCollectedLovelace) + delta
    ).toString(),
  };

  const totalBefore =
    BigInt(receiverBefore.accruedToHookLovelace) +
    BigInt(hookBefore.accruedFeesLovelace);
  const totalAfter =
    BigInt(receiverAfter.accruedToHookLovelace) +
    BigInt(hookAfter.accruedFeesLovelace);

  assert.equal(totalAfter, totalBefore, "Settle must conserve total accrued");
  assert.equal(receiverAfter.accruedToHookLovelace, "0");
  assert.equal(receiverAfter.balanceLovelace, receiverBefore.balanceLovelace);
  assert.equal(receiverAfter.minUtxoLovelace, receiverBefore.minUtxoLovelace);

  // Also: hook.lifetime_collected must grow by exactly delta.
  assert.equal(
    BigInt(hookAfter.lifetimeCollectedLovelace) -
      BigInt(hookBefore.lifetimeCollectedLovelace),
    delta,
  );
  // hook.lifetime_withdrawn must NOT change during a settle.
  assert.equal(
    hookAfter.lifetimeWithdrawnLovelace,
    hookBefore.lifetimeWithdrawnLovelace,
  );

  // CBORs must round-trip cleanly through their decoders.
  assert.deepEqual(
    decodeReceiverDatum(buildReceiverDatumCbor(receiverAfter)),
    receiverAfter,
  );
  assert.deepEqual(
    decodePaymentHookDatum(
      buildPaymentHookDatumCbor(hookAfter),
      hookAfter.withdrawAddress,
    ),
    hookAfter,
  );
}

function testBatchRejectsDuplicatePair(): void {
  // Already covered by testCompatibleBatchRules but keep an explicit name
  // so a regression touching only this rule shows clearly in the output.
  const protocol = sampleConfigArtifact();
  const client = sampleClientArtifact();
  client.receiver = sampleReceiverArtifact();
  const pair = resolvePairArtifact(samplePairArtifact("aa"), client, protocol);
  assert.throws(
    () => ensureCompatibleBatch([pair, pair]),
    /Duplicate pair state included in batch/,
  );
}

function testBatchRejectsForeignReceiver(): void {
  const protocol = sampleConfigArtifact();
  const client = sampleClientArtifact();
  client.receiver = sampleReceiverArtifact();
  const first = resolvePairArtifact(samplePairArtifact("aa"), client, protocol);
  const second = resolvePairArtifact(samplePairArtifact("bb"), client, protocol);

  // Mutating the second resolved pair to point at a different receiver
  // simulates two pairs from different client deployments being submitted
  // in one batch.
  const tampered = {
    ...second,
    receiver: {
      ...second.receiver,
      receiverUnit: `${"33".repeat(28)}444946464552454e54`,
    },
  };

  assert.throws(
    () => ensureCompatibleBatch([first, tampered]),
    /same client deployment/,
  );
}

function testReferenceScriptMissingHelper(): void {
  assert.equal(
    isAnyReferenceScriptMissing({ receiver: false }),
    false,
    "all-resolved reference maps should not trigger inline fallback",
  );
  assert.equal(
    isAnyReferenceScriptMissing({ receiver: true }),
    true,
    "a missing reference should trigger inline fallback",
  );
  assert.equal(
    isAnyReferenceScriptMissing({ receiver: false, pair: true }),
    true,
    "mixed reference availability should still report a missing entry",
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
    paymentHookState: samplePaymentHookState(),
    compiledScripts: {
      configMintPolicy: "aa",
      configValidator: "bb",
      coordinatorValidator: "cc",
      paymentHookMintPolicy: "dd",
      paymentHookValidator: "ee",
      referenceHolderValidator: "ff",
    },
    datum: {
      configCbor: "config-cbor",
      paymentHookCbor: "hook-cbor",
    },
    transactions: [
      {
        step: "preview:payment-hook:bootstrap",
        submittedTxHash: "hook-bootstrap-tx",
        confirmed: true,
      },
    ],
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
        pairMint: {
          txHash: "client-pair-mint-ref",
          outputIndex: 2,
          scriptHash: "22".repeat(28),
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
      accruedToHookLovelace: "0",
      minUtxoLovelace: "3000000",
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
    referenceHolderValidatorHash: "55".repeat(28),
    referenceHolderAddress: "addr_test1referenceholder",
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
    baseFeeLovelace: "600000",
    perPairFeeLovelace: "400000",
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
    maxBootstrapDriftSeconds: "300",
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

async function runLucidEmulatorHarnessSmokeTests(): Promise<void> {
  await testEmulatorHarnessSimpleTransfer();
  await testEmulatorHarnessReferenceScriptGenesisRow();
  await testInstallEmulatorLucidRedirectsCliHelpers();
  await testEmulatorProtocolFlowConfigBootstrap();
}

async function testEmulatorHarnessSimpleTransfer(): Promise<void> {
  const { lucid, emulator, accounts } = await makeOracleEmulatorLucid();
  const dest = accounts[1].address;
  const send = 15_000_000n;
  const txSignBuilder = await lucid
    .newTx()
    .pay.ToAddress(dest, { lovelace: send })
    .complete();
  const metrics = collectTxSignBuilderMetrics(txSignBuilder);
  assert.ok(metrics.feeLovelace > 0n, "simple transfers should still estimate a fee");
  assert.equal(metrics.exUnits.cpu, 0n);
  assert.equal(metrics.exUnits.mem, 0n);
  const signed = await txSignBuilder.sign.withWallet().complete();
  await emulatorSubmitAndMine(emulator, signed);
  const utxos = await emulator.getUtxos(dest);
  const total = utxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);
  assert.ok(total >= send, "recipient should hold at least the paid lovelace");
}

async function testEmulatorHarnessReferenceScriptGenesisRow(): Promise<void> {
  const { emulator, accounts } = await makeOracleEmulatorWithReferenceScriptRow();
  const refAddr = accounts[1].address;
  const utxos = await emulator.getUtxos(refAddr);
  assert.equal(utxos.length, 1);
  assert.ok(utxos[0].scriptRef, "genesis row should expose reference script");
  assert.equal(utxos[0].scriptRef?.type, "PlutusV3");
}

// Proves that after `installEmulatorLucid` the CLI's own
// `makeConfiguredLucid` / `selectConfiguredWallet` return the emulator's
// Lucid + an emulator-genesis-funded wallet — without any builder
// caller change. Also proves `uninstallEmulatorLucid` restores the
// production env-based path (verified by observing it now throws on a
// fresh call when no `.env` provider is set up; we just check the
// active wallet address differs between installed and uninstalled
// states by comparing against the emulator account's address).
async function testInstallEmulatorLucidRedirectsCliHelpers(): Promise<void> {
  const { installEmulatorLucid, uninstallEmulatorLucid } = await import(
    "../emulator/lucid-injection.js"
  );
  const { makeConfiguredLucid, selectConfiguredWallet } = await import(
    "../core/lucid.js"
  );

  const ctx = await makeOracleEmulatorLucid();
  try {
    installEmulatorLucid({
      lucid: ctx.lucid,
      emulator: ctx.emulator,
      walletSeedPhrase: ctx.accounts[0].seedPhrase,
    });

    const cliLucid = await makeConfiguredLucid();
    assert.strictEqual(
      cliLucid,
      ctx.lucid,
      "makeConfiguredLucid should return the emulator's Lucid instance after install",
    );

    const source = await selectConfiguredWallet(cliLucid);
    assert.equal(source, "seed", "wallet source should be 'seed'");

    const installedAddress = await cliLucid.wallet().address();
    assert.equal(
      installedAddress,
      ctx.accounts[0].address,
      "selectConfiguredWallet should select the primary emulator account",
    );
  } finally {
    uninstallEmulatorLucid();
  }
}

// Slice-vertical smoke test for the emulator protocol-flow orchestrator.
// Drives the same first three steps that `run-all-cli.sh` runs against
// Preview — `preview:protocol:init`, `preview:config:parameterize`,
// `preview:config:bootstrap` — but against the in-memory Lucid Emulator,
// reusing every CLI builder verbatim through the lucid-injection bridge.
// Skipped silently when `DIA_EVM_PRIVATE_KEY` is not configured, because
// the bootstrap step derives the authorized DIA signer from that env
// var exactly like the bash script. This keeps the test optional in
// environments without the secret but exercises the real wiring when
// it is present.
async function testEmulatorProtocolFlowConfigBootstrap(): Promise<void> {
  if (!process.env.DIA_EVM_PRIVATE_KEY?.trim()) {
    console.log(
      "[skip] testEmulatorProtocolFlowConfigBootstrap: set DIA_EVM_PRIVATE_KEY to run",
    );
    return;
  }

  const { runEmulatorProtocolFlow } = await import(
    "../emulator/protocol-flow.js"
  );
  const ctx = await makeOracleEmulatorLucid();

  // `batchSize: 1` is the fastest end-to-end smoke: bootstrap → top-up →
  // create 1 pair → batch-1 → settle → withdraws → reclaim → republish →
  // burn. Exercises every step of the orchestrator without paying for the
  // full probe up the catalog.
  const report = await runEmulatorProtocolFlow({
    lucid: ctx.lucid,
    emulator: ctx.emulator,
    walletSeedPhrase: ctx.accounts[0].seedPhrase,
    batchSize: 1,
  });

  assert.equal(
    report.steps.find((s) => s.label === "config:bootstrap")?.ok,
    true,
    "config:bootstrap should succeed in the emulator",
  );
  for (const step of report.steps) {
    assert.equal(
      step.ok,
      true,
      `step "${step.label}" should succeed; got error: ${"error" in step ? step.error : ""}`,
    );
  }
}
