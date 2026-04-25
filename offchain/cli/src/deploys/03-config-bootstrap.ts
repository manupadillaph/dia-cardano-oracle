import { readFile } from "node:fs/promises";
import path from "node:path";
import { Constr, type OutRef, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeConfigStateMintingPolicy,
  makeConfigStateValidator,
  makeCoordinatorValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptCredentialState,
  scriptHashFromValidator,
  scriptRewardAddress,
} from "../core/contracts.js";
import {
  normalizeEthereumAddressHex,
  normalizeHex,
  utf8ToHex,
} from "../core/dia-intent.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { readConfigState, type ConfigStateArtifact } from "../core/state.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import { findUtxoByOutRef, selectFundingUtxo } from "../core/chain-helpers.js";

type ConfigBootstrapInput = {
  bootstrapRef?: {
    txHash: string;
    outputIndex: number;
  };
  configAssetName: string;
  validConfigSigners?: string[];
  authorizedDiaPublicKeys: string[];
  domain: {
    name: string;
    version: string;
    sourceChainId: number | string;
    verifyingContract: string;
  };
  protocolFeeLovelace: string;
  minUtxoLovelace: string;
};

type ResolvedConfigBootstrapInput = {
  configAssetName: string;
  validConfigSigners: string[];
  authorizedDiaPublicKeys: string[];
  domain: {
    name: string;
    version: string;
    sourceChainId: bigint;
    verifyingContract: string;
  };
  protocolFeeLovelace: bigint;
  minUtxoLovelace: bigint;
};

export async function configBootstrap(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading config bootstrap input from ${path.resolve(args.inputPath)}`);
  const inputPath = path.resolve(args.inputPath);
  const input = await readConfigBootstrapInput(inputPath);
  const previousState = args.statePath
    ? await readConfigState(path.resolve(args.statePath))
    : null;

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const walletAddress = await wallet.address();
  const walletUtxos = await wallet.getUtxos();
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });
  const resolvedInput = resolveConfigBootstrapInput(input, walletDefaults);

  const configuredBootstrapRef =
    input.bootstrapRef ??
    (previousState?.bootstrapRefs.config.txHash
      ? previousState.bootstrapRefs.config
      : undefined);
  const walletBootstrapUtxo = configuredBootstrapRef
    ? findUtxoByOutRef(walletUtxos, configuredBootstrapRef, "config bootstrap")
    : selectBootstrapUtxo(walletUtxos, resolvedInput.minUtxoLovelace);

  if (!walletBootstrapUtxo) {
    throw new Error(
      "No suitable wallet UTxO is available for config bootstrap. Fund the configured Preview wallet and inspect it with 'npm run cli -- preview:wallet:utxos'.",
    );
  }

  const bootstrapOutRef: OutRef = {
    txHash: walletBootstrapUtxo.txHash,
    outputIndex: walletBootstrapUtxo.outputIndex,
  };
  reportProgress(
    `Selected wallet bootstrap UTxO ${bootstrapOutRef.txHash}#${bootstrapOutRef.outputIndex}`,
  );

  reportProgress("Deriving Config and global Coordinator scripts from the current blueprint");
  const configAssetName = normalizeHex(
    resolvedInput.configAssetName,
    "configAssetName",
  );
  const configMintPolicy = await makeConfigStateMintingPolicy({
    bootstrapOutRef,
    assetName: configAssetName,
  });
  const configPolicyId = policyIdFromMintingPolicy(configMintPolicy);
  if (previousState?.scripts.configPolicyId && previousState.scripts.configPolicyId !== configPolicyId) {
    throw new Error("Config bootstrap input does not match the previously published Config reference script.");
  }
  const configUnit = `${configPolicyId}${configAssetName}`;

  const configValidator = await makeConfigStateValidator({
    bootstrapOutRef,
    assetName: configAssetName,
  });
  const configValidatorHash = scriptHashFromValidator(configValidator);
  const configValidatorAddress = scriptAddressFromValidator(configValidator);

  const coordinatorValidator = await makeCoordinatorValidator({
    configPolicyId,
    configAssetName,
  });
  const coordinatorHash = scriptHashFromValidator(coordinatorValidator);
  const coordinatorRewardAddress = scriptRewardAddress(coordinatorHash);

  const configDatumCbor = buildConfigDatumCbor(resolvedInput);
  const mintRedeemer = Data.to(new Constr(0, []));
  const fundingUtxos =
    (walletBootstrapUtxo.assets.lovelace ?? 0n) >=
    resolvedInput.minUtxoLovelace + 2_000_000n
      ? []
      : [
          selectFundingUtxo(
            walletUtxos,
            [
              bootstrapOutRef,
              ...(previousState?.bootstrapRefs.paymentHook
                ? [previousState.bootstrapRefs.paymentHook]
                : []),
            ],
            resolvedInput.minUtxoLovelace + 2_000_000n,
            "config bootstrap",
          ),
        ];

  reportProgress("Building Preview config bootstrap transaction");
  const txBuilder = lucid
    .newTx()
    .collectFrom([walletBootstrapUtxo, ...fundingUtxos])
    .attach.MintingPolicy(configMintPolicy)
    .mintAssets({ [configUnit]: 1n }, mintRedeemer)
    .pay.ToContract(
      configValidatorAddress,
      { kind: "inline", value: configDatumCbor },
      {
        lovelace: resolvedInput.minUtxoLovelace,
        [configUnit]: 1n,
      },
    );

  const txSignBuilder = await txBuilder.complete();
  const unsignedHash = txSignBuilder.toHash();
  const unsignedCbor = txSignBuilder.toCBOR();

  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(`Unsigned transaction ready: ${unsignedHash}`);
    reportProgress("Signing transaction with the configured wallet");
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    reportProgress("Submitting transaction to Preview");
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    reportProgress("Waiting for transaction confirmation on Preview");
    confirmed = await lucid.awaitTx(submittedTxHash, 3_000);

    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }
  }

  const currentConfigUtxo =
    args.buildOnly || !confirmed
      ? {
          txHash: "",
          outputIndex: 0,
        }
      : await waitForUtxoAtUnit(
          lucid,
          configValidatorAddress,
          configUnit,
          "config",
        );

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    bootstrapRefs: {
      config: bootstrapOutRef,
      paymentHook: previousState?.bootstrapRefs.paymentHook ?? null,
    },
    scripts: {
      configPolicyId,
      configUnit,
      configValidatorHash,
      configValidatorAddress,
      pairPolicyId: previousState?.scripts.pairPolicyId ?? null,
      pairValidatorHash: previousState?.scripts.pairValidatorHash ?? null,
      pairValidatorAddress: previousState?.scripts.pairValidatorAddress ?? null,
      coordinatorHash,
      coordinatorRewardAddress,
      paymentHookPolicyId: previousState?.scripts.paymentHookPolicyId ?? null,
      paymentHookUnit: previousState?.scripts.paymentHookUnit ?? null,
      paymentHookValidatorHash: previousState?.scripts.paymentHookValidatorHash ?? null,
      paymentHookValidatorAddress: previousState?.scripts.paymentHookValidatorAddress ?? null,
    },
    configState: {
      validConfigSigners: resolvedInput.validConfigSigners,
      authorizedDiaPublicKeys: resolvedInput.authorizedDiaPublicKeys,
      domain: {
        name: resolvedInput.domain.name,
        version: resolvedInput.domain.version,
        sourceChainId: resolvedInput.domain.sourceChainId.toString(),
        verifyingContract: resolvedInput.domain.verifyingContract,
      },
      protocolFeeLovelace: resolvedInput.protocolFeeLovelace.toString(),
      paymentHookRef: null,
      updateCoordinatorCredential: null,
      minUtxoLovelace: resolvedInput.minUtxoLovelace.toString(),
    },
    configUtxo: {
      current: currentConfigUtxo,
    },
    paymentHookState: previousState?.paymentHookState ?? null,
    paymentHookUtxo: previousState?.paymentHookUtxo ?? null,
    datum: {
      configCbor: configDatumCbor,
      paymentHookCbor: null,
    },
    referenceScripts: previousState?.referenceScripts,
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:config:bootstrap] ${message}`);
}

async function readConfigBootstrapInput(
  inputPath: string,
): Promise<ConfigBootstrapInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ConfigBootstrapInput;
}

function resolveConfigBootstrapInput(
  input: ConfigBootstrapInput,
  walletDefaults: ReturnType<typeof deriveConfiguredWalletDefaults>,
): ResolvedConfigBootstrapInput {
  const validConfigSigners =
    input.validConfigSigners && input.validConfigSigners.length > 0
      ? input.validConfigSigners.map((value) =>
          normalizeHex(value, "validConfigSigners[]"),
        )
      : [walletDefaults.paymentKeyHash];

  return {
    configAssetName: input.configAssetName,
    validConfigSigners,
    authorizedDiaPublicKeys: input.authorizedDiaPublicKeys.map((value) =>
      normalizeHex(value, "authorizedDiaPublicKeys[]"),
    ),
    domain: {
      name: input.domain.name.trim(),
      version: input.domain.version.trim(),
      sourceChainId: toBigInt(input.domain.sourceChainId, "domain.sourceChainId"),
      verifyingContract: normalizeEthereumAddressHex(
        input.domain.verifyingContract,
        "domain.verifyingContract",
      ),
    },
    protocolFeeLovelace: toBigInt(input.protocolFeeLovelace, "protocolFeeLovelace"),
    minUtxoLovelace: toBigInt(input.minUtxoLovelace, "minUtxoLovelace"),
  };
}

function buildConfigDatumCbor(input: ResolvedConfigBootstrapInput): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      input.validConfigSigners.map((value) => normalizeHex(value, "validConfigSigners[]")),
      input.authorizedDiaPublicKeys.map((value) =>
        normalizeHex(value, "authorizedDiaPublicKeys[]"),
      ),
      new Constr<PlutusData>(0, [
        utf8ToHex(input.domain.name),
        utf8ToHex(input.domain.version),
        input.domain.sourceChainId,
        normalizeHex(input.domain.verifyingContract, "domain.verifyingContract"),
      ]),
      input.protocolFeeLovelace,
      noneData(),
      noneData(),
      input.minUtxoLovelace,
    ]),
  );
}

function noneData(): Constr<PlutusData> {
  return new Constr<PlutusData>(1, []);
}

function selectBootstrapUtxo(
  utxos: UTxO[],
  requiredLovelace: bigint,
): UTxO | null {
  return (
    utxos
      .filter((utxo) => Object.keys(utxo.assets).length === 1)
      .filter((utxo) => (utxo.assets.lovelace ?? 0n) >= requiredLovelace)
      .sort((left, right) => {
        const leftValue = left.assets.lovelace ?? 0n;
        const rightValue = right.assets.lovelace ?? 0n;
        if (leftValue === rightValue) return 0;
        return leftValue > rightValue ? -1 : 1;
      })[0] ?? null
  );
}

async function waitForUtxoAtUnit(
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>,
  address: string,
  unit: string,
  label: string,
): Promise<{
  txHash: string;
  outputIndex: number;
}> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const utxos = await lucid.utxosAtWithUnit(address, unit);
    if (utxos.length === 1) {
      return {
        txHash: utxos[0].txHash,
        outputIndex: utxos[0].outputIndex,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(
    `Unable to observe the current ${label} UTxO at ${address} with unit ${unit}.`,
  );
}

function toBigInt(value: string | number, label: string): bigint {
  const normalized = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Expected ${label} to be an integer.`);
  }
  return BigInt(normalized);
}
