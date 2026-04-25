import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  signDiaOracleIntentInput,
  type DiaEip712DomainInput,
  type UnsignedDiaOracleIntentInput,
} from "../core/dia-intent.js";

type IntentSignInput = {
  domain: DiaEip712DomainInput;
  intent: UnsignedDiaOracleIntentInput;
};

export async function signPreviewOracleIntent(args: {
  inputPath: string;
}): Promise<{
  intent: ReturnType<typeof signDiaOracleIntentInput>["intent"];
  witness: {
    signerPublicKey: string;
    signerAddress: string;
    intentHash: string;
    compactSignature: string;
  };
}> {
  const privateKey = process.env.DIA_EVM_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error("Missing required environment variable: DIA_EVM_PRIVATE_KEY");
  }

  const input = await readIntentSignInput(path.resolve(args.inputPath));
  const signed = signDiaOracleIntentInput({
    domain: input.domain,
    intent: input.intent,
    privateKey,
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

async function readIntentSignInput(inputPath: string): Promise<IntentSignInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as IntentSignInput;
}
