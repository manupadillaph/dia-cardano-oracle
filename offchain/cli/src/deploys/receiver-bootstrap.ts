import path from "node:path";
import { stepId, networkTag } from "../core/config.js";
import { Constr, type OutRef, type UTxO } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";

import {
  mintingPolicyFromCompiledScript,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import { normalizeHex } from "../core/dia-intent.js";
import {
  appendTransactionRecord,
  hasCompletedStep,
  type ClientStateArtifact,
} from "../core/state.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { readClientContext } from "../core/artifact-context.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildReceiverDatumCbor,
  findSingleUtxoAtUnit,
  findUtxoByOutRef,
  selectBootstrapUtxo,
  selectFundingUtxo,
  toBigInt,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";
import { assertNftBootstrapDestinationIsNotFundingWallet } from "../preflight/bootstrap-pay.js";
import { assertPositiveMinUtxoLovelace } from "../preflight/index.js";

export async function receiverBootstrap(args: {
  statePath?: string;
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
  reportProgress("Using Receiver values from the client artifact");

  const statePath = path.resolve(args.statePath ?? `state/${networkTag()}/clients/client-a.json`);
  reportProgress(`Loading config state from ${statePath}`);
  const { client: state, protocol } = await readClientContext({
    clientStatePath: statePath,
    protocolStatePath: args.protocolStatePath,
  });

  if (hasCompletedStep(state.transactions, stepId("receiver:bootstrap"))) {
    throw new Error(
      "Receiver bootstrap was already completed for this client artifact. Reuse the current artifact and continue with the next step instead of running receiver:bootstrap again.",
    );
  }

  if (!protocol.configState.updateCoordinatorCredential || !protocol.configState.paymentHookRef) {
    throw new Error(
      "Receiver bootstrap requires a config state artifact produced after payment-hook bootstrap.",
    );
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
  const resolvedInput = resolveReceiverBootstrapInput(state);

  if (!protocol.configState.validConfigSigners.includes(walletDefaults.paymentKeyHash)) {
    throw new Error(
      "The configured wallet is not authorized as a config signer in the provided state file.",
    );
  }

  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    protocol.scripts.configValidatorAddress,
    protocol.scripts.configUnit,
    "config",
  );
  const configuredBootstrapRef = state.receiver?.bootstrapRef;
  const receiverBootstrapUtxo = configuredBootstrapRef
    ? findUtxoByOutRef(walletUtxos, configuredBootstrapRef, "receiver bootstrap")
    : selectBootstrapUtxo(walletUtxos, 0n, [
        protocol.bootstrapRefs.config,
        protocol.bootstrapRefs.paymentHook!,
      ]);
  if (!receiverBootstrapUtxo) {
    throw new Error("No suitable wallet UTxO is available for receiver bootstrap.");
  }

  const receiverAssetName = normalizeHex(
    resolvedInput.receiverAssetName,
    "receiverAssetName",
  );
  if (state.receiver && state.receiver.receiverAssetName !== receiverAssetName) {
    throw new Error("Receiver bootstrap input does not match the previously published Receiver reference script.");
  }
  const receiverBootstrapOutRef: OutRef = {
    txHash: receiverBootstrapUtxo.txHash,
    outputIndex: receiverBootstrapUtxo.outputIndex,
  };

  if (!state.compiledScripts?.receiverMintPolicy) {
    throw new Error("receiverMintPolicy compiled script not found. Run receiver:parameterize first.");
  }
  const receiverMintPolicy = mintingPolicyFromCompiledScript(state.compiledScripts.receiverMintPolicy);
  const receiverPolicyId = policyIdFromMintingPolicy(receiverMintPolicy);
  const receiverUnit = `${receiverPolicyId}${receiverAssetName}`;

  if (!state.compiledScripts?.receiverValidator) {
    throw new Error("receiverValidator compiled script not found. Run receiver:parameterize first.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator);
  const receiverValidatorHash = scriptHashFromValidator(receiverValidator);
  const receiverValidatorAddress = scriptAddressFromValidator(receiverValidator);

  if (!state.compiledScripts?.pairMintPolicy) {
    throw new Error("pairMintPolicy compiled script not found. Run receiver:parameterize first.");
  }
  const pairMintPolicy = mintingPolicyFromCompiledScript(state.compiledScripts.pairMintPolicy);
  const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);

  if (!state.compiledScripts?.pairValidator) {
    throw new Error("pairValidator compiled script not found. Run receiver:parameterize first.");
  }
  const pairValidator = spendingValidatorFromCompiledScript(state.compiledScripts.pairValidator);
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);

  const receiverState = {
    balanceLovelace: "0",
    accruedToHookLovelace: "0",
    minUtxoLovelace: toBigInt(
      resolvedInput.minUtxoLovelace,
      "minUtxoLovelace",
    ).toString(),
  };
  const receiverOutputLovelace = BigInt(receiverState.minUtxoLovelace);
  const fundingUtxos =
    (receiverBootstrapUtxo.assets.lovelace ?? 0n) >= receiverOutputLovelace + 2_000_000n
      ? []
      : [
          selectFundingUtxo(
            walletUtxos,
            [
              protocol.bootstrapRefs.config,
              protocol.bootstrapRefs.paymentHook!,
              receiverBootstrapOutRef,
            ],
            receiverOutputLovelace + 2_000_000n,
            "receiver bootstrap",
          ),
        ];
  const receiverDatumCbor = buildReceiverDatumCbor(receiverState);
  const mintRedeemer = Data.to(new Constr(0, []));

  reportProgress("Building Preview receiver bootstrap transaction");
  assertNftBootstrapDestinationIsNotFundingWallet(
    receiverValidatorAddress,
    walletAddress,
    stepId("receiver:bootstrap"),
  );
  const txBuilder = lucid
    .newTx()
    .readFrom([currentConfigUtxo])
    .collectFrom([receiverBootstrapUtxo, ...fundingUtxos])
    .addSignerKey(walletDefaults.paymentKeyHash)
    .attach.MintingPolicy(receiverMintPolicy)
    .mintAssets({ [receiverUnit]: 1n }, mintRedeemer)
    .pay.ToContract(
      receiverValidatorAddress,
      { kind: "inline", value: receiverDatumCbor },
      {
        lovelace: receiverOutputLovelace,
        [receiverUnit]: 1n,
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
      label: "receiver bootstrap transaction",
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      spentUtxos: [receiverBootstrapUtxo, ...fundingUtxos],
      label: "receiver bootstrap",
    });
  }

  // Wait for the indexer to see the freshly-minted Receiver UTxO before
  // returning, so the next CLI step resolves it by NFT immediately.
  if (!args.buildOnly && confirmed) {
    await findSingleUtxoAtUnit(lucid, receiverValidatorAddress, receiverUnit, "receiver");
  }

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    scripts: {
      ...state.scripts,
      pairPolicyId,
      pairValidatorHash,
      pairValidatorAddress,
    },
    receiver: {
      clientId: resolvedInput.clientId.trim(),
      bootstrapRef: receiverBootstrapOutRef,
      receiverAssetName,
      receiverPolicyId,
      receiverUnit,
      receiverValidatorHash,
      receiverValidatorAddress,
      receiverState,
    },
    datum: {
      ...state.datum,
      receiverCbor: receiverDatumCbor,
    },
    transactions: appendTransactionRecord(state.transactions, {
      step: stepId("receiver:bootstrap"),
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[receiver:bootstrap] ${message}`);
}

function resolveReceiverBootstrapInput(state: ClientStateArtifact): {
  clientId: string;
  receiverAssetName: string;
  minUtxoLovelace: string;
} {
  const currentReceiver = state.receiver;
  const defaults = state.drafts?.receiverParameterize;
  const clientId = currentReceiver?.clientId || defaults?.clientId;
  const receiverAssetName =
    currentReceiver?.receiverAssetName ||
    defaults?.receiverAssetName;
  const minUtxoLovelace =
    currentReceiver?.receiverState.minUtxoLovelace ||
    defaults?.minUtxoLovelace;

  if (!clientId || !receiverAssetName || !minUtxoLovelace) {
    throw new Error(
      "Receiver bootstrap requires the Receiver values already stored in the client artifact. Run client:init and receiver:parameterize first.",
    );
  }

  const resolvedMinUtxoLovelace = toBigInt(minUtxoLovelace, "minUtxoLovelace");
  assertPositiveMinUtxoLovelace(resolvedMinUtxoLovelace, "Receiver");

  return {
    clientId,
    receiverAssetName: normalizeHex(receiverAssetName, "receiverAssetName"),
    minUtxoLovelace: resolvedMinUtxoLovelace.toString(),
  };
}
