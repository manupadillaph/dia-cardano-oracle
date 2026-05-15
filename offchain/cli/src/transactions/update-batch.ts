import { readFile } from "node:fs/promises";
import path from "node:path";
import { Constr } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  mintingPolicyFromCompiledScript,
  policyIdFromMintingPolicy,
  spendingValidatorFromCompiledScript,
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
  type DiaOracleIntent,
} from "../core/dia-intent.js";
import {
  assertOracleIntentTimestampAndNonceMonotonic,
  assertOracleUpdateBootstrapRefsResolved,
  assertPaymentKeyHashIsConfigSigner,
} from "../preflight/index.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  hasCompletedStep,
  readOptionalPairState,
  type ConfigStateArtifact,
  type ClientStateArtifact,
  type PairStateArtifact,
  type ResolvedCompiledScripts,
  type ResolvedDeploymentScripts,
  type ReferenceScriptsState,
} from "../core/state.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { loadReferenceScriptUtxos } from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { getNetworkNow, slotBackoffUnixTimeMs } from "../core/network-time.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  buildPairDatumCbor,
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  requireInlineDatum,
  splitUnit,
  updateWitnessData,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
  writeJsonFile,
} from "../core/chain-helpers.js";
import { buildPairApplyUpdateRedeemer } from "../core/redeemers.js";

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
  pairs: Array<{
    statePath: string;
    outPath: string;
    pairId: string;
    pairUnit: string;
  }>;
  transactions?: ConfigStateArtifact["transactions"];
};

type ResolvedPairStateArtifact = PairStateArtifact & {
  bootstrapRefs: ConfigStateArtifact["bootstrapRefs"];
  scripts: ResolvedDeploymentScripts;
  configState: ConfigStateArtifact["configState"];
  paymentHookState: NonNullable<ConfigStateArtifact["paymentHookState"]>;
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
  assertOracleUpdateBootstrapRefsResolved(context.protocol.bootstrapRefs);
  if (!context.client.compiledScripts.pairMintPolicy) {
    throw new Error("pairMintPolicy compiled script not found. Run preview:receiver:parameterize first.");
  }
  const pairMintPolicy = mintingPolicyFromCompiledScript(context.client.compiledScripts.pairMintPolicy);
  const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
  if (!context.client.compiledScripts.pairValidator) {
    throw new Error("pairValidator compiled script not found. Run preview:receiver:parameterize first.");
  }
  const pairValidator = spendingValidatorFromCompiledScript(context.client.compiledScripts.pairValidator);
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
        minUtxoLovelace: context.protocol.configState.minUtxoLovelace,
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
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });
  const hasCreate = states.some(({ isCreate }) => isCreate);
  if (hasCreate) {
    // Any batch that includes a pair creation MUST be signed by a config
    // admin (pair_state.mint MintPairs is admin-gated). Pure-update
    // batches do not need this.
    assertPaymentKeyHashIsConfigSigner(
      walletDefaults.paymentKeyHash,
      protocolState.configState.validConfigSigners,
      {
        unauthorizedMessage:
          "Batch update includes one or more pair creations and requires the configured wallet to be a config admin (config_admins). The current wallet is not authorized.",
      },
    );
  }
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
        {
          key: "pairMint",
          label: "pairMint",
          outRef: state.referenceScripts?.client?.pairMint
            ? {
                txHash: state.referenceScripts.client.pairMint.txHash,
                outputIndex: state.referenceScripts.client.pairMint.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  const [currentConfigUtxo, currentReceiverUtxo] =
    await Promise.all([
      findSingleUtxoAtUnit(
        lucid,
        state.scripts.configValidatorAddress,
        state.scripts.configUnit,
        "config",
      ),
      findSingleUtxoAtUnit(
        lucid,
        state.receiver.receiverValidatorAddress,
        state.receiver.receiverUnit,
        "receiver",
      ),
    ]);
  const currentReceiverState = decodeReceiverDatum(
    requireInlineDatum(currentReceiverUtxo, "receiver"),
  );

  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  if (pairValidatorHash !== state.scripts.pairValidatorHash) {
    throw new Error("Pair validator hash does not match the current blueprint.");
  }

  if (!state.compiledScripts.receiverValidator) {
    throw new Error("receiverValidator compiled script not found. Run preview:receiver:parameterize first.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator);
  const receiverValidatorHash = scriptHashFromValidator(receiverValidator);
  if (receiverValidatorHash !== state.receiver.receiverValidatorHash) {
    throw new Error("Receiver validator hash does not match the current blueprint.");
  }

  if (!state.compiledScripts.coordinatorValidator) {
    throw new Error("coordinatorValidator compiled script not found. Run preview:config:parameterize first.");
  }
  const coordinatorValidator = withdrawalValidatorFromCompiledScript(state.compiledScripts.coordinatorValidator);

  const domain = normalizeDiaEip712Domain({
    name: state.configState.domain.name,
    version: state.configState.domain.version,
    sourceChainId: state.configState.domain.sourceChainId,
    verifyingContract: state.configState.domain.verifyingContract,
  });

  const networkNow = await getNetworkNow(lucid);

  const preparedUpdates = sortBatchUpdatesByPairTokenName(
    states.map(({ entry, artifact, intent: loadedIntent, isCreate }) => {
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
    assertOracleIntentTimestampAndNonceMonotonic({
      isCreate,
      intentTimestamp: intent.timestamp,
      intentNonce: intent.nonce,
      pairStateTimestamp: artifact.pairState.timestamp,
      pairStateNonce: artifact.pairState.nonce,
      batchStatePath: entry.statePath,
    });

    assertDiaOracleIntentNotExpired(intent, networkNow.unixTimeSec);

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
  }),
  );

  const totalFee =
    BigInt(state.configState.baseFeeLovelace) +
    BigInt(state.configState.perPairFeeLovelace) * BigInt(preparedUpdates.length);
  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) - totalFee
    ).toString(),
    accruedToHookLovelace: (
      BigInt(currentReceiverState.accruedToHookLovelace) + totalFee
    ).toString(),
  };
  if (BigInt(nextReceiverState.balanceLovelace) < 0n) {
    throw new Error("Receiver balance is not sufficient to pay the protocol fee batch.");
  }

  const receiverRedeemer = Data.to(new Constr(1, []));
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
  const currentPairUtxoByUnit = new Map(
    currentPairEntries.map(({ unit, utxo }) => [unit, utxo]),
  );

  reportProgress("Building Preview oracle batch update transaction");
  // Finite tx validity range required by the on-chain coordinator
  // (intent_expiry_satisfied) and pair_state indexed witness binding.
  // Cap upper bound below the earliest intent expiry in the batch.
  const earliestExpirySec = preparedUpdates.reduce(
    (min, u) => (u.intent.expiry < min ? u.intent.expiry : min),
    preparedUpdates[0].intent.expiry,
  );
  const txValidFromMs = slotBackoffUnixTimeMs(lucid, networkNow.slot);
  const txValidToMs = Math.min(
    networkNow.unixTimeMs + 30 * 60_000,
    Number(earliestExpirySec) * 1000 - 60_000,
  );
  let txBuilder = lucid
    .newTx()
    .validFrom(txValidFromMs)
    .validTo(txValidToMs)
    .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
    .collectFrom([currentReceiverUtxo], receiverRedeemer)
    .withdraw(state.scripts.coordinatorRewardAddress, 0n, coordinatorRedeemer);

  for (const { utxo } of currentPairEntries) {
    txBuilder = txBuilder.collectFrom([utxo], buildPairApplyUpdateRedeemer());
  }

  if (missingReferenceScripts.receiver) {
    reportProgress("Reference script for receiver is missing on-chain; attaching the receiver validator inline.");
    txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
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
    // Admin signer is required by `pair_state.mint(MintPairs)` for any
    // batch that creates one or more pairs (anti-replay gate on signed
    // DIA intents — see security notes).
    txBuilder = txBuilder
      .mintAssets(mintAssets, Data.to(new Constr<PlutusData>(0, [])))
      .addSignerKey(walletDefaults.paymentKeyHash);
    if (missingReferenceScripts.pairMint) {
      reportProgress("Reference script for pairMint is missing on-chain; attaching the pair minting policy inline.");
      txBuilder = txBuilder.attach.MintingPolicy(pairMintPolicy);
    }
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
          BigInt(nextReceiverState.balanceLovelace) +
          BigInt(nextReceiverState.accruedToHookLovelace),
        [state.receiver.receiverUnit]: 1n,
      },
    );

  const txSignBuilder = await txBuilder.complete();
  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
  logEffectiveOutputs(txSignBuilder, reportProgress);
  const unsignedHash = txSignBuilder.toHash();
  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(`Unsigned transaction ready: ${unsignedHash}`);
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await awaitTxConfirmation({
      lucid,
      txHash: submittedTxHash,
      reportProgress,
      label: "oracle batch update transaction",
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      spentUtxos: [],
      label: "oracle batch update",
      requireChangeWhenNoSpentUtxos: true,
    });
  }

  if (!args.buildOnly && confirmed) {
    await Promise.all([
      ...preparedUpdates.map(({ artifact }) =>
        waitForUnitUtxoReplacement({
          lucid,
          address: artifact.pair.pairValidatorAddress,
          unit: artifact.pair.pairUnit,
          label: `pair ${artifact.pair.pairId}`,
          previousOutRef: currentPairUtxoByUnit.get(artifact.pair.pairUnit),
        }),
      ),
      waitForUnitUtxoReplacement({
        lucid,
        address: state.receiver.receiverValidatorAddress,
        unit: state.receiver.receiverUnit,
        label: "receiver",
        previousOutRef: currentReceiverUtxo,
      }),
    ]);
  }


  const updatedArtifacts = preparedUpdates.map(({ entry, artifact, nextPairState }) => {
    const updatedArtifact: PairStateArtifact = {
      wallet: {
        source,
        address: walletAddress,
      },
      pair: {
        ...artifact.pair,
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
    },
    pairs: updatedArtifacts.map(({ entry, artifact }) => ({
      statePath: path.resolve(entry.statePath),
      outPath: path.resolve(entry.outPath ?? entry.statePath),
      pairId: artifact.pair.pairId,
      pairUnit: artifact.pair.pairUnit,
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

function createPairArtifactFromIntent(args: {
  intent: DiaOracleIntent;
  pairPolicyId: string;
  pairValidatorAddress: string;
  minUtxoLovelace: string;
}): PairStateArtifact {
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
  if (
    !protocolState.paymentHookState ||
    !hasCompletedStep(protocolState.transactions, "preview:payment-hook:bootstrap")
  ) {
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
    paymentHookState: protocolState.paymentHookState,
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

// Canonical batch order — the on-chain coordinator rejects any batch whose
// witnesses are not strictly ascending by `bytearray.compare` on
// `pair_token_name` during its main witness walk. Pair token names are
// `blake2b_256(pair_id)` bytes serialized as lowercase even-length hex by
// the CLI, so a bytewise compare on the decoded bytes is equivalent to a
// plain lexicographic compare on the normalized hex string. We avoid
// `localeCompare` because it can apply locale-sensitive collation that
// diverges from byte order on some platforms; we normalize first to
// guarantee that the input matches the on-chain expectation.
export function sortBatchUpdatesByPairTokenName<
  T extends { artifact: { pair: { tokenName: string } } },
>(updates: T[]): T[] {
  const normalized = updates.map((update) => ({
    update,
    tokenName: normalizeHex(update.artifact.pair.tokenName, "pair.tokenName"),
  }));
  normalized.sort((left, right) => compareHexBytewise(left.tokenName, right.tokenName));
  return normalized.map(({ update }) => update);
}

// Bytewise comparison on two already-normalized (lowercase, even-length)
// hex strings. Equivalent to `bytearray.compare` on the decoded bytes:
// hex digits 0-9 < a-f preserve byte order, and pair-wise hex chars
// inherit byte order from their numeric value.
export function compareHexBytewise(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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
