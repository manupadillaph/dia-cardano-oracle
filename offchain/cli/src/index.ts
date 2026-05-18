import { input as promptInput } from "@inquirer/prompts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Surface unhandled rejections instead of letting Node.js terminate the
// process with a bare stack trace. Lucid's polling helpers occasionally
// reject asynchronously after the caller has moved on (network blips against
// Blockfrost); without this handler such a rejection killed the batch-10
// run in m1-mainnet-20260517-063917 right after submit, before any
// confirmation fallback could take over.
process.on("unhandledRejection", (reason) => {
  const detail =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : String(reason);
  console.error(
    `[cli] unhandled promise rejection (continuing, transient provider error): ${detail}`,
  );
});

import { getCliConfig, networkTag } from "./core/config.js";
import { signedIntentPathForSymbol } from "./core/intent-paths.js";
import {
  getDefaultBlueprintPath,
  listBlueprintValidators,
} from "./core/blueprint.js";

function printJson(value: unknown): void {
  console.log(
    JSON.stringify(
      value,
      (_key, currentValue) =>
        typeof currentValue === "bigint"
          ? currentValue.toString()
          : currentValue,
      2,
    ),
  );
}

function printUsage(): void {
  console.log(`Usage:
  npm run cli -- blueprint:list
  npm run cli -- reference-holder
  npm run cli -- protocol
  npm run cli -- wallet:create
  npm run cli -- wallet
  npm run cli -- wallet:utxos
  npm run cli -- wallet:defaults
  npm run cli -- ethereum-wallet:create
  npm run cli -- protocol:init [--valid-config-signers <pkh[,pkh...]> --authorized-dia-public-keys <pubkey[,pubkey...]> --domain-name "DIA Oracle" --domain-version 1.0 --domain-source-chain-id 100640 --domain-verifying-contract 0xF8c614A483A0427A13512F52ac72A576678bE317 --base-fee-lovelace 600000 --per-pair-fee-lovelace 400000 --max-bootstrap-drift-seconds 300 --min-utxo-lovelace 5000000 --config-asset-label DIA_CONFIG --payment-hook-asset-label DIA_PAYMENT_HOOK --payment-hook-withdraw-address <addr>] [--out ./state/<network>/config-bootstrap.json]
  npm run cli -- client:init [--state ./state/<network>/config-bootstrap.json] [--client-id client-a --receiver-asset-label DIA_RECEIVER_CLIENT_A] [--out ./state/<network>/clients/client-a.json]
  npm run cli -- intent:create [--state ./state/<network>/config-bootstrap.json] [--symbol USDC/USD] [--price 100045678] [--timestamp 1777274653] [--nonce 1777274633040] [--expiry 1777278253] [--out ./state/<network>/intents/usdc-usd.unsigned.json]
  npm run cli -- intent:sign [--input ./state/<network>/intents/usdc-usd.unsigned.json] [--out ./state/<network>/intents/usdc-usd.signed.json]
  npm run cli -- intent:create-and-sign [--state ./state/<network>/config-bootstrap.json] [--symbol USDC/USD] [--price 100045678] [--timestamp 1777274653] [--nonce 1777274633040] [--expiry 1777278253] [--out ./state/<network>/intents/usdc-usd.signed.json]
  npm run cli -- config:update:create [--state ./state/<network>/config-bootstrap.json] [--out ./state/<network>/config-updates/config-update.json]
  npm run cli -- config:parameterize --state ./state/<network>/config-bootstrap.json
  npm run cli -- config:reference-scripts --state ./state/<network>/config-bootstrap.json [--build-only]
  npm run cli -- config:bootstrap --state ./state/<network>/config-bootstrap.json [--build-only]
  npm run cli -- payment-hook:parameterize --state ./state/<network>/config-bootstrap.json
  npm run cli -- payment-hook:reference-script --state ./state/<network>/config-bootstrap.json [--build-only]
  npm run cli -- payment-hook:bootstrap --state ./state/<network>/config-bootstrap.json [--build-only]
  npm run cli -- payment-hook:update --input ./state/<network>/hook-updates/payment-hook-update.json --state ./state/<network>/config-bootstrap.json [--build-only]
  npm run cli -- receiver:parameterize --protocol-state ./state/<network>/config-bootstrap.json --state ./state/<network>/clients/client-a.json
  npm run cli -- reference-scripts:publish-client --protocol-state ./state/<network>/config-bootstrap.json --state ./state/<network>/clients/client-a.json [--build-only]
  npm run cli -- receiver:bootstrap --protocol-state ./state/<network>/config-bootstrap.json --state ./state/<network>/clients/client-a.json [--build-only]
  npm run cli -- update --intent ./state/<network>/intents/usdc-usd.signed.json --protocol-state ./state/<network>/config-bootstrap.json --client-state ./state/<network>/clients/client-a.json --state ./state/<network>/clients/client-a/pairs/usdc-usd.json [--build-only]
  npm run cli -- config:update --input ./state/<network>/config-updates/config-update.json --state ./state/<network>/config-bootstrap.json [--build-only]
  npm run cli -- update:batch:create [--pairs-dir ./state/<network>/clients/client-a/pairs] [--intents-dir ./state/<network>/intents] [--out ./state/<network>/update-batches/update-batch.manifest.json]
  npm run cli -- update:batch --protocol-state ./state/<network>/config-bootstrap.json --client-state ./state/<network>/clients/client-a.json --manifest ./state/<network>/update-batches/update-batch.manifest.json [--build-only] [--out ./state/<network>/update-batches/update-batch.result.json]
  npm run cli -- receiver:top-up --amount-lovelace 5000000 --protocol-state ./state/<network>/config-bootstrap.json --state ./state/<network>/clients/client-a.json [--build-only]
  npm run cli -- receiver:withdraw --amount-lovelace 2000000 [--recipient-address <addr>] --protocol-state ./state/<network>/config-bootstrap.json --state ./state/<network>/clients/client-a.json [--build-only]
  npm run cli -- receiver:update-min-utxo --new-min-utxo-lovelace 3000000 --protocol-state ./state/<network>/config-bootstrap.json --state ./state/<network>/clients/client-a.json [--build-only]
  npm run cli -- pair:update-min-utxo --new-min-utxo-lovelace 3000000 --protocol-state ./state/<network>/config-bootstrap.json --client-state ./state/<network>/clients/client-a.json --state ./state/<network>/clients/client-a/pairs/usdc-usd.json [--build-only]
  npm run cli -- pair:burn --protocol-state ./state/<network>/config-bootstrap.json --client-state ./state/<network>/clients/client-a.json --state ./state/<network>/clients/client-a/pairs/usdc-usd.json [--build-only]
  npm run cli -- settle --protocol-state ./state/<network>/config-bootstrap.json --client-state ./state/<network>/clients/client-a.json [--build-only]
  npm run cli -- payment-hook:withdraw --amount-lovelace 2000000 --state ./state/<network>/config-bootstrap.json [--build-only]
  npm run cli -- reclaim-reference-script --script <config|payment-hook> --state ./state/<network>/config-bootstrap.json [--build-only]
  npm run cli -- reclaim-reference-script --script client --protocol-state ./state/<network>/config-bootstrap.json --state ./state/<network>/clients/client-a.json [--build-only]`);
}

function requireInputPath(): string {
  const args = process.argv.slice(3);
  const inputFlagIndex = args.findIndex((arg) => arg === "--input");

  if (inputFlagIndex === -1 || !args[inputFlagIndex + 1]) {
    throw new Error("Missing required argument: --input <path>");
  }

  return args[inputFlagIndex + 1];
}

function requireFlagValue(flag: string): string {
  const value = optionalFlagValue(flag);
  if (!value) {
    throw new Error(`Missing required argument: ${flag} <value>`);
  }
  return value;
}

function hasBuildOnlyFlag(): boolean {
  return process.argv.slice(3).includes("--build-only");
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(3).includes(flag);
}

function optionalFlagValue(flag: string): string | undefined {
  const args = process.argv.slice(3);
  const index = args.findIndex((arg) => arg === flag);

  if (index === -1) {
    return undefined;
  }

  if (!args[index + 1]) {
    throw new Error(`Missing required value for ${flag}.`);
  }

  return args[index + 1];
}

function parseCommaSeparatedFlagValues(flag: string): string[] {
  return requireFlagValue(flag)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

async function promptForText(args: {
  message: string;
  defaultValue?: string;
}): Promise<string> {
  return promptInput({
    message: args.message,
    default: args.defaultValue,
    validate: (value) => value.trim().length > 0 || "Value is required.",
    transformer: (value) => value.trim(),
  });
}

async function resolveTextFlag(args: {
  flag: string;
  message: string;
  defaultValue?: string;
}): Promise<string> {
  return optionalFlagValue(args.flag) ?? promptForText(args);
}

async function writeJsonOutput(outPath: string, value: unknown): Promise<void> {
  const resolvedPath = path.resolve(outPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(
    resolvedPath,
    JSON.stringify(
      value,
      (_key, currentValue) =>
        typeof currentValue === "bigint"
          ? currentValue.toString()
          : currentValue,
      2,
    ) + "\n",
    "utf8",
  );
  console.error(`[cli] Wrote JSON output to ${resolvedPath}`);
}

async function run(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "blueprint:list": {
      const validators = await listBlueprintValidators();

      printJson({
        blueprintPath: getDefaultBlueprintPath(),
        validatorCount: validators.length,
        validators: validators.map((validator) => ({
          title: validator.title,
          hasCompiledCode: Boolean(validator.compiledCode),
          hash: validator.hash ?? null,
        })),
      });
      return;
    }

    case "reference-holder": {
      const { readConfigState } = await import("./core/state.js");
      const statePath =
        optionalFlagValue("--state") ?? `state/${networkTag()}/config-bootstrap.json`;
      const state = await readConfigState(path.resolve(statePath));
      if (!state.scripts.referenceHolderAddress || !state.scripts.referenceHolderValidatorHash) {
        throw new Error("ReferenceHolder address not found. Run config:parameterize first.");
      }
      printJson({
        network: getCliConfig().cardanoNetwork,
        validator: "reference_holder.reference_holder.spend",
        address: state.scripts.referenceHolderAddress,
        scriptHash: state.scripts.referenceHolderValidatorHash,
        reclaimableByAdmin: true,
      });
      return;
    }

    case "protocol": {
      const { getProtocolParameters } = await import("./core/protocol.js");
      getCliConfig();
      const result = await getProtocolParameters();
      printJson(result);
      return;
    }

    case "wallet": {
      const { walletSummary } = await import("./wallet/wallet.js");
      getCliConfig();
      const result = await walletSummary();
      printJson(result);
      return;
    }

    case "wallet:utxos": {
      const { walletUtxos } = await import("./wallet/wallet.js");
      getCliConfig();
      const result = await walletUtxos();
      printJson(result);
      return;
    }

    case "wallet:defaults": {
      const { walletDefaults } = await import("./wallet/wallet.js");
      getCliConfig();
      const result = await walletDefaults();
      printJson(result);
      return;
    }

    case "wallet:create": {
      const { createWallet } = await import("./wallet/wallet-create.js");
      const result = createWallet();
      printJson(result);
      return;
    }

    case "ethereum-wallet:create": {
      const { createEthereumWallet } = await import(
        "./oracle/ethereum-wallet-create.js"
      );
      const result = createEthereumWallet();
      printJson(result);
      return;
    }

    case "protocol:init": {
      const { initializeProtocolState } = await import("./init/protocol-init.js");
      getCliConfig();
      const hasExplicitProtocolConfig =
        hasFlag("--valid-config-signers") ||
        hasFlag("--authorized-dia-public-keys") ||
        hasFlag("--domain-name") ||
        hasFlag("--domain-version") ||
        hasFlag("--domain-source-chain-id") ||
        hasFlag("--domain-verifying-contract") ||
        hasFlag("--base-fee-lovelace") ||
        hasFlag("--per-pair-fee-lovelace") ||
        hasFlag("--max-bootstrap-drift-seconds") ||
        hasFlag("--min-utxo-lovelace") ||
        hasFlag("--config-asset-label") ||
        hasFlag("--payment-hook-asset-label") ||
        hasFlag("--payment-hook-withdraw-address");
      const result = await initializeProtocolState({
        configInput: hasExplicitProtocolConfig
          ? {
              validConfigSigners: parseCommaSeparatedFlagValues("--valid-config-signers"),
              authorizedDiaPublicKeys: parseCommaSeparatedFlagValues("--authorized-dia-public-keys"),
              domain: {
                name: requireFlagValue("--domain-name"),
                version: requireFlagValue("--domain-version"),
                sourceChainId: requireFlagValue("--domain-source-chain-id"),
                verifyingContract: requireFlagValue("--domain-verifying-contract"),
              },
              baseFeeLovelace: requireFlagValue("--base-fee-lovelace"),
              perPairFeeLovelace: requireFlagValue("--per-pair-fee-lovelace"),
              maxBootstrapDriftSeconds: requireFlagValue("--max-bootstrap-drift-seconds"),
              minUtxoLovelace: requireFlagValue("--min-utxo-lovelace"),
              configAssetLabel: requireFlagValue("--config-asset-label"),
              configAssetName: "",
              paymentHookAssetLabel: requireFlagValue("--payment-hook-asset-label"),
              paymentHookAssetName: "",
              paymentHookWithdrawAddress: requireFlagValue("--payment-hook-withdraw-address"),
            }
          : undefined,
        useDefaults: hasFlag("--use-defaults"),
      });
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Protocol artifact output path",
          defaultValue: "./state/<network>/config-bootstrap.json",
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "client:init": {
      const { initializeClientState } = await import("./init/client-init.js");
      const { normalizeHex, utf8ToHex } = await import("./core/dia-intent.js");
      getCliConfig();
      const statePath = await resolveTextFlag({
        flag: "--state",
        message: "Protocol state path",
        defaultValue: "./state/<network>/config-bootstrap.json",
      });
      const hasExplicitReceiverDefaults =
        hasFlag("--client-id") ||
        hasFlag("--receiver-asset-label");
      const explicitClientId = optionalFlagValue("--client-id");
      const result = await initializeClientState({
        statePath,
        clientId: explicitClientId,
        receiverDefaults: hasExplicitReceiverDefaults
          ? {
              clientId: requireFlagValue("--client-id"),
              receiverAssetLabel: requireFlagValue("--receiver-asset-label"),
              receiverAssetName: normalizeHex(
                utf8ToHex(requireFlagValue("--receiver-asset-label")),
                "receiverAssetName",
              ),
            }
          : undefined,
        useDefaults: hasFlag("--use-defaults"),
      });
      const resolvedClientId =
        explicitClientId ?? result.drafts?.receiverParameterize?.clientId ?? "client-a";
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Client artifact output path",
          defaultValue: `./state/<network>/clients/${resolvedClientId}.json`,
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "intent:create": {
      const {
        createPreviewOracleIntent,
        defaultUnsignedIntentOutputPath,
      } = await import("./oracle/intent-create.js");
      const result = await createPreviewOracleIntent({
        statePath: optionalFlagValue("--state"),
        intentType: optionalFlagValue("--intent-type"),
        nonce: optionalFlagValue("--nonce"),
        expiry: optionalFlagValue("--expiry"),
        symbol: optionalFlagValue("--symbol"),
        price: optionalFlagValue("--price"),
        timestamp: optionalFlagValue("--timestamp"),
        source: optionalFlagValue("--source"),
      });
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Unsigned intent output path",
          defaultValue: defaultUnsignedIntentOutputPath(result),
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "intent:sign": {
      const { signPreviewOracleIntent } = await import("./oracle/intent-sign.js");
      const { signPreviewOracleIntentInteractive } = await import("./oracle/intent-create.js");
      const result = hasFlag("--input")
        ? await signPreviewOracleIntent({
            inputPath: requireInputPath(),
          })
        : await signPreviewOracleIntentInteractive();
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Signed intent output path",
          defaultValue: signedIntentPathForSymbol(result.intent.symbol),
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "intent:create-and-sign": {
      const {
        createAndSignPreviewOracleIntent,
        defaultSignedIntentOutputPath,
      } = await import("./oracle/intent-create.js");
      const result = await createAndSignPreviewOracleIntent({
        statePath: optionalFlagValue("--state"),
        intentType: optionalFlagValue("--intent-type"),
        nonce: optionalFlagValue("--nonce"),
        expiry: optionalFlagValue("--expiry"),
        symbol: optionalFlagValue("--symbol"),
        price: optionalFlagValue("--price"),
        timestamp: optionalFlagValue("--timestamp"),
        source: optionalFlagValue("--source"),
      });
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Signed intent output path",
          defaultValue: defaultSignedIntentOutputPath({
            symbol: result.intent.symbol,
          }),
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "config:update:create": {
      const { createConfigUpdateDraft } = await import("./init/config-update-create.js");
      getCliConfig();
      const statePath = await resolveTextFlag({
        flag: "--state",
        message: "Protocol state path",
        defaultValue: "./state/<network>/config-bootstrap.json",
      });
      const result = await createConfigUpdateDraft({ statePath });
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Config update draft output path",
          defaultValue: "./state/<network>/config-updates/config-update.json",
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "config:parameterize": {
      const { parameterizeConfigScripts } = await import(
        "./deploys/config-parameterize.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const result = await parameterizeConfigScripts({ statePath });
      if (statePath) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "config:reference-scripts": {
      const { publishConfigReferenceScripts } = await import(
        "./deploys/config-reference-scripts.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await publishConfigReferenceScripts({
        statePath,
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "config:bootstrap": {
      const { configBootstrap } = await import(
        "./deploys/config-bootstrap.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await configBootstrap({ statePath, buildOnly });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "config:update": {
      const { configUpdate } = await import("./transactions/config-update.js");
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await configUpdate({
        inputPath: requireInputPath(),
        statePath,
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "payment-hook:bootstrap": {
      const { paymentHookBootstrap } = await import(
        "./deploys/payment-hook-bootstrap.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await paymentHookBootstrap({ statePath, buildOnly });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "payment-hook:parameterize": {
      const { parameterizePaymentHookScripts } = await import(
        "./deploys/payment-hook-parameterize.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const result = await parameterizePaymentHookScripts({ statePath });
      if (statePath) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "payment-hook:reference-script": {
      const { publishPaymentHookReferenceScript } = await import(
        "./deploys/payment-hook-reference-script.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await publishPaymentHookReferenceScript({
        statePath,
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "payment-hook:withdraw": {
      const { paymentHookWithdraw } = await import(
        "./transactions/payment-hook-withdraw.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await paymentHookWithdraw({
        amountLovelace: requireFlagValue("--amount-lovelace"),
        statePath,
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "payment-hook:update": {
      const { paymentHookUpdate } = await import(
        "./transactions/payment-hook-update.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await paymentHookUpdate({
        inputPath: requireInputPath(),
        statePath,
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "settle": {
      const { settleAccruedFees } = await import(
        "./transactions/settle.js"
      );
      getCliConfig();
      const buildOnly = hasBuildOnlyFlag();
      const result = await settleAccruedFees({
        protocolStatePath: requireFlagValue("--protocol-state"),
        clientStatePath: requireFlagValue("--client-state"),
        buildOnly,
      });
      printJson(result);
      return;
    }

    case "receiver:bootstrap": {
      const { receiverBootstrap } = await import(
        "./deploys/receiver-bootstrap.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await receiverBootstrap({
        statePath,
        protocolStatePath: requireFlagValue("--protocol-state"),
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "receiver:parameterize": {
      const { parameterizeReceiverScripts } = await import(
        "./deploys/receiver-parameterize.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const result = await parameterizeReceiverScripts({
        statePath,
        protocolStatePath: requireFlagValue("--protocol-state"),
      });
      if (statePath) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "reference-scripts:publish-client": {
      const { publishClientReferenceScripts } = await import(
        "./deploys/client-reference-scripts.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await publishClientReferenceScripts({
        statePath,
        protocolStatePath: requireFlagValue("--protocol-state"),
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "receiver:top-up": {
      const { receiverTopUp } = await import("./transactions/receiver-top-up.js");
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await receiverTopUp({
        amountLovelace: requireFlagValue("--amount-lovelace"),
        statePath,
        protocolStatePath: requireFlagValue("--protocol-state"),
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "receiver:withdraw": {
      const { receiverWithdraw } = await import("./transactions/receiver-withdraw.js");
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await receiverWithdraw({
        amountLovelace: requireFlagValue("--amount-lovelace"),
        recipientAddress: optionalFlagValue("--recipient-address"),
        statePath,
        protocolStatePath: requireFlagValue("--protocol-state"),
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "receiver:update-min-utxo": {
      const { receiverUpdateMinUtxo } = await import(
        "./transactions/receiver-update-min-utxo.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await receiverUpdateMinUtxo({
        newMinUtxoLovelace: requireFlagValue("--new-min-utxo-lovelace"),
        protocolStatePath: requireFlagValue("--protocol-state"),
        clientStatePath: statePath ?? "",
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "pair:update-min-utxo": {
      const { pairUpdateMinUtxo } = await import(
        "./transactions/pair-update-min-utxo.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await pairUpdateMinUtxo({
        newMinUtxoLovelace: requireFlagValue("--new-min-utxo-lovelace"),
        protocolStatePath: requireFlagValue("--protocol-state"),
        clientStatePath: requireFlagValue("--client-state"),
        pairStatePath: statePath ?? "",
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "pair:burn": {
      // Admin-gated tx that burns the Pair NFT and recovers the locked
      // min-ADA to the admin wallet. See pair-burn.ts and the security
      // notes for the on-chain invariants this drives.
      const { pairBurn } = await import("./transactions/pair-burn.js");
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await pairBurn({
        protocolStatePath: requireFlagValue("--protocol-state"),
        clientStatePath: requireFlagValue("--client-state"),
        pairStatePath: statePath ?? "",
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "update:batch": {
      const { submitBatchOracleUpdate } = await import("./transactions/update-batch.js");
      getCliConfig();
      const result = await submitBatchOracleUpdate({
        manifestPath: requireFlagValue("--manifest"),
        clientStatePath: requireFlagValue("--client-state"),
        protocolStatePath: requireFlagValue("--protocol-state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "update:batch:create": {
      const { createBatchUpdateManifest } = await import("./init/batch-update-create.js");
      const result = await createBatchUpdateManifest({
        pairsDir: optionalFlagValue("--pairs-dir"),
        intentsDir: optionalFlagValue("--intents-dir"),
      });
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Batch manifest output path",
          defaultValue: "./state/<network>/update-batches/update-batch.manifest.json",
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "update": {
      const { submitOracleUpdate } = await import("./transactions/update.js");
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      if (!statePath) {
        throw new Error("Missing required argument: --state <path>");
      }
      const buildOnly = hasBuildOnlyFlag();
      const result = await submitOracleUpdate({
        intentPath: requireFlagValue("--intent"),
        statePath,
        clientStatePath: requireFlagValue("--client-state"),
        protocolStatePath: requireFlagValue("--protocol-state"),
        buildOnly,
      });
      if (!buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "reclaim-reference-script": {
      const { reclaimProtocolReferenceScript, reclaimClientReferenceScript } = await import(
        "./transactions/reclaim-reference-script.js"
      );
      getCliConfig();
      const scriptArg = requireFlagValue("--script");
      const buildOnly = hasBuildOnlyFlag();

      if (scriptArg === "config" || scriptArg === "payment-hook") {
        const statePath = requireFlagValue("--state");
        const result = await reclaimProtocolReferenceScript({ script: scriptArg, statePath, buildOnly });
        if (!buildOnly) await writeJsonOutput(statePath, result);
        printJson(result);
        return;
      }

      if (scriptArg === "client") {
        const protocolStatePath = requireFlagValue("--protocol-state");
        const statePath = requireFlagValue("--state");
        const result = await reclaimClientReferenceScript({ script: scriptArg, protocolStatePath, statePath, buildOnly });
        if (!buildOnly) await writeJsonOutput(statePath, result);
        printJson(result);
        return;
      }

      throw new Error(
        `Unknown --script value: '${scriptArg}'. Valid values: config, payment-hook, client.`,
      );
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
