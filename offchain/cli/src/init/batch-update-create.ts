import { checkbox, input as promptInput } from "@inquirer/prompts";
import { networkTag } from "../core/config.js";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { signedIntentPathForSymbol } from "../core/intent-paths.js";
import { readPairState } from "../core/state.js";

export type BatchUpdateManifest = {
  updates: Array<{
    statePath: string;
    intentPath: string;
  }>;
};

async function promptForText(args: {
  message: string;
  defaultValue: string;
  validate?: (value: string) => string | true;
}): Promise<string> {
  return promptInput({
    message: args.message,
    default: args.defaultValue,
    validate: (value) =>
      args.validate?.(value.trim()) ??
      (value.trim().length > 0 || "Value is required."),
    transformer: (value) => value.trim(),
  });
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

function defaultIntentPathForPair(intentsDir: string, pairSymbol: string): string {
  return path.resolve(intentsDir, path.basename(signedIntentPathForSymbol(pairSymbol)));
}

export async function createBatchUpdateManifest(args: {
  pairsDir?: string;
  intentsDir?: string;
}): Promise<BatchUpdateManifest> {
  const pairsDir = path.resolve(args.pairsDir ?? `./state/${networkTag()}/clients/client-a/pairs`);
  const intentsDir = path.resolve(args.intentsDir ?? `./state/${networkTag()}/intents`);
  const pairFiles = await listJsonFiles(pairsDir);
  if (pairFiles.length === 0) {
    throw new Error(`No pair state JSON files were found in ${pairsDir}.`);
  }

  console.error("[update:batch:create] Select the pair states to include.");
  const selectedPairFiles = await checkbox({
    message: "Pair state files",
    choices: pairFiles.map((fileName) => ({
      name: fileName,
      value: fileName,
    })),
    validate: (values) => (values.length > 0 ? true : "Select at least one pair."),
  });

  const updates: BatchUpdateManifest["updates"] = [];
  for (const fileName of selectedPairFiles) {
    const statePath = path.join(pairsDir, fileName);
    const pairState = await readPairState(statePath);
    const intentPath = await promptForText({
      message: `Signed intent path for ${pairState.pair.pairId} (${pairState.pairState.intent.symbol})`,
      defaultValue: defaultIntentPathForPair(
        intentsDir,
        pairState.pairState.intent.symbol,
      ),
    });
    updates.push({
      statePath,
      intentPath: path.resolve(intentPath),
    });
  }

  return { updates };
}
