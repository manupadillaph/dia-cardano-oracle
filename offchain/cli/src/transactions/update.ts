import { unlink } from "node:fs/promises";
import path from "node:path";
import { confirm } from "@inquirer/prompts";
import { Constr, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeCoordinatorValidator,
  makePairStateMintingPolicy,
  makePairStateValidator,
  makeReceiverValidator,
  mintingPolicyFromCompiledScript,
  spendingValidatorFromCompiledScript,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  withdrawalValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  assertDiaOracleIntentNotExpired,
  diaIntentToState,
  diaIntentTokenNameFromSymbol,
  diaPairIdHex,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  normalizeHex,
  readSignedIntentInput,
  recoverDiaOracleIntentWitness,
} from "../core/dia-intent.js";
import {
  assertOracleIntentTimestampAndNonceMonotonic,
  assertOracleUpdateBootstrapRefsResolved,
} from "../preflight/index.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  readOptionalPairState,
  type PairStateArtifact,
} from "../core/state.js";
import { loadReferenceScriptUtxos } from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  buildPairDatumCbor,
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  requireInlineDatum,
  selectFundingUtxo,
  splitUnit,
  updateWitnessData,
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
  assertOracleUpdateBootstrapRefsResolved(protocol.bootstrapRefs);
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
      receiverCbor: client.datum.receiverCbor,
      pairCbor: pair.datum.pairCbor,
    },
  };

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
  const currentReceiverUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.receiver.receiverValidatorAddress,
    state.receiver.receiverUnit,
    "receiver",
  );
  const currentReceiverState = decodeReceiverDatum(
    requireInlineDatum(currentReceiverUtxo, "receiver"),
  );
  const walletFundingUtxo = selectFundingUtxo(
    walletUtxos,
    [state.bootstrapRefs.config],
    5_000_000n,
    "oracle update",
  );

  if (pairValidatorHash !== state.scripts.pairValidatorHash) {
    throw new Error("Pair validator hash does not match the current blueprint.");
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

  assertOracleIntentTimestampAndNonceMonotonic({
    isCreate,
    intentTimestamp: intent.timestamp,
    intentNonce: intent.nonce,
    pairStateTimestamp: state.pairState.timestamp,
    pairStateNonce: state.pairState.nonce,
  });

  assertDiaOracleIntentNotExpired(intent, BigInt(Math.floor(Date.now() / 1000)));

  const nextPairState = {
    ...state.pairState,
    price: intent.price.toString(),
    timestamp: intent.timestamp.toString(),
    nonce: intent.nonce.toString(),
    intentHash: witness.intentHash,
    signer: intent.signer,
    intent: diaIntentToState(intent),
  };
  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) -
      BigInt(state.configState.protocolFeeLovelace)
    ).toString(),
    accruedToHookLovelace: (
      BigInt(currentReceiverState.accruedToHookLovelace) +
      BigInt(state.configState.protocolFeeLovelace)
    ).toString(),
  };
  if (BigInt(nextReceiverState.balanceLovelace) < 0n) {
    throw new Error("Receiver balance is not sufficient to pay the protocol fee.");
  }

  const pairRedeemer = Data.to(new Constr(0, []));
  const pairMintRedeemer = Data.to(new Constr<PlutusData>(0, []));
  const receiverRedeemer = Data.to(new Constr(1, [])); // AccrueFee redeemer
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
  const nextReceiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);

  reportProgress("Building Preview oracle update transaction");
  // The on-chain coordinator (and pair_state.pair_intent_satisfied) require
  // a finite tx validity range so intent expiry / bootstrap freshness can
  // be evaluated. Cap the upper bound below the signed intent's expiry.
  const nowMs = Date.now();
  const txValidFromMs = nowMs - 60_000;
  const intentExpiryMs = Number(intent.expiry) * 1000;
  const txValidToMs = Math.min(nowMs + 30 * 60_000, intentExpiryMs - 60_000);
  let txBuilder = lucid
    .newTx()
    .validFrom(txValidFromMs)
    .validTo(txValidToMs)
    .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
    .collectFrom([currentReceiverUtxo], receiverRedeemer)
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
          BigInt(nextReceiverState.balanceLovelace) +
          BigInt(nextReceiverState.accruedToHookLovelace),
        [state.receiver.receiverUnit]: 1n,
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
  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
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
