import type { ConfigStateArtifact } from "../core/state.js";

/**
 * Mirrors `hook_and_coordinator_are_consistent` and non-empty
 * `valid_payment_hook_ref` from `config_logic.ak`.
 */
export function assertHookCoordinatorConsistency(
  paymentHookRef: ConfigStateArtifact["configState"]["paymentHookRef"],
  updateCoordinatorCredential: ConfigStateArtifact["configState"]["updateCoordinatorCredential"],
): void {
  const hookSet = paymentHookRef !== null;
  const coordSet = updateCoordinatorCredential !== null;

  if (hookSet && !coordSet) {
    throw new Error(
      "Config update would leave paymentHookRef set without updateCoordinatorCredential; on-chain admin_update would reject this.",
    );
  }
  if (!hookSet && coordSet) {
    throw new Error(
      "Config update would leave updateCoordinatorCredential set without paymentHookRef; on-chain admin_update would reject this.",
    );
  }
  if (hookSet && paymentHookRef) {
    if (paymentHookRef.policyId.length === 0 || paymentHookRef.assetName.length === 0) {
      throw new Error(
        "paymentHookRef.policyId and paymentHookRef.assetName must be non-empty hex (valid_payment_hook_ref on-chain).",
      );
    }
  }
}

/** Any tx that needs `has_config_signer` (settle, receiver withdraw, hook withdraw, …). */
export function assertPaymentKeyHashIsConfigSigner(
  paymentKeyHash: string,
  validConfigSigners: readonly string[],
  options?: { unauthorizedMessage?: string },
): void {
  if (!validConfigSigners.includes(paymentKeyHash)) {
    throw new Error(
      options?.unauthorizedMessage ??
        "The configured wallet is not authorized as a config signer.",
    );
  }
}

export function assertPositiveMinUtxoLovelace(
  minUtxoLovelace: bigint,
  label: string,
): void {
  if (minUtxoLovelace <= 0n) {
    throw new Error(`${label} min_utxo_lovelace must be greater than zero lovelace.`);
  }
}

/**
 * Ensures the loaded config UTxO sits at the script address from the artifact (guards mis-bound state / relocate).
 */
export function assertConfigUtxoLivesAtValidatorAddress(
  utxoAddress: string,
  expectedConfigValidatorAddress: string,
): void {
  if (utxoAddress !== expectedConfigValidatorAddress) {
    throw new Error(
      `Loaded config UTxO address does not match scripts.configValidatorAddress from state (expected ${expectedConfigValidatorAddress}, got ${utxoAddress}).`,
    );
  }
}

/** Fresh protocol artifact must list at least one admin signer. */
export function assertNonEmptyConfigSignerList(signers: readonly string[]): void {
  if (signers.length === 0) {
    throw new Error("validConfigSigners must list at least one payment key hash.");
  }
  for (const entry of signers) {
    if (!entry || entry.trim().length === 0) {
      throw new Error("Each validConfigSigners entry must be a non-empty hex string.");
    }
  }
}
