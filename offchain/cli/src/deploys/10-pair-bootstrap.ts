import { readFile } from "node:fs/promises";
import path from "node:path";
import { Constr, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makePairStateMintingPolicy,
  makePairStateValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
} from "../core/contracts.js";
import {
  diaIntentTokenNameFromSymbol,
  diaIntentToState,
  diaPairIdHex,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  normalizeHex,
  recoverDiaOracleIntentWitness,
  type DiaOracleIntentInput,
} from "../core/dia-intent.js";
import { getDefaultConfigStatePath, readConfigState, type PairStateArtifact } from "../core/state.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";

type PairBootstrapInput = {
  pairTokenName?: string;
  intent: DiaOracleIntentInput;
  minUtxoLovelace: string;
};

export async function pairBootstrap(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<PairStateArtifact> {
  reportProgress(`Loading pair bootstrap input from ${path.resolve(args.inputPath)}`);
  const inputPath = path.resolve(args.inputPath);
  const input = await readPairBootstrapInput(inputPath);

  const statePath = path.resolve(args.statePath ?? getDefaultConfigStatePath());
  reportProgress(`Loading config state from ${statePath}`);
  const state = await readConfigState(statePath);
  if (!("receiver" in state) || !state.receiver) {
    throw new Error(
      "Pair bootstrap requires a receiver state artifact produced by receiver bootstrap.",
    );
  }

  if (!state.bootstrapRefs.config.txHash.length) {
    throw new Error("Config state artifact is missing the Config one-shot parameterization reference.");
  }

  if (!state.configState.updateCoordinatorCredential || !state.configState.paymentHookRef) {
    throw new Error(
      "Pair bootstrap requires a config state artifact produced after payment-hook bootstrap.",
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

  if (!state.configState.validConfigSigners.includes(walletDefaults.paymentKeyHash)) {
    throw new Error(
      "The configured wallet is not authorized as a config signer in the provided state file.",
    );
  }

  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    state.scripts.configUnit,
    "config",
  );
  const walletFundingUtxo = selectFundingUtxo(walletUtxos, [
    state.bootstrapRefs.config,
    state.bootstrapRefs.paymentHook!,
  ]);
  if (!walletFundingUtxo) {
    throw new Error("No suitable wallet UTxO is available to cover pair bootstrap fees.");
  }

  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const pairMintPolicy = await makePairStateMintingPolicy({
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    receiverHash: state.receiver.receiverValidatorHash,
  });
  const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
  if (state.scripts.pairPolicyId && pairPolicyId !== state.scripts.pairPolicyId) {
    throw new Error("State file pair policy id does not match the current blueprint.");
  }

  const pairValidator = await makePairStateValidator({
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    receiverHash: state.receiver.receiverValidatorHash,
  });
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);

  const intent = normalizeDiaOracleIntent(input.intent);
  const pair = {
    tokenName: normalizeHex(
      input.pairTokenName?.trim() && input.pairTokenName.trim().length > 0
        ? input.pairTokenName
        : diaIntentTokenNameFromSymbol(intent),
      "pairTokenName",
    ),
    pairId: diaPairIdHex(intent),
  };
  const domain = normalizeDiaEip712Domain({
    name: state.configState.domain.name,
    version: state.configState.domain.version,
    sourceChainId: state.configState.domain.sourceChainId,
    verifyingContract: state.configState.domain.verifyingContract,
  });
  const witness = recoverDiaOracleIntentWitness(domain, intent);
  if (!state.configState.authorizedDiaPublicKeys.includes(witness.signerPublicKey)) {
    throw new Error(
      `Recovered DIA signer public key ${witness.signerPublicKey} is not authorized in the current config state.`,
    );
  }

  const pairUnit = `${pairPolicyId}${pair.tokenName}`;
  const pairState = {
    pairId: pair.pairId,
    price: "0",
    timestamp: "0",
    nonce: "0",
    intentHash: "00".repeat(32),
    signer: "00".repeat(20),
    minUtxoLovelace: toBigInt(input.minUtxoLovelace, "minUtxoLovelace").toString(),
    intent: diaIntentToState(intent),
  };

  const pairMintRedeemer = Data.to(
    new Constr<PlutusData>(0, [pair.pairId]),
  );
  const pairDatumCbor = buildPairDatumCbor(pairState);

  reportProgress("Building Preview pair bootstrap transaction");
  const txBuilder = lucid
    .newTx()
    .readFrom([currentConfigUtxo])
    .collectFrom([walletFundingUtxo])
    .addSignerKey(walletDefaults.paymentKeyHash)
    .attach.MintingPolicy(pairMintPolicy)
    .mintAssets({ [pairUnit]: 1n }, pairMintRedeemer)
    .pay.ToContract(
      pairValidatorAddress,
      { kind: "inline", value: pairDatumCbor },
      {
        lovelace: BigInt(pairState.minUtxoLovelace),
        [pairUnit]: 1n,
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

  const latestConfigUtxo =
    args.buildOnly || !confirmed
      ? state.configUtxo.current
      : await findSingleUtxoAtUnit(
          lucid,
          state.scripts.configValidatorAddress,
          state.scripts.configUnit,
          "config",
        );
  const pairStateUtxo =
    args.buildOnly || !confirmed
      ? { txHash: "", outputIndex: 0 }
      : await findSingleUtxoAtUnit(
          lucid,
          pairValidatorAddress,
          pairUnit,
          "pair",
        );

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    bootstrapRefs: {
      config: state.bootstrapRefs.config,
      paymentHook: state.bootstrapRefs.paymentHook!,
    },
    scripts: {
      ...state.scripts,
      pairPolicyId,
      pairValidatorHash,
      pairValidatorAddress,
    },
    configState: state.configState,
    configUtxo: {
      current: latestConfigUtxo,
    },
    paymentHookState: state.paymentHookState!,
    paymentHookUtxo: state.paymentHookUtxo!,
    referenceScripts: state.referenceScripts,
    receiver: state.receiver,
    pair: {
      tokenName: pair.tokenName,
      pairId: pair.pairId,
      pairUnit,
      pairValidatorAddress,
      stateUtxo: pairStateUtxo,
    },
    pairState,
    datum: {
      configCbor: state.datum.configCbor,
      paymentHookCbor: state.datum.paymentHookCbor!,
      receiverCbor: state.datum.receiverCbor,
      pairCbor: pairDatumCbor,
    },
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:pair:bootstrap] ${message}`);
}

async function readPairBootstrapInput(inputPath: string): Promise<PairBootstrapInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as PairBootstrapInput;
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
