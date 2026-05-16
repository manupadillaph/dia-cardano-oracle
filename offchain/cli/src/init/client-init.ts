import { input as promptInput } from "@inquirer/prompts";
import { normalizeHex, utf8ToHex } from "../core/dia-intent.js";
import { assertClientIdNonEmpty } from "../preflight/index.js";
import {
  emptyClientCompiledScripts,
  emptyReferenceScriptUtxo,
  readConfigState,
  type ClientStateArtifact,
  type ReceiverParameterizeDefaults,
} from "../core/state.js";

function normalizedClientIdSuffix(clientId: string): string {
  return clientId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function defaultReceiverAssetLabelForClient(clientId: string): string {
  return `DIA_RECEIVER_${normalizedClientIdSuffix(clientId)}`;
}

function receiverAssetNameFromLabel(label: string): string {
  return utf8ToHex(label.trim());
}

function defaultReceiverAssetNameForClient(clientId: string): string {
  return receiverAssetNameFromLabel(defaultReceiverAssetLabelForClient(clientId));
}

function defaultReceiverParameterizeDefaults(
  clientId: string,
  minUtxoLovelace: string,
): ReceiverParameterizeDefaults {
  return {
    clientId,
    receiverAssetLabel: defaultReceiverAssetLabelForClient(clientId),
    receiverAssetName: defaultReceiverAssetNameForClient(clientId),
    minUtxoLovelace,
  };
}

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

async function promptForReceiverDefaults(
  clientId: string,
  minUtxoLovelace: string,
): Promise<ReceiverParameterizeDefaults> {
  console.error("[client:init] Enter the initial Receiver defaults.");
  const defaults = defaultReceiverParameterizeDefaults(clientId, minUtxoLovelace);
  const resolvedClientId = await promptForText({
    message: "Client id",
    defaultValue: defaults.clientId,
  });
  const receiverAssetLabel = await promptForText({
    message: "Receiver asset label",
    defaultValue: defaultReceiverAssetLabelForClient(resolvedClientId),
  });

  return {
    clientId: resolvedClientId,
    receiverAssetLabel: receiverAssetLabel.trim(),
    receiverAssetName: normalizeHex(
      receiverAssetNameFromLabel(receiverAssetLabel),
      "receiverAssetName",
    ),
    minUtxoLovelace: defaults.minUtxoLovelace,
  };
}

export function createClientStateArtifact(
  clientId: string,
  receiverDefaults: ReceiverParameterizeDefaults,
): ClientStateArtifact {
  assertClientIdNonEmpty(clientId);

  return {
    clientId,
    scripts: {
      pairPolicyId: "",
      pairValidatorHash: "",
      pairValidatorAddress: "",
    },
    compiledScripts: emptyClientCompiledScripts(),
    drafts: {
      receiverParameterize: receiverDefaults,
    },
    referenceScripts: {
      client: {
        receiver: emptyReferenceScriptUtxo(),
        pair: emptyReferenceScriptUtxo(),
        pairMint: emptyReferenceScriptUtxo(),
      },
    },
    datum: {
      receiverCbor: "",
    },
  };
}

export async function initializeClientState(args: {
  statePath: string;
  clientId?: string;
  useDefaults?: boolean;
  receiverDefaults?: Omit<ReceiverParameterizeDefaults, "minUtxoLovelace">;
}): Promise<ClientStateArtifact> {
  const state = await readConfigState(args.statePath);
  if (!state.bootstrapRefs.config.txHash || !state.bootstrapRefs.paymentHook?.txHash) {
    throw new Error(
      "Client init requires protocol state after Config and PaymentHook bootstrap.",
    );
  }

  if (!state.configState.paymentHookRef || !state.configState.updateCoordinatorCredential) {
    throw new Error(
      "Client init requires protocol state after PaymentHook bootstrap.",
    );
  }
  const inheritedMinUtxoLovelace = state.configState.minUtxoLovelace;
  const receiverDefaults: ReceiverParameterizeDefaults = args.receiverDefaults
    ? { ...args.receiverDefaults, minUtxoLovelace: inheritedMinUtxoLovelace }
    : args.useDefaults
      ? defaultReceiverParameterizeDefaults(args.clientId ?? "client-a", inheritedMinUtxoLovelace)
      : await promptForReceiverDefaults(args.clientId ?? "client-a", inheritedMinUtxoLovelace);
  return createClientStateArtifact(
    receiverDefaults.clientId,
    receiverDefaults,
  );
}
