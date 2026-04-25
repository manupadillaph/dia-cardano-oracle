import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type BlueprintValidator = {
  title: string;
  compiledCode?: string;
  hash?: string;
  datum?: unknown;
  redeemer?: unknown;
  parameters?: unknown;
};

type Blueprint = {
  validators?: BlueprintValidator[];
};

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BLUEPRINT_PATH = path.resolve(
  CURRENT_DIR,
  "../../../../contracts/aiken/plutus.json",
);

export async function readBlueprint(
  blueprintPath: string = DEFAULT_BLUEPRINT_PATH,
): Promise<Blueprint> {
  const raw = await readFile(blueprintPath, "utf8");
  return JSON.parse(raw) as Blueprint;
}

export async function listBlueprintValidators(
  blueprintPath?: string,
): Promise<BlueprintValidator[]> {
  const blueprint = await readBlueprint(blueprintPath);
  return blueprint.validators ?? [];
}

export async function getBlueprintValidator(
  title: string,
  blueprintPath?: string,
): Promise<BlueprintValidator> {
  const validators = await listBlueprintValidators(blueprintPath);
  const validator = validators.find((entry) => entry.title === title);

  if (!validator) {
    throw new Error(`Validator not found in blueprint: ${title}`);
  }

  if (!validator.compiledCode) {
    throw new Error(`Validator is missing compiled code: ${title}`);
  }

  return validator;
}

export function getDefaultBlueprintPath(): string {
  return DEFAULT_BLUEPRINT_PATH;
}
