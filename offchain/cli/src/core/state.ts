import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DiaOracleIntentInput } from "./dia-intent.js";

export type PairEntryState = {
  tokenName: string;
  pairId: string;
};

export type PaymentHookRefState = {
  policyId: string;
  assetName: string;
  unit: string;
};

export type CoordinatorCredentialState = {
  type: "Script" | "Key";
  hash: string;
};

export type ConfigState = {
  validConfigSigners: string[];
  authorizedDiaPublicKeys: string[];
  domain: {
    name: string;
    version: string;
    sourceChainId: string;
    verifyingContract: string;
  };
  protocolFeeLovelace: string;
  maxBootstrapDriftSeconds: string;  // Intent freshness window for bootstrap validation
  paymentHookRef: PaymentHookRefState | null;
  updateCoordinatorCredential: CoordinatorCredentialState | null;
  minUtxoLovelace: string;
};

export type PaymentHookState = {
  withdrawAddress: string;
  minUtxoLovelace: string;
  accruedFeesLovelace: string;
  lifetimeCollectedLovelace: string;
  lifetimeWithdrawnLovelace: string;
};

export type ProtocolDeploymentScripts = {
  configPolicyId: string;
  configUnit: string;
  configValidatorHash: string;
  configValidatorAddress: string;
  coordinatorHash: string;
  coordinatorRewardAddress: string;
  referenceHolderValidatorHash: string;
  referenceHolderAddress: string;
  paymentHookPolicyId: string;
  paymentHookUnit: string;
  paymentHookValidatorHash: string;
  paymentHookValidatorAddress: string;
};

export type ClientDeploymentScripts = {
  pairPolicyId: string;
  pairValidatorHash: string;
  pairValidatorAddress: string;
};

export type ResolvedDeploymentScripts = ProtocolDeploymentScripts &
  ClientDeploymentScripts;

export type ReceiverState = {
  balanceLovelace: string;
  accruedToHookLovelace: string;  // Pending protocol fees to be settled to the hook
  minUtxoLovelace: string;
};

export type ReceiverArtifact = {
  clientId: string;
  bootstrapRef: {
    txHash: string;
    outputIndex: number;
  };
  receiverAssetName: string;
  receiverPolicyId: string;
  receiverUnit: string;
  receiverValidatorHash: string;
  receiverValidatorAddress: string;
  receiverState: ReceiverState;
};

export type ReceiverParameterizeDefaults = {
  clientId: string;
  receiverAssetLabel?: string;
  receiverAssetName: string;
  minUtxoLovelace: string;
};

export type ConfigParameterizeDefaults = {
  configAssetLabel?: string;
  configAssetName: string;
};

export type PaymentHookParameterizeDefaults = {
  paymentHookAssetLabel?: string;
  paymentHookAssetName: string;
  withdrawAddress: string;
  minUtxoLovelace: string;
};

export type ReferenceScriptUtxo = {
  txHash: string;
  outputIndex: number;
  scriptHash: string;
};

export type ReferenceScriptsState = {
  global?: {
    config: ReferenceScriptUtxo;
    coordinator: ReferenceScriptUtxo;
    paymentHook: ReferenceScriptUtxo;
  };
  client?: {
    receiver: ReferenceScriptUtxo;
    pair: ReferenceScriptUtxo;
    pairMint: ReferenceScriptUtxo;
  };
};

export type ProtocolCompiledScripts = {
  configMintPolicy: string;
  configValidator: string;
  coordinatorValidator: string;
  paymentHookMintPolicy: string;
  paymentHookValidator: string;
  referenceHolderValidator: string;
};

export type ClientCompiledScripts = {
  receiverMintPolicy: string;
  receiverValidator: string;
  pairMintPolicy: string;
  pairValidator: string;
};

export type ResolvedCompiledScripts = ProtocolCompiledScripts &
  ClientCompiledScripts;

export type TransactionRecord = {
  step: string;
  submittedTxHash: string | null;
  confirmed: boolean;
};

export type ConfigStateArtifact = {
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  bootstrapRefs: {
    config: {
      txHash: string;
      outputIndex: number;
    };
    paymentHook: {
      txHash: string;
      outputIndex: number;
    } | null;
  };
  scripts: ProtocolDeploymentScripts;
  configState: ConfigState;
  paymentHookState: PaymentHookState | null;
  compiledScripts: ProtocolCompiledScripts;
  drafts?: {
    configParameterize?: ConfigParameterizeDefaults;
    paymentHookParameterize?: PaymentHookParameterizeDefaults;
    receiverParameterize?: ReceiverParameterizeDefaults;
  };
  referenceScripts?: ReferenceScriptsState;
  receiver?: ReceiverArtifact;
  datum: {
    configCbor: string;
    paymentHookCbor: string;
  };
  transactions?: TransactionRecord[];
};

export type ClientStateArtifact = {
  wallet?: {
    source: "seed" | "private-key";
    address: string;
  };
  clientId: string;
  scripts: ClientDeploymentScripts;
  compiledScripts: ClientCompiledScripts;
  drafts?: {
    receiverParameterize?: ReceiverParameterizeDefaults;
  };
  referenceScripts?: {
    client?: {
      receiver: ReferenceScriptUtxo;
      pair: ReferenceScriptUtxo;
      pairMint: ReferenceScriptUtxo;
    };
  };
  receiver?: ReceiverArtifact;
  datum: {
    receiverCbor: string;
  };
  transactions?: TransactionRecord[];
};

export type PairLiveState = {
  pairId: string;
  price: string;
  timestamp: string;
  nonce: string;
  intentHash: string;
  signer: string;
  minUtxoLovelace: string;
  intent: DiaOracleIntentInput;
};

export type PairStateArtifact = {
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  pair: {
    tokenName: string;
    pairId: string;
    pairUnit: string;
    pairValidatorAddress: string;
  };
  pairState: PairLiveState;
  datum: {
    pairCbor: string;
  };
  transactions?: TransactionRecord[];
};

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PREVIEW_CONFIG_STATE_PATH = path.resolve(
  CURRENT_DIR,
  "../../state/preview/config-bootstrap.json",
);

export async function readConfigState(
  statePath: string = DEFAULT_PREVIEW_CONFIG_STATE_PATH,
): Promise<ConfigStateArtifact> {
  const raw = await readFile(path.resolve(statePath), "utf8");
  return JSON.parse(raw) as ConfigStateArtifact;
}

export async function readClientState(
  statePath: string,
): Promise<ClientStateArtifact> {
  const raw = await readFile(path.resolve(statePath), "utf8");
  return JSON.parse(raw) as ClientStateArtifact;
}

export function getDefaultConfigStatePath(): string {
  return DEFAULT_PREVIEW_CONFIG_STATE_PATH;
}

export function emptyProtocolCompiledScripts(): ProtocolCompiledScripts {
  return {
    configMintPolicy: "",
    configValidator: "",
    coordinatorValidator: "",
    paymentHookMintPolicy: "",
    paymentHookValidator: "",
    referenceHolderValidator: "",
  };
}

export function emptyReferenceScriptUtxo(): ReferenceScriptUtxo {
  return {
    txHash: "",
    outputIndex: 0,
    scriptHash: "",
  };
}

export function emptyClientCompiledScripts(): ClientCompiledScripts {
  return {
    receiverMintPolicy: "",
    receiverValidator: "",
    pairMintPolicy: "",
    pairValidator: "",
  };
}

export function appendTransactionRecord(
  records: TransactionRecord[] | undefined,
  entry: TransactionRecord,
): TransactionRecord[] | undefined {
  if (!entry.submittedTxHash) {
    return records;
  }

  return [...(records ?? []), entry];
}

export function hasCompletedStep(
  records: TransactionRecord[] | undefined,
  step: string,
): boolean {
  return Boolean(
    records?.some((entry) => entry.step === step && entry.submittedTxHash),
  );
}

export async function readPairState(
  statePath: string,
): Promise<PairStateArtifact> {
  const raw = await readFile(path.resolve(statePath), "utf8");
  return JSON.parse(raw) as PairStateArtifact;
}

// Same as readPairState, but returns null if the file does not exist
// instead of throwing. Used by the update tx builders to handle the
// "first update for this pair" case.
export async function readOptionalPairState(
  statePath: string,
): Promise<PairStateArtifact | null> {
  try {
    await access(statePath);
  } catch {
    return null;
  }
  return readPairState(statePath);
}
