import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { input } from "@inquirer/prompts";

import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  getDefaultConfigStatePath,
  readConfigState,
} from "../core/state.js";
import { resolveIntentTimingFromNetwork } from "../core/network-time.js";
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

  const lucid = await makeConfiguredLucid();
  await selectConfiguredWallet(lucid);
  const timing = await resolveIntentTimingFromNetwork({
    lucid,
    expirySeconds: 3600n,
  });

  return {
    domain,
    intent: {
      ...defaultIntent,
      version: domain.version,
      chainId: domain.sourceChainId,
      nonce: timing.nonce,
      expiry: timing.expiry,
      timestamp: timing.timestamp,
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
  intentType?: string;
  nonce?: string;
  expiry?: string;
  symbol?: string;
  price?: string;
  timestamp?: string;
  source?: string;
}): Promise<IntentSignInput> {
  const defaults = await resolvePromptDefaults(args.statePath);

  if (
    args.intentType ||
    args.nonce ||
    args.expiry ||
    args.symbol ||
    args.price ||
    args.timestamp ||
    args.source
  ) {
    const intentType = args.intentType?.trim() || defaults.intent.intentType;
    const nonce = args.nonce?.trim() || String(defaults.intent.nonce);
    const expiry = args.expiry?.trim() || String(defaults.intent.expiry);
    const symbol = args.symbol?.trim() || defaults.intent.symbol;
    const price = args.price?.trim() || String(defaults.intent.price);
    const timestamp = args.timestamp?.trim() || String(defaults.intent.timestamp);
    const source = args.source?.trim() || defaults.domain.name;

    for (const [label, value] of [
      ["nonce", nonce],
      ["expiry", expiry],
      ["price", price],
      ["timestamp", timestamp],
    ] as const) {
      const validation = validateIntegerString(value);
      if (validation) {
        throw new Error(`Invalid ${label}: ${validation}`);
      }
    }

    return {
      domain: defaults.domain,
      intent: {
        intentType,
        version: defaults.domain.version,
        chainId: defaults.domain.sourceChainId,
        nonce,
        expiry,
        symbol,
        price,
        timestamp,
        source,
      },
    };
  }

  console.error(
    "[intent:create] Using EIP-712 domain from protocol state:",
  );
  console.error(`  name              ${defaults.domain.name}`);
  console.error(`  version           ${defaults.domain.version}`);
  console.error(`  sourceChainId     ${defaults.domain.sourceChainId}`);
  console.error(`  verifyingContract ${defaults.domain.verifyingContract}`);
  console.error(
    "[intent:create] Enter the OracleIntent fields that change per intent.",
  );

  const intentType = await promptValue({
    label: "Intent type",
    defaultValue: defaults.intent.intentType,
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

  return {
    domain: defaults.domain,
    intent: {
      intentType,
      version: defaults.domain.version,
      chainId: defaults.domain.sourceChainId,
      nonce,
      expiry,
      symbol,
      price,
      timestamp,
      source: defaults.domain.name,
    },
  };
}

export async function signPreviewOracleIntentInteractive(): Promise<ReturnType<typeof signPreviewOracleIntentFromInput>> {
  console.error("[intent:sign] Select the unsigned OracleIntent JSON to sign.");
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
  intentType?: string;
  nonce?: string;
  expiry?: string;
  symbol?: string;
  price?: string;
  timestamp?: string;
  source?: string;
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
