import {
  CML,
  Constr,
  applyParamsToScript,
  mintingPolicyToId,
  validatorToAddress,
  validatorToScriptHash,
  type Data as LucidData,
  type MintingPolicy,
  type OutRef,
  type SpendingValidator,
  type WithdrawalValidator,
} from "@lucid-evolution/lucid";
import { getBlueprintValidator } from "./blueprint.js";
import { getCliConfig } from "./config.js";
import { normalizeHex } from "./dia-intent.js";

const CONFIG_STATE_MINT_TITLE = "config_state.config_state.mint";
const CONFIG_STATE_SPEND_TITLE = "config_state.config_state.spend";
const PAIR_STATE_MINT_TITLE = "pair_state.pair_state.mint";
const PAIR_STATE_SPEND_TITLE = "pair_state.pair_state.spend";
const PAYMENT_HOOK_MINT_TITLE = "payment_hook.payment_hook.mint";
const PAYMENT_HOOK_SPEND_TITLE = "payment_hook.payment_hook.spend";
const RECEIVER_MINT_TITLE = "receiver.receiver.mint";
const RECEIVER_SPEND_TITLE = "receiver.receiver.spend";
const COORDINATOR_WITHDRAW_TITLE = "update_coordinator.update_coordinator.withdraw";
const REFERENCE_HOLDER_SPEND_TITLE = "reference_holder.reference_holder.spend";

export async function makeConfigStateMintingPolicy(args: {
  bootstrapOutRef: OutRef;
  assetName: string;
}): Promise<MintingPolicy> {
  const validator = await getBlueprintValidator(CONFIG_STATE_MINT_TITLE);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      outRefToData(args.bootstrapOutRef),
      args.assetName,
    ]),
  };
}

export async function makeConfigStateValidator(args: {
  bootstrapOutRef: OutRef;
  assetName: string;
}): Promise<SpendingValidator> {
  const validator = await getBlueprintValidator(CONFIG_STATE_SPEND_TITLE);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      outRefToData(args.bootstrapOutRef),
      args.assetName,
    ]),
  };
}

export async function makePairStateMintingPolicy(args: {
  configPolicyId: string;
  configAssetName: string;
  receiverHash: string;
}): Promise<MintingPolicy> {
  const validator = await getBlueprintValidator(PAIR_STATE_MINT_TITLE);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      args.configPolicyId,
      args.configAssetName,
      args.receiverHash,
    ]),
  };
}

export async function makePairStateValidator(args: {
  configPolicyId: string;
  configAssetName: string;
  receiverHash: string;
}): Promise<SpendingValidator> {
  const validator = await getBlueprintValidator(PAIR_STATE_SPEND_TITLE);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      args.configPolicyId,
      args.configAssetName,
      args.receiverHash,
    ]),
  };
}

export async function makePaymentHookMintingPolicy(args: {
  bootstrapOutRef: OutRef;
  assetName: string;
  configPolicyId: string;
  configAssetName: string;
  coordinatorCredentialHash: string;
}): Promise<MintingPolicy> {
  const validator = await getBlueprintValidator(PAYMENT_HOOK_MINT_TITLE);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      outRefToData(args.bootstrapOutRef),
      args.assetName,
      args.configPolicyId,
      args.configAssetName,
      scriptCredentialData(args.coordinatorCredentialHash),
    ]),
  };
}

export async function makePaymentHookValidator(args: {
  bootstrapOutRef: OutRef;
  assetName: string;
  configPolicyId: string;
  configAssetName: string;
  coordinatorCredentialHash: string;
}): Promise<SpendingValidator> {
  const validator = await getBlueprintValidator(PAYMENT_HOOK_SPEND_TITLE);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      outRefToData(args.bootstrapOutRef),
      args.assetName,
      args.configPolicyId,
      args.configAssetName,
      scriptCredentialData(args.coordinatorCredentialHash),
    ]),
  };
}

export async function makeReceiverMintingPolicy(args: {
  bootstrapOutRef: OutRef;
  assetName: string;
  configPolicyId: string;
  configAssetName: string;
}): Promise<MintingPolicy> {
  const validator = await getBlueprintValidator(RECEIVER_MINT_TITLE);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      outRefToData(args.bootstrapOutRef),
      args.assetName,
      args.configPolicyId,
      args.configAssetName,
    ]),
  };
}

export async function makeReceiverValidator(args: {
  bootstrapOutRef: OutRef;
  assetName: string;
  configPolicyId: string;
  configAssetName: string;
}): Promise<SpendingValidator> {
  const validator = await getBlueprintValidator(RECEIVER_SPEND_TITLE);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      outRefToData(args.bootstrapOutRef),
      args.assetName,
      args.configPolicyId,
      args.configAssetName,
    ]),
  };
}

export async function makeCoordinatorValidator(args: {
  configPolicyId: string;
  configAssetName: string;
}): Promise<WithdrawalValidator> {
  const validator = await getBlueprintValidator(COORDINATOR_WITHDRAW_TITLE);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      args.configPolicyId,
      args.configAssetName,
    ]),
  };
}

export async function makeReferenceHolderValidator(args: {
  configPolicyId: string;
  configAssetName: string;
}): Promise<SpendingValidator> {
  const validator = await getBlueprintValidator(REFERENCE_HOLDER_SPEND_TITLE);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      args.configPolicyId,
      args.configAssetName,
    ]),
  };
}

export function scriptHashFromValidator(
  validator: SpendingValidator | WithdrawalValidator,
): string {
  return validatorToScriptHash(validator);
}

export function scriptAddressFromValidator(validator: SpendingValidator): string {
  return validatorToAddress("Preview", validator);
}

export function policyIdFromMintingPolicy(policy: MintingPolicy): string {
  return mintingPolicyToId(policy);
}

export function mintingPolicyFromCompiledScript(script: string): MintingPolicy {
  return {
    type: "PlutusV3",
    script: normalizeHex(script, "compiled minting policy"),
  };
}

export function spendingValidatorFromCompiledScript(script: string): SpendingValidator {
  return {
    type: "PlutusV3",
    script: normalizeHex(script, "compiled spending validator"),
  };
}

export function withdrawalValidatorFromCompiledScript(
  script: string,
): WithdrawalValidator {
  return {
    type: "PlutusV3",
    script: normalizeHex(script, "compiled withdrawal validator"),
  };
}

export function scriptRewardAddress(scriptHash: string): string {
  const networkId = getCliConfig().cardanoNetwork === "Preview" ? 0 : 1;
  const credential = CML.Credential.new_script(CML.ScriptHash.from_hex(scriptHash));
  return CML.RewardAddress.new(networkId, credential)
    .to_address()
    .to_bech32();
}

export function scriptCredentialState(scriptHash: string): {
  type: "Script";
  hash: string;
} {
  return {
    type: "Script",
    hash: scriptHash,
  };
}

export function scriptCredentialData(scriptHash: string): Constr<LucidData> {
  return new Constr<LucidData>(1, [scriptHash]);
}

export function outRefToData(outRef: OutRef): Constr<LucidData> {
  return new Constr<LucidData>(0, [outRef.txHash, BigInt(outRef.outputIndex)]);
}
