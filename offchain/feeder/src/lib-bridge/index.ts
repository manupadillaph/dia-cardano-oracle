// Bridge module — typed facade over the CLI's Cardano tx builders.
//
// `OracleIntentBridge` is the interface the submitter depends on.
// `createRealOracleIntentBridge` wires `buildOracleUpdateTx` from
// `offchain/cli/src/lib/` and handles the full Lucid lifecycle:
//   load state → build tx → sign → submit → await confirmation.
//
// CLI modules are loaded via dynamic `import()` so the feeder can
// typecheck without `@lucid-evolution/lucid` present; at runtime the
// optional dependency must be installed (npm optionalDependencies).
//
// Tests inject a `FakeOracleIntentBridge` instead.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnrichedIntent } from "../source/types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Parameters for a single oracle-update submission. */
export type OracleIntentSubmitParams = {
  /** Absolute or relative path to client-state.json. */
  clientStatePath: string;
  /** Absolute or relative path to config-bootstrap.json. */
  protocolStatePath: string;
  /** The enriched intent from the pipeline. */
  enriched: EnrichedIntent;
  /** EVM intent hash (`0x…`). */
  intentHash: string;
  /**
   * Called once for each pipeline step inside `submitOracleUpdate`.
   * Used by the write client to write intermediate entries to the
   * per-intent log file without coupling the bridge to the file logger.
   * Steps emitted (in order):
   *   connecting, building, signing, submitting,
   *   submitted (carries txHash), waiting_confirm,
   *   waiting_utxo, writing_state
   */
  onStep?: (step: string, meta?: { txHash?: string }) => void;
};

/** Structured result returned by a successful oracle-update submission. */
export type OracleUpdateResult = {
  /** Cardano transaction hash of the confirmed tx. */
  txHash: string;
  /** Receiver NFT unit (`policyId + assetName`) touched by this tx.
   *  Used as the exclusive-lock key in the inflight table. */
  receiverUnit: string;
  /** Pair NFT unit (`policyId + assetName`) updated by this tx. */
  pairUnit: string;
  /** True if this tx minted the pair NFT (first update for this symbol). */
  isCreate: boolean;
};

/**
 * Single method the write client calls. Implementors handle the full
 * Lucid lifecycle: load state, build tx, sign, submit, confirm.
 * Returns `OracleUpdateResult` on success; throws on failure.
 */
export type OracleIntentBridge = {
  submitOracleUpdate(params: OracleIntentSubmitParams): Promise<OracleUpdateResult>;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type RealBridgeOptions = {
  /** Progress lines are forwarded to this sink (default: process.stderr). */
  log?: (line: string) => void;
  /**
   * Absolute path to the feeder's `offchain/cli/src` root so dynamic
   * imports resolve correctly when the feeder is installed in a different
   * working directory.
   * Defaults to `../../../cli/src` relative to this file's location,
   * which is correct for the monorepo layout.
   */
  cliSrcRoot?: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a production `OracleIntentBridge` that delegates every
 * oracle-update submission to the CLI's `buildOracleUpdateTx` builder.
 *
 * The implementation mirrors `cli/src/transactions/update.ts`:
 *   1. Read client + protocol state artifacts.
 *   2. Normalise the intent (bigint fields) and recover the EIP-712 witness.
 *   3. Fetch current chain UTxOs.
 *   4. Build, sign, submit the Cardano tx.
 *   5. Await multi-provider confirmation (Blockfrost primary → Koios → BF REST).
 *
 * Throws on any unrecoverable error so the submitter queue can mark the
 * request as failed and continue with the next intent.
 */
export function createRealOracleIntentBridge(
  options: RealBridgeOptions = {},
): OracleIntentBridge {
  const log = options.log ?? ((line: string) => process.stderr.write(`[bridge] ${line}\n`));

  // Resolve CLI src root once — avoids re-computing on every call.
  const cliSrcRoot = options.cliSrcRoot
    ? path.resolve(options.cliSrcRoot)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../cli/src");

  function cliPath(rel: string): string {
    return `${cliSrcRoot}/${rel}`;
  }

  return {
    async submitOracleUpdate(params: OracleIntentSubmitParams): Promise<OracleUpdateResult> {
      const { clientStatePath, protocolStatePath, enriched, intentHash, onStep } = params;
      const { fullIntent } = enriched;

      log(`submitOracleUpdate: intentHash=${intentHash} symbol=${fullIntent.symbol}`);

      // ------------------------------------------------------------------
      // Dynamic imports — keeps the feeder's static dependency graph free
      // of @lucid-evolution/lucid at typecheck time.
      // ------------------------------------------------------------------
      const configMod = cliPath("core/config.js");
      const lucidMod = cliPath("core/lucid.js");
      const artifactMod = cliPath("core/artifact-context.js");
      const diaIntentMod = cliPath("core/dia-intent.js");
      const networkTimeMod = cliPath("core/network-time.js");
      const chainHelpersMod = cliPath("core/chain-helpers.js");
      const confirmMod = cliPath("core/tx-confirmation.js");
      const buildMod = cliPath("lib/transactions/build-oracle-update.js");
      const stateMod = cliPath("core/state.js");
      const walletMod = cliPath("wallet/wallet.js");
      const contractsMod = cliPath("core/contracts.js");
      const preflightMod = cliPath("preflight/index.js");
      const intentPathsMod = cliPath("core/intent-paths.js");

      const [
        { getCliConfig },
        { makeConfiguredLucidWithConfig, selectConfiguredWalletWithConfig },
        { readClientContext },
        {
          normalizeDiaOracleIntent,
          recoverDiaOracleIntentWitness,
          normalizeDiaEip712Domain,
          diaIntentTokenNameFromSymbol,
          diaPairIdHex,
          diaIntentToState,
          normalizeHex,
          assertDiaOracleIntentNotExpired,
        },
        { getNetworkNow },
        { findSingleUtxoAtUnit, waitForWalletSettlement, waitForUnitUtxoReplacement, decodePairDatum },
        { awaitTxConfirmation },
        { buildOracleUpdateTx },
        { readOptionalPairState, appendTransactionRecord },
        { deriveConfiguredWalletDefaults },
        {
          mintingPolicyFromCompiledScript,
          policyIdFromMintingPolicy,
          spendingValidatorFromCompiledScript,
          scriptHashFromValidator,
          scriptAddressFromValidator,
        },
        {
          assertOracleIntentTimestampAndNonceMonotonic,
          assertOracleUpdateBootstrapRefsResolved,
          assertPaymentKeyHashIsConfigSigner,
        },
        { pairSlugFromSymbol },
      ] = await Promise.all([
        import(configMod),
        import(lucidMod),
        import(artifactMod),
        import(diaIntentMod),
        import(networkTimeMod),
        import(chainHelpersMod),
        import(confirmMod),
        import(buildMod),
        import(stateMod),
        import(walletMod),
        import(contractsMod),
        import(preflightMod),
        import(intentPathsMod),
      ]);

      // ------------------------------------------------------------------
      // 1. Load client + protocol state.
      // ------------------------------------------------------------------
      log(`loading state: client=${clientStatePath} protocol=${protocolStatePath}`);
      const { client, protocol } = await readClientContext({
        clientStatePath: path.resolve(clientStatePath),
        protocolStatePath: path.resolve(protocolStatePath),
      });

      if (!client.receiver) {
        throw new Error(
          `Bridge: client state at ${clientStatePath} has no receiver — run receiver:bootstrap first.`,
        );
      }
      if (!client.scripts.pairPolicyId || !client.scripts.pairValidatorHash || !client.scripts.pairValidatorAddress) {
        throw new Error(
          `Bridge: client state at ${clientStatePath} has no pair scripts — run receiver:parameterize first.`,
        );
      }
      assertOracleUpdateBootstrapRefsResolved(protocol.bootstrapRefs);

      // ------------------------------------------------------------------
      // 2. Normalise intent + recover EIP-712 witness.
      // ------------------------------------------------------------------
      // `fullIntent` fields are already bigint — pass them through as-is.
      const intentInput = {
        intentType: fullIntent.intentType,
        version: fullIntent.version,
        chainId: fullIntent.chainId.toString(),
        nonce: fullIntent.nonce.toString(),
        expiry: fullIntent.expiry.toString(),
        symbol: fullIntent.symbol,
        price: fullIntent.price.toString(),
        timestamp: fullIntent.timestamp.toString(),
        source: fullIntent.source,
        signature: fullIntent.signature,
        signer: fullIntent.signer,
      };
      const intent = normalizeDiaOracleIntent(intentInput);

      const domain = normalizeDiaEip712Domain({
        name: protocol.configState.domain.name,
        version: protocol.configState.domain.version,
        sourceChainId: protocol.configState.domain.sourceChainId,
        verifyingContract: protocol.configState.domain.verifyingContract,
      });
      const witness = recoverDiaOracleIntentWitness(domain, intent);
      if (!protocol.configState.authorizedDiaPublicKeys.includes(witness.signerPublicKey)) {
        throw new Error("Bridge: recovered DIA signer public key is not authorized in the provided config state.");
      }

      // ------------------------------------------------------------------
      // 3. Connect Lucid + resolve current UTxOs.
      // ------------------------------------------------------------------
      onStep?.("connecting");
      log(`connecting to Cardano…`);
      const cliConfig = getCliConfig();
      const lucid = await makeConfiguredLucidWithConfig(cliConfig);
      const walletSource = await selectConfiguredWalletWithConfig(lucid, cliConfig);
      const wallet = lucid.wallet();
      const [walletAddress, walletUtxos] = await Promise.all([
        wallet.address(),
        wallet.getUtxos(),
      ]);
      const walletDefaults = deriveConfiguredWalletDefaults({ source: walletSource, address: walletAddress });

      const networkNow = await getNetworkNow(lucid);
      assertDiaOracleIntentNotExpired(intent, networkNow.unixTimeSec);

      // Compute pair unit first — needed for the on-chain isCreate check.
      if (!client.compiledScripts.pairMintPolicy) {
        throw new Error("Bridge: pairMintPolicy compiled script not found. Run receiver:parameterize first.");
      }
      const pairMintPolicy = mintingPolicyFromCompiledScript(client.compiledScripts.pairMintPolicy);
      const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
      const pairTokenName = diaIntentTokenNameFromSymbol(intent);
      const pairUnit = `${pairPolicyId}${pairTokenName}`;
      if (!client.compiledScripts.pairValidator) {
        throw new Error("Bridge: pairValidator compiled script not found. Run receiver:parameterize first.");
      }
      const pairValidator = spendingValidatorFromCompiledScript(client.compiledScripts.pairValidator);
      const pairValidatorHash = scriptHashFromValidator(pairValidator);
      const pairValidatorAddress = scriptAddressFromValidator(pairValidator);
      const pairId = diaPairIdHex(intent);

      // ------------------------------------------------------------------
      // isCreate decided from chain — not from local file.
      // utxosAtWithUnit returns [] when the pair NFT has never been minted
      // or was burned; a non-empty result means a live pair UTxO exists.
      // ------------------------------------------------------------------
      const chainPairUtxos = await lucid.utxosAtWithUnit(pairValidatorAddress, pairUnit);
      const isCreate = chainPairUtxos.length === 0;
      const currentPairUtxo = chainPairUtxos[0] ?? null;

      if (isCreate) {
        assertPaymentKeyHashIsConfigSigner(
          walletDefaults.paymentKeyHash,
          protocol.configState.validConfigSigners,
          {
            unauthorizedMessage:
              "Bridge: pair creation requires the configured wallet to be a config admin.",
          },
        );
      }

      // Read local pair state. If the pair is on-chain but the local file is
      // absent (startup reconcile failed or file was deleted mid-run),
      // reconstruct a minimal state from the on-chain datum so the monotonic-
      // nonce check and buildState have the correct baseline.
      const pairStatePath = pairStatePathForSymbol(clientStatePath, fullIntent.symbol, pairSlugFromSymbol);
      let existingPair = await readOptionalPairState(pairStatePath);
      if (!isCreate && !existingPair && currentPairUtxo?.datum) {
        const onChain = decodePairDatum(currentPairUtxo.datum);
        log(
          `submitOracleUpdate: local pair state missing for symbol=${fullIntent.symbol}; ` +
          `reconstructed from chain nonce=${onChain.nonce}`,
        );
        existingPair = {
          wallet: { source: "seed", address: walletAddress },
          pair: { tokenName: pairTokenName, pairId, pairUnit, pairValidatorAddress },
          pairState: {
            ...onChain,
            intent: {
              intentType: "", version: "0", chainId: "0", nonce: "0", expiry: "0",
              symbol: fullIntent.symbol, price: onChain.price,
              timestamp: onChain.timestamp, source: "", signature: "", signer: onChain.signer,
            },
          },
          datum: { pairCbor: currentPairUtxo.datum },
        };
      }

      const minUtxoLovelace = existingPair?.pairState.minUtxoLovelace ?? protocol.configState.minUtxoLovelace;

      const rawState = buildState({
        client,
        protocol,
        existingPair,
        intent,
        walletAddress,
        pairTokenName,
        pairId,
        pairUnit,
        pairValidatorAddress,
        minUtxoLovelace,
        diaIntentToState,
      });
      // Cast through a minimal typed view so property access below typechecks.
      // All fields come from the CLI's JSON artifacts; the actual shape is
      // validated at runtime by the CLI helpers themselves.
      const state = rawState as {
        scripts: Record<string, string>;
        pair: Record<string, string>;
        receiver: Record<string, string>;
        pairState: Record<string, unknown>;
        configState: Record<string, unknown>;
        compiledScripts: Record<string, unknown>;
        referenceScripts: Record<string, unknown>;
        transactions?: unknown[];
      };
      if (pairValidatorHash !== state.scripts.pairValidatorHash) {
        throw new Error("Bridge: pair validator hash does not match the current blueprint.");
      }
      if (normalizeHex(state.pair.pairId, "pair.pairId") !== normalizeHex(pairId, "intent.symbol")) {
        throw new Error(`Bridge: intent symbol ${intent.symbol} does not match pair id ${state.pair.pairId}.`);
      }
      assertOracleIntentTimestampAndNonceMonotonic({
        isCreate,
        intentTimestamp: intent.timestamp,
        intentNonce: intent.nonce,
        pairStateTimestamp: state.pairState.timestamp,
        pairStateNonce: state.pairState.nonce,
      });

      const currentConfigUtxo = await findSingleUtxoAtUnit(
        lucid,
        state.scripts.configValidatorAddress,
        state.scripts.configUnit,
        "config",
      );
      // currentPairUtxo already fetched above via utxosAtWithUnit (isCreate check).
      const currentReceiverUtxo = await findSingleUtxoAtUnit(
        lucid,
        state.receiver.receiverValidatorAddress,
        state.receiver.receiverUnit,
        "receiver",
      );

      // ------------------------------------------------------------------
      // 4. Build, sign, submit.
      // ------------------------------------------------------------------
      onStep?.("building");
      log(`building oracle update tx for symbol=${fullIntent.symbol}`);
      const { txSignBuilder, nextPairState, nextPairDatumCbor } = await buildOracleUpdateTx(lucid, {
        isCreate,
        intent,
        witness,
        networkNow,
        currentConfigUtxo,
        currentPairUtxo,
        currentReceiverUtxo,
        walletPaymentKeyHash: walletDefaults.paymentKeyHash,
        scripts: state.scripts,
        compiledScripts: state.compiledScripts,
        referenceScripts: state.referenceScripts,
        configState: state.configState,
        pairState: state.pairState,
        pair: state.pair,
        receiver: state.receiver,
      });

      onStep?.("signing");
      const signedTx = await txSignBuilder.sign.withWallet().complete();
      onStep?.("submitting");
      const txHash = await signedTx.submit();
      onStep?.("submitted", { txHash });
      log(`submitted: txHash=${txHash} intentHash=${intentHash}`);

      // ------------------------------------------------------------------
      // 5. Await confirmation.
      // ------------------------------------------------------------------
      onStep?.("waiting_confirm");
      const confirmed = await awaitTxConfirmation({
        lucid,
        txHash,
        reportProgress: log,
        label: `oracle update (${fullIntent.symbol}, intentHash=${intentHash})`,
      });

      if (!confirmed) {
        throw new Error(
          `Transaction ${txHash} was submitted but confirmation was never observed ` +
          `(intentHash=${intentHash}).`,
        );
      }

      onStep?.("waiting_utxo");
      await waitForWalletSettlement({
        wallet,
        previousUtxos: walletUtxos,
        spentUtxos: [],
        requireChangeWhenNoSpentUtxos: true,
        label: "oracle update",
      });
      await Promise.all([
        waitForUnitUtxoReplacement({
          lucid,
          address: state.pair.pairValidatorAddress,
          unit: state.pair.pairUnit,
          label: "pair",
          previousOutRef: currentPairUtxo ?? undefined,
        }),
        waitForUnitUtxoReplacement({
          lucid,
          address: state.receiver.receiverValidatorAddress,
          unit: state.receiver.receiverUnit,
          label: "receiver",
          previousOutRef: currentReceiverUtxo,
        }),
      ]);
      onStep?.("writing_state");
      await writePairState(pairStatePath, {
        wallet: { source: walletSource, address: walletAddress },
        pair: { ...state.pair },
        pairState: nextPairState,
        datum: { pairCbor: nextPairDatumCbor },
        transactions: appendTransactionRecord(state.transactions, {
          step: "feeder:update",
          submittedTxHash: txHash,
          confirmed,
        }),
      });

      log(`confirmed: txHash=${txHash} receiverUnit=${state.receiver.receiverUnit as string}`);
      return {
        txHash,
        receiverUnit: state.receiver.receiverUnit as string,
        pairUnit,
        isCreate,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assemble the combined state object expected by `buildOracleUpdateTx`,
 * merging client + protocol artifacts the same way `update.ts` does.
 */
function buildState(args: {
  client: Record<string, unknown>;
  protocol: Record<string, unknown>;
  existingPair: Record<string, unknown> | null;
  intent: Record<string, unknown>;
  walletAddress: string;
  pairTokenName: string;
  pairId: string;
  pairUnit: string;
  pairValidatorAddress: string;
  minUtxoLovelace: string | number | bigint;
  diaIntentToState: (intent: Record<string, unknown>) => unknown;
}): Record<string, unknown> {
  const { client, protocol, existingPair } = args;
  const defaultPairState = {
    pairId: args.pairId,
    price: "0",
    timestamp: "0",
    nonce: "0",
    intentHash: "00".repeat(32),
    signer: "00".repeat(20),
    minUtxoLovelace: args.minUtxoLovelace,
    intent: args.diaIntentToState(args.intent),
  };

  const pair = existingPair ?? {
    wallet: { source: "seed", address: args.walletAddress },
    pair: {
      tokenName: args.pairTokenName,
      pairId: args.pairId,
      pairUnit: args.pairUnit,
      pairValidatorAddress: args.pairValidatorAddress,
    },
    pairState: defaultPairState,
    datum: { pairCbor: "" },
  };

  return {
    ...(pair as object),
    scripts: {
      ...(protocol as Record<string, unknown>),
      ...(client as Record<string, unknown>),
      ...((protocol as Record<string, Record<string, unknown>>).scripts ?? {}),
      ...((client as Record<string, Record<string, unknown>>).scripts ?? {}),
    },
    configState: (protocol as Record<string, Record<string, unknown>>).configState,
    compiledScripts: {
      ...((protocol as Record<string, Record<string, unknown>>).compiledScripts ?? {}),
      ...((client as Record<string, Record<string, unknown>>).compiledScripts ?? {}),
    },
    referenceScripts: {
      ...((protocol as Record<string, Record<string, unknown>>).referenceScripts ?? {}),
      ...((client as Record<string, Record<string, unknown>>).referenceScripts ?? {}),
    },
    receiver: (client as Record<string, unknown>).receiver,
    transactions: (pair as Record<string, unknown>).transactions,
  };
}

function pairStatePathForSymbol(
  clientStatePath: string,
  symbol: string,
  pairSlugFromSymbol: (symbol: string) => string,
): string {
  const resolvedClientPath = path.resolve(clientStatePath);
  const clientFile = path.basename(resolvedClientPath, path.extname(resolvedClientPath));
  return path.join(
    path.dirname(resolvedClientPath),
    clientFile,
    "pairs",
    `${pairSlugFromSymbol(symbol)}.json`,
  );
}

async function writePairState(filePath: string, state: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

