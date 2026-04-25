import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getCliConfig } from "./core/config.js";
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
  npm run cli -- preview:intent:sign --input ./examples/preview/01-oracle-intent-sign.example.json [--out ./tmp/usdc-usd.update.json]
  npm run cli -- preview:config:parameterize --input ./examples/preview/02-config-parameterize.example.json [--build-only] [--out ./state/preview/config-bootstrap.json]
  npm run cli -- preview:config:reference-scripts --input ./examples/preview/03-config-reference-scripts.example.json --state ./state/preview/config-bootstrap.json [--build-only] [--out ./state/preview/config-bootstrap.json]
  npm run cli -- preview:config:bootstrap --input ./examples/preview/04-config-bootstrap.example.json --state ./state/preview/config-bootstrap.json [--build-only] [--out ./state/preview/config-bootstrap.json]
  npm run cli -- preview:payment-hook:parameterize --input ./examples/preview/05-payment-hook-parameterize.example.json --state ./state/preview/config-bootstrap.json [--build-only] [--out ./state/preview/config-bootstrap.json]
  npm run cli -- preview:payment-hook:reference-script --input ./examples/preview/06-payment-hook-reference-script.example.json --state ./state/preview/config-bootstrap.json [--build-only] [--out ./state/preview/config-bootstrap.json]
  npm run cli -- preview:payment-hook:bootstrap --input ./examples/preview/07-payment-hook-bootstrap.example.json --state ./state/preview/config-bootstrap.json [--build-only] [--out ./state/preview/config-bootstrap.json]
  npm run cli -- preview:receiver:parameterize --input ./examples/preview/08-receiver-parameterize.example.json --state ./state/preview/config-bootstrap.json [--build-only] [--out ./state/preview/clients/client-a.json]
  npm run cli -- preview:reference-scripts:publish-client --input ./examples/preview/09-client-reference-scripts.example.json --state ./state/preview/clients/client-a.json [--build-only] [--out ./state/preview/clients/client-a.json]
  npm run cli -- preview:receiver:bootstrap --input ./examples/preview/10-receiver-bootstrap.example.json --state ./state/preview/clients/client-a.json [--build-only] [--out ./state/preview/clients/client-a.json]
  npm run cli -- preview:pair:bootstrap --input ./examples/preview/11-pair-bootstrap.example.json --state ./state/preview/clients/client-a.json [--build-only] [--out ./state/preview/clients/client-a/pairs/usdc-usd.json]
  npm run cli -- preview:update --input ./examples/preview/12-update.example.json --state ./state/preview/clients/client-a/pairs/usdc-usd.json [--build-only] [--out ./state/preview/clients/client-a/pairs/usdc-usd.json]
  npm run cli -- preview:config:update --input ./examples/preview/13-config-update.example.json --state ./state/preview/config-bootstrap.json [--build-only] [--out ./state/preview/config-bootstrap.json]
  npm run cli -- preview:update:batch --input ./examples/preview/14-update-batch.example.json [--build-only] [--out ./tmp/update-batch.json]
  npm run cli -- preview:receiver:top-up --input ./examples/preview/15-receiver-top-up.example.json --state ./state/preview/clients/client-a.json [--build-only] [--out ./state/preview/clients/client-a.json]
  npm run cli -- preview:receiver:withdraw --input ./examples/preview/16-receiver-withdraw.example.json --state ./state/preview/clients/client-a.json [--build-only] [--out ./state/preview/clients/client-a.json]
  npm run cli -- preview:payment-hook:withdraw --input ./examples/preview/17-payment-hook-withdraw.example.json --state ./state/preview/config-bootstrap.json [--build-only] [--out ./state/preview/config-bootstrap.json]`);
}

function requireInputPath(): string {
  const args = process.argv.slice(3);
  const inputFlagIndex = args.findIndex((arg) => arg === "--input");

  if (inputFlagIndex === -1 || !args[inputFlagIndex + 1]) {
    throw new Error("Missing required argument: --input <path>");
  }

  return args[inputFlagIndex + 1];
}

function hasBuildOnlyFlag(): boolean {
  return process.argv.slice(3).includes("--build-only");
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
        "./oracle/01-ethereum-wallet-create.js"
      );
      const result = createEthereumWallet();
      printJson(result);
      return;
    }

    case "preview:intent:sign": {
      const { signPreviewOracleIntent } = await import("./oracle/02-intent-sign.js");
      const result = await signPreviewOracleIntent({
        inputPath: requireInputPath(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:config:parameterize": {
      const { parameterizeConfigScripts } = await import(
        "./deploys/01-config-parameterize.js"
      );
      getCliConfig();
      const result = await parameterizeConfigScripts({
        inputPath: requireInputPath(),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:config:reference-scripts": {
      const { publishConfigReferenceScripts } = await import(
        "./deploys/02-config-reference-scripts.js"
      );
      getCliConfig();
      const result = await publishConfigReferenceScripts({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:config:bootstrap": {
      const { configBootstrap } = await import(
        "./deploys/03-config-bootstrap.js"
      );
      getCliConfig();
      const result = await configBootstrap({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:config:update": {
      const { configUpdate } = await import("./transactions/12-config-update.js");
      getCliConfig();
      const result = await configUpdate({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:payment-hook:bootstrap": {
      const { paymentHookBootstrap } = await import(
        "./deploys/06-payment-hook-bootstrap.js"
      );
      getCliConfig();
      const result = await paymentHookBootstrap({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:payment-hook:parameterize": {
      const { parameterizePaymentHookScripts } = await import(
        "./deploys/04-payment-hook-parameterize.js"
      );
      getCliConfig();
      const result = await parameterizePaymentHookScripts({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:payment-hook:reference-script": {
      const { publishPaymentHookReferenceScript } = await import(
        "./deploys/05-payment-hook-reference-script.js"
      );
      getCliConfig();
      const result = await publishPaymentHookReferenceScript({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:payment-hook:withdraw": {
      const { paymentHookWithdraw } = await import(
        "./transactions/16-payment-hook-withdraw.js"
      );
      getCliConfig();
      const result = await paymentHookWithdraw({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:receiver:bootstrap": {
      const { receiverBootstrap } = await import(
        "./deploys/09-receiver-bootstrap.js"
      );
      getCliConfig();
      const result = await receiverBootstrap({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:receiver:parameterize": {
      const { parameterizeReceiverScripts } = await import(
        "./deploys/07-receiver-parameterize.js"
      );
      getCliConfig();
      const result = await parameterizeReceiverScripts({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:reference-scripts:publish-client": {
      const { publishClientReferenceScripts } = await import(
        "./deploys/08-client-reference-scripts.js"
      );
      getCliConfig();
      const result = await publishClientReferenceScripts({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:receiver:top-up": {
      const { receiverTopUp } = await import("./transactions/14-receiver-top-up.js");
      getCliConfig();
      const result = await receiverTopUp({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:receiver:withdraw": {
      const { receiverWithdraw } = await import("./transactions/15-receiver-withdraw.js");
      getCliConfig();
      const result = await receiverWithdraw({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:pair:bootstrap": {
      const { pairBootstrap } = await import(
        "./deploys/10-pair-bootstrap.js"
      );
      getCliConfig();
      const result = await pairBootstrap({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:update:batch": {
      const { submitBatchOracleUpdate } = await import("./transactions/13-update-batch.js");
      getCliConfig();
      const result = await submitBatchOracleUpdate({
        inputPath: requireInputPath(),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:update": {
      const { submitOracleUpdate } = await import("./transactions/11-update.js");
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      if (!statePath) {
        throw new Error("Missing required argument: --state <path>");
      }
      const result = await submitOracleUpdate({
        inputPath: requireInputPath(),
        statePath,
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
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
