import path from "node:path";
import { networkTag , getCliConfig} from "../core/config.js";

import {
  makePairStateMintingPolicy,
  makePairStateValidator,
  makeReceiverMintingPolicy,
  makeReceiverValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import {
  type ClientStateArtifact,
  type ReceiverParameterizeDefaults,
} from "../core/state.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  buildReceiverDatumCbor,
  findUtxoByOutRef,
  selectBootstrapUtxo,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";
import { normalizeHex } from "../core/dia-intent.js";
import { assertPositiveMinUtxoLovelace } from "../preflight/index.js";

export async function parameterizeReceiverScripts(args: {
  statePath?: string;
  protocolStatePath: string;
}): Promise<ClientStateArtifact> {
  const { client: state, protocol } = await readClientContext({
    clientStatePath: path.resolve(args.statePath ?? `state/${networkTag()}/clients/client-a.json`),
    protocolStatePath: args.protocolStatePath,
  });
  reportProgress("Using receiver values from the client artifact");

  if (!protocol.bootstrapRefs.paymentHook) {
    throw new Error("Receiver script parameterization requires protocol state after PaymentHook bootstrap.");
  }

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const configuredBootstrapRef = state.receiver?.bootstrapRef;
  const selectedBootstrapUtxo = configuredBootstrapRef
    ? findUtxoByOutRef(walletUtxos, configuredBootstrapRef, "receiver bootstrap")
    : selectBootstrapUtxo(walletUtxos, 0n, [
        protocol.bootstrapRefs.config,
        protocol.bootstrapRefs.paymentHook,
      ]);
  if (!selectedBootstrapUtxo) {
    throw new Error(
      "No suitable pure ADA wallet UTxO is available for receiver script parameterization. Inspect the wallet with 'npm run cli -- wallet:utxos'.",
    );
  }

  const receiverBootstrapRef = {
    txHash: selectedBootstrapUtxo.txHash,
    outputIndex: selectedBootstrapUtxo.outputIndex,
  };
  reportProgress(
    `Using wallet bootstrap UTxO ${receiverBootstrapRef.txHash}#${receiverBootstrapRef.outputIndex}`,
  );
  reportProgress("Deriving parameterized Receiver and Pair scripts offline");
  const resolvedInput = resolveReceiverParameterizeInput(state);
  const configAssetName = splitUnit(protocol.scripts.configUnit).assetName;
  const receiverAssetName = normalizeHex(
    resolvedInput.receiverAssetName,
    "receiverAssetName",
  );
  const receiverMintPolicy = await makeReceiverMintingPolicy({
    bootstrapOutRef: receiverBootstrapRef,
    assetName: receiverAssetName,
    configPolicyId: protocol.scripts.configPolicyId,
    configAssetName,
  });
  const receiverPolicyId = policyIdFromMintingPolicy(receiverMintPolicy);
  const receiverUnit = `${receiverPolicyId}${receiverAssetName}`;
  const receiverValidator = await makeReceiverValidator({
    bootstrapOutRef: receiverBootstrapRef,
    assetName: receiverAssetName,
    configPolicyId: protocol.scripts.configPolicyId,
    configAssetName,
  });
  const receiverValidatorHash = scriptHashFromValidator(receiverValidator);
  const pairMintPolicy = await makePairStateMintingPolicy({
    configPolicyId: protocol.scripts.configPolicyId,
    configAssetName,
    receiverHash: receiverValidatorHash,
  });
  const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
  const pairValidator = await makePairStateValidator({
    configPolicyId: protocol.scripts.configPolicyId,
    configAssetName,
    receiverHash: receiverValidatorHash,
  });
  const receiverMinUtxoLovelace = toBigInt(
    resolvedInput.minUtxoLovelace,
    "minUtxoLovelace",
  );
  assertPositiveMinUtxoLovelace(receiverMinUtxoLovelace, "Receiver");
  const receiverState = {
    balanceLovelace: "0",
    accruedToHookLovelace: "0",
    minUtxoLovelace: receiverMinUtxoLovelace.toString(),
  };

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    scripts: {
      pairPolicyId,
      pairValidatorHash: scriptHashFromValidator(pairValidator),
      pairValidatorAddress: scriptAddressFromValidator(pairValidator),
    },
    receiver: {
      clientId: resolvedInput.clientId.trim(),
      bootstrapRef: receiverBootstrapRef,
      receiverAssetName,
      receiverPolicyId,
      receiverUnit,
      receiverValidatorHash,
      receiverValidatorAddress: scriptAddressFromValidator(receiverValidator),
      receiverState,
    },
    compiledScripts: {
      ...state.compiledScripts,
      receiverMintPolicy: receiverMintPolicy.script,
      receiverValidator: receiverValidator.script,
      pairMintPolicy: pairMintPolicy.script,
      pairValidator: pairValidator.script,
    },
    datum: {
      ...state.datum,
      receiverCbor: buildReceiverDatumCbor(receiverState),
    },
  };
}

function resolveReceiverParameterizeInput(state: ClientStateArtifact): ReceiverParameterizeDefaults {
  const draft = state.drafts?.receiverParameterize;
  const currentReceiver = state.receiver;
  const clientId = draft?.clientId || currentReceiver?.clientId;
  const receiverAssetName =
    draft?.receiverAssetName ||
    currentReceiver?.receiverAssetName;
  const minUtxoLovelace =
    draft?.minUtxoLovelace ||
    currentReceiver?.receiverState.minUtxoLovelace;

  if (!clientId || !receiverAssetName || !minUtxoLovelace) {
    throw new Error(
      "Receiver parameterization requires clientId, receiverAssetName, and minUtxoLovelace in the client artifact. Run client:init first.",
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

function reportProgress(message: string): void {
  console.error(`[receiver:parameterize] ${message}`);
}
