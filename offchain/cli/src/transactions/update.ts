import { access, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { confirm } from "@inquirer/prompts";
import {
  Constr,
  getAddressDetails,
  type OutRef,
  type UTxO,
} from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeCoordinatorValidator,
  makePairStateMintingPolicy,
  makePairStateValidator,
  makePaymentHookValidator,
  makeReceiverValidator,
  mintingPolicyFromCompiledScript,
  spendingValidatorFromCompiledScript,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  withdrawalValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  diaIntentToState,
  diaIntentTokenNameFromSymbol,
  diaPairIdHex,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  normalizeHex,
  recoverDiaOracleIntentWitness,
  type DiaOracleIntent,
  type DiaOracleIntentInput,
} from "../core/dia-intent.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  readPairState,
  type PaymentHookState,
  type ReceiverState,
  type PairStateArtifact,
} from "../core/state.js";
import { loadReferenceScriptUtxos } from "../core/reference-scripts.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  decodePaymentHookDatum,
  decodeReceiverDatum,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";

export async function submitOracleUpdate(args: {
  intentPath: string;
  statePath: string;
  clientStatePath: string;
  protocolStatePath: string;
  minUtxoLovelace?: string;
  buildOnly: boolean;
}): Promise<PairStateArtifact> {
  reportProgress(`Loading signed intent from ${path.resolve(args.intentPath)}`);
  const input = await readSignedIntentInput(path.resolve(args.intentPath));
  const intent = normalizeDiaOracleIntent(input);

  const statePath = path.resolve(args.statePath);
  reportProgress(`Loading client and protocol state`);
  const { client, protocol } = await readClientContext({
    clientStatePath: args.clientStatePath,
    protocolStatePath: args.protocolStatePath,
  });
  if (!client.receiver) {
    throw new Error("Oracle update requires client state after Receiver bootstrap.");
  }
  if (!client.scripts.pairPolicyId || !client.scripts.pairValidatorHash || !client.scripts.pairValidatorAddress) {
    throw new Error("Oracle update requires client state after Receiver/Pair parameterization.");
  }
  let existingPair = await readOptionalPairState(statePath);
  if (
    existingPair &&
    existingPair.pair.pairValidatorAddress !== client.scripts.pairValidatorAddress
  ) {
    reportProgress(
      `Pair state file ${statePath} is from a different deployment. If you continue, the file will be deleted and recreated from the signed intent.`,
    );
    reportProgress(
      `  state file pair address: ${existingPair.pair.pairValidatorAddress}`,
    );
    reportProgress(
      `  current deployment    : ${client.scripts.pairValidatorAddress}`,
    );
    const proceed = await confirm({
      message:
        "Delete the stale pair state file and continue (the next update will mint a new Pair NFT and create the Pair UTxO from the signed intent)?",
      default: true,
    });
    if (!proceed) {
      throw new Error("Aborted by user. Stale pair state file was kept.");
    }
    await unlink(statePath);
    reportProgress(`Removed stale pair state file ${statePath}`);
    existingPair = null;
  }
  const configAssetName = splitUnit(protocol.scripts.configUnit).assetName;
  const pairMintPolicy = client.compiledScripts?.pairMintPolicy
    ? mintingPolicyFromCompiledScript(client.compiledScripts.pairMintPolicy)
    : await makePairStateMintingPolicy({
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
        receiverHash: client.receiver.receiverValidatorHash,
      });
  const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
  const pairTokenName = diaIntentTokenNameFromSymbol(intent);
  const pairUnit = `${pairPolicyId}${pairTokenName}`;
  const pairValidator = client.compiledScripts?.pairValidator
    ? spendingValidatorFromCompiledScript(client.compiledScripts.pairValidator)
    : await makePairStateValidator({
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
        receiverHash: client.receiver.receiverValidatorHash,
      });
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);
  const pairId = diaPairIdHex(intent);
  const isCreate = !existingPair;
  const minUtxoLovelace = existingPair?.pairState.minUtxoLovelace ??
    args.minUtxoLovelace;
  if (!minUtxoLovelace) {
    throw new Error(
      "Creating a new pair requires --min-utxo-lovelace because no pair artifact exists yet.",
    );
  }
  const pair: PairStateArtifact = existingPair ?? {
    wallet: {
      source: "seed",
      address: "",
    },
    pair: {
      tokenName: pairTokenName,
      pairId,
      pairUnit,
      pairValidatorAddress,
      stateUtxo: {
        txHash: "",
        outputIndex: 0,
      },
    },
    pairState: {
      pairId,
      price: "0",
      timestamp: "0",
      nonce: "0",
      intentHash: "00".repeat(32),
      signer: "00".repeat(20),
      minUtxoLovelace,
      intent: diaIntentToState(intent),
    },
    datum: {
      pairCbor: "",
    },
  };
  const state = {
    ...pair,
    bootstrapRefs: protocol.bootstrapRefs,
    scripts: {
      ...protocol.scripts,
      ...client.scripts,
    },
    configState: protocol.configState,
    configUtxo: protocol.configUtxo,
    paymentHookState: protocol.paymentHookState!,
    paymentHookUtxo: protocol.paymentHookUtxo!,
    compiledScripts: {
      ...protocol.compiledScripts,
      ...client.compiledScripts,
    },
    referenceScripts: {
      ...protocol.referenceScripts,
      ...client.referenceScripts,
    },
    receiver: client.receiver,
    datum: {
      configCbor: protocol.datum.configCbor,
      paymentHookCbor: protocol.datum.paymentHookCbor,
      receiverCbor: client.datum.receiverCbor,
      pairCbor: pair.datum.pairCbor,
    },
  };

  if (!state.bootstrapRefs.paymentHook?.txHash) {
    throw new Error("Pair state artifact is missing the selected PaymentHook bootstrap reference.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const { utxos: referenceScriptUtxos, missing: missingReferenceScripts } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "coordinator",
          label: "coordinator",
          outRef: state.referenceScripts?.global?.coordinator
            ? {
                txHash: state.referenceScripts.global.coordinator.txHash,
                outputIndex: state.referenceScripts.global.coordinator.outputIndex,
              }
            : null,
        },
        {
          key: "paymentHook",
          label: "payment hook",
          outRef: state.referenceScripts?.global?.paymentHook
            ? {
                txHash: state.referenceScripts.global.paymentHook.txHash,
                outputIndex: state.referenceScripts.global.paymentHook.outputIndex,
              }
            : null,
        },
        {
          key: "receiver",
          label: "receiver",
          outRef: state.referenceScripts?.client?.receiver
            ? {
                txHash: state.referenceScripts.client.receiver.txHash,
                outputIndex: state.referenceScripts.client.receiver.outputIndex,
              }
            : null,
        },
        {
          key: "pair",
          label: "pair",
          outRef: state.referenceScripts?.client?.pair
            ? {
                txHash: state.referenceScripts.client.pair.txHash,
                outputIndex: state.referenceScripts.client.pair.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    state.scripts.configUnit,
    "config",
  );
  const currentPairUtxo = isCreate
    ? null
    : await findSingleUtxoAtUnit(
        lucid,
        state.pair.pairValidatorAddress,
        state.pair.pairUnit,
        "pair",
      );
  const currentPaymentHookUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.paymentHookValidatorAddress!,
    state.scripts.paymentHookUnit!,
    "payment hook",
  );
  const currentReceiverUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.receiver.receiverValidatorAddress,
    state.receiver.receiverUnit,
    "receiver",
  );
  const currentPaymentHookState = decodePaymentHookDatum(
    requireInlineDatum(currentPaymentHookUtxo, "payment hook"),
    state.paymentHookState.withdrawAddress,
  );
  const currentReceiverState = decodeReceiverDatum(
    requireInlineDatum(currentReceiverUtxo, "receiver"),
  );
  const walletFundingUtxo = selectFundingUtxo(walletUtxos, [
    state.bootstrapRefs.config,
    state.bootstrapRefs.paymentHook,
  ]);
  if (!walletFundingUtxo) {
    throw new Error("No suitable wallet UTxO is available to cover update fees and collateral.");
  }

  if (pairValidatorHash !== state.scripts.pairValidatorHash) {
    throw new Error("Pair validator hash does not match the current blueprint.");
  }

  const paymentHookValidator = state.compiledScripts?.paymentHookValidator
    ? spendingValidatorFromCompiledScript(state.compiledScripts.paymentHookValidator)
    : await makePaymentHookValidator({
        bootstrapOutRef: state.bootstrapRefs.paymentHook as OutRef,
        assetName: splitUnit(state.scripts.paymentHookUnit!).assetName,
        configPolicyId: state.scripts.configPolicyId,
        configAssetName,
        coordinatorCredentialHash: state.scripts.coordinatorHash,
      });
  const paymentHookValidatorHash = scriptHashFromValidator(paymentHookValidator);
  if (paymentHookValidatorHash !== state.scripts.paymentHookValidatorHash) {
    throw new Error("Payment hook validator hash does not match the current blueprint.");
  }

  const coordinatorValidator = state.compiledScripts?.coordinatorValidator
    ? withdrawalValidatorFromCompiledScript(state.compiledScripts.coordinatorValidator)
    : await makeCoordinatorValidator({
        configPolicyId: state.scripts.configPolicyId,
        configAssetName,
      });
  const receiverValidator = state.compiledScripts?.receiverValidator
    ? spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator)
    : await makeReceiverValidator({
        bootstrapOutRef: state.receiver.bootstrapRef,
        assetName: state.receiver.receiverAssetName,
        configPolicyId: state.scripts.configPolicyId,
        configAssetName,
      });
  const receiverValidatorHash = scriptHashFromValidator(receiverValidator);
  if (receiverValidatorHash !== state.receiver.receiverValidatorHash) {
    throw new Error("Receiver validator hash does not match the current blueprint.");
  }

  const domain = normalizeDiaEip712Domain({
    name: state.configState.domain.name,
    version: state.configState.domain.version,
    sourceChainId: state.configState.domain.sourceChainId,
    verifyingContract: state.configState.domain.verifyingContract,
  });
  const witness = recoverDiaOracleIntentWitness(domain, intent);
  if (!state.configState.authorizedDiaPublicKeys.includes(witness.signerPublicKey)) {
    throw new Error(
      "The recovered DIA signer public key is not authorized in the provided config state.",
    );
  }

  if (normalizeHex(state.pair.pairId, "pair.pairId") !== normalizeHex(pairId, "intent.symbol")) {
    throw new Error(`Intent symbol ${intent.symbol} does not match pair id ${state.pair.pairId}.`);
  }

  if (!isCreate && BigInt(intent.timestamp) <= BigInt(state.pairState.timestamp)) {
    throw new Error("Oracle intent timestamp must be greater than the current timestamp.");
  }
  if (!isCreate && BigInt(intent.nonce) <= BigInt(state.pairState.nonce)) {
    throw new Error("Oracle intent nonce must be greater than the current nonce.");
  }

  const nextPairState = {
    ...state.pairState,
    price: intent.price.toString(),
    timestamp: intent.timestamp.toString(),
    nonce: intent.nonce.toString(),
    intentHash: witness.intentHash,
    signer: intent.signer,
    intent: diaIntentToState(intent),
  };
  const nextPaymentHookState = {
    ...currentPaymentHookState,
    accruedFeesLovelace: (
      BigInt(currentPaymentHookState.accruedFeesLovelace) +
      BigInt(state.configState.protocolFeeLovelace)
    ).toString(),
    lifetimeCollectedLovelace: (
      BigInt(currentPaymentHookState.lifetimeCollectedLovelace) +
      BigInt(state.configState.protocolFeeLovelace)
    ).toString(),
  };
  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) -
      BigInt(state.configState.protocolFeeLovelace)
    ).toString(),
  };
  if (BigInt(nextReceiverState.balanceLovelace) < 0n) {
    throw new Error("Receiver balance is not sufficient to pay the protocol fee.");
  }

  const pairRedeemer = Data.to(new Constr(0, []));
  const pairMintRedeemer = Data.to(new Constr<PlutusData>(0, []));
  const paymentHookRedeemer = Data.to(new Constr(0, []));
  const receiverRedeemer = Data.to(new Constr(1, []));
  const coordinatorRedeemer = Data.to(
    new Constr<PlutusData>(0, [
      updateWitnessData(
        intent,
        state.receiver.receiverPolicyId,
        state.receiver.receiverAssetName,
        splitUnit(state.pair.pairUnit).policyId,
        state.pair.tokenName,
        witness.signerPublicKey,
      ),
    ]),
  );
  const nextPairDatumCbor = buildPairDatumCbor(nextPairState);
  const nextPaymentHookDatumCbor = buildPaymentHookDatumCbor(nextPaymentHookState);
  const nextReceiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);

  reportProgress("Building Preview oracle update transaction");
  let txBuilder = lucid
    .newTx()
    .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
    .collectFrom([currentReceiverUtxo], receiverRedeemer)
    .collectFrom([currentPaymentHookUtxo], paymentHookRedeemer)
    .collectFrom([walletFundingUtxo])
    .withdraw(state.scripts.coordinatorRewardAddress, 0n, coordinatorRedeemer)
    .pay.ToContract(
      state.pair.pairValidatorAddress,
      { kind: "inline", value: nextPairDatumCbor },
      {
        lovelace: BigInt(nextPairState.minUtxoLovelace),
        [state.pair.pairUnit]: 1n,
      },
    )
    .pay.ToContract(
      state.receiver.receiverValidatorAddress,
      { kind: "inline", value: nextReceiverDatumCbor },
      {
        lovelace:
          BigInt(nextReceiverState.minUtxoLovelace) +
          BigInt(nextReceiverState.balanceLovelace),
        [state.receiver.receiverUnit]: 1n,
      },
    )
    .pay.ToContract(
      state.scripts.paymentHookValidatorAddress!,
      { kind: "inline", value: nextPaymentHookDatumCbor },
      {
        lovelace:
          BigInt(nextPaymentHookState.minUtxoLovelace) +
          BigInt(nextPaymentHookState.accruedFeesLovelace),
        [state.scripts.paymentHookUnit!]: 1n,
      },
    );

  if (isCreate) {
    txBuilder = txBuilder
      .attach.MintingPolicy(pairMintPolicy)
      .mintAssets({ [state.pair.pairUnit]: 1n }, pairMintRedeemer);
  } else {
    txBuilder = txBuilder.collectFrom([currentPairUtxo!], pairRedeemer);
  }

  if (missingReferenceScripts.receiver) {
    reportProgress("Reference script for receiver is missing on-chain; attaching the receiver validator inline.");
    txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
  }
  if (missingReferenceScripts.paymentHook) {
    reportProgress("Reference script for payment hook is missing on-chain; attaching the payment hook validator inline.");
    txBuilder = txBuilder.attach.SpendingValidator(paymentHookValidator);
  }
  if (missingReferenceScripts.coordinator) {
    reportProgress("Reference script for coordinator is missing on-chain; attaching the coordinator validator inline.");
    txBuilder = txBuilder.attach.WithdrawalValidator(coordinatorValidator);
  }
  if (!isCreate && missingReferenceScripts.pair) {
    reportProgress("Reference script for pair is missing on-chain; attaching the pair validator inline.");
    txBuilder = txBuilder
      .attach.SpendingValidator(pairValidator);
  }

  const txSignBuilder = await txBuilder.complete();
  const unsignedHash = txSignBuilder.toHash();
  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(`Unsigned transaction ready: ${unsignedHash}`);
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await lucid.awaitTx(submittedTxHash, 3_000);
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      spentUtxos: [walletFundingUtxo],
      label: "oracle update",
    });
  }

  const latestPairUtxo =
    args.buildOnly || !confirmed
      ? state.pair.stateUtxo
      : await waitForUnitUtxoReplacement({
          lucid,
          address: state.pair.pairValidatorAddress,
          unit: state.pair.pairUnit,
          label: "pair",
          previousOutRef: currentPairUtxo ?? undefined,
        });
  const latestPaymentHookUtxo =
    args.buildOnly || !confirmed
      ? state.paymentHookUtxo.current
      : await waitForUnitUtxoReplacement({
          lucid,
          address: state.scripts.paymentHookValidatorAddress!,
          unit: state.scripts.paymentHookUnit!,
          label: "payment hook",
          previousOutRef: currentPaymentHookUtxo,
        });
  const latestReceiverUtxo =
    args.buildOnly || !confirmed
      ? state.receiver.receiverUtxo.current
      : await waitForUnitUtxoReplacement({
          lucid,
          address: state.receiver.receiverValidatorAddress,
          unit: state.receiver.receiverUnit,
          label: "receiver",
          previousOutRef: currentReceiverUtxo,
        });

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    pair: {
      ...state.pair,
      stateUtxo: {
        txHash: latestPairUtxo.txHash,
        outputIndex: latestPairUtxo.outputIndex,
      },
    },
    pairState: nextPairState,
    datum: {
      pairCbor: nextPairDatumCbor,
    },
    transactions: appendTransactionRecord(state.transactions, {
      step: "preview:update",
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:update] ${message}`);
}

async function readSignedIntentInput(inputPath: string): Promise<DiaOracleIntentInput> {
  const raw = JSON.parse(await readFile(inputPath, "utf8")) as
    | DiaOracleIntentInput
    | { intent: DiaOracleIntentInput };
  return "intent" in raw ? raw.intent : raw;
}

async function readOptionalPairState(
  statePath: string,
): Promise<PairStateArtifact | null> {
  try {
    await access(statePath);
  } catch {
    return null;
  }
  return readPairState(statePath);
}

function buildPairDatumCbor(state: PairStateArtifact["pairState"]): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      state.pairId,
      BigInt(state.price),
      BigInt(state.timestamp),
      BigInt(state.nonce),
      normalizeHex(state.intentHash, "intentHash"),
      normalizeHex(state.signer, "signer"),
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

function buildPaymentHookDatumCbor(
  state: PaymentHookState,
): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      addressToPlutusData(state.withdrawAddress),
      BigInt(state.accruedFeesLovelace),
      BigInt(state.lifetimeCollectedLovelace),
      BigInt(state.lifetimeWithdrawnLovelace),
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

function buildReceiverDatumCbor(state: ReceiverState): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      BigInt(state.balanceLovelace),
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

function addressToPlutusData(address: string): Constr<PlutusData> {
  const details = getAddressDetails(address);
  if (!details.paymentCredential) {
    throw new Error("withdrawAddress must contain a payment credential.");
  }

  const paymentCredential =
    details.paymentCredential.type === "Key"
      ? new Constr<PlutusData>(0, [details.paymentCredential.hash])
      : new Constr<PlutusData>(1, [details.paymentCredential.hash]);

  const stakeCredential = details.stakeCredential
    ? new Constr<PlutusData>(0, [
        new Constr<PlutusData>(0, [
          details.stakeCredential.type === "Key"
            ? new Constr<PlutusData>(0, [details.stakeCredential.hash])
            : new Constr<PlutusData>(1, [details.stakeCredential.hash]),
        ]),
      ])
    : new Constr<PlutusData>(1, []);

  return new Constr<PlutusData>(0, [paymentCredential, stakeCredential]);
}

function updateWitnessData(
  intent: DiaOracleIntent,
  receiverPolicyId: string,
  receiverAssetName: string,
  pairPolicyId: string,
  pairTokenName: string,
  signerPublicKey: string,
): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    normalizeHex(receiverPolicyId, "receiverPolicyId"),
    normalizeHex(receiverAssetName, "receiverAssetName"),
    normalizeHex(pairPolicyId, "pairPolicyId"),
    pairTokenName,
    diaIntentData(intent),
    normalizeHex(signerPublicKey, "signerPublicKey"),
  ]);
}

function diaIntentData(intent: DiaOracleIntent): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    Buffer.from(intent.intentType, "utf8").toString("hex"),
    Buffer.from(intent.version, "utf8").toString("hex"),
    intent.chainId,
    intent.nonce,
    intent.expiry,
    Buffer.from(intent.symbol, "utf8").toString("hex"),
    intent.price,
    intent.timestamp,
    Buffer.from(intent.source, "utf8").toString("hex"),
    normalizeHex(intent.signature, "intent.signature"),
    normalizeHex(intent.signer, "intent.signer"),
  ]);
}

async function findSingleUtxoAtUnit(
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>,
  address: string,
  unit: string,
  label: string,
): Promise<UTxO> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const utxos = await lucid.utxosAtWithUnit(address, unit);
    if (utxos.length === 1) {
      return utxos[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(`Unable to observe a single ${label} UTxO at ${address} with unit ${unit}.`);
}

function splitUnit(unit: string): { policyId: string; assetName: string } {
  const normalizedUnit = normalizeHex(unit, "unit");
  return {
    policyId: normalizedUnit.slice(0, 56),
    assetName: normalizedUnit.slice(56),
  };
}

function selectFundingUtxo(
  utxos: UTxO[],
  excludedOutRefs: Array<{
    txHash: string;
    outputIndex: number;
  }>,
): UTxO | null {
  return (
    utxos
      .filter(
        (utxo) =>
          !excludedOutRefs.some(
            (outRef) =>
              utxo.txHash === outRef.txHash && utxo.outputIndex === outRef.outputIndex,
          ),
      )
      .filter((utxo) => Object.keys(utxo.assets).length === 1)
      .sort((left, right) => {
        const leftValue = left.assets.lovelace ?? 0n;
        const rightValue = right.assets.lovelace ?? 0n;
        if (leftValue === rightValue) return 0;
        return leftValue > rightValue ? -1 : 1;
      })[0] ?? null
  );
}

function requireInlineDatum(utxo: UTxO, label: string): string {
  if (!utxo.datum) {
    throw new Error(`Current ${label} UTxO is missing its inline datum.`);
  }
  return utxo.datum;
}
