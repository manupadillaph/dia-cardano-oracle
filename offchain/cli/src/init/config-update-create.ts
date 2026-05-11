import { input as promptInput } from "@inquirer/prompts";
import path from "node:path";

import {
  normalizeEthereumAddressHex,
  parseCommaSeparatedHexList,
} from "../core/dia-intent.js";
import { readConfigState } from "../core/state.js";
import { toBigInt } from "../core/chain-helpers.js";

export type ConfigUpdateDraft = {
  validConfigSigners: string[];
  authorizedDiaPublicKeys: string[];
  domain: {
    name: string;
    version: string;
    sourceChainId: string;
    verifyingContract: string;
  };
  baseFeeLovelace: string;
  perPairFeeLovelace: string;
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

export async function createConfigUpdateDraft(args: {
  statePath: string;
}): Promise<ConfigUpdateDraft> {
  const state = await readConfigState(path.resolve(args.statePath));
  console.error("[preview:config:update:create] Enter the next Config values.");

  const validConfigSignersRaw = await promptForText({
    message: "Valid config signers (comma-separated payment key hashes)",
    defaultValue: state.configState.validConfigSigners.join(", "),
  });
  const authorizedDiaPublicKeysRaw = await promptForText({
    message: "Authorized DIA public keys (comma-separated compressed secp256k1 pubkeys)",
    defaultValue: state.configState.authorizedDiaPublicKeys.join(", "),
  });
  const domainName = await promptForText({
    message: "Domain name",
    defaultValue: state.configState.domain.name,
  });
  const domainVersion = await promptForText({
    message: "Domain version",
    defaultValue: state.configState.domain.version,
  });
  const sourceChainId = await promptForText({
    message: "Domain sourceChainId",
    defaultValue: state.configState.domain.sourceChainId,
    validate: (value) => (/^\d+$/.test(value) ? true : "Enter a non-negative integer."),
  });
  const verifyingContract = await promptForText({
    message: "Domain verifyingContract",
    defaultValue: state.configState.domain.verifyingContract,
  });
  const baseFeeLovelace = await promptForText({
    message: "Base protocol fee lovelace (constant component)",
    defaultValue: state.configState.baseFeeLovelace,
    validate: (value) => (/^\d+$/.test(value) ? true : "Enter a non-negative integer."),
  });
  const perPairFeeLovelace = await promptForText({
    message: "Per-pair protocol fee lovelace (variable component per pair)",
    defaultValue: state.configState.perPairFeeLovelace,
    validate: (value) => (/^\d+$/.test(value) ? true : "Enter a non-negative integer."),
  });

  return {
    validConfigSigners: parseCommaSeparatedHexList(validConfigSignersRaw, "validConfigSigners[]"),
    authorizedDiaPublicKeys: parseCommaSeparatedHexList(
      authorizedDiaPublicKeysRaw,
      "authorizedDiaPublicKeys[]",
    ),
    domain: {
      name: domainName,
      version: domainVersion,
      sourceChainId: toBigInt(sourceChainId, "domain.sourceChainId").toString(),
      verifyingContract: normalizeEthereumAddressHex(
        verifyingContract,
        "domain.verifyingContract",
      ),
    },
    baseFeeLovelace: toBigInt(baseFeeLovelace, "baseFeeLovelace").toString(),
    perPairFeeLovelace: toBigInt(perPairFeeLovelace, "perPairFeeLovelace").toString(),
  };
}
