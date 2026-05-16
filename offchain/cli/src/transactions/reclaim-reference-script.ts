import path from "node:path";
import { Constr, type LucidEvolution, type SpendingValidator, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import { spendingValidatorFromCompiledScript } from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import {
  appendTransactionRecord,
  emptyReferenceScriptUtxo,
  readConfigState,
  readClientState,
  type ClientStateArtifact,
  type ConfigStateArtifact,
  type ReferenceScriptUtxo,
  type ReferenceScriptsState,
} from "../core/state.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { assertPaymentKeyHashIsConfigSigner } from "../preflight/index.js";
import {
  findSingleUtxoAtUnit,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";

// "config" reclaims global.config + global.coordinator together (published in the same tx).
// "payment-hook" reclaims global.paymentHook alone.
export type GlobalReclaimableScript = "config" | "payment-hook";

// "client" reclaims client.receiver + client.pair + client.pairMint together (published in the same tx).
export type ClientReclaimableScript = "client";

export async function reclaimProtocolReferenceScript(args: {
  script: GlobalReclaimableScript;
  statePath: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  const state = await readConfigState(path.resolve(args.statePath));

  if (!state.scripts.referenceHolderAddress) {
    throw new Error(
      "Reclaim requires config parameterization first (run config:parameterize).",
    );
  }

  const utxoRefs = resolveGlobalUtxoRefs(state, args.script);
  for (const { ref, name } of utxoRefs) {
    if (!ref?.txHash) {
      throw new Error(
        `Reference script '${name}' has not been published yet. Run the corresponding publish command first.`,
      );
    }
  }

  const { lucid, walletAddress, walletUtxos, walletDefaults, source } =
    await connectWallet();

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    state.configState.validConfigSigners,
  );

  const referenceHolderValidator = resolveReferenceHolderValidator(state);

  reportProgress(args.script, "Fetching reference-script UTxOs and Config UTxO from chain");
  const [allRefHolderUtxos, currentConfigUtxo] = await Promise.all([
    lucid.utxosAt(state.scripts.referenceHolderAddress),
    findSingleUtxoAtUnit(
      lucid,
      state.scripts.configValidatorAddress,
      state.scripts.configUnit,
      "config",
    ),
  ]);

  const targetUtxos = utxoRefs.map(({ ref, name }) =>
    findUtxoByOutRef(allRefHolderUtxos, ref!, name),
  );

  const { submittedTxHash, confirmed } = await buildAndSubmit({
    lucid,
    targetUtxos,
    currentConfigUtxo,
    referenceHolderValidator,
    walletDefaults,
    walletUtxos,
    buildOnly: args.buildOnly,
    script: args.script,
  });

  return {
    ...state,
    wallet: { source, address: walletAddress },
    referenceScripts: clearGlobalEntry(state.referenceScripts, args.script),
    transactions: appendTransactionRecord(state.transactions, {
      step: `reclaim-reference-script:${args.script}`,
      submittedTxHash,
      confirmed,
    }),
  };
}

export async function reclaimClientReferenceScript(args: {
  script: ClientReclaimableScript;
  protocolStatePath: string;
  statePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
  const [protocolState, clientState] = await Promise.all([
    readConfigState(path.resolve(args.protocolStatePath)),
    readClientState(path.resolve(args.statePath)),
  ]);

  if (!protocolState.scripts.referenceHolderAddress) {
    throw new Error(
      "Reclaim requires config parameterization first (run config:parameterize).",
    );
  }

  const utxoRefs = resolveClientUtxoRefs(clientState);
  for (const { ref, name } of utxoRefs) {
    if (!ref?.txHash) {
      throw new Error(
        `Reference script '${name}' has not been published yet. Run reference-scripts:publish-client first.`,
      );
    }
  }

  const { lucid, walletAddress, walletUtxos, walletDefaults, source } =
    await connectWallet();

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    protocolState.configState.validConfigSigners,
  );

  const referenceHolderValidator = resolveReferenceHolderValidator(protocolState);

  reportProgress(args.script, "Fetching reference-script UTxOs and Config UTxO from chain");
  const [allRefHolderUtxos, currentConfigUtxo] = await Promise.all([
    lucid.utxosAt(protocolState.scripts.referenceHolderAddress),
    findSingleUtxoAtUnit(
      lucid,
      protocolState.scripts.configValidatorAddress,
      protocolState.scripts.configUnit,
      "config",
    ),
  ]);

  const targetUtxos = utxoRefs.map(({ ref, name }) =>
    findUtxoByOutRef(allRefHolderUtxos, ref!, name),
  );

  const { submittedTxHash, confirmed } = await buildAndSubmit({
    lucid,
    targetUtxos,
    currentConfigUtxo,
    referenceHolderValidator,
    walletDefaults,
    walletUtxos,
    buildOnly: args.buildOnly,
    script: args.script,
  });

  return {
    ...clientState,
    referenceScripts: clearClientEntry(clientState.referenceScripts),
    transactions: appendTransactionRecord(clientState.transactions, {
      step: `reclaim-reference-script:${args.script}`,
      submittedTxHash,
      confirmed,
    }),
  };
}

async function connectWallet() {
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });
  return { lucid, walletAddress, walletUtxos, walletDefaults, source };
}

function resolveReferenceHolderValidator(state: ConfigStateArtifact): SpendingValidator {
  if (!state.compiledScripts.referenceHolderValidator) {
    throw new Error(
      "ReferenceHolder compiled script not found. Run config:parameterize first.",
    );
  }
  return spendingValidatorFromCompiledScript(state.compiledScripts.referenceHolderValidator);
}

function findUtxoByOutRef(
  utxos: UTxO[],
  outRef: ReferenceScriptUtxo,
  script: string,
): UTxO {
  const utxo = utxos.find(
    (u) => u.txHash === outRef.txHash && u.outputIndex === outRef.outputIndex,
  );
  if (!utxo) {
    throw new Error(
      `Reference script '${script}' UTxO ${outRef.txHash}#${outRef.outputIndex} not found on-chain. It may have already been reclaimed.`,
    );
  }
  return utxo;
}

async function buildAndSubmit(args: {
  lucid: LucidEvolution;
  targetUtxos: UTxO[];
  currentConfigUtxo: UTxO;
  referenceHolderValidator: SpendingValidator;
  walletDefaults: { paymentKeyHash: string };
  walletUtxos: UTxO[];
  buildOnly: boolean;
  script: string;
}): Promise<{ submittedTxHash: string | null; confirmed: boolean }> {
  const spendRedeemer = Data.to(new Constr<PlutusData>(0, []));

  reportProgress(args.script, `Building reclaim transaction (spending ${args.targetUtxos.length} UTxO(s))`);
  const txSignBuilder = await args.lucid
    .newTx()
    .readFrom([args.currentConfigUtxo])
    .collectFrom(args.targetUtxos, spendRedeemer)
    .attach.SpendingValidator(args.referenceHolderValidator)
    .addSignerKey(args.walletDefaults.paymentKeyHash)
    .complete();

  reportTxSignBuilderMetrics(txSignBuilder, (msg) => reportProgress(args.script, msg));
  logEffectiveOutputs(txSignBuilder, (msg) => reportProgress(args.script, msg));

  const unsignedHash = txSignBuilder.toHash();
  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(args.script, `Unsigned transaction ready: ${unsignedHash}`);
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(args.script, `Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await awaitTxConfirmation({
      lucid: args.lucid,
      txHash: submittedTxHash,
      reportProgress: (msg) => reportProgress(args.script, msg),
      label: `reclaim-reference-script (${args.script}) transaction`,
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet: args.lucid.wallet(),
      previousUtxos: args.walletUtxos,
      spentUtxos: [],
      label: `reclaim-reference-script (${args.script})`,
    });
  }

  return { submittedTxHash, confirmed };
}

function resolveGlobalUtxoRefs(
  state: ConfigStateArtifact,
  script: GlobalReclaimableScript,
): Array<{ ref: ReferenceScriptUtxo | undefined; name: string }> {
  switch (script) {
    case "config":
      return [
        { ref: state.referenceScripts?.global?.config, name: "config" },
        { ref: state.referenceScripts?.global?.coordinator, name: "coordinator" },
      ];
    case "payment-hook":
      return [
        { ref: state.referenceScripts?.global?.paymentHook, name: "payment-hook" },
      ];
  }
}

function resolveClientUtxoRefs(
  clientState: ClientStateArtifact,
): Array<{ ref: ReferenceScriptUtxo | undefined; name: string }> {
  return [
    { ref: clientState.referenceScripts?.client?.receiver, name: "receiver" },
    { ref: clientState.referenceScripts?.client?.pair, name: "pair" },
    { ref: clientState.referenceScripts?.client?.pairMint, name: "pairMint" },
  ];
}

function clearGlobalEntry(
  referenceScripts: ReferenceScriptsState | undefined,
  script: GlobalReclaimableScript,
): ReferenceScriptsState | undefined {
  if (!referenceScripts?.global) return referenceScripts;
  const empty = emptyReferenceScriptUtxo();
  switch (script) {
    case "config":
      return {
        ...referenceScripts,
        global: {
          ...referenceScripts.global,
          config: empty,
          coordinator: empty,
        },
      };
    case "payment-hook":
      return {
        ...referenceScripts,
        global: {
          ...referenceScripts.global,
          paymentHook: empty,
        },
      };
  }
}

function clearClientEntry(
  referenceScripts: ClientStateArtifact["referenceScripts"],
): ClientStateArtifact["referenceScripts"] {
  if (!referenceScripts?.client) return referenceScripts;
  const empty = emptyReferenceScriptUtxo();
  return {
    ...referenceScripts,
    client: {
      receiver: empty,
      pair: empty,
      pairMint: empty,
    },
  };
}

function reportProgress(script: string, message: string): void {
  console.error(`[reclaim-reference-script:${script}] ${message}`);
}
