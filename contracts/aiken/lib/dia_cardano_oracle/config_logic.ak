use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Credential, Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Transaction}

pub type Domain {
  Domain {
    name: ByteArray,
    version: ByteArray,
    source_chain_id: Int,
    verifying_contract: ByteArray,
  }
}

pub type PaymentHookRef {
  PaymentHookRef { policy_id: PolicyId, asset_name: AssetName }
}

/// Configuration datum for the DIA Cardano Oracle protocol.
/// Controls administrative settings, fee structure, and cross-chain parameters.
pub type ConfigDatum {
  ConfigDatum {
    /// List of admin verification key hashes authorized to update config.
    config_admins: List<VerificationKeyHash>,
    /// List of authorized DIA secp256k1 public keys for intent signatures.
    authorized_dia_public_keys: List<ByteArray>,
    /// EIP-712 domain data for Ethereum signature verification.
    domain_data: Domain,
    /// Base protocol fee in lovelace (constant component).
    /// Formula: protocol_fee(N) = base_fee_lovelace + (N * per_pair_fee_lovelace)
    base_fee_lovelace: Int,
    /// Per-pair protocol fee in lovelace (variable component per pair).
    /// Formula: protocol_fee(N) = base_fee_lovelace + (N * per_pair_fee_lovelace)
    per_pair_fee_lovelace: Int,
    /// Reference to the global PaymentHook UTxO (if enabled).
    payment_hook_ref: Option<PaymentHookRef>,
    /// Credential of the update coordinator script (if enabled).
    update_coordinator_credential: Option<Credential>,
    /// Maximum time drift in seconds for intent freshness validation.
    max_bootstrap_drift_seconds: Int,
    /// Minimum lovelace required for protocol UTxOs.
    min_utxo_lovelace: Int,
  }
}

pub type ConfigRedeemer {
  AdminUpdate
}

pub fn has_config_signer(datum: ConfigDatum, tx: Transaction) -> Bool {
  list.any(
    datum.config_admins,
    fn(config_signer) { list.has(tx.extra_signatories, config_signer) },
  )
}

pub fn valid_domain(domain: Domain) -> Bool {
  and {
    !bytearray.is_empty(domain.name),
    !bytearray.is_empty(domain.version),
    domain.source_chain_id >= 0,
    bytearray.length(domain.verifying_contract) == 20,
  }
}

pub fn valid_payment_hook_ref(hook_ref: PaymentHookRef) -> Bool {
  !bytearray.is_empty(hook_ref.asset_name)
}

pub fn valid_config_state(datum: ConfigDatum) -> Bool {
  and {
    list.length(datum.config_admins) > 0,
    list.length(datum.authorized_dia_public_keys) > 0,
    valid_domain(datum.domain_data),
    datum.base_fee_lovelace >= 0,
    datum.per_pair_fee_lovelace >= 0,
    hook_and_coordinator_are_consistent(
      datum.payment_hook_ref,
      datum.update_coordinator_credential,
    ),
    unique_authorized_dia_public_keys(datum.authorized_dia_public_keys),
    datum.max_bootstrap_drift_seconds >= 0,
    datum.min_utxo_lovelace > 0,
  }
}

/// Validates that an admin update preserves frozen fields while allowing
/// updates to admins, keys, domain, drift, fee parameters, and min_utxo.
pub fn admin_update_transition(previous: ConfigDatum, next: ConfigDatum) -> Bool {
  and {
    valid_config_state(previous),
    valid_config_state(next),
    // min_utxo_lovelace can now be updated via AdminUpdate redeemer
    // All other fields can be changed by admin
  }
}

/// Calculates the total protocol fee for N pairs using the formula:
///   protocol_fee(N) = base_fee_lovelace + (N * per_pair_fee_lovelace)
/// 
/// # Parameters
/// - `datum`: The configuration datum containing fee parameters
/// - `pair_count`: Number of pairs (N >= 0)
/// 
/// # Returns
/// Total protocol fee in lovelace
pub fn calculate_protocol_fee(datum: ConfigDatum, pair_count: Int) -> Int {
  datum.base_fee_lovelace + (pair_count * datum.per_pair_fee_lovelace)
}

fn unique_authorized_dia_public_keys(keys: List<ByteArray>) -> Bool {
  when keys is {
    [] -> True
    [head, ..tail] -> and {
        !bytearray.is_empty(head),
        !list.has(tail, head),
        unique_authorized_dia_public_keys(tail),
      }
  }
}

fn hook_and_coordinator_are_consistent(
  maybe_hook_ref: Option<PaymentHookRef>,
  maybe_coordinator_credential: Option<Credential>,
) -> Bool {
  when maybe_hook_ref is {
    Some(hook_ref) ->
      when maybe_coordinator_credential is {
        Some(_) -> valid_payment_hook_ref(hook_ref)
        None -> False
      }

    None ->
      when maybe_coordinator_credential is {
        None -> True
        Some(_) -> False
      }
  }
}

pub fn sample_domain() -> Domain {
  Domain {
    name: #"444941204f7261636c65",
    version: #"312e30",
    source_chain_id: 100640,
    verifying_contract: #"f8c614a483a0427a13512f52ac72a576678be317",
  }
}

pub fn sample_config() -> ConfigDatum {
  ConfigDatum {
    config_admins: [#"11111111111111111111111111111111111111111111111111111111"],
    authorized_dia_public_keys: [
      #"03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807",
    ],
    domain_data: sample_domain(),
    base_fee_lovelace: 500_000,
    per_pair_fee_lovelace: 300_000,
    payment_hook_ref: None,
    update_coordinator_credential: None,
    max_bootstrap_drift_seconds: 86_400,
    min_utxo_lovelace: 2_000_000,
  }
}

fn sample_updated_fee_config() -> ConfigDatum {
  ConfigDatum {
    config_admins: sample_config().config_admins,
    authorized_dia_public_keys: sample_config().authorized_dia_public_keys,
    domain_data: sample_config().domain_data,
    base_fee_lovelace: 750_000,
    per_pair_fee_lovelace: 400_000,
    payment_hook_ref: sample_config().payment_hook_ref,
    update_coordinator_credential: sample_config().update_coordinator_credential,
    max_bootstrap_drift_seconds: sample_config().max_bootstrap_drift_seconds,
    min_utxo_lovelace: sample_config().min_utxo_lovelace,
  }
}

test valid_config_state_requires_non_empty_admins_and_domain() {
  valid_config_state(sample_config())
}

test admin_update_transition_accepts_fee_rotation() {
  admin_update_transition(sample_config(), sample_updated_fee_config())
}

test duplicate_authorized_dia_public_keys_are_rejected() {
  !valid_config_state(
    ConfigDatum {
      config_admins: sample_config().config_admins,
      authorized_dia_public_keys: [
        #"022222222222222222222222222222222222222222222222222222222222222222",
        #"022222222222222222222222222222222222222222222222222222222222222222",
      ],
      domain_data: sample_domain(),
      base_fee_lovelace: 500_000,
      per_pair_fee_lovelace: 300_000,
      payment_hook_ref: None,
      update_coordinator_credential: None,
      max_bootstrap_drift_seconds: 86_400,
      min_utxo_lovelace: 2_000_000,
    },
  )
}

test negative_max_bootstrap_drift_is_rejected() {
  !valid_config_state(
    ConfigDatum { ..sample_config(), max_bootstrap_drift_seconds: -1 },
  )
}

test empty_config_admins_are_rejected() {
  !valid_config_state(ConfigDatum { ..sample_config(), config_admins: [] })
}

test empty_authorized_dia_public_keys_are_rejected() {
  !valid_config_state(
    ConfigDatum { ..sample_config(), authorized_dia_public_keys: [] },
  )
}

test hook_set_without_coordinator_is_rejected() {
  let sample_hook_ref =
    PaymentHookRef {
      policy_id: #"22222222222222222222222222222222222222222222222222222222",
      asset_name: #"4449415f5041594d454e545f484f4f4b",
    }
  !valid_config_state(
    ConfigDatum {
      ..sample_config(),
      payment_hook_ref: Some(sample_hook_ref),
      update_coordinator_credential: None,
    },
  )
}

test coordinator_set_without_hook_is_rejected() {
  let sample_coord_credential =
    Script(#"33333333333333333333333333333333333333333333333333333333")
  !valid_config_state(
    ConfigDatum {
      ..sample_config(),
      payment_hook_ref: None,
      update_coordinator_credential: Some(sample_coord_credential),
    },
  )
}

test admin_update_transition_accepts_drift_rotation() {
  admin_update_transition(
    sample_config(),
    ConfigDatum { ..sample_config(), max_bootstrap_drift_seconds: 3_600 },
  )
}

test admin_update_transition_accepts_min_utxo_change() {
  admin_update_transition(
    sample_config(),
    ConfigDatum { ..sample_config(), min_utxo_lovelace: 5_000_000 },
  )
}

test valid_config_state_rejects_zero_min_utxo() {
  !valid_config_state(ConfigDatum { ..sample_config(), min_utxo_lovelace: 0 })
}
