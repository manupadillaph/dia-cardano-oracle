import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { Constr, type OutRef, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeCoordinatorValidator,
  makePairStateMintingPolicy,
  makePairStateValidator,
  makePaymentHookValidator,
  makeReceiverValidator,
  mintingPolicyFromCompiledScript,
  policyIdFromMintingPolicy,
  spendingValidatorFromCompiledScript,
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
  type ConfigStateArtifact,
  type ClientStateArtifact,
  type PairStateArtifact,
  type ResolvedCompiledScripts,
  type ResolvedDeploymentScripts,
  type ReferenceScriptsState,
} from "../core/state.js";
import { loadReferenceScriptUtxos } from "../core/reference-scripts.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  buildPairDatumCbor,
  buildPaymentHookDatumCbor,
  buildReceiverDatumCbor,
  decodePaymentHookDatum,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  splitUnit,
  updateWitnessData,
  waitForUnitUtxoReplacement,
  writeJsonFile,
} from "../core/chain-helpers.js";

type BatchUpdateEntry = {
  statePath: string;
  outPath?: string;
  intentPath: string;
};

type BatchUpdateInput = {
  updates: BatchUpdateEntry[];
};

type BatchUpdateResult = {
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  receiver: ResolvedPairStateArtifact["receiver"];
  paymentHookState: ResolvedPairStateArtifact["paymentHookState"];
  paymentHookUtxo: ResolvedPairStateArtifact["paymentHookUtxo"];
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
  transactions?: ConfigStateArtifact["transactions"];
};

type ResolvedPairStateArtifact = PairStateArtifact & {
  bootstrapRefs: ConfigStateArtifact["bootstrapRefs"];
  scripts: ResolvedDeploymentScripts;
  configState: ConfigStateArtifact["configState"];
  configUtxo: ConfigStateArtifact["configUtxo"];
  paymentHookState: NonNullable<ConfigStateArtifact["paymentHookState"]>;
  paymentHookUtxo: NonNullable<ConfigStateArtifact["paymentHookUtxo"]>;
  compiledScripts: ResolvedCompiledScripts;
  referenceScripts?: ReferenceScriptsState;
  receiver: NonNullable<ClientStateArtifact["receiver"]>;
  datum: PairStateArtifact["datum"] & {
    configCbor: string;
    paymentHookCbor: string;
    receiverCbor: string;
  };
};

export async function submitBatchOracleUpdate(args: {
  manifestPath: string;
  clientStatePath: string;
  protocolStatePath: string;
  minUtxoLovelace?: string;
  buildOnly: boolean;
}): Promise<BatchUpdateResult> {
  reportProgress(`Loading batch update manifest from ${path.resolve(args.manifestPath)}`);
  const input = await readBatchUpdateInput(path.resolve(args.manifestPath));

  if (input.updates.length === 0) {
    throw new Error("Batch update requires at least one pair update entry.");
  }

  const context = await readClientContext({
    clientStatePath: path.resolve(args.clientStatePath),
    protocolStatePath: path.resolve(args.protocolStatePath),
  });
  const configAssetName = splitUnit(context.protocol.scripts.configUnit).assetName;
  if (!context.client.receiver) {
    throw new Error("Batch update requires client state after Receiver bootstrap.");
  }
  if (
    !context.client.scripts.pairPolicyId ||
    !context.client.scripts.pairValidatorHash ||
    !context.client.scripts.pairValidatorAddress
  ) {
    throw new Error("Batch update requires client state after Receiver/Pair parameterization.");
  }
  const pairMintPolicy = context.client.compiledScripts?.pairMintPolicy
    ? mintingPolicyFromCompiledScript(context.client.compiledScripts.pairMintPolicy)
    : await makePairStateMintingPolicy({
        configPolicyId: context.protocol.scripts.configPolicyId,
        configAssetName,
        receiverHash: context.client.receiver.receiverValidatorHash,
      });
  const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
  const pairValidator = context.client.compiledScripts?.pairValidator
    ? spendingValidatorFromCompiledScript(context.client.compiledScripts.pairValidator)
    : await makePairStateValidator({
        configPolicyId: context.protocol.scripts.configPolicyId,
        configAssetName,
        receiverHash: context.client.receiver.receiverValidatorHash,
      });
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);

  const states = await Promise.all(
    input.updates.map(async (entry) => {
      const loadedIntent = await readSignedIntentInput(path.resolve(entry.intentPath));
      const intent = normalizeDiaOracleIntent(loadedIntent);
      const existingPair = await readOptionalPairState(path.resolve(entry.statePath));
      const pair = existingPair ?? createPairArtifactFromIntent({
        intent,
        pairPolicyId,
        pairValidatorAddress,
        minUtxoLovelace: args.minUtxoLovelace,
      });
      return {
        entry,
        protocol: context.protocol,
        client: context.client,
        artifact: resolvePairArtifact(pair, context.client, context.protocol),
        intent: loadedIntent,
        isCreate: !existingPair,
      };
    }),
  );

  const [first] = states;
  if (!first) {
    throw new Error("Batch update requires at least one pair update entry.");
  }

  ensureCompatibleBatch(states.map(({ artifact }) => artifact));
  const state = first.artifact;
  const protocolState = first.protocol;
  const clientState = first.client;
  const protocolStatePath = path.resolve(args.protocolStatePath);
  const clientStatePath = path.resolve(args.clientStatePath);
  if (!state.receiver) {
    throw new Error("Batch update requires pair artifacts produced under the receiver architecture.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const walletAddress = await lucid.wallet().address();
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
  const currentPaymentHookState = decodePaymentHookDatum(
    requireInlineDatum(currentPaymentHookUtxo, "payment hook"),
    state.paymentHookState.withdrawAddress,
  );
  const currentReceiverState = decodeReceiverDatum(
    requireInlineDatum(currentReceiverUtxo, "receiver"),
  );

  const pairValidatorHash = scriptHashFromValidator(pairValidator);
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

  const coordinatorValidator = state.compiledScripts?.coordinatorValidator
    ? withdrawalValidatorFromCompiledScript(state.compiledScripts.coordinatorValidator)
    : await makeCoordinatorValidator({
        configPolicyId: state.scripts.configPolicyId,
        configAssetName,
      });

  const domain = normalizeDiaEip712Domain({
    name: state.configState.domain.name,
    version: state.configState.domain.version,
    sourceChainId: state.configState.domain.sourceChainId,
    verifyingContract: state.configState.domain.verifyingContract,
  });

  const preparedUpdates = states.map(({ entry, artifact, intent: loadedIntent, isCreate }) => {
    const intent = normalizeDiaOracleIntent(loadedIntent);
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
    if (!isCreate && BigInt(intent.timestamp) <= BigInt(artifact.pairState.timestamp)) {
      throw new Error(`Intent timestamp must be greater than current timestamp for ${entry.statePath}.`);
    }
    if (!isCreate && BigInt(intent.nonce) <= BigInt(artifact.pairState.nonce)) {
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
      isCreate,
    };
  });

  const totalFee =
    BigInt(state.configState.protocolFeeLovelace) *
    BigInt(preparedUpdates.length);
  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) - totalFee
    ).toString(),
  };
  if (BigInt(nextReceiverState.balanceLovelace) < 0n) {
    throw new Error("Receiver balance is not sufficient to pay the protocol fee batch.");
  }

  const nextPaymentHookState = {
    ...currentPaymentHookState,
    accruedFeesLovelace: (
      BigInt(currentPaymentHookState.accruedFeesLovelace) + totalFee
    ).toString(),
    lifetimeCollectedLovelace: (
      BigInt(currentPaymentHookState.lifetimeCollectedLovelace) + totalFee
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

  const currentPairEntries = await Promise.all(
    preparedUpdates
      .filter(({ isCreate }) => !isCreate)
      .map(async ({ artifact }) => ({
        unit: artifact.pair.pairUnit,
        utxo: await findSingleUtxoAtUnit(
          lucid,
          artifact.pair.pairValidatorAddress,
          artifact.pair.pairUnit,
          `pair ${artifact.pair.pairId}`,
        ),
      })),
  );
  const currentPairUtxos = currentPairEntries.map(({ utxo }) => utxo);
  const currentPairUtxoByUnit = new Map(
    currentPairEntries.map(({ unit, utxo }) => [unit, utxo]),
  );

  reportProgress("Building Preview oracle batch update transaction");
  let txBuilder = lucid
    .newTx()
    .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
    .collectFrom([currentReceiverUtxo], receiverRedeemer)
    .collectFrom([currentPaymentHookUtxo], paymentHookRedeemer)
    .withdraw(state.scripts.coordinatorRewardAddress, 0n, coordinatorRedeemer);

  if (currentPairUtxos.length > 0) {
    txBuilder = txBuilder.collectFrom(currentPairUtxos, pairRedeemer);
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
  if (missingReferenceScripts.pair) {
    reportProgress("Reference script for pair is missing on-chain; attaching the pair validator inline.");
    txBuilder = txBuilder.attach.SpendingValidator(pairValidator);
  }

  const mintAssets: Record<string, bigint> = {};
  for (const { artifact, isCreate } of preparedUpdates) {
    if (isCreate) {
      mintAssets[artifact.pair.pairUnit] = 1n;
    }
  }
  if (Object.keys(mintAssets).length > 0) {
    txBuilder = txBuilder
      .attach.MintingPolicy(pairMintPolicy)
      .mintAssets(mintAssets, Data.to(new Constr<PlutusData>(0, [])));
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
    args.buildOnly || !confirmed
      ? preparedUpdates.map(({ artifact }) => artifact.pair.stateUtxo)
      : await Promise.all(
          preparedUpdates.map(({ artifact }) =>
            waitForUnitUtxoReplacement({
              lucid,
              address: artifact.pair.pairValidatorAddress,
              unit: artifact.pair.pairUnit,
              label: `pair ${artifact.pair.pairId}`,
              previousOutRef: currentPairUtxoByUnit.get(artifact.pair.pairUnit),
            }),
          ),
        );
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

  const updatedArtifacts = preparedUpdates.map(({ entry, artifact, nextPairState }, index) => {
    const latestPairUtxo = latestPairUtxos[index]!;
    const updatedArtifact: PairStateArtifact = {
      wallet: {
        source,
        address: walletAddress,
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
        pairCbor: buildPairDatumCbor(nextPairState),
      },
      transactions: appendTransactionRecord(artifact.transactions, {
        step: "preview:update:batch",
        submittedTxHash,
        confirmed,
      }),
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
    if (protocolStatePath) {
      await writeJsonFile(protocolStatePath, {
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
        transactions: appendTransactionRecord(protocolState.transactions, {
          step: "preview:update:batch",
          submittedTxHash,
          confirmed,
        }),
      });
    }
    if (clientStatePath && clientState.receiver) {
      await writeJsonFile(clientStatePath, {
        ...clientState,
        wallet: {
          source,
          address: walletAddress,
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
          receiverCbor: buildReceiverDatumCbor(nextReceiverState),
        },
        transactions: appendTransactionRecord(clientState.transactions, {
          step: "preview:update:batch",
          submittedTxHash,
          confirmed,
        }),
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
    transactions: appendTransactionRecord(undefined, {
      step: "preview:update:batch",
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:update:batch] ${message}`);
}

async function readBatchUpdateInput(inputPath: string): Promise<BatchUpdateInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as BatchUpdateInput;
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

function createPairArtifactFromIntent(args: {
  intent: DiaOracleIntent;
  pairPolicyId: string;
  pairValidatorAddress: string;
  minUtxoLovelace?: string;
}): PairStateArtifact {
  if (!args.minUtxoLovelace) {
    throw new Error(
      "Creating new pairs in a batch requires --min-utxo-lovelace for entries without pair artifacts.",
    );
  }
  const pairId = diaPairIdHex(args.intent);
  const tokenName = diaIntentTokenNameFromSymbol(args.intent);
  return {
    wallet: {
      source: "seed",
      address: "",
    },
    pair: {
      tokenName,
      pairId,
      pairUnit: `${args.pairPolicyId}${tokenName}`,
      pairValidatorAddress: args.pairValidatorAddress,
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
      minUtxoLovelace: args.minUtxoLovelace,
      intent: diaIntentToState(args.intent),
    },
    datum: {
      pairCbor: "",
    },
  };
}

export function resolvePairArtifact(
  artifact: PairStateArtifact,
  clientState: ClientStateArtifact,
  protocolState: ConfigStateArtifact,
): ResolvedPairStateArtifact {
  if (!protocolState.paymentHookState || !protocolState.paymentHookUtxo) {
    throw new Error("Batch update requires protocol state after PaymentHook bootstrap.");
  }

  if (!clientState.receiver) {
    throw new Error("Batch update requires client state after Receiver bootstrap.");
  }

  return {
    ...artifact,
    bootstrapRefs: protocolState.bootstrapRefs,
    scripts: {
      ...protocolState.scripts,
      ...clientState.scripts,
    },
    configState: protocolState.configState,
    configUtxo: protocolState.configUtxo,
    paymentHookState: protocolState.paymentHookState,
    paymentHookUtxo: protocolState.paymentHookUtxo,
    compiledScripts: {
      ...protocolState.compiledScripts,
      ...clientState.compiledScripts,
    },
    referenceScripts: {
      ...protocolState.referenceScripts,
      ...clientState.referenceScripts,
    },
    receiver: clientState.receiver,
    datum: {
      ...artifact.datum,
      configCbor: protocolState.datum.configCbor,
      paymentHookCbor: protocolState.datum.paymentHookCbor,
      receiverCbor: clientState.datum.receiverCbor,
    },
  };
}

export function ensureCompatibleBatch(states: ResolvedPairStateArtifact[]): void {
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

function requireInlineDatum(utxo: UTxO, label: string): string {
  if (!utxo.datum) {
    throw new Error(`Current ${label} UTxO is missing its inline datum.`);
  }
  return utxo.datum;
}
