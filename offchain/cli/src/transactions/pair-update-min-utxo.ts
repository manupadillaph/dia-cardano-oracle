import path from "node:path";
import { Constr } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";

import { spendingValidatorFromCompiledScript } from "../core/contracts.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  readClientState,
  readConfigState,
  readPairState,
  type PairStateArtifact,
} from "../core/state.js";
import { isAnyReferenceScriptMissing, loadReferenceScriptUtxos } from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildPairDatumCbor,
  decodePairDatum,
  findSingleUtxoAtUnit,
  requireInlineDatum,
  toBigInt,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertConfigUtxoLivesAtValidatorAddress,
} from "../preflight/index.js";

export async function pairUpdateMinUtxo(args: {
  newMinUtxoLovelace: string;
  protocolStatePath: string;
  clientStatePath: string;
  pairStatePath: string;
  buildOnly: boolean;
}): Promise<PairStateArtifact> {
  reportProgress("Loading protocol, client and pair state");
  const protocol = await readConfigState(path.resolve(args.protocolStatePath));
  const client = await readClientState(path.resolve(args.clientStatePath));
  const pair = await readPairState(path.resolve(args.pairStatePath));

  if (!pair.pairState) {
    throw new Error("Pair state does not have pairState. Run update first.");
  }

  const newMinUtxo = toBigInt(args.newMinUtxoLovelace, "newMinUtxoLovelace");
  if (newMinUtxo <= 0n) {
    throw new Error("Pair min_utxo_lovelace must be greater than zero lovelace.");
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

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    protocol.configState.validConfigSigners,
    {
      unauthorizedMessage: "The configured wallet is not authorized as a config signer.",
    },
  );

  reportProgress("Finding Config UTxO");
  const configUtxo = await findSingleUtxoAtUnit(
    lucid,
    protocol.scripts.configValidatorAddress,
    protocol.scripts.configUnit,
    "config",
  );
  assertConfigUtxoLivesAtValidatorAddress(
    configUtxo.address,
    protocol.scripts.configValidatorAddress,
  );

  reportProgress("Finding Pair UTxO");
  const pairUnit = pair.pair.pairUnit;
  const pairValidatorAddress = pair.pair.pairValidatorAddress;
  const currentPairUtxo = await findSingleUtxoAtUnit(
    lucid,
    pairValidatorAddress,
    pairUnit,
    "pair",
  );

  const currentPairDatumCbor = requireInlineDatum(currentPairUtxo, "pair");
  const currentPairState = decodePairDatum(currentPairDatumCbor);

  reportProgress(`Updating Pair min_utxo from ${currentPairState.minUtxoLovelace} to ${newMinUtxo}`);

  const nextPairDatumCbor = buildPairDatumCbor({
    ...currentPairState,
    minUtxoLovelace: newMinUtxo.toString(),
  });

  // Build the UpdateMinUtxo redeemer
  // PairSpendAction::UpdateMinUtxo { new_min_utxo_lovelace: Int }
  const updateMinUtxoRedeemer = Data.to(
    new Constr(1, [newMinUtxo]) // Index 1 = UpdateMinUtxo (after ApplyUpdate at index 0)
  );

  reportProgress("Building Preview pair update-min-utxo transaction");

  const { utxos: referenceScriptUtxos, missing: missingReferenceScript } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "pair",
          label: "pair_state spend",
          outRef: client.referenceScripts?.client?.pair
            ? {
                txHash: client.referenceScripts.client.pair.txHash,
                outputIndex: client.referenceScripts.client.pair.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  if (!client.compiledScripts?.pairValidator) {
    throw new Error("pairValidator compiled script not found. Run client:init first.");
  }
  const pairValidator = spendingValidatorFromCompiledScript(
    client.compiledScripts.pairValidator,
  );

  let txBuilder = lucid
    .newTx()
    .readFrom([configUtxo])
    .collectFrom([currentPairUtxo], updateMinUtxoRedeemer)
    .addSignerKey(walletDefaults.paymentKeyHash)
    .pay.ToContract(
      pairValidatorAddress,
      { kind: "inline", value: nextPairDatumCbor },
      {
        lovelace: newMinUtxo,
        [pairUnit]: 1n,
      },
    );

  if (isAnyReferenceScriptMissing(missingReferenceScript)) {
    reportProgress("Reference script for pair is missing; attaching inline.");
    txBuilder = txBuilder.attach.SpendingValidator(pairValidator);
  } else {
    txBuilder = txBuilder.readFrom(referenceScriptUtxos);
  }

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
      label: "pair update-min-utxo transaction",
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
      label: "pair update-min-utxo",
      requireChangeWhenNoSpentUtxos: true,
    });

    await waitForUnitUtxoReplacement({
      lucid,
      address: pairValidatorAddress,
      unit: pairUnit,
      label: "pair",
      previousOutRef: currentPairUtxo,
    });
  }

  const updatedPair: PairStateArtifact = {
    ...pair,
    pairState: {
      ...currentPairState,
      intent: pair.pairState.intent,
      minUtxoLovelace: newMinUtxo.toString(),
    },
    datum: {
      pairCbor: nextPairDatumCbor,
    },
    transactions: appendTransactionRecord(pair.transactions, {
      step: "preview:pair:update-min-utxo",
      submittedTxHash,
      confirmed,
    }),
  };

  return updatedPair;
}

function reportProgress(message: string): void {
  console.error(`[preview:pair:update-min-utxo] ${message}`);
}
