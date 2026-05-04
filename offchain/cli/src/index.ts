import { input as promptInput } from "@inquirer/prompts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getCliConfig } from "./core/config.js";
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
  npm run cli -- preview:reference-holder
  npm run cli -- preview:protocol
  npm run cli -- preview:wallet:create
  npm run cli -- preview:wallet
  npm run cli -- preview:wallet:utxos
  npm run cli -- preview:wallet:defaults
  npm run cli -- preview:ethereum-wallet:create
  npm run cli -- preview:protocol:init [--use-defaults] [--out ./state/preview/config-bootstrap.json]
  npm run cli -- preview:client:init [--state ./state/preview/config-bootstrap.json] [--client-id client-a] [--use-defaults] [--out ./state/preview/clients/client-a.json]
  npm run cli -- preview:intent:create [--state ./state/preview/config-bootstrap.json] [--out ./state/preview/intents/usdc-usd.unsigned.json]
  npm run cli -- preview:intent:sign [--input ./state/preview/intents/usdc-usd.unsigned.json] [--out ./state/preview/intents/usdc-usd.signed.json]
  npm run cli -- preview:intent:create-and-sign [--state ./state/preview/config-bootstrap.json] [--out ./state/preview/intents/usdc-usd.signed.json]
  npm run cli -- preview:config:update:create [--state ./state/preview/config-bootstrap.json] [--out ./state/preview/config-updates/config-update.preview.json]
  npm run cli -- preview:config:parameterize --state ./state/preview/config-bootstrap.json
  npm run cli -- preview:config:reference-scripts --lovelace-per-output 3000000 --state ./state/preview/config-bootstrap.json [--build-only]
  npm run cli -- preview:config:bootstrap --state ./state/preview/config-bootstrap.json [--build-only]
  npm run cli -- preview:payment-hook:parameterize --state ./state/preview/config-bootstrap.json
  npm run cli -- preview:payment-hook:reference-script --lovelace-per-output 3000000 --state ./state/preview/config-bootstrap.json [--build-only]
  npm run cli -- preview:payment-hook:bootstrap --state ./state/preview/config-bootstrap.json [--build-only]
  npm run cli -- preview:receiver:parameterize --protocol-state ./state/preview/config-bootstrap.json --state ./state/preview/clients/client-a.json
  npm run cli -- preview:reference-scripts:publish-client --lovelace-per-output 3000000 --protocol-state ./state/preview/config-bootstrap.json --state ./state/preview/clients/client-a.json [--build-only]
  npm run cli -- preview:receiver:bootstrap --protocol-state ./state/preview/config-bootstrap.json --state ./state/preview/clients/client-a.json [--build-only]
  npm run cli -- preview:update --intent ./state/preview/intents/usdc-usd.signed.json --min-utxo-lovelace 5000000 --protocol-state ./state/preview/config-bootstrap.json --client-state ./state/preview/clients/client-a.json --state ./state/preview/clients/client-a/pairs/usdc-usd.json [--build-only]
  npm run cli -- preview:config:update --input ./state/preview/config-updates/config-update.preview.json --state ./state/preview/config-bootstrap.json [--build-only]
  npm run cli -- preview:update:batch:create [--pairs-dir ./state/preview/clients/client-a/pairs] [--intents-dir ./state/preview/intents] [--out ./state/preview/update-batches/update-batch.manifest.json]
  npm run cli -- preview:update:batch --protocol-state ./state/preview/config-bootstrap.json --client-state ./state/preview/clients/client-a.json --manifest ./state/preview/update-batches/update-batch.manifest.json [--min-utxo-lovelace 5000000] [--build-only] [--out ./state/preview/update-batches/update-batch.result.json]
  npm run cli -- preview:receiver:top-up --amount-lovelace 5000000 --protocol-state ./state/preview/config-bootstrap.json --state ./state/preview/clients/client-a.json [--build-only]
  npm run cli -- preview:receiver:withdraw --amount-lovelace 2000000 [--recipient-address <addr>] --protocol-state ./state/preview/config-bootstrap.json --state ./state/preview/clients/client-a.json [--build-only]
  npm run cli -- preview:settle --protocol-state ./state/preview/config-bootstrap.json --client-state ./state/preview/clients/client-a.json [--build-only]
  npm run cli -- preview:payment-hook:withdraw --amount-lovelace 2000000 --state ./state/preview/config-bootstrap.json [--build-only]`);
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

    case "preview:reference-holder": {
      const {
        makeReferenceHolderValidator,
        scriptAddressFromValidator,
        scriptHashFromValidator,
      } = await import("./core/contracts.js");
      const validator = await makeReferenceHolderValidator();
      printJson({
        network: "Preview",
        validator: "reference_holder.reference_holder.spend",
        address: scriptAddressFromValidator(validator),
        scriptHash: scriptHashFromValidator(validator),
        spendableByWallet: false,
      });
      return;
    }

    case "preview:protocol": {
      const { getProtocolParameters } = await import("./core/protocol.js");
      getCliConfig();
      const result = await getProtocolParameters();
      printJson(result);
      return;
    }

    case "preview:wallet": {
      const { walletSummary } = await import("./wallet/wallet.js");
      getCliConfig();
      const result = await walletSummary();
      printJson(result);
      return;
    }

    case "preview:wallet:utxos": {
      const { walletUtxos } = await import("./wallet/wallet.js");
      getCliConfig();
      const result = await walletUtxos();
      printJson(result);
      return;
    }

    case "preview:wallet:defaults": {
      const { walletDefaults } = await import("./wallet/wallet.js");
      getCliConfig();
      const result = await walletDefaults();
      printJson(result);
      return;
    }

    case "preview:wallet:create": {
      const { createWallet } = await import("./wallet/wallet-create.js");
      const result = createWallet();
      printJson(result);
      return;
    }

    case "preview:ethereum-wallet:create": {
      const { createEthereumWallet } = await import(
        "./oracle/ethereum-wallet-create.js"
      );
      const result = createEthereumWallet();
      printJson(result);
      return;
    }

    case "preview:protocol:init": {
      const { initializeProtocolState } = await import("./init/protocol-init.js");
      getCliConfig();
      const result = await initializeProtocolState({
        useDefaults: hasFlag("--use-defaults"),
      });
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Protocol artifact output path",
          defaultValue: "./state/preview/config-bootstrap.json",
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "preview:client:init": {
      const { initializeClientState } = await import("./init/client-init.js");
      getCliConfig();
      const statePath = await resolveTextFlag({
        flag: "--state",
        message: "Protocol state path",
        defaultValue: "./state/preview/config-bootstrap.json",
      });
      const result = await initializeClientState({
        statePath,
        clientId: optionalFlagValue("--client-id"),
        useDefaults: hasFlag("--use-defaults"),
      });
      const resolvedClientId =
        result.drafts?.receiverParameterize?.clientId ?? "client-a";
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Client artifact output path",
          defaultValue: `./state/preview/clients/${resolvedClientId}.json`,
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "preview:intent:create": {
      const {
        createPreviewOracleIntent,
        defaultUnsignedIntentOutputPath,
      } = await import("./oracle/intent-create.js");
      const result = await createPreviewOracleIntent({
        statePath: optionalFlagValue("--state"),
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

    case "preview:intent:sign": {
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

    case "preview:intent:create-and-sign": {
      const {
        createAndSignPreviewOracleIntent,
        defaultSignedIntentOutputPath,
      } = await import("./oracle/intent-create.js");
      const result = await createAndSignPreviewOracleIntent({
        statePath: optionalFlagValue("--state"),
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

    case "preview:config:update:create": {
      const { createConfigUpdateDraft } = await import("./init/config-update-create.js");
      getCliConfig();
      const statePath = await resolveTextFlag({
        flag: "--state",
        message: "Protocol state path",
        defaultValue: "./state/preview/config-bootstrap.json",
      });
      const result = await createConfigUpdateDraft({ statePath });
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Config update draft output path",
          defaultValue: "./state/preview/config-updates/config-update.preview.json",
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "preview:config:parameterize": {
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

    case "preview:config:reference-scripts": {
      const { publishConfigReferenceScripts } = await import(
        "./deploys/config-reference-scripts.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await publishConfigReferenceScripts({
        lovelacePerOutput: requireFlagValue("--lovelace-per-output"),
        statePath,
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "preview:config:bootstrap": {
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

    case "preview:config:update": {
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

    case "preview:payment-hook:bootstrap": {
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

    case "preview:payment-hook:parameterize": {
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

    case "preview:payment-hook:reference-script": {
      const { publishPaymentHookReferenceScript } = await import(
        "./deploys/payment-hook-reference-script.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await publishPaymentHookReferenceScript({
        lovelacePerOutput: requireFlagValue("--lovelace-per-output"),
        statePath,
        buildOnly,
      });
      if (statePath && !buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
    }

    case "preview:payment-hook:withdraw": {
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

    case "preview:settle": {
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

    case "preview:receiver:bootstrap": {
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

    case "preview:receiver:parameterize": {
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

    case "preview:reference-scripts:publish-client": {
      const { publishClientReferenceScripts } = await import(
        "./deploys/client-reference-scripts.js"
      );
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      const buildOnly = hasBuildOnlyFlag();
      const result = await publishClientReferenceScripts({
        lovelacePerOutput: requireFlagValue("--lovelace-per-output"),
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

    case "preview:receiver:top-up": {
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

    case "preview:receiver:withdraw": {
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

    case "preview:update:batch": {
      const { submitBatchOracleUpdate } = await import("./transactions/update-batch.js");
      getCliConfig();
      const result = await submitBatchOracleUpdate({
        manifestPath: requireFlagValue("--manifest"),
        clientStatePath: requireFlagValue("--client-state"),
        protocolStatePath: requireFlagValue("--protocol-state"),
        minUtxoLovelace: optionalFlagValue("--min-utxo-lovelace"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:update:batch:create": {
      const { createBatchUpdateManifest } = await import("./init/batch-update-create.js");
      const result = await createBatchUpdateManifest({
        pairsDir: optionalFlagValue("--pairs-dir"),
        intentsDir: optionalFlagValue("--intents-dir"),
      });
      const outPath = optionalFlagValue("--out") ??
        await promptForText({
          message: "Batch manifest output path",
          defaultValue: "./state/preview/update-batches/update-batch.manifest.json",
        });
      await writeJsonOutput(outPath, result);
      printJson(result);
      return;
    }

    case "preview:update": {
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
        minUtxoLovelace: optionalFlagValue("--min-utxo-lovelace"),
        buildOnly,
      });
      if (!buildOnly) {
        await writeJsonOutput(statePath, result);
      }
      printJson(result);
      return;
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
