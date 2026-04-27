import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  signDiaOracleIntentInput,
  type DiaEip712DomainInput,
  type UnsignedDiaOracleIntentInput,
} from "../core/dia-intent.js";

export type IntentSignInput = {
  domain: DiaEip712DomainInput;
  intent: UnsignedDiaOracleIntentInput;
};

type SignedPreviewOracleIntent = {
  intent: ReturnType<typeof signDiaOracleIntentInput>["intent"];
  witness: {
    signerPublicKey: string;
    signerAddress: string;
    intentHash: string;
    compactSignature: string;
  };
};

function requireIntentSigningPrivateKey(): string {
  const privateKey = process.env.DIA_EVM_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error("Missing required environment variable: DIA_EVM_PRIVATE_KEY");
  }
  return privateKey;
}

export function signPreviewOracleIntentFromInput(args: {
  input: IntentSignInput;
}): SignedPreviewOracleIntent {
  const signed = signDiaOracleIntentInput({
    domain: args.input.domain,
    intent: args.input.intent,
    privateKey: requireIntentSigningPrivateKey(),
  });

  return {
    intent: signed.intent,
    witness: {
      signerPublicKey: signed.signerPublicKey,
      signerAddress: signed.signerAddress,
      intentHash: signed.intentHash,
      compactSignature: signed.compactSignature,
    },
  };
}

export async function signPreviewOracleIntent(args: {
  inputPath: string;
}): Promise<SignedPreviewOracleIntent> {
  const input = await readIntentSignInput(path.resolve(args.inputPath));
  return signPreviewOracleIntentFromInput({ input });
}

async function readIntentSignInput(inputPath: string): Promise<IntentSignInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as IntentSignInput;
}
