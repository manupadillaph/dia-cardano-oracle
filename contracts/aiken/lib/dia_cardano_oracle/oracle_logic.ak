use aiken/builtin
use aiken/collection/list
use aiken/crypto.{blake2b_256, keccak_256, verify_ecdsa_signature}
use aiken/interval.{Finite, IntervalBound}
use aiken/primitive/bytearray
use aiken/primitive/string
use cardano/assets
use cardano/transaction.{Output, Transaction}
use dia_cardano_oracle/config_logic

pub type OracleIntent {
  OracleIntent {
    intent_type: ByteArray,
    version: ByteArray,
    chain_id: Int,
    nonce: Int,
    expiry: Int,
    symbol: ByteArray,
    price: Int,
    timestamp: Int,
    source: ByteArray,
    signature: ByteArray,
    signer: ByteArray,
  }
}

pub type PairDatum {
  PairDatum {
    pair_id: ByteArray,
    price: Int,
    timestamp: Int,
    nonce: Int,
    intent_hash: ByteArray,
    signer: ByteArray,
    min_utxo_lovelace: Int,
  }
}

pub type UpdateWitness {
  UpdateWitness {
    receiver_policy_id: ByteArray,
    receiver_asset_name: ByteArray,
    pair_policy_id: ByteArray,
    pair_token_name: ByteArray,
    intent: OracleIntent,
    signer_public_key: ByteArray,
  }
}

pub fn pair_asset_name(pair_id: ByteArray) -> ByteArray {
  blake2b_256(pair_id)
}

pub fn oracle_intent_hash(
  domain: config_logic.Domain,
  intent: OracleIntent,
) -> ByteArray {
  oracle_intent_hash_with_sep(domain_separator(domain), intent)
}

pub fn oracle_intent_hash_with_sep(
  domain_sep: ByteArray,
  intent: OracleIntent,
) -> ByteArray {
  keccak_256(
    bytearray.concat(
      #"1901",
      bytearray.concat(
        domain_sep,
        oracle_intent_struct_hash(intent),
      ),
    ),
  )
}

pub fn valid_pair_state(datum: PairDatum) -> Bool {
  and {
    !bytearray.is_empty(datum.pair_id),
    datum.price >= 0,
    datum.timestamp >= 0,
    datum.nonce >= 0,
    bytearray.length(datum.intent_hash) == 32,
    bytearray.length(datum.signer) == 20,
    datum.min_utxo_lovelace > 0,
  }
}

pub fn exact_locked_lovelace(output: Output, datum: PairDatum) -> Bool {
  assets.lovelace_of(output.value) == datum.min_utxo_lovelace
}

pub fn signer_is_authorized(
  config_datum: config_logic.ConfigDatum,
  signer_public_key: ByteArray,
) -> Bool {
  list.has(config_datum.authorized_dia_public_keys, signer_public_key)
}

pub fn is_fresh_update(previous: PairDatum, intent: OracleIntent) -> Bool {
  and {
    intent.timestamp > previous.timestamp,
    intent.nonce > previous.nonce,
  }
}

/// Returns True if the intent's `expiry` (unix seconds, signed by DIA)
/// is at or after the transaction's validity-range upper bound (posix
/// milliseconds). The off-chain code MUST set a finite upper bound on
/// every tx that consumes a signed intent — an open-ended upper bound
/// would leave the intent replayable forever and is rejected here.
pub fn intent_expiry_satisfied(
  intent: OracleIntent,
  tx: Transaction,
) -> Bool {
  let IntervalBound { bound_type, .. } = tx.validity_range.upper_bound
  when bound_type is {
    Finite(upper_millis) -> intent.expiry * 1000 >= upper_millis
    _ -> False
  }
}

/// Returns True if the intent's `timestamp` (unix seconds) is no older
/// than `max_drift_seconds` before the transaction's validity-range
/// lower bound (posix milliseconds). Used to enforce freshness on
/// bootstrap, where there is no previous Pair datum to provide a
/// freshness anchor. Rejects open-ended lower bounds for the same
/// reason as `intent_expiry_satisfied`.
pub fn intent_freshness_satisfied(
  intent: OracleIntent,
  tx: Transaction,
  max_drift_seconds: Int,
) -> Bool {
  let IntervalBound { bound_type, .. } = tx.validity_range.lower_bound
  when bound_type is {
    Finite(lower_millis) ->
      intent.timestamp * 1000 >= lower_millis - max_drift_seconds * 1000
    _ -> False
  }
}

pub fn has_valid_signature(
  config_datum: config_logic.ConfigDatum,
  intent_hash: ByteArray,
  witness: UpdateWitness,
) -> Bool {
  and {
    valid_intent(witness.intent),
    signer_is_authorized(config_datum, witness.signer_public_key),
    verify_ecdsa_signature(
      witness.signer_public_key,
      intent_hash,
      normalized_signature(witness.intent.signature),
    ),
  }
}

pub fn next_pair_matches_witness(
  previous: PairDatum,
  next: PairDatum,
  config_datum: config_logic.ConfigDatum,
  domain_sep: ByteArray,
  witness: UpdateWitness,
) -> Bool {
  let intent_hash = oracle_intent_hash_with_sep(domain_sep, witness.intent)

  and {
    valid_pair_state(previous),
    valid_pair_state(next),
    previous.pair_id == next.pair_id,
    previous.min_utxo_lovelace == next.min_utxo_lovelace,
    next.pair_id == witness.intent.symbol,
    next.price == witness.intent.price,
    next.timestamp == witness.intent.timestamp,
    next.nonce == witness.intent.nonce,
    next.intent_hash == intent_hash,
    next.signer == witness.intent.signer,
    witness.pair_token_name == pair_asset_name(next.pair_id),
    is_fresh_update(previous, witness.intent),
    has_valid_signature(config_datum, intent_hash, witness),
  }
}

pub fn initial_pair_matches_witness(
  datum: PairDatum,
  config_datum: config_logic.ConfigDatum,
  domain_sep: ByteArray,
  witness: UpdateWitness,
) -> Bool {
  let intent_hash = oracle_intent_hash_with_sep(domain_sep, witness.intent)

  and {
    valid_pair_state(datum),
    datum.pair_id == witness.intent.symbol,
    datum.price == witness.intent.price,
    datum.timestamp == witness.intent.timestamp,
    datum.nonce == witness.intent.nonce,
    datum.intent_hash == intent_hash,
    datum.signer == witness.intent.signer,
    witness.pair_token_name == pair_asset_name(datum.pair_id),
    has_valid_signature(config_datum, intent_hash, witness),
  }
}

fn valid_intent(intent: OracleIntent) -> Bool {
  and {
    !bytearray.is_empty(intent.intent_type),
    !bytearray.is_empty(intent.version),
    intent.chain_id >= 0,
    intent.nonce >= 0,
    intent.expiry >= 0,
    !bytearray.is_empty(intent.symbol),
    intent.price >= 0,
    intent.timestamp >= 0,
    !bytearray.is_empty(intent.source),
    signature_has_supported_length(intent.signature),
    bytearray.length(intent.signer) == 20,
  }
}

fn signature_has_supported_length(signature: ByteArray) -> Bool {
  let length = bytearray.length(signature)
  length == 64 || length == 65
}

fn normalized_signature(signature: ByteArray) -> ByteArray {
  if bytearray.length(signature) == 65 {
    builtin.slice_bytearray(0, 64, signature)
  } else {
    signature
  }
}

pub fn domain_separator(domain: config_logic.Domain) -> ByteArray {
  keccak_256(
    abi_words(
      [
        keccak_256(
          string.to_bytearray(
            @"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)",
          ),
        ),
        keccak_256(domain.name),
        keccak_256(domain.version),
        uint256_word(domain.source_chain_id),
        address_word(domain.verifying_contract),
        zero_word(),
      ],
    ),
  )
}

fn oracle_intent_struct_hash(intent: OracleIntent) -> ByteArray {
  keccak_256(
    abi_words(
      [
        keccak_256(
          string.to_bytearray(
            @"OracleIntent(string intentType,string version,uint256 chainId,uint256 nonce,uint256 expiry,string symbol,uint256 price,uint256 timestamp,string source)",
          ),
        ),
        keccak_256(intent.intent_type),
        keccak_256(intent.version),
        uint256_word(intent.chain_id),
        uint256_word(intent.nonce),
        uint256_word(intent.expiry),
        keccak_256(intent.symbol),
        uint256_word(intent.price),
        uint256_word(intent.timestamp),
        keccak_256(intent.source),
      ],
    ),
  )
}

fn abi_words(words: List<ByteArray>) -> ByteArray {
  list.foldl(words, #"", fn(word, acc) { bytearray.concat(acc, word) })
}

fn uint256_word(value: Int) -> ByteArray {
  builtin.integer_to_bytearray(True, 32, value)
}

fn address_word(value: ByteArray) -> ByteArray {
  bytearray.concat(builtin.integer_to_bytearray(True, 12, 0), value)
}

fn zero_word() -> ByteArray {
  builtin.integer_to_bytearray(True, 32, 0)
}

fn sample_intent() -> OracleIntent {
  OracleIntent {
    intent_type: #"4f7261636c65557064617465",
    version: #"312e30",
    chain_id: 100640,
    nonce: 1760960522308165264,
    expiry: 1760964122,
    symbol: #"555344432f555344",
    price: 99992561,
    timestamp: 1760960522,
    source: #"444941204f7261636c65",
    signature: #"7e3ab9c6c59f1997f007063e96120ab198bb4129875e49b4f48298c533771d0e6266a261ea108343a4ed02a6823ab3602bcdedd4b891226c2f452b4a158ac1011b",
    signer: #"f64d333c19b007519c7b9316680ed26578f98c08",
  }
}

fn sample_signer_public_key() -> ByteArray {
  #"03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807"
}

fn sample_config() -> config_logic.ConfigDatum {
  config_logic.ConfigDatum {
    config_admins: config_logic.sample_config().config_admins,
    authorized_dia_public_keys: config_logic.sample_config().authorized_dia_public_keys,
    domain_data: config_logic.sample_config().domain_data,
    base_fee_lovelace: config_logic.sample_config().base_fee_lovelace,
    per_pair_fee_lovelace: config_logic.sample_config().per_pair_fee_lovelace,
    payment_hook_ref: None,
    update_coordinator_credential: None,
    max_bootstrap_drift_seconds: config_logic.sample_config().max_bootstrap_drift_seconds,
    min_utxo_lovelace: config_logic.sample_config().min_utxo_lovelace,
  }
}

fn sample_domain_sep() -> ByteArray {
  domain_separator(sample_config().domain_data)
}

fn sample_pair_datum() -> PairDatum {
  let intent = sample_intent()

  PairDatum {
    pair_id: intent.symbol,
    price: intent.price,
    timestamp: intent.timestamp,
    nonce: intent.nonce,
    intent_hash: oracle_intent_hash(sample_config().domain_data, intent),
    signer: intent.signer,
    min_utxo_lovelace: 2_000_000,
  }
}

fn sample_witness() -> UpdateWitness {
  UpdateWitness {
    receiver_policy_id: #"22222222222222222222222222222222222222222222222222222222",
    receiver_asset_name: #"4449415f5245434549564552",
    pair_policy_id: #"11111111111111111111111111111111111111111111111111111111",
    pair_token_name: pair_asset_name(sample_intent().symbol),
    intent: sample_intent(),
    signer_public_key: sample_signer_public_key(),
  }
}

test valid_pair_state_accepts_sample_state() {
  valid_pair_state(sample_pair_datum())
}

test real_dia_signature_is_accepted() {
  has_valid_signature(
    sample_config(),
    oracle_intent_hash(sample_config().domain_data, sample_witness().intent),
    sample_witness(),
  )
}

test negative_price_pair_state_is_rejected() {
  !valid_pair_state(PairDatum { ..sample_pair_datum(), price: -1 })
}

test zero_min_utxo_pair_state_is_rejected() {
  !valid_pair_state(PairDatum { ..sample_pair_datum(), min_utxo_lovelace: 0 })
}

test negative_price_intent_signature_is_rejected() {
  !has_valid_signature(
    sample_config(),
    #"0000000000000000000000000000000000000000000000000000000000000000",
    UpdateWitness {
      ..sample_witness(),
      intent: OracleIntent { ..sample_intent(), price: -1 },
    },
  )
}

test initial_pair_matches_witness_accepts_first_real_update() {
  initial_pair_matches_witness(
    sample_pair_datum(),
    sample_config(),
    sample_domain_sep(),
    sample_witness(),
  )
}

test initial_pair_matches_witness_rejects_zero_placeholder() {
  !initial_pair_matches_witness(
    PairDatum {
      pair_id: sample_pair_datum().pair_id,
      price: 0,
      timestamp: 0,
      nonce: 0,
      intent_hash: oracle_intent_hash(
        sample_config().domain_data,
        sample_intent(),
      ),
      signer: sample_pair_datum().signer,
      min_utxo_lovelace: sample_pair_datum().min_utxo_lovelace,
    },
    sample_config(),
    sample_domain_sep(),
    sample_witness(),
  )
}

test next_pair_matches_witness_requires_fresh_data() {
  let previous =
    PairDatum {
      pair_id: sample_pair_datum().pair_id,
      price: 99980000,
      timestamp: sample_pair_datum().timestamp - 100,
      nonce: sample_pair_datum().nonce - 10,
      intent_hash: sample_pair_datum().intent_hash,
      signer: sample_pair_datum().signer,
      min_utxo_lovelace: sample_pair_datum().min_utxo_lovelace,
    }

  next_pair_matches_witness(
    previous,
    sample_pair_datum(),
    sample_config(),
    sample_domain_sep(),
    sample_witness(),
  )
}

test stale_timestamp_is_rejected() {
  let previous =
    PairDatum {
      ..sample_pair_datum(),
      timestamp: sample_intent().timestamp,
      nonce: sample_intent().nonce - 1,
    }

  !next_pair_matches_witness(
    previous,
    sample_pair_datum(),
    sample_config(),
    sample_domain_sep(),
    sample_witness(),
  )
}

test stale_nonce_is_rejected() {
  let previous =
    PairDatum {
      ..sample_pair_datum(),
      timestamp: sample_intent().timestamp - 1,
      nonce: sample_intent().nonce,
    }

  !next_pair_matches_witness(
    previous,
    sample_pair_datum(),
    sample_config(),
    sample_domain_sep(),
    sample_witness(),
  )
}

test unauthorized_dia_signer_is_rejected() {
  !has_valid_signature(
    config_logic.ConfigDatum {
      ..sample_config(),
      authorized_dia_public_keys: [],
    },
    oracle_intent_hash(sample_config().domain_data, sample_witness().intent),
    sample_witness(),
  )
}

test wrong_pair_symbol_is_rejected() {
  let next = PairDatum { ..sample_pair_datum(), pair_id: #"4554482f555344" }

  !next_pair_matches_witness(
    PairDatum {
      ..sample_pair_datum(),
      price: 99980000,
      timestamp: sample_pair_datum().timestamp - 100,
      nonce: sample_pair_datum().nonce - 10,
    },
    next,
    sample_config(),
    sample_domain_sep(),
    sample_witness(),
  )
}

test wrong_pair_nft_is_rejected() {
  !next_pair_matches_witness(
    PairDatum {
      ..sample_pair_datum(),
      price: 99980000,
      timestamp: sample_pair_datum().timestamp - 100,
      nonce: sample_pair_datum().nonce - 10,
    },
    sample_pair_datum(),
    sample_config(),
    sample_domain_sep(),
    UpdateWitness {
      ..sample_witness(),
      pair_token_name: #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
  )
}

fn sample_tx_with_validity_range(
  lower_millis: Int,
  upper_millis: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    validity_range: interval.between(lower_millis, upper_millis),
  }
}

test intent_expiry_satisfied_when_upper_bound_within_expiry() {
  // intent.expiry = 1760964122 (unix seconds)
  // upper_bound = expiry_millis - 1 ms => still inside the expiry window
  let intent = sample_intent()
  intent_expiry_satisfied(
    intent,
    sample_tx_with_validity_range(0, intent.expiry * 1000 - 1),
  )
}

test intent_expiry_satisfied_when_upper_bound_equals_expiry() {
  let intent = sample_intent()
  intent_expiry_satisfied(
    intent,
    sample_tx_with_validity_range(0, intent.expiry * 1000),
  )
}

test intent_expiry_rejected_when_upper_bound_after_expiry() {
  // upper_bound = expiry + 1 ms => intent has lapsed by the latest moment
  // this tx could be applied on-chain.
  let intent = sample_intent()
  !intent_expiry_satisfied(
    intent,
    sample_tx_with_validity_range(0, intent.expiry * 1000 + 1),
  )
}

test intent_expiry_rejected_when_upper_bound_is_open() {
  // open-ended upper bound (interval.everything) must be rejected:
  // it would allow replaying a signed intent forever.
  let intent = sample_intent()
  !intent_expiry_satisfied(intent, transaction.placeholder)
}

test intent_freshness_satisfied_when_timestamp_within_drift() {
  // intent.timestamp = 1760960522 (unix seconds)
  // lower_bound exactly at timestamp_millis => freshness ok with any
  // non-negative drift.
  let intent = sample_intent()
  intent_freshness_satisfied(
    intent,
    sample_tx_with_validity_range(intent.timestamp * 1000, intent.expiry * 1000),
    0,
  )
}

test intent_freshness_satisfied_when_timestamp_inside_drift_window() {
  // lower_bound is timestamp + 60 s; with drift 120 s, still fresh.
  let intent = sample_intent()
  intent_freshness_satisfied(
    intent,
    sample_tx_with_validity_range(
      intent.timestamp * 1000 + 60_000,
      intent.expiry * 1000,
    ),
    120,
  )
}

test intent_freshness_rejected_when_outside_drift_window() {
  // lower_bound is timestamp + 1 day; with drift 60 s, intent is stale.
  let intent = sample_intent()
  !intent_freshness_satisfied(
    intent,
    sample_tx_with_validity_range(
      intent.timestamp * 1000 + 86_400_000,
      intent.timestamp * 1000 + 86_400_000 + 1_000,
    ),
    60,
  )
}

test intent_freshness_rejected_when_lower_bound_is_open() {
  // open-ended lower bound (interval.everything) must be rejected:
  // we cannot determine on-chain how stale the intent is.
  let intent = sample_intent()
  !intent_freshness_satisfied(intent, transaction.placeholder, 86_400)
}

test tampered_intent_timestamp_is_rejected() {
  // The signed payload binds price+timestamp+nonce. Mutating the
  // timestamp after signing must invalidate the signature.
  !has_valid_signature(
    sample_config(),
    oracle_intent_hash(
      sample_config().domain_data,
      OracleIntent {
        ..sample_intent(),
        timestamp: sample_intent().timestamp + 1,
      },
    ),
    UpdateWitness {
      ..sample_witness(),
      intent: OracleIntent {
        ..sample_intent(),
        timestamp: sample_intent().timestamp + 1,
      },
    },
  )
}

test tampered_intent_nonce_is_rejected() {
  !has_valid_signature(
    sample_config(),
    oracle_intent_hash(
      sample_config().domain_data,
      OracleIntent {
        ..sample_intent(),
        nonce: sample_intent().nonce + 1,
      },
    ),
    UpdateWitness {
      ..sample_witness(),
      intent: OracleIntent {
        ..sample_intent(),
        nonce: sample_intent().nonce + 1,
      },
    },
  )
}
