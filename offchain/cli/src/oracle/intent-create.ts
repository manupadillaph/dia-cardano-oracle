import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { input } from "@inquirer/prompts";

import {
  getDefaultConfigStatePath,
  readConfigState,
} from "../core/state.js";
import {
  signedIntentPathForSymbol,
  unsignedIntentPathForSymbol,
} from "../core/intent-paths.js";
import {
  signPreviewOracleIntentFromInput,
  type IntentSignInput,
} from "./intent-sign.js";

type PromptDefaults = {
  domain: IntentSignInput["domain"];
  intent: IntentSignInput["intent"];
};

const DEFAULT_DOMAIN = {
  name: "DIA Oracle",
  version: "1.0",
  sourceChainId: "100640",
  verifyingContract: "0xF8c614A483A0427A13512F52ac72A576678bE317",
};

function toUnixSeconds(date: Date): string {
  return Math.floor(date.getTime() / 1000).toString();
}

function with0x(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? value : `0x${value}`;
}

async function resolvePromptDefaults(statePath?: string): Promise<PromptDefaults> {
  let domain = DEFAULT_DOMAIN;
  let defaultIntent: IntentSignInput["intent"] = {
    intentType: "OracleUpdate",
    version: domain.version,
    chainId: domain.sourceChainId,
    nonce: "0",
    expiry: "0",
    symbol: "USDC/USD",
    price: "100045678",
    timestamp: "0",
    source: domain.name,
  };

  const resolvedStatePath = statePath
    ? path.resolve(statePath)
    : getDefaultConfigStatePath();

  try {
    const state = await readConfigState(resolvedStatePath);
    if (
      state.configState.domain.name.trim().length > 0 &&
      state.configState.domain.version.trim().length > 0 &&
      state.configState.domain.sourceChainId.trim().length > 0 &&
      state.configState.domain.sourceChainId !== "0" &&
      state.configState.domain.verifyingContract.trim().length > 0
    ) {
      domain = {
        name: state.configState.domain.name,
        version: state.configState.domain.version,
        sourceChainId: state.configState.domain.sourceChainId,
        verifyingContract: with0x(state.configState.domain.verifyingContract),
      };
    }
  } catch {
    // Fall back to Preview defaults when no protocol artifact is available.
  }

  const now = new Date();
  const timestamp = toUnixSeconds(now);
  const expiry = (BigInt(timestamp) + 3600n).toString();

  return {
    domain,
    intent: {
      ...defaultIntent,
      version: domain.version,
      chainId: domain.sourceChainId,
      nonce: now.getTime().toString(),
      expiry,
      timestamp,
      source: domain.name,
    },
  };
}

async function promptValue(args: {
  label: string;
  defaultValue?: string;
  validate?: (value: string) => string | null;
}): Promise<string> {
  return input({
    message: args.label,
    default: args.defaultValue,
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return "Value is required.";
      }
      return args.validate?.(trimmed) ?? true;
    },
    transformer: (value) => value.trim(),
  });
}

function validateIntegerString(value: string): string | null {
  return /^\d+$/.test(value) ? null : "Enter a non-negative integer.";
}

function validateHexAddress(value: string): string | null {
  const normalized = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{40}$/.test(normalized)) {
    return "Enter a 20-byte hex Ethereum address.";
  }
  return null;
}

async function promptExistingFilePath(): Promise<string> {
  while (true) {
    const value = await promptValue({
      label: "Unsigned intent JSON path",
      defaultValue: unsignedIntentPathForSymbol("USDC/USD"),
    });
    try {
      await access(path.resolve(value));
      return value;
    } catch {
      console.error("File does not exist.");
    }
  }
}

export async function createPreviewOracleIntent(args: {
  statePath?: string;
}): Promise<IntentSignInput> {
  const defaults = await resolvePromptDefaults(args.statePath);
  console.error("[preview:intent:create] Enter the unsigned OracleIntent fields.");

  const domainName = await promptValue({
    label: "Domain name",
    defaultValue: defaults.domain.name,
  });
  const domainVersion = await promptValue({
    label: "Domain version",
    defaultValue: defaults.domain.version,
  });
  const sourceChainId = await promptValue({
    label: "Domain sourceChainId",
    defaultValue: String(defaults.domain.sourceChainId),
    validate: validateIntegerString,
  });
  const verifyingContract = await promptValue({
    label: "Domain verifyingContract",
    defaultValue: defaults.domain.verifyingContract,
    validate: validateHexAddress,
  });

  const intentType = await promptValue({
    label: "Intent type",
    defaultValue: defaults.intent.intentType,
  });
  const intentVersion = await promptValue({
    label: "Intent version",
    defaultValue: defaults.intent.version,
  });
  const chainId = await promptValue({
    label: "Intent chainId",
    defaultValue: String(defaults.intent.chainId),
    validate: validateIntegerString,
  });
  const nonce = await promptValue({
    label: "Nonce",
    defaultValue: String(defaults.intent.nonce),
    validate: validateIntegerString,
  });
  const expiry = await promptValue({
    label: "Expiry (unix seconds)",
    defaultValue: String(defaults.intent.expiry),
    validate: validateIntegerString,
  });
  const symbol = await promptValue({
    label: "Symbol",
    defaultValue: defaults.intent.symbol,
  });
  const price = await promptValue({
    label: "Price",
    defaultValue: String(defaults.intent.price),
    validate: validateIntegerString,
  });
  const timestamp = await promptValue({
    label: "Timestamp (unix seconds)",
    defaultValue: String(defaults.intent.timestamp),
    validate: validateIntegerString,
  });
  const source = await promptValue({
    label: "Source",
    defaultValue: defaults.intent.source,
  });

  return {
    domain: {
      name: domainName,
      version: domainVersion,
      sourceChainId,
      verifyingContract,
    },
    intent: {
      intentType,
      version: intentVersion,
      chainId,
      nonce,
      expiry,
      symbol,
      price,
      timestamp,
      source,
    },
  };
}

export async function signPreviewOracleIntentInteractive(): Promise<ReturnType<typeof signPreviewOracleIntentFromInput>> {
  console.error("[preview:intent:sign] Select the unsigned OracleIntent JSON to sign.");
  const inputPath = await promptExistingFilePath();
  const parsedInput = JSON.parse(
    await readFile(path.resolve(inputPath), "utf8"),
  ) as IntentSignInput;
  return signPreviewOracleIntentFromInput({
    input: parsedInput,
  });
}

export async function createAndSignPreviewOracleIntent(args: {
  statePath?: string;
}): Promise<ReturnType<typeof signPreviewOracleIntentFromInput>> {
  const unsignedIntent = await createPreviewOracleIntent(args);
  return signPreviewOracleIntentFromInput({ input: unsignedIntent });
}

export function defaultUnsignedIntentOutputPath(intent: IntentSignInput): string {
  return unsignedIntentPathForSymbol(intent.intent.symbol);
}

export function defaultSignedIntentOutputPath(args: {
  symbol: string;
}): string {
  return signedIntentPathForSymbol(args.symbol);
}
