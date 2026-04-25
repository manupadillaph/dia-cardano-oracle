import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  makePaymentHookMintingPolicy,
  makePaymentHookValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { readConfigState, type ConfigStateArtifact } from "../core/state.js";
import {
  BOOTSTRAP_REF_MIN_LOVELACE,
  buildPaymentHookDatumCbor,
  selectFundingUtxo,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";
import { normalizeHex } from "../core/dia-intent.js";

type PaymentHookParameterizeInput = {
  paymentHookAssetName: string;
  withdrawAddress?: string;
  minUtxoLovelace: string;
};

export async function parameterizePaymentHookScripts(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading payment-hook parameterization input from ${path.resolve(args.inputPath)}`);
  const input = await readInput(path.resolve(args.inputPath));
  const state = await readConfigState(path.resolve(args.statePath ?? "state/preview/config-bootstrap.json"));

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const fundingUtxo = selectFundingUtxo(
    walletUtxos,
    [state.bootstrapRefs.config],
    BOOTSTRAP_REF_MIN_LOVELACE,
    "payment-hook script parameterization",
  );

  reportProgress("Building Preview payment-hook script parameterization transaction");
  const txSignBuilder = await lucid
    .newTx()
    .collectFrom([fundingUtxo])
    .pay.ToAddress(walletAddress, { lovelace: BOOTSTRAP_REF_MIN_LOVELACE })
    .complete();
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

  const paymentHookBootstrapRef = {
    txHash: submittedTxHash ?? "",
    outputIndex: 0,
  };
  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const paymentHookAssetName = normalizeHex(input.paymentHookAssetName, "paymentHookAssetName");
  const paymentHookMintPolicy = await makePaymentHookMintingPolicy({
    bootstrapOutRef: paymentHookBootstrapRef,
    assetName: paymentHookAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    coordinatorCredentialHash: state.scripts.coordinatorHash,
  });
  const paymentHookPolicyId = policyIdFromMintingPolicy(paymentHookMintPolicy);
  const paymentHookUnit = `${paymentHookPolicyId}${paymentHookAssetName}`;
  const paymentHookValidator = await makePaymentHookValidator({
    bootstrapOutRef: paymentHookBootstrapRef,
    assetName: paymentHookAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    coordinatorCredentialHash: state.scripts.coordinatorHash,
  });
  const paymentHookState = {
    withdrawAddress: input.withdrawAddress?.trim().length
      ? input.withdrawAddress.trim()
      : walletAddress,
    minUtxoLovelace: toBigInt(input.minUtxoLovelace, "minUtxoLovelace").toString(),
    accruedFeesLovelace: "0",
    lifetimeCollectedLovelace: "0",
    lifetimeWithdrawnLovelace: "0",
  };

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    bootstrapRefs: {
      ...state.bootstrapRefs,
      paymentHook: paymentHookBootstrapRef,
    },
    scripts: {
      ...state.scripts,
      paymentHookPolicyId,
      paymentHookUnit,
      paymentHookValidatorHash: scriptHashFromValidator(paymentHookValidator),
      paymentHookValidatorAddress: scriptAddressFromValidator(paymentHookValidator),
    },
    paymentHookState,
    paymentHookUtxo: {
      current: {
        txHash: "",
        outputIndex: 0,
      },
    },
    datum: {
      ...state.datum,
      paymentHookCbor: buildPaymentHookDatumCbor(paymentHookState),
    },
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

async function readInput(inputPath: string): Promise<PaymentHookParameterizeInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as PaymentHookParameterizeInput;
}

function reportProgress(message: string): void {
  console.error(`[preview:payment-hook:parameterize] ${message}`);
}
