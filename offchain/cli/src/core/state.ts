import { readFile } from "node:fs/promises";
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
  paymentHookPolicyId: string | null;
  paymentHookUnit: string | null;
  paymentHookValidatorHash: string | null;
  paymentHookValidatorAddress: string | null;
};

export type ClientDeploymentScripts = {
  pairPolicyId: string | null;
  pairValidatorHash: string | null;
  pairValidatorAddress: string | null;
};

export type ResolvedDeploymentScripts = ProtocolDeploymentScripts &
  ClientDeploymentScripts;

export type ReceiverState = {
  balanceLovelace: string;
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
  receiverUtxo: {
    current: {
      txHash: string;
      outputIndex: number;
    };
  };
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
  };
};

export type ProtocolCompiledScripts = {
  configMintPolicy: string;
  configValidator: string;
  coordinatorValidator: string;
  paymentHookMintPolicy: string;
  paymentHookValidator: string;
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
  referenceHolderAddress?: string;
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
  configUtxo: {
    current: {
      txHash: string;
      outputIndex: number;
    };
  };
  paymentHookState: PaymentHookState | null;
  paymentHookUtxo: {
    current: {
      txHash: string;
      outputIndex: number;
    };
  } | null;
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
    stateUtxo: {
      txHash: string;
      outputIndex: number;
    };
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

export async function readPairState(
  statePath: string,
): Promise<PairStateArtifact> {
  const raw = await readFile(path.resolve(statePath), "utf8");
  return JSON.parse(raw) as PairStateArtifact;
}
