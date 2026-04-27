use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Credential}
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

pub type ConfigDatum {
  ConfigDatum {
    config_admins: List<VerificationKeyHash>,
    authorized_dia_public_keys: List<ByteArray>,
    domain_data: Domain,
    protocol_fee_lovelace: Int,
    payment_hook_ref: Option<PaymentHookRef>,
    update_coordinator_credential: Option<Credential>,
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
    datum.protocol_fee_lovelace >= 0,
    hook_and_coordinator_are_consistent(
      datum.payment_hook_ref,
      datum.update_coordinator_credential,
    ),
    unique_authorized_dia_public_keys(datum.authorized_dia_public_keys),
    datum.min_utxo_lovelace >= 0,
  }
}

pub fn admin_update_transition(previous: ConfigDatum, next: ConfigDatum) -> Bool {
  and {
    valid_config_state(previous),
    valid_config_state(next),
    previous.min_utxo_lovelace == next.min_utxo_lovelace,
  }
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
    protocol_fee_lovelace: 2_000_000,
    payment_hook_ref: None,
    update_coordinator_credential: None,
    min_utxo_lovelace: 2_000_000,
  }
}

fn sample_updated_fee_config() -> ConfigDatum {
  ConfigDatum {
    config_admins: sample_config().config_admins,
    authorized_dia_public_keys: sample_config().authorized_dia_public_keys,
    domain_data: sample_config().domain_data,
    protocol_fee_lovelace: 3_000_000,
    payment_hook_ref: sample_config().payment_hook_ref,
    update_coordinator_credential: sample_config().update_coordinator_credential,
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
      protocol_fee_lovelace: 2_000_000,
      payment_hook_ref: None,
      update_coordinator_credential: None,
      min_utxo_lovelace: 2_000_000,
    },
  )
}
