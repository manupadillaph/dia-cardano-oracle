import path from "node:path";
import { Constr, type OutRef, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeReceiverMintingPolicy,
  makeReceiverValidator,
  makePairStateMintingPolicy,
  makePairStateValidator,
  mintingPolicyFromCompiledScript,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import { normalizeHex } from "../core/dia-intent.js";
import {
  appendTransactionRecord,
  type ClientStateArtifact,
} from "../core/state.js";
import { readClientContext } from "../core/artifact-context.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  findUtxoByOutRef,
  selectFundingUtxo,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";

export async function receiverBootstrap(args: {
  statePath?: string;
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
  reportProgress("Using Receiver values from the client artifact");

  const statePath = path.resolve(args.statePath ?? "state/preview/clients/client-a.json");
  reportProgress(`Loading config state from ${statePath}`);
  const { client: state, protocol } = await readClientContext({
    clientStatePath: statePath,
    protocolStatePath: args.protocolStatePath,
  });

  if (state.receiver?.receiverUtxo.current.txHash) {
    throw new Error(
      "Receiver bootstrap was already completed for this client artifact. Reuse the current artifact and continue with the next step instead of running preview:receiver:bootstrap again.",
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
    : selectBootstrapUtxo(walletUtxos, [
        protocol.bootstrapRefs.config,
        protocol.bootstrapRefs.paymentHook!,
      ]);
  if (!receiverBootstrapUtxo) {
    throw new Error("No suitable wallet UTxO is available for receiver bootstrap.");
  }

  const configAssetName = splitUnit(protocol.scripts.configUnit).assetName;
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

  const receiverMintPolicy = state.compiledScripts?.receiverMintPolicy
    ? mintingPolicyFromCompiledScript(state.compiledScripts.receiverMintPolicy)
    : await makeReceiverMintingPolicy({
        bootstrapOutRef: receiverBootstrapOutRef,
        assetName: receiverAssetName,
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
      });
  const receiverPolicyId = policyIdFromMintingPolicy(receiverMintPolicy);
  const receiverUnit = `${receiverPolicyId}${receiverAssetName}`;

  const receiverValidator = state.compiledScripts?.receiverValidator
    ? spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator)
    : await makeReceiverValidator({
        bootstrapOutRef: receiverBootstrapOutRef,
        assetName: receiverAssetName,
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
      });
  const receiverValidatorHash = scriptHashFromValidator(receiverValidator);
  const receiverValidatorAddress = scriptAddressFromValidator(receiverValidator);

  const pairMintPolicy = state.compiledScripts?.pairMintPolicy
    ? mintingPolicyFromCompiledScript(state.compiledScripts.pairMintPolicy)
    : await makePairStateMintingPolicy({
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
        receiverHash: receiverValidatorHash,
      });
  const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
  const pairValidator = state.compiledScripts?.pairValidator
    ? spendingValidatorFromCompiledScript(state.compiledScripts.pairValidator)
    : await makePairStateValidator({
        configPolicyId: protocol.scripts.configPolicyId,
        configAssetName,
        receiverHash: receiverValidatorHash,
      });
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);

  const receiverState = {
    balanceLovelace: "0",
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
      spentUtxos: [receiverBootstrapUtxo, ...fundingUtxos],
      label: "receiver bootstrap",
    });
  }

  const latestReceiverUtxo =
    args.buildOnly || !confirmed
      ? { txHash: "", outputIndex: 0 }
      : await findSingleUtxoAtUnit(lucid, receiverValidatorAddress, receiverUnit, "receiver");

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
      receiverUtxo: {
        current: {
          txHash: latestReceiverUtxo.txHash,
          outputIndex: latestReceiverUtxo.outputIndex,
        },
      },
    },
    datum: {
      ...state.datum,
      receiverCbor: receiverDatumCbor,
    },
    transactions: appendTransactionRecord(state.transactions, {
      step: "preview:receiver:bootstrap",
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:receiver:bootstrap] ${message}`);
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
      "Receiver bootstrap requires the Receiver values already stored in the client artifact. Run preview:client:init and preview:receiver:parameterize first.",
    );
  }

  return {
    clientId,
    receiverAssetName: normalizeHex(receiverAssetName, "receiverAssetName"),
    minUtxoLovelace: toBigInt(minUtxoLovelace, "minUtxoLovelace").toString(),
  };
}

function buildReceiverDatumCbor(state: {
  balanceLovelace: string;
  minUtxoLovelace: string;
}): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      BigInt(state.balanceLovelace),
      BigInt(state.minUtxoLovelace),
    ]),
  );
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

function selectBootstrapUtxo(
  utxos: UTxO[],
  excludedOutRefs: Array<{ txHash: string; outputIndex: number }>,
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

function splitUnit(unit: string): { policyId: string; assetName: string } {
  const normalizedUnit = normalizeHex(unit, "unit");
  return {
    policyId: normalizedUnit.slice(0, 56),
    assetName: normalizedUnit.slice(56),
  };
}

function toBigInt(value: string | number, label: string): bigint {
  const normalized = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Expected ${label} to be an integer.`);
  }
  return BigInt(normalized);
}
