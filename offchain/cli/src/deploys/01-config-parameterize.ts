import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  makeConfigStateMintingPolicy,
  makeConfigStateValidator,
  makeCoordinatorValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  scriptRewardAddress,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import type { ConfigStateArtifact } from "../core/state.js";
import {
  BOOTSTRAP_REF_MIN_LOVELACE,
  buildConfigDatumCbor,
  selectFundingUtxo,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";
import {
  normalizeEthereumAddressHex,
  normalizeHex,
} from "../core/dia-intent.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";

type ConfigParameterizeInput = {
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

export async function parameterizeConfigScripts(args: {
  inputPath: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading config parameterization input from ${path.resolve(args.inputPath)}`);
  const input = await readInput(path.resolve(args.inputPath));

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  const fundingUtxo = selectFundingUtxo(
    walletUtxos,
    [],
    BOOTSTRAP_REF_MIN_LOVELACE,
    "config script parameterization",
  );

  reportProgress("Building Preview config script parameterization transaction");
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

  const bootstrapRef = {
    txHash: submittedTxHash ?? "",
    outputIndex: 0,
  };
  const configAssetName = normalizeHex(input.configAssetName, "configAssetName");
  const configMintPolicy = await makeConfigStateMintingPolicy({
    bootstrapOutRef: bootstrapRef,
    assetName: configAssetName,
  });
  const configPolicyId = policyIdFromMintingPolicy(configMintPolicy);
  const configUnit = `${configPolicyId}${configAssetName}`;
  const configValidator = await makeConfigStateValidator({
    bootstrapOutRef: bootstrapRef,
    assetName: configAssetName,
  });
  const coordinatorValidator = await makeCoordinatorValidator({
    configPolicyId,
    configAssetName: splitUnit(configUnit).assetName,
  });
  const coordinatorHash = scriptHashFromValidator(coordinatorValidator);
  const configState = {
    validConfigSigners:
      input.validConfigSigners?.map((value) => normalizeHex(value, "validConfigSigners[]")) ??
      [walletDefaults.paymentKeyHash],
    authorizedDiaPublicKeys: input.authorizedDiaPublicKeys.map((value) =>
      normalizeHex(value, "authorizedDiaPublicKeys[]"),
    ),
    domain: {
      name: input.domain.name.trim(),
      version: input.domain.version.trim(),
      sourceChainId: toBigInt(input.domain.sourceChainId, "domain.sourceChainId").toString(),
      verifyingContract: normalizeEthereumAddressHex(
        input.domain.verifyingContract,
        "domain.verifyingContract",
      ),
    },
    protocolFeeLovelace: toBigInt(input.protocolFeeLovelace, "protocolFeeLovelace").toString(),
    paymentHookRef: null,
    updateCoordinatorCredential: null,
    minUtxoLovelace: toBigInt(input.minUtxoLovelace, "minUtxoLovelace").toString(),
  };

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    bootstrapRefs: {
      config: bootstrapRef,
      paymentHook: null,
    },
    scripts: {
      configPolicyId,
      configUnit,
      configValidatorHash: scriptHashFromValidator(configValidator),
      configValidatorAddress: scriptAddressFromValidator(configValidator),
      pairPolicyId: null,
      pairValidatorHash: null,
      pairValidatorAddress: null,
      coordinatorHash,
      coordinatorRewardAddress: scriptRewardAddress(coordinatorHash),
      paymentHookPolicyId: null,
      paymentHookUnit: null,
      paymentHookValidatorHash: null,
      paymentHookValidatorAddress: null,
    },
    configState,
    configUtxo: {
      current: {
        txHash: "",
        outputIndex: 0,
      },
    },
    paymentHookState: null,
    paymentHookUtxo: null,
    datum: {
      configCbor: buildConfigDatumCbor(configState),
      paymentHookCbor: null,
    },
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

async function readInput(inputPath: string): Promise<ConfigParameterizeInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ConfigParameterizeInput;
}

function reportProgress(message: string): void {
  console.error(`[preview:config:parameterize] ${message}`);
}
