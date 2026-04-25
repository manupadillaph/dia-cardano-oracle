import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Constr,
  getAddressDetails,
  type OutRef,
  type UTxO,
} from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeConfigStateValidator,
  makePaymentHookMintingPolicy,
  makePaymentHookValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptCredentialState,
  scriptHashFromValidator,
} from "../core/contracts.js";
import { normalizeHex } from "../core/dia-intent.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { readConfigState, type ConfigStateArtifact } from "../core/state.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import { findUtxoByOutRef, selectFundingUtxo } from "../core/chain-helpers.js";

type PaymentHookBootstrapInput = {
  bootstrapRef?: {
    txHash: string;
    outputIndex: number;
  };
  paymentHookAssetName: string;
  withdrawAddress?: string;
  minUtxoLovelace: string;
};

export async function paymentHookBootstrap(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading payment-hook bootstrap input from ${path.resolve(args.inputPath)}`);
  const inputPath = path.resolve(args.inputPath);
  const input = await readPaymentHookBootstrapInput(inputPath);

  const statePath = path.resolve(args.statePath ?? "state/preview/config-bootstrap.json");
  reportProgress(`Loading config state from ${statePath}`);
  const state = await readConfigState(statePath);

  if (state.bootstrapRefs.config.txHash.length === 0) {
    throw new Error("Config state artifact is missing the Config one-shot parameterization reference.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const walletAddress = await wallet.address();
  const walletUtxos = await wallet.getUtxos();
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  if (!state.configState.validConfigSigners.includes(walletDefaults.paymentKeyHash)) {
    throw new Error(
      "The configured wallet is not authorized as a config signer in the provided config state.",
    );
  }

  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    state.scripts.configUnit,
    "config",
  );

  const configuredBootstrapRef =
    input.bootstrapRef ??
    (state.bootstrapRefs.paymentHook?.txHash
      ? state.bootstrapRefs.paymentHook
      : undefined);
  const paymentHookBootstrapUtxo = configuredBootstrapRef
    ? findUtxoByOutRef(walletUtxos, configuredBootstrapRef, "payment-hook bootstrap")
    : selectBootstrapUtxo(
        walletUtxos,
        toBigInt(input.minUtxoLovelace, "minUtxoLovelace"),
        [state.bootstrapRefs.config],
      );
  if (!paymentHookBootstrapUtxo) {
    throw new Error(
      "No suitable wallet UTxO is available for payment-hook bootstrap.",
    );
  }

  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const configBootstrapOutRef: OutRef = state.bootstrapRefs.config;
  const paymentHookBootstrapOutRef: OutRef = {
    txHash: paymentHookBootstrapUtxo.txHash,
    outputIndex: paymentHookBootstrapUtxo.outputIndex,
  };
  const paymentHookMinUtxoLovelace = toBigInt(input.minUtxoLovelace, "minUtxoLovelace");
  const fundingUtxos =
    (paymentHookBootstrapUtxo.assets.lovelace ?? 0n) >=
    paymentHookMinUtxoLovelace + 4_000_000n
      ? []
      : [
          selectFundingUtxo(
            walletUtxos,
            [state.bootstrapRefs.config, paymentHookBootstrapOutRef],
            paymentHookMinUtxoLovelace + 4_000_000n,
            "payment-hook bootstrap",
          ),
        ];

  const configValidator = await makeConfigStateValidator({
    bootstrapOutRef: configBootstrapOutRef,
    assetName: configAssetName,
  });
  const paymentHookAssetName = normalizeHex(
    input.paymentHookAssetName,
    "paymentHookAssetName",
  );
  const paymentHookMintPolicy = await makePaymentHookMintingPolicy({
    bootstrapOutRef: paymentHookBootstrapOutRef,
    assetName: paymentHookAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    coordinatorCredentialHash: state.scripts.coordinatorHash,
  });
  const paymentHookPolicyId = policyIdFromMintingPolicy(paymentHookMintPolicy);
  if (
    state.scripts.paymentHookPolicyId &&
    state.scripts.paymentHookPolicyId !== paymentHookPolicyId
  ) {
    throw new Error("PaymentHook bootstrap input does not match the previously published PaymentHook reference script.");
  }
  const paymentHookUnit = `${paymentHookPolicyId}${paymentHookAssetName}`;

  const paymentHookValidator = await makePaymentHookValidator({
    bootstrapOutRef: paymentHookBootstrapOutRef,
    assetName: paymentHookAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    coordinatorCredentialHash: state.scripts.coordinatorHash,
  });
  const paymentHookValidatorHash = scriptHashFromValidator(paymentHookValidator);
  const paymentHookValidatorAddress = scriptAddressFromValidator(paymentHookValidator);

  const nextConfigState = {
    ...state.configState,
    paymentHookRef: {
      policyId: paymentHookPolicyId,
      assetName: paymentHookAssetName,
      unit: paymentHookUnit,
    },
    updateCoordinatorCredential: scriptCredentialState(state.scripts.coordinatorHash),
  };

  const paymentHookState = {
    withdrawAddress: input.withdrawAddress?.trim().length
      ? input.withdrawAddress.trim()
      : walletAddress,
    minUtxoLovelace: paymentHookMinUtxoLovelace.toString(),
    accruedFeesLovelace: "0",
    lifetimeCollectedLovelace: "0",
    lifetimeWithdrawnLovelace: "0",
  };

  const configDatumCbor = buildConfigDatumCbor(nextConfigState);
  const paymentHookDatumCbor = buildPaymentHookDatumCbor(paymentHookState);
  const adminUpdateRedeemer = Data.to(new Constr(0, []));
  const mintRedeemer = Data.to(new Constr(0, []));

  reportProgress("Building Preview payment-hook bootstrap transaction");
  const txBuilder = lucid
    .newTx()
    .collectFrom([currentConfigUtxo], adminUpdateRedeemer)
    .collectFrom([paymentHookBootstrapUtxo, ...fundingUtxos])
    .addSignerKey(walletDefaults.paymentKeyHash)
    .register.Stake(state.scripts.coordinatorRewardAddress)
    .attach.SpendingValidator(configValidator)
    .attach.MintingPolicy(paymentHookMintPolicy)
    .mintAssets({ [paymentHookUnit]: 1n }, mintRedeemer)
    .pay.ToContract(
      state.scripts.configValidatorAddress,
      { kind: "inline", value: configDatumCbor },
      { ...currentConfigUtxo.assets },
    )
    .pay.ToContract(
      paymentHookValidatorAddress,
      { kind: "inline", value: paymentHookDatumCbor },
      {
        lovelace: BigInt(paymentHookState.minUtxoLovelace),
        [paymentHookUnit]: 1n,
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
  const latestPaymentHookUtxo =
    args.buildOnly || !confirmed
      ? { txHash: "", outputIndex: 0 }
      : await findSingleUtxoAtUnit(
          lucid,
          paymentHookValidatorAddress,
          paymentHookUnit,
          "payment hook",
        );

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    bootstrapRefs: {
      config: state.bootstrapRefs.config,
      paymentHook: paymentHookBootstrapOutRef,
    },
    scripts: {
      ...state.scripts,
      paymentHookPolicyId,
      paymentHookUnit,
      paymentHookValidatorHash,
      paymentHookValidatorAddress,
    },
    configState: nextConfigState,
    configUtxo: {
      current: latestConfigUtxo,
    },
    paymentHookState,
    paymentHookUtxo: {
      current: latestPaymentHookUtxo,
    },
    referenceScripts: state.referenceScripts,
    datum: {
      configCbor: configDatumCbor,
      paymentHookCbor: paymentHookDatumCbor,
    },
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:payment-hook:bootstrap] ${message}`);
}

async function readPaymentHookBootstrapInput(
  inputPath: string,
): Promise<PaymentHookBootstrapInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as PaymentHookBootstrapInput;
}

function buildConfigDatumCbor(state: ConfigStateArtifact["configState"]): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      state.validConfigSigners.map((value) => normalizeHex(value, "validConfigSigners[]")),
      state.authorizedDiaPublicKeys.map((value) =>
        normalizeHex(value, "authorizedDiaPublicKeys[]"),
      ),
      new Constr<PlutusData>(0, [
        Buffer.from(state.domain.name, "utf8").toString("hex"),
        Buffer.from(state.domain.version, "utf8").toString("hex"),
        BigInt(state.domain.sourceChainId),
        normalizeHex(state.domain.verifyingContract, "domain.verifyingContract"),
      ]),
      BigInt(state.protocolFeeLovelace),
      state.paymentHookRef
        ? new Constr<PlutusData>(0, [
            new Constr<PlutusData>(0, [
              state.paymentHookRef.policyId,
              state.paymentHookRef.assetName,
            ]),
          ])
        : new Constr<PlutusData>(1, []),
      state.updateCoordinatorCredential
        ? new Constr<PlutusData>(0, [
            state.updateCoordinatorCredential.type === "Script"
              ? new Constr<PlutusData>(1, [state.updateCoordinatorCredential.hash])
              : new Constr<PlutusData>(0, [state.updateCoordinatorCredential.hash]),
          ])
        : new Constr<PlutusData>(1, []),
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

function buildPaymentHookDatumCbor(
  state: NonNullable<ConfigStateArtifact["paymentHookState"]>,
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

function selectBootstrapUtxo(
  utxos: UTxO[],
  requiredLovelace: bigint,
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
      .filter((utxo) => (utxo.assets.lovelace ?? 0n) >= requiredLovelace)
      .sort((left, right) => {
        const leftValue = left.assets.lovelace ?? 0n;
        const rightValue = right.assets.lovelace ?? 0n;
        if (leftValue === rightValue) return 0;
        return leftValue > rightValue ? -1 : 1;
      })[0] ?? null
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
