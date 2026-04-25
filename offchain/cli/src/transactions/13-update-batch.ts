import path from "node:path";
import { Constr, type OutRef } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeCoordinatorValidator,
  makePairStateValidator,
  makePaymentHookValidator,
  makeReceiverValidator,
  scriptHashFromValidator,
} from "../core/contracts.js";
import {
  diaIntentToState,
  diaPairIdHex,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  normalizeHex,
  recoverDiaOracleIntentWitness,
  type DiaOracleIntentInput,
} from "../core/dia-intent.js";
import {
  makeConfiguredLucid,
  makeConfiguredProvider,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  readConfigState,
  readPairState,
  type ConfigStateArtifact,
  type PairStateArtifact,
} from "../core/state.js";
import {
  buildPairDatumCbor,
  buildPaymentHookDatumCbor,
  buildReceiverDatumCbor,
  findSingleUtxoAtUnit,
  splitUnit,
  updateWitnessData,
  writeJsonFile,
} from "../core/chain-helpers.js";

type BatchUpdateEntry = {
  statePath: string;
  outPath?: string;
  intent: DiaOracleIntentInput;
};

type BatchUpdateInput = {
  protocolStatePath?: string;
  clientStatePath?: string;
  updates: BatchUpdateEntry[];
};

type BatchUpdateResult = {
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  receiver: NonNullable<PairStateArtifact["receiver"]>;
  paymentHookState: PairStateArtifact["paymentHookState"];
  paymentHookUtxo: PairStateArtifact["paymentHookUtxo"];
  pairs: Array<{
    statePath: string;
    outPath: string;
    pairId: string;
    pairUnit: string;
    stateUtxo: {
      txHash: string;
      outputIndex: number;
    };
  }>;
  transaction: {
    submittedTxHash: string | null;
    confirmed: boolean;
  };
};

export async function submitBatchOracleUpdate(args: {
  inputPath: string;
  buildOnly: boolean;
}): Promise<BatchUpdateResult> {
  reportProgress(`Loading batch update input from ${path.resolve(args.inputPath)}`);
  const input = await readBatchUpdateInput(path.resolve(args.inputPath));

  if (input.updates.length === 0) {
    throw new Error("Batch update requires at least one pair update entry.");
  }

  const [protocolState, clientState] = await Promise.all([
    input.protocolStatePath
      ? readConfigState(path.resolve(input.protocolStatePath))
      : Promise.resolve(null),
    input.clientStatePath
      ? readConfigState(path.resolve(input.clientStatePath))
      : Promise.resolve(null),
  ]);

  const states = await Promise.all(
    input.updates.map(async (entry) => ({
      entry,
      artifact: applyLiveSnapshots(
        await readPairState(path.resolve(entry.statePath)),
        protocolState,
        clientState,
      ),
    })),
  );

  const [first] = states;
  if (!first) {
    throw new Error("Batch update requires at least one pair update entry.");
  }

  ensureCompatibleBatch(states.map(({ artifact }) => artifact));
  const state = first.artifact;
  if (!state.receiver) {
    throw new Error("Batch update requires pair artifacts produced under the receiver architecture.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const walletAddress = await lucid.wallet().address();
  const referenceScriptUtxos = await loadReferenceScriptUtxos(state);

  const [currentConfigUtxo, currentPaymentHookUtxo, currentReceiverUtxo] =
    await Promise.all([
      findSingleUtxoAtUnit(
        lucid,
        state.scripts.configValidatorAddress,
        state.scripts.configUnit,
        "config",
      ),
      findSingleUtxoAtUnit(
        lucid,
        state.scripts.paymentHookValidatorAddress!,
        state.scripts.paymentHookUnit!,
        "payment hook",
      ),
      findSingleUtxoAtUnit(
        lucid,
        state.receiver.receiverValidatorAddress,
        state.receiver.receiverUnit,
        "receiver",
      ),
    ]);

  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const pairValidator = await makePairStateValidator({
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    receiverHash: state.receiver.receiverValidatorHash,
  });
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  if (pairValidatorHash !== state.scripts.pairValidatorHash) {
    throw new Error("Pair validator hash does not match the current blueprint.");
  }

  const paymentHookValidator = await makePaymentHookValidator({
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

  const receiverValidator = await makeReceiverValidator({
    bootstrapOutRef: state.receiver.bootstrapRef,
    assetName: state.receiver.receiverAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
  });
  const receiverValidatorHash = scriptHashFromValidator(receiverValidator);
  if (receiverValidatorHash !== state.receiver.receiverValidatorHash) {
    throw new Error("Receiver validator hash does not match the current blueprint.");
  }

  const coordinatorValidator = await makeCoordinatorValidator({
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
  });

  const domain = normalizeDiaEip712Domain({
    name: state.configState.domain.name,
    version: state.configState.domain.version,
    sourceChainId: state.configState.domain.sourceChainId,
    verifyingContract: state.configState.domain.verifyingContract,
  });

  const preparedUpdates = states.map(({ entry, artifact }) => {
    const intent = normalizeDiaOracleIntent(entry.intent);
    const witness = recoverDiaOracleIntentWitness(domain, intent);

    if (!artifact.receiver) {
      throw new Error(`State file ${entry.statePath} is missing receiver metadata.`);
    }
    if (!artifact.configState.authorizedDiaPublicKeys.includes(witness.signerPublicKey)) {
      throw new Error(
        `Recovered DIA signer public key ${witness.signerPublicKey} is not authorized for ${entry.statePath}.`,
      );
    }
    if (
      normalizeHex(artifact.pair.pairId, "pair.pairId") !==
      normalizeHex(diaPairIdHex(intent), "intent.symbol")
    ) {
      throw new Error(`Intent symbol ${intent.symbol} does not match pair id ${artifact.pair.pairId}.`);
    }
    if (BigInt(intent.timestamp) <= BigInt(artifact.pairState.timestamp)) {
      throw new Error(`Intent timestamp must be greater than current timestamp for ${entry.statePath}.`);
    }
    if (BigInt(intent.nonce) <= BigInt(artifact.pairState.nonce)) {
      throw new Error(`Intent nonce must be greater than current nonce for ${entry.statePath}.`);
    }

    const nextPairState = {
      ...artifact.pairState,
      price: intent.price.toString(),
      timestamp: intent.timestamp.toString(),
      nonce: intent.nonce.toString(),
      intentHash: witness.intentHash,
      signer: intent.signer,
      intent: diaIntentToState(intent),
    };

    return {
      entry,
      artifact,
      intent,
      witness,
      nextPairState,
    };
  });

  const totalFee =
    BigInt(state.configState.protocolFeeLovelace) *
    BigInt(preparedUpdates.length);
  const nextReceiverState = {
    ...state.receiver.receiverState,
    balanceLovelace: (
      BigInt(state.receiver.receiverState.balanceLovelace) - totalFee
    ).toString(),
  };
  if (BigInt(nextReceiverState.balanceLovelace) < 0n) {
    throw new Error("Receiver balance is not sufficient to pay the protocol fee batch.");
  }

  const nextPaymentHookState = {
    ...state.paymentHookState,
    accruedFeesLovelace: (
      BigInt(state.paymentHookState.accruedFeesLovelace) + totalFee
    ).toString(),
    lifetimeCollectedLovelace: (
      BigInt(state.paymentHookState.lifetimeCollectedLovelace) + totalFee
    ).toString(),
  };

  const pairRedeemer = Data.to(new Constr(0, []));
  const receiverRedeemer = Data.to(new Constr(1, []));
  const paymentHookRedeemer = Data.to(new Constr(0, []));
  const coordinatorRedeemer = Data.to(
    new Constr<PlutusData>(1, [
      preparedUpdates.map(({ intent, witness, artifact }) =>
        updateWitnessData(
          intent,
          artifact.receiver!.receiverPolicyId,
          artifact.receiver!.receiverAssetName,
          splitUnit(artifact.pair.pairUnit).policyId,
          artifact.pair.tokenName,
          witness.signerPublicKey,
        ),
      ),
    ]),
  );

  const currentPairUtxos = await Promise.all(
    preparedUpdates.map(({ artifact }) =>
      findSingleUtxoAtUnit(
        lucid,
        artifact.pair.pairValidatorAddress,
        artifact.pair.pairUnit,
        `pair ${artifact.pair.pairId}`,
      ),
    ),
  );

  reportProgress("Building Preview oracle batch update transaction");
  let txBuilder = lucid
    .newTx()
    .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
    .collectFrom(currentPairUtxos, pairRedeemer)
    .collectFrom([currentReceiverUtxo], receiverRedeemer)
    .collectFrom([currentPaymentHookUtxo], paymentHookRedeemer)
    .withdraw(state.scripts.coordinatorRewardAddress, 0n, coordinatorRedeemer);

  if (referenceScriptUtxos.length === 0) {
    txBuilder = txBuilder
      .attach.SpendingValidator(pairValidator)
      .attach.SpendingValidator(receiverValidator)
      .attach.SpendingValidator(paymentHookValidator)
      .attach.WithdrawalValidator(coordinatorValidator);
  }

  for (const { artifact, nextPairState } of preparedUpdates) {
    txBuilder = txBuilder.pay.ToContract(
      artifact.pair.pairValidatorAddress,
      { kind: "inline", value: buildPairDatumCbor(nextPairState) },
      {
        lovelace: BigInt(nextPairState.minUtxoLovelace),
        [artifact.pair.pairUnit]: 1n,
      },
    );
  }

  txBuilder = txBuilder
    .pay.ToContract(
      state.receiver.receiverValidatorAddress,
      { kind: "inline", value: buildReceiverDatumCbor(nextReceiverState) },
      {
        lovelace:
          BigInt(nextReceiverState.minUtxoLovelace) +
          BigInt(nextReceiverState.balanceLovelace),
        [state.receiver.receiverUnit]: 1n,
      },
    )
    .pay.ToContract(
      state.scripts.paymentHookValidatorAddress!,
      { kind: "inline", value: buildPaymentHookDatumCbor(nextPaymentHookState) },
      {
        lovelace:
          BigInt(nextPaymentHookState.minUtxoLovelace) +
          BigInt(nextPaymentHookState.accruedFeesLovelace),
        [state.scripts.paymentHookUnit!]: 1n,
      },
    );

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
  }

  const latestPairUtxos =
    args.buildOnly || !confirmed || !submittedTxHash
      ? preparedUpdates.map(({ artifact }) => artifact.pair.stateUtxo)
      : preparedUpdates.map((_entry, index) => ({
          txHash: submittedTxHash,
          outputIndex: index,
        }));
  const latestReceiverUtxo =
    args.buildOnly || !confirmed || !submittedTxHash
      ? state.receiver.receiverUtxo.current
      : {
          txHash: submittedTxHash,
          outputIndex: preparedUpdates.length,
        };
  const latestPaymentHookUtxo =
    args.buildOnly || !confirmed || !submittedTxHash
      ? state.paymentHookUtxo.current
      : {
          txHash: submittedTxHash,
          outputIndex: preparedUpdates.length + 1,
        };

  const updatedArtifacts = preparedUpdates.map(({ entry, artifact, nextPairState }, index) => {
    const latestPairUtxo = latestPairUtxos[index]!;
    const updatedArtifact: PairStateArtifact = {
      ...artifact,
      wallet: {
        source,
        address: walletAddress,
      },
      configUtxo: {
        current: {
          txHash: currentConfigUtxo.txHash,
          outputIndex: currentConfigUtxo.outputIndex,
        },
      },
      paymentHookState: nextPaymentHookState,
      paymentHookUtxo: {
        current: {
          txHash: latestPaymentHookUtxo.txHash,
          outputIndex: latestPaymentHookUtxo.outputIndex,
        },
      },
      receiver: {
        ...artifact.receiver!,
        receiverState: nextReceiverState,
        receiverUtxo: {
          current: {
            txHash: latestReceiverUtxo.txHash,
            outputIndex: latestReceiverUtxo.outputIndex,
          },
        },
      },
      pair: {
        ...artifact.pair,
        stateUtxo: {
          txHash: latestPairUtxo.txHash,
          outputIndex: latestPairUtxo.outputIndex,
        },
      },
      pairState: nextPairState,
      datum: {
        ...artifact.datum,
        paymentHookCbor: buildPaymentHookDatumCbor(nextPaymentHookState),
        receiverCbor: buildReceiverDatumCbor(nextReceiverState),
        pairCbor: buildPairDatumCbor(nextPairState),
      },
      transaction: {
        submittedTxHash,
        confirmed,
      },
    };

    return {
      entry,
      artifact: updatedArtifact,
    };
  });

  if (!args.buildOnly && confirmed) {
    for (const { entry, artifact } of updatedArtifacts) {
      await writeJsonFile(entry.outPath ?? entry.statePath, artifact);
    }
    if (input.protocolStatePath && protocolState) {
      await writeJsonFile(input.protocolStatePath, {
        ...protocolState,
        wallet: {
          source,
          address: walletAddress,
        },
        configUtxo: {
          current: {
            txHash: currentConfigUtxo.txHash,
            outputIndex: currentConfigUtxo.outputIndex,
          },
        },
        paymentHookState: nextPaymentHookState,
        paymentHookUtxo: {
          current: {
            txHash: latestPaymentHookUtxo.txHash,
            outputIndex: latestPaymentHookUtxo.outputIndex,
          },
        },
        datum: {
          ...protocolState.datum,
          paymentHookCbor: buildPaymentHookDatumCbor(nextPaymentHookState),
        },
        transaction: {
          submittedTxHash,
          confirmed,
        },
      });
    }
    if (input.clientStatePath && clientState?.receiver) {
      await writeJsonFile(input.clientStatePath, {
        ...clientState,
        wallet: {
          source,
          address: walletAddress,
        },
        configState: state.configState,
        configUtxo: {
          current: {
            txHash: currentConfigUtxo.txHash,
            outputIndex: currentConfigUtxo.outputIndex,
          },
        },
        paymentHookState: nextPaymentHookState,
        paymentHookUtxo: {
          current: {
            txHash: latestPaymentHookUtxo.txHash,
            outputIndex: latestPaymentHookUtxo.outputIndex,
          },
        },
        receiver: {
          ...clientState.receiver,
          receiverState: nextReceiverState,
          receiverUtxo: {
            current: {
              txHash: latestReceiverUtxo.txHash,
              outputIndex: latestReceiverUtxo.outputIndex,
            },
          },
        },
        datum: {
          ...clientState.datum,
          paymentHookCbor: buildPaymentHookDatumCbor(nextPaymentHookState),
          receiverCbor: buildReceiverDatumCbor(nextReceiverState),
        },
        transaction: {
          submittedTxHash,
          confirmed,
        },
      });
    }
  }

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    receiver: {
      ...state.receiver,
      receiverState: nextReceiverState,
      receiverUtxo: {
        current: {
          txHash: latestReceiverUtxo.txHash,
          outputIndex: latestReceiverUtxo.outputIndex,
        },
      },
    },
    paymentHookState: nextPaymentHookState,
    paymentHookUtxo: {
      current: {
        txHash: latestPaymentHookUtxo.txHash,
        outputIndex: latestPaymentHookUtxo.outputIndex,
      },
    },
    pairs: updatedArtifacts.map(({ entry, artifact }) => ({
      statePath: path.resolve(entry.statePath),
      outPath: path.resolve(entry.outPath ?? entry.statePath),
      pairId: artifact.pair.pairId,
      pairUnit: artifact.pair.pairUnit,
      stateUtxo: artifact.pair.stateUtxo,
    })),
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:update:batch] ${message}`);
}

async function readBatchUpdateInput(inputPath: string): Promise<BatchUpdateInput> {
  const raw = await import("node:fs/promises").then(({ readFile }) => readFile(inputPath, "utf8"));
  return JSON.parse(raw) as BatchUpdateInput;
}

export function applyLiveSnapshots(
  artifact: PairStateArtifact,
  protocolState: ConfigStateArtifact | null,
  clientState: ConfigStateArtifact | null,
): PairStateArtifact {
  const protocolSnapshot: Partial<PairStateArtifact> = protocolState
    ? {
        configState: protocolState.configState,
        configUtxo: protocolState.configUtxo,
        paymentHookState: protocolState.paymentHookState ?? artifact.paymentHookState,
        paymentHookUtxo: protocolState.paymentHookUtxo ?? artifact.paymentHookUtxo,
        datum: {
          ...artifact.datum,
          configCbor: protocolState.datum.configCbor,
          paymentHookCbor:
            protocolState.datum.paymentHookCbor ?? artifact.datum.paymentHookCbor,
        },
      }
    : {};

  const clientSnapshot: Partial<PairStateArtifact> = clientState?.receiver
    ? {
        receiver: clientState.receiver,
        datum: {
          ...(protocolSnapshot.datum ?? artifact.datum),
          receiverCbor: clientState.datum.receiverCbor ?? artifact.datum.receiverCbor,
        },
      }
    : {};

  return {
    ...artifact,
    ...protocolSnapshot,
    ...clientSnapshot,
  };
}

export function ensureCompatibleBatch(states: PairStateArtifact[]): void {
  const [head, ...tail] = states;
  if (!head || !head.receiver) {
    throw new Error("Batch update requires at least one pair artifact with receiver metadata.");
  }

  const seenPairUnits = new Set<string>();
  for (const state of states) {
    if (!state.receiver) {
      throw new Error("Batch update requires pair artifacts with receiver metadata.");
    }

    if (
      state.receiver.receiverUnit !== head.receiver.receiverUnit ||
      state.scripts.configUnit !== head.scripts.configUnit ||
      state.scripts.paymentHookUnit !== head.scripts.paymentHookUnit ||
      state.scripts.pairPolicyId !== head.scripts.pairPolicyId
    ) {
      throw new Error("Batch update entries must belong to the same client deployment.");
    }

    if (seenPairUnits.has(state.pair.pairUnit)) {
      throw new Error(`Duplicate pair state included in batch: ${state.pair.pairUnit}`);
    }
    seenPairUnits.add(state.pair.pairUnit);
  }

  for (const state of tail) {
    if (state.pair.pairValidatorAddress !== head.pair.pairValidatorAddress) {
      throw new Error("Batch update entries must target the same client pair validator.");
    }
  }
}

async function loadReferenceScriptUtxos(
  state: PairStateArtifact,
): Promise<import("@lucid-evolution/lucid").UTxO[]> {
  const globalRefs = state.referenceScripts?.global;
  const clientRefs = state.referenceScripts?.client;

  if (!globalRefs || !clientRefs) {
    return [];
  }

  const provider = await makeConfiguredProvider();
  return provider.getUtxosByOutRef([
    {
      txHash: globalRefs.coordinator.txHash,
      outputIndex: globalRefs.coordinator.outputIndex,
    },
    {
      txHash: globalRefs.paymentHook.txHash,
      outputIndex: globalRefs.paymentHook.outputIndex,
    },
    { txHash: clientRefs.receiver.txHash, outputIndex: clientRefs.receiver.outputIndex },
    { txHash: clientRefs.pair.txHash, outputIndex: clientRefs.pair.outputIndex },
  ]);
}
