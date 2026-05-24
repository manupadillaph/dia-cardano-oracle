use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/fuzz
use aiken/interval
use cardano/address.{Credential, Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Redeemer, Transaction,
  Withdraw, placeholder,
}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/coordinator_logic.{
  ApplyBatch, ApplySingle, CoordinatorRedeemer, coordinator_in_update_mode,
  pair_mint_intent_satisfied,
}
use dia_cardano_oracle/oracle_logic

/// Pair NFT minting policy actions.
///
/// - `MintPairs`: create one or more new Pair NFTs. Admin-gated (a
///   `config_admins` VKH must sign the tx). Each minted name MUST be
///   backed by a coordinator witness whose `intent.expiry` is at or
///   after the tx's finite upper validity bound; the matching intent's
///   `nonce` is persisted into the new `PairDatum.nonce` by the
///   coordinator's `initial_pair_matches_witness`, which freezes the
///   anti-replay anchor for every subsequent update.
/// - `BurnPairs`: burn one or more Pair NFTs. Admin-gated. Each entry
///   in the mint must have quantity `-1`. The corresponding pair UTxO
///   is spent in the same tx under the `BurnPair` spend redeemer; the
///   admin recovers the locked min-ADA from each burned pair.
pub type PairMintAction {
  MintPairs
  BurnPairs
}

pub type PairSpendAction {
  /// Spent during an oracle update (single or batch). The script body
  /// is intentionally minimal: NFT continuity, exact ADA locking, and
  /// cross-script redeemer-confusion defence via
  /// `coordinator_in_update_mode`. Datum semantics, signature recovery,
  /// freshness, intent expiry, receiver presence, and one-input-per-
  /// witness accounting are all enforced once by `update_coordinator`
  /// — duplicating them here would multiply that cost by N pair scripts
  /// inside a batch.
  ApplyUpdate
  /// Admin-only update of min_utxo_lovelace. Requires config signer authorization.
  UpdateMinUtxo { new_min_utxo_lovelace: Int }
  /// Admin-only burn of the Pair NFT. Requires a `config_admins` VKH
  /// signature AND a matching burn entry in `tx.mint` (quantity `-1`
  /// for this exact `(pair_policy_id, pair_token_name)`). The pair
  /// UTxO has no continuation output: the locked min-ADA is released
  /// to the admin. There is no coordinator interaction on this path,
  /// because no oracle update is being applied.
  BurnPair
}

validator pair_state(
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
  // `receiver_hash` ties this `pair_state` instance to one client's
  // receiver script. The body no longer references it directly —
  // `update_coordinator` enforces receiver identity for every batch
  // witness, and the Pair NFT mint policy is itself parameterised by
  // `receiver_hash`, so the binding survives at the script-hash level.
  // The leading `_` silences Aiken's unused-binding warning; the
  // parameter slot is still applied to the compiled validator, so
  // each client still gets its own `pair_state` script address.
  _receiver_hash: ScriptHash,
) {
  mint(action: PairMintAction, policy_id: PolicyId, self: Transaction) {
    let minted_pairs =
      self.mint
        |> assets.tokens(policy_id)
        |> dict.to_pairs()

    expect Some(config_input) =
      list.find(
        self.reference_inputs,
        fn(input) {
          assets.quantity_of(
            input.output.value,
            config_policy_id,
            config_asset_name,
          ) == 1
        },
      )

    expect InlineDatum(config_datum_data) = config_input.output.datum
    expect config_datum: config_logic.ConfigDatum = config_datum_data

    when action is {
      MintPairs -> and {
          list.length(minted_pairs) > 0,
          // Admin gate. A signed DIA intent alone is NOT sufficient to
          // create a Pair NFT: the same intent could otherwise be
          // replayed across two transactions to mint two NFTs with the
          // same `pair_token_name`, since there is no on-chain prior
          // state to anchor a nonce check at creation time. Requiring
          // a `config_admins` signature gates pair creation behind the
          // DIA admin wallet; the coordinator's
          // `initial_pair_matches_witness` then freezes the intent
          // `nonce` into `PairDatum.nonce`, which prevents replay
          // against any future update of this Pair UTxO via
          // `is_fresh_update`.
          config_logic.has_config_signer(config_datum, self),
          list.all(
            minted_pairs,
            fn(minted_pair) {
              let Pair(asset_name, quantity) = minted_pair
              and {
                quantity == 1,
                has_pair_output(self.outputs, policy_id, asset_name),
                // Binds the coordinator redeemer to this exact Pair NFT AND
                // re-asserts intent expiry locally (defence-in-depth: every
                // path that consumes a signed intent enforces expiry, not
                // only the coordinator's own redeemer body).
                pair_mint_intent_satisfied(
                  self,
                  config_datum,
                  policy_id,
                  asset_name,
                ),
              }
            },
          ),
          config_logic.valid_config_state(config_datum),
        }

      BurnPairs -> and {
          list.length(minted_pairs) > 0,
          // Admin gate. Burning a Pair NFT releases the locked min-ADA
          // from the pair UTxO; only the DIA admin may authorise this.
          config_logic.has_config_signer(config_datum, self),
          list.all(
            minted_pairs,
            fn(minted_pair) {
              let Pair(_asset_name, quantity) = minted_pair
              // Every entry under `BurnPairs` MUST be a burn. A mix of
              // positive and negative quantities is impossible under
              // this redeemer: a `+1` entry would fail here, and the
              // separate `MintPairs` redeemer requires `quantity == 1`
              // for every entry, so it cannot carry a `-1` either.
              quantity == -1
            },
          ),
          config_logic.valid_config_state(config_datum),
        }
    }
  }

  spend(
    maybe_datum: Option<oracle_logic.PairDatum>,
    redeemer: PairSpendAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(current_datum) = maybe_datum
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    expect Script(own_policy_id) = own_input.output.address.payment_credential

    expect [Pair(pair_token_name, 1)] =
      own_input.output.value
        |> assets.tokens(own_policy_id)
        |> dict.to_pairs()

    when redeemer is {
      ApplyUpdate -> {
        // Find the continuation pair output by NFT name. We only need
        // the output's address + lovelace; the datum is decoded once,
        // by `update_coordinator`, so we do not deserialize it here.
        expect Some(pair_output) =
          list.find(
            self.outputs,
            fn(output) {
              assets.quantity_of(output.value, own_policy_id, pair_token_name) == 1
            },
          )

        // Read the Config UTxO (reference input) ONLY to learn the
        // coordinator credential. We do not call
        // `valid_config_state` here — the coordinator's own
        // execution does, and that runs in the same tx.
        expect Some(config_input) =
          list.find(
            self.reference_inputs,
            fn(input) {
              assets.quantity_of(
                input.output.value,
                config_policy_id,
                config_asset_name,
              ) == 1
            },
          )
        expect InlineDatum(config_datum_data) = config_input.output.datum
        expect config_datum: config_logic.ConfigDatum = config_datum_data

        and {
          // NFT continuity: the same Pair NFT lives at the same per-
          // client script address in the continuation output.
          pair_output.address.payment_credential == Script(own_policy_id),
          // Exact ADA locking. The coordinator's
          // `next_pair_matches_witness` enforces
          // `previous.min_utxo_lovelace == next.min_utxo_lovelace` for
          // updates, so checking against `current_datum.min_utxo_lovelace`
          // covers both input and output without decoding `next_datum`
          // again here.
          assets.lovelace_of(own_input.output.value) == current_datum.min_utxo_lovelace,
          assets.lovelace_of(pair_output.value) == current_datum.min_utxo_lovelace,
          // Cross-script redeemer-confusion defence: the coordinator
          // MUST be running in `ApplySingle` or `ApplyBatch` mode
          // (not `ApplySettle`). `coordinator_in_update_mode` uses a
          // `CoordinatorRedeemerFingerprint` that decodes only the
          // outer constructor tag, so this stays cheap even when the
          // coordinator's witness list is large. Every other safety
          // property of an update — datum semantics, signature
          // recovery, intent freshness/expiry, receiver presence,
          // canonical witness ordering, one-pair-input-per-witness
          // accounting — is enforced once by `update_coordinator`
          // inside the same tx; duplicating any of it here would
          // multiply the cost by N pair scripts in a batch.
          coordinator_in_update_mode(self, config_datum),
        }
      }

      UpdateMinUtxo { new_min_utxo_lovelace } -> {
        // Admin-gated: full decoding of next_datum + config is
        // worthwhile here because this branch is rare and singular,
        // not part of any high-throughput batch.
        expect Some(pair_output) =
          list.find(
            self.outputs,
            fn(output) {
              assets.quantity_of(output.value, own_policy_id, pair_token_name) == 1
            },
          )
        expect InlineDatum(output_datum) = pair_output.datum
        expect next_datum: oracle_logic.PairDatum = output_datum
        expect Some(config_input) =
          list.find(
            self.reference_inputs,
            fn(input) {
              assets.quantity_of(
                input.output.value,
                config_policy_id,
                config_asset_name,
              ) == 1
            },
          )
        expect InlineDatum(config_datum_data) = config_input.output.datum
        expect config_datum: config_logic.ConfigDatum = config_datum_data

        and {
          config_logic.has_config_signer(config_datum, self),
          new_min_utxo_lovelace > 0,
          next_datum.min_utxo_lovelace == new_min_utxo_lovelace,
          next_datum.pair_id == current_datum.pair_id,
          next_datum.price == current_datum.price,
          next_datum.timestamp == current_datum.timestamp,
          next_datum.nonce == current_datum.nonce,
          next_datum.intent_hash == current_datum.intent_hash,
          next_datum.signer == current_datum.signer,
          oracle_logic.valid_pair_state(current_datum),
          oracle_logic.valid_pair_state(next_datum),
          assets.quantity_of(pair_output.value, own_policy_id, pair_token_name) == 1,
          pair_output.address.payment_credential == Script(own_policy_id),
          pair_token_name == oracle_logic.pair_asset_name(current_datum.pair_id),
          config_logic.valid_config_state(config_datum),
          oracle_logic.exact_locked_lovelace(own_input.output, current_datum),
          oracle_logic.exact_locked_lovelace(pair_output, next_datum),
        }
      }

      BurnPair -> {
        // Admin-gated burn: the pair UTxO is consumed without
        // continuation, and the matching Pair NFT MUST be burned in
        // the same tx (so the NFT supply stays exactly 0/1 at any
        // point — no orphan token, no replayed UTxO). The mint
        // policy's own `BurnPairs` redeemer also enforces admin
        // signature; both sides duplicate the signer check on
        // purpose, so neither side can be invoked alone.
        expect Some(config_input) =
          list.find(
            self.reference_inputs,
            fn(input) {
              assets.quantity_of(
                input.output.value,
                config_policy_id,
                config_asset_name,
              ) == 1
            },
          )
        expect InlineDatum(config_datum_data) = config_input.output.datum
        expect config_datum: config_logic.ConfigDatum = config_datum_data

        and {
          config_logic.has_config_signer(config_datum, self),
          config_logic.valid_config_state(config_datum),
          // The Pair NFT carried by this very UTxO MUST be burned in
          // the same tx. Anything else (e.g. moving the NFT to a
          // wallet) would silently bypass the mint-policy's burn
          // gate, since spends and mints run independently.
          assets.quantity_of(self.mint, own_policy_id, pair_token_name) == -1,
        }
      }
    }
  }

  else(_) {
    False
  }
}

fn has_pair_output(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
  pair_asset_name: ByteArray,
) -> Bool {
  when
    list.find(
      outputs,
      fn(output) {
        assets.quantity_of(output.value, pair_policy_id, pair_asset_name) == 1
      },
    )
  is {
    Some(matching_output) ->
      when matching_output.datum is {
        InlineDatum(output_datum) -> {
          expect pair_datum: oracle_logic.PairDatum = output_datum
          and {
            matching_output.address.payment_credential == Script(pair_policy_id),
            oracle_logic.pair_asset_name(pair_datum.pair_id) == pair_asset_name,
            oracle_logic.valid_pair_state(pair_datum),
            oracle_logic.exact_locked_lovelace(matching_output, pair_datum),
          }
        }

        _ -> False
      }

    None -> False
  }
}

// ---------------------------------------------------------------------------
// Regression tests
//
// These tests exercise the admin-signer gate at the mint and burn paths of
// `pair_state`, plus the matching `BurnPair` spend path. The `ApplyUpdate`
// branch must NOT require an admin signature — those updates run as part of
// the high-throughput oracle path and are authorised by DIA's signed intent,
// not by the protocol admin.

const test_admin_vkh: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

const test_other_vkh: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const test_config_policy: PolicyId =
  #"cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00"

const test_config_asset: AssetName =
  #"4449415f434f4e464947"

const test_pair_policy: PolicyId =
  #"11111111111111111111111111111111111111111111111111111111"

const test_receiver_hash: ScriptHash =
  #"99999999999999999999999999999999999999999999999999999999"

const test_coord_credential: Credential =
  Script(#"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc")

const test_receiver_policy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const test_receiver_asset: AssetName =
  #"4449415f5245434549564552"

fn test_config_datum() -> config_logic.ConfigDatum {
  config_logic.ConfigDatum {
    ..config_logic.sample_config(),
    config_admins: [test_admin_vkh],
    payment_hook_ref: Some(
      config_logic.PaymentHookRef {
        policy_id: #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        asset_name: #"484f4f4b",
      },
    ),
    update_coordinator_credential: Some(test_coord_credential),
  }
}

fn test_intent() -> oracle_logic.OracleIntent {
  oracle_logic.OracleIntent {
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

fn test_pair_datum() -> oracle_logic.PairDatum {
  let intent = test_intent()
  oracle_logic.PairDatum {
    pair_id: intent.symbol,
    price: intent.price,
    timestamp: intent.timestamp,
    nonce: intent.nonce,
    intent_hash: oracle_logic.oracle_intent_hash(
      test_config_datum().domain_data,
      intent,
    ),
    signer: intent.signer,
    min_utxo_lovelace: 2_000_000,
  }
}

fn test_pair_token_name() -> ByteArray {
  oracle_logic.pair_asset_name(test_intent().symbol)
}

fn test_witness() -> oracle_logic.UpdateWitness {
  oracle_logic.UpdateWitness {
    receiver_policy_id: test_receiver_policy,
    receiver_asset_name: test_receiver_asset,
    pair_policy_id: test_pair_policy,
    pair_token_name: test_pair_token_name(),
    intent: test_intent(),
    signer_public_key: #"03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807",
  }
}

fn test_config_ref_input() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"abababababababababababababababababababababababababababababababab",
      output_index: 0,
    },
    output: Output {
      address: address.from_script(
        #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      ),
      value: assets.from_asset(test_config_policy, test_config_asset, 1),
      datum: InlineDatum(test_config_datum()),
      reference_script: None,
    },
  }
}

fn test_pair_output() -> Output {
  Output {
    address: address.from_script(test_pair_policy),
    value: assets.add(
      assets.from_lovelace(test_pair_datum().min_utxo_lovelace),
      test_pair_policy,
      test_pair_token_name(),
      1,
    ),
    datum: InlineDatum(test_pair_datum()),
    reference_script: None,
  }
}

fn test_pair_input(token_name: ByteArray) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
      output_index: 0,
    },
    output: Output {
      address: address.from_script(test_pair_policy),
      value: assets.add(
        assets.from_lovelace(test_pair_datum().min_utxo_lovelace),
        test_pair_policy,
        token_name,
        1,
      ),
      datum: InlineDatum(test_pair_datum()),
      reference_script: None,
    },
  }
}

fn test_mint_tx(
  extra_signatories: List<ByteArray>,
  mint_amount: Int,
  coord_redeemer: CoordinatorRedeemer,
) -> Transaction {
  let payload: Redeemer = coord_redeemer
  let intent_expiry_ms = test_intent().expiry * 1000
  Transaction {
    ..placeholder,
    reference_inputs: [test_config_ref_input()],
    outputs: [test_pair_output()],
    mint: assets.from_asset(test_pair_policy, test_pair_token_name(), mint_amount),
    redeemers: [Pair(Withdraw(test_coord_credential), payload)],
    extra_signatories,
    validity_range: interval.between(0, intent_expiry_ms - 1),
  }
}

// 1. Pair create without admin signer fails.
test mint_pairs_rejects_without_admin_signer() {
  let tx = test_mint_tx([], 1, ApplySingle(test_witness()))
  !pair_state.mint(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    MintPairs,
    test_pair_policy,
    tx,
  )
}

// 2. Pair create with admin signer passes.
test mint_pairs_accepts_with_admin_signer() {
  let tx = test_mint_tx([test_admin_vkh], 1, ApplySingle(test_witness()))
  pair_state.mint(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    MintPairs,
    test_pair_policy,
    tx,
  )
}

// A non-admin signer (random VKH that is NOT in config_admins) is still
// rejected even though a signature is present — the gate is identity-bound,
// not "any signature".
test mint_pairs_rejects_non_admin_signer() {
  let tx = test_mint_tx([test_other_vkh], 1, ApplySingle(test_witness()))
  !pair_state.mint(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    MintPairs,
    test_pair_policy,
    tx,
  )
}

// 4. Duplicate create without admin signer fails. A duplicate intent reused
// in a separate tx still fails at the admin gate, even though everything
// else (coordinator binding, intent expiry) is satisfied — this is the
// concrete attack the gate was added to prevent.
test duplicate_create_without_admin_signer_fails() {
  let tx_first = test_mint_tx([], 1, ApplySingle(test_witness()))
  let tx_replay = test_mint_tx([], 1, ApplySingle(test_witness()))
  and {
    !pair_state.mint(
      test_config_policy,
      test_config_asset,
      test_receiver_hash,
      MintPairs,
      test_pair_policy,
      tx_first,
    ),
    !pair_state.mint(
      test_config_policy,
      test_config_asset,
      test_receiver_hash,
      MintPairs,
      test_pair_policy,
      tx_replay,
    ),
  }
}

// 5. Batch with a create witness without admin signer fails. The batch path
// goes through `ApplyBatch`; the create still triggers the mint validator,
// which gates on the admin signer.
test batch_with_create_without_admin_signer_fails() {
  let tx = test_mint_tx([], 1, ApplyBatch([test_witness()]))
  !pair_state.mint(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    MintPairs,
    test_pair_policy,
    tx,
  )
}

// 6. Batch with only updates (no mint entry) does NOT require admin signer.
// `pair_state.mint` is not called for a pure-update batch; we model that by
// invoking `spend` with `ApplyUpdate` against a tx whose coordinator
// redeemer is `ApplyBatch` and whose mint is empty. No admin signer.
test apply_update_does_not_require_admin_signer() {
  let payload: Redeemer = ApplyBatch([test_witness()])
  let own_ref =
    OutputReference {
      transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
      output_index: 0,
    }
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_pair_input(test_pair_token_name())],
      reference_inputs: [test_config_ref_input()],
      outputs: [test_pair_output()],
      redeemers: [Pair(Withdraw(test_coord_credential), payload)],
      // No `extra_signatories`: ApplyUpdate path must accept this.
      validity_range: interval.between(0, test_intent().expiry * 1000 - 1),
    }
  pair_state.spend(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    Some(test_pair_datum()),
    ApplyUpdate,
    own_ref,
    tx,
  )
}

// Burn-path tests.

test burn_pairs_rejects_without_admin_signer() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [test_config_ref_input()],
      mint: assets.from_asset(test_pair_policy, test_pair_token_name(), -1),
      extra_signatories: [],
    }
  !pair_state.mint(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    BurnPairs,
    test_pair_policy,
    tx,
  )
}

test burn_pairs_accepts_with_admin_signer() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [test_config_ref_input()],
      mint: assets.from_asset(test_pair_policy, test_pair_token_name(), -1),
      extra_signatories: [test_admin_vkh],
    }
  pair_state.mint(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    BurnPairs,
    test_pair_policy,
    tx,
  )
}

// A mint entry under the BurnPairs redeemer must have quantity -1; a mix
// (or a positive-only entry) is rejected even with an admin signature.
test burn_pairs_rejects_positive_quantity() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [test_config_ref_input()],
      mint: assets.from_asset(test_pair_policy, test_pair_token_name(), 1),
      extra_signatories: [test_admin_vkh],
    }
  !pair_state.mint(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    BurnPairs,
    test_pair_policy,
    tx,
  )
}

// Spend BurnPair: admin signer is required and the matching Pair NFT MUST be
// burned in the same tx (quantity -1 under the pair mint policy for this
// token name).
test burn_pair_spend_rejects_without_admin_signer() {
  let token_name = test_pair_token_name()
  let own_ref =
    OutputReference {
      transaction_id: #"0202020202020202020202020202020202020202020202020202020202020202",
      output_index: 0,
    }
  let pair_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: address.from_script(test_pair_policy),
        value: assets.add(
          assets.from_lovelace(test_pair_datum().min_utxo_lovelace),
          test_pair_policy,
          token_name,
          1,
        ),
        datum: InlineDatum(test_pair_datum()),
        reference_script: None,
      },
    }
  let tx =
    Transaction {
      ..placeholder,
      inputs: [pair_input],
      reference_inputs: [test_config_ref_input()],
      mint: assets.from_asset(test_pair_policy, token_name, -1),
      extra_signatories: [],
    }
  !pair_state.spend(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    Some(test_pair_datum()),
    BurnPair,
    own_ref,
    tx,
  )
}

test burn_pair_spend_accepts_with_admin_and_burn() {
  let token_name = test_pair_token_name()
  let own_ref =
    OutputReference {
      transaction_id: #"0303030303030303030303030303030303030303030303030303030303030303",
      output_index: 0,
    }
  let pair_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: address.from_script(test_pair_policy),
        value: assets.add(
          assets.from_lovelace(test_pair_datum().min_utxo_lovelace),
          test_pair_policy,
          token_name,
          1,
        ),
        datum: InlineDatum(test_pair_datum()),
        reference_script: None,
      },
    }
  let tx =
    Transaction {
      ..placeholder,
      inputs: [pair_input],
      reference_inputs: [test_config_ref_input()],
      mint: assets.from_asset(test_pair_policy, token_name, -1),
      extra_signatories: [test_admin_vkh],
      outputs: [
        Output {
          address: address.from_verification_key(test_admin_vkh),
          value: assets.from_lovelace(test_pair_datum().min_utxo_lovelace),
          datum: NoDatum,
          reference_script: None,
        },
      ],
    }
  pair_state.spend(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    Some(test_pair_datum()),
    BurnPair,
    own_ref,
    tx,
  )
}

// Spend BurnPair: if the matching Pair NFT is NOT burned in this same tx
// (no `-1` entry in `tx.mint` for the own token), the spend MUST fail
// even with an admin signature. This is what prevents a malicious admin
// from "draining" the locked min-ADA while keeping the NFT alive.
test burn_pair_spend_rejects_without_matching_burn() {
  let token_name = test_pair_token_name()
  let own_ref =
    OutputReference {
      transaction_id: #"0404040404040404040404040404040404040404040404040404040404040404",
      output_index: 0,
    }
  let pair_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: address.from_script(test_pair_policy),
        value: assets.add(
          assets.from_lovelace(test_pair_datum().min_utxo_lovelace),
          test_pair_policy,
          token_name,
          1,
        ),
        datum: InlineDatum(test_pair_datum()),
        reference_script: None,
      },
    }
  let tx =
    Transaction {
      ..placeholder,
      inputs: [pair_input],
      reference_inputs: [test_config_ref_input()],
      // No mint entry: the NFT escapes the burn gate.
      mint: assets.zero,
      extra_signatories: [test_admin_vkh],
    }
  !pair_state.spend(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    Some(test_pair_datum()),
    BurnPair,
    own_ref,
    tx,
  )
}

type PairApplyUpdateBenchCase {
  PairApplyUpdateBenchCase {
    own_ref: OutputReference,
    tx: Transaction,
  }
}

fn repeat_update_witnesses(count: Int) -> List<oracle_logic.UpdateWitness> {
  if count <= 0 {
    []
  } else {
    [test_witness(), ..repeat_update_witnesses(count - 1)]
  }
}

fn pair_apply_update_bench_case(count: Int) -> PairApplyUpdateBenchCase {
  let own_ref =
    OutputReference {
      transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
      output_index: 0,
    }
  let payload: Redeemer = ApplyBatch(repeat_update_witnesses(count))

  PairApplyUpdateBenchCase {
    own_ref,
    tx: Transaction {
      ..placeholder,
      inputs: [test_pair_input(test_pair_token_name())],
      reference_inputs: [test_config_ref_input()],
      outputs: [test_pair_output()],
      redeemers: [Pair(Withdraw(test_coord_credential), payload)],
      validity_range: interval.between(0, test_intent().expiry * 1000 - 1),
    },
  }
}

fn sample_pair_apply_update_case(size: Int) -> Fuzzer<PairApplyUpdateBenchCase> {
  fuzz.constant(pair_apply_update_bench_case(size + 1))
}

bench pair_state_spend_apply_update_fingerprint_stays_hot(
  bench_case via sample_pair_apply_update_case,
) {
  pair_state.spend(
    test_config_policy,
    test_config_asset,
    test_receiver_hash,
    Some(test_pair_datum()),
    ApplyUpdate,
    bench_case.own_ref,
    bench_case.tx,
  )
}
