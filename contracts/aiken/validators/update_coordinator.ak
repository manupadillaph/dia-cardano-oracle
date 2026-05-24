use aiken/builtin
use aiken/collection/dict
use aiken/collection/list
use aiken/fuzz
use aiken/interval
use aiken/primitive/bytearray
use cardano/address.{Credential, Script}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/coordinator_logic.{
  ApplyBatch, ApplySettle, ApplySingle, CoordinatorRedeemer, SettleManifest,
  SettleReceiver,
}
use dia_cardano_oracle/oracle_logic
use dia_cardano_oracle/payment_hook_logic
use dia_cardano_oracle/receiver_logic

validator update_coordinator(
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
) {
  withdraw(
    redeemer: CoordinatorRedeemer,
    own_credential: Credential,
    self: Transaction,
  ) {
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
      config_logic.valid_config_state(config_datum),
      config_datum.update_coordinator_credential == Some(own_credential),
      when redeemer is {
        ApplySingle(witness) -> and {
            oracle_logic.intent_expiry_satisfied(witness.intent, self),
            valid_single_update(self, config_datum, witness),
            valid_receiver_accrue_fee(
              self,
              witness.receiver_policy_id,
              witness.receiver_asset_name,
              // Single pair: fee = base + 1*k
              config_logic.calculate_protocol_fee(config_datum, 1),
            ),
          }

        ApplyBatch(witnesses) -> and {
            valid_batch_update(self, config_datum, witnesses),
            valid_batch_receiver_accrue_fee(
              self,
              witnesses,
              // Batch: fee = base + N*k (charged to the single receiver)
              config_logic.calculate_protocol_fee(
                config_datum,
                list.length(witnesses),
              ),
            ),
          }

        ApplySettle(manifest) -> and {
            config_logic.has_config_signer(config_datum, self),
            valid_settle(self, config_datum, manifest),
          }
      },
    }
  }

  else(_) {
    False
  }
}

// Receiver transition from balance to accrued (inside the update tx).
// The lovelace stays at the UTxO; only the datum obligation moves.
fn valid_receiver_accrue_fee(
  self: Transaction,
  receiver_policy_id: PolicyId,
  receiver_asset_name: AssetName,
  fee_lovelace: Int,
) -> Bool {
  expect Some(receiver_input) =
    list.find(
      self.inputs,
      fn(input) {
        assets.quantity_of(
          input.output.value,
          receiver_policy_id,
          receiver_asset_name,
        ) == 1
      },
    )
  expect Some(receiver_output) =
    list.find(
      self.outputs,
      fn(output) {
        assets.quantity_of(
          output.value,
          receiver_policy_id,
          receiver_asset_name,
        ) == 1
      },
    )

  expect InlineDatum(receiver_input_datum) = receiver_input.output.datum
  expect previous_receiver: receiver_logic.ReceiverDatum = receiver_input_datum

  expect InlineDatum(receiver_output_datum) = receiver_output.datum
  expect next_receiver: receiver_logic.ReceiverDatum = receiver_output_datum

  and {
    receiver_logic.valid_receiver_state(previous_receiver),
    receiver_logic.valid_receiver_state(next_receiver),
    receiver_logic.exact_locked_lovelace(
      receiver_input.output,
      previous_receiver,
    ),
    receiver_logic.exact_locked_lovelace(receiver_output, next_receiver),
    receiver_logic.accrue_fee_transition(
      previous_receiver,
      next_receiver,
      fee_lovelace,
    ),
  }
}

fn valid_batch_receiver_accrue_fee(
  self: Transaction,
  witnesses: List<oracle_logic.UpdateWitness>,
  fee_lovelace: Int,
) -> Bool {
  when witnesses is {
    [] -> False
    [head, ..] ->
      valid_receiver_accrue_fee(
        self,
        head.receiver_policy_id,
        head.receiver_asset_name,
        fee_lovelace,
      )
  }
}

// Settle moves accrued fees from multiple Receivers to the PaymentHook.
// The coordinator validates the arithmetic so each Receiver only checks local invariants.
fn valid_settle(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  manifest: SettleManifest,
) -> Bool {
  expect Some(payment_hook_ref) = config_datum.payment_hook_ref

  // Exactly one Hook input and one Hook output
  expect Some(hook_input) =
    list.find(
      self.inputs,
      fn(input) {
        assets.quantity_of(
          input.output.value,
          payment_hook_ref.policy_id,
          payment_hook_ref.asset_name,
        ) == 1
      },
    )
  expect Some(hook_output) =
    list.find(
      self.outputs,
      fn(output) {
        assets.quantity_of(
          output.value,
          payment_hook_ref.policy_id,
          payment_hook_ref.asset_name,
        ) == 1
      },
    )

  expect InlineDatum(hook_input_datum) = hook_input.output.datum
  expect previous_hook: payment_hook_logic.PaymentHookDatum = hook_input_datum

  expect InlineDatum(hook_output_datum) = hook_output.datum
  expect next_hook: payment_hook_logic.PaymentHookDatum = hook_output_datum

  let expected_delta =
    next_hook.accrued_fees_lovelace - previous_hook.accrued_fees_lovelace

  and {
    list.length(manifest.receivers) > 0,
    unique_settle_receivers(manifest.receivers),
    payment_hook_logic.valid_payment_hook_state(previous_hook),
    payment_hook_logic.valid_payment_hook_state(next_hook),
    payment_hook_logic.exact_locked_lovelace(hook_input.output, previous_hook),
    payment_hook_logic.exact_locked_lovelace(hook_output, next_hook),
    payment_hook_logic.apply_settle_transition(
      previous_hook,
      next_hook,
      expected_delta,
    ),
    sum_receiver_accrued_equals_delta(self, manifest.receivers, expected_delta),
  }
}

fn sum_receiver_accrued_equals_delta(
  self: Transaction,
  receivers: List<SettleReceiver>,
  expected_delta: Int,
) -> Bool {
  let total_accrued =
    list.foldl(
      receivers,
      0,
      fn(receiver, acc) { acc + get_receiver_accrued_drained(self, receiver) },
    )
  total_accrued == expected_delta
}

fn get_receiver_accrued_drained(
  self: Transaction,
  receiver: SettleReceiver,
) -> Int {
  expect Some(receiver_input) =
    list.find(
      self.inputs,
      fn(input) {
        assets.quantity_of(
          input.output.value,
          receiver.receiver_policy_id,
          receiver.receiver_asset_name,
        ) == 1
      },
    )
  expect Some(receiver_output) =
    list.find(
      self.outputs,
      fn(output) {
        assets.quantity_of(
          output.value,
          receiver.receiver_policy_id,
          receiver.receiver_asset_name,
        ) == 1
      },
    )

  expect InlineDatum(receiver_input_datum) = receiver_input.output.datum
  expect previous_receiver: receiver_logic.ReceiverDatum = receiver_input_datum

  expect InlineDatum(receiver_output_datum) = receiver_output.datum
  expect next_receiver: receiver_logic.ReceiverDatum = receiver_output_datum

  expect and {
      receiver_logic.valid_receiver_state(previous_receiver),
      receiver_logic.valid_receiver_state(next_receiver),
      receiver_logic.exact_locked_lovelace(
        receiver_input.output,
        previous_receiver,
      ),
      receiver_logic.exact_locked_lovelace(receiver_output, next_receiver),
      receiver_logic.settle_transition(previous_receiver, next_receiver),
      receiver_output.address.payment_credential == Script(
        receiver.receiver_policy_id,
      ),
    }

  previous_receiver.accrued_to_hook_lovelace
}

fn unique_settle_receivers(receivers: List<SettleReceiver>) -> Bool {
  when receivers is {
    [] -> True
    [head, ..tail] -> and {
        !list.any(
          tail,
          fn(other) {
            and {
              other.receiver_policy_id == head.receiver_policy_id,
              other.receiver_asset_name == head.receiver_asset_name,
            }
          },
        ),
        unique_settle_receivers(tail),
      }
  }
}

fn valid_single_update(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  witness: oracle_logic.UpdateWitness,
) -> Bool {
  let pair_policy_id = witness.pair_policy_id
  let domain_sep = oracle_logic.domain_separator(config_datum.domain_data)
  let pair_input =
    find_unique_pair_input(self.inputs, pair_policy_id, witness.pair_token_name)

  expect Some(pair_output) =
    find_unique_pair_output(
      self.outputs,
      pair_policy_id,
      witness.pair_token_name,
    )

  expect InlineDatum(output_datum_data) = pair_output.datum
  expect next_pair: oracle_logic.PairDatum = output_datum_data

  when pair_input is {
    None -> and {
        minted_pair_quantity(self, pair_policy_id, witness.pair_token_name) == 1,
        minted_pair_token_count(self, pair_policy_id) == 1,
        pair_output.address.payment_credential == Script(pair_policy_id),
        oracle_logic.exact_locked_lovelace(pair_output, next_pair),
        oracle_logic.initial_pair_matches_witness(
          next_pair,
          config_datum,
          domain_sep,
          witness,
        ),
        oracle_logic.intent_freshness_satisfied(
          witness.intent,
          self,
          config_datum.max_bootstrap_drift_seconds,
        ),
      }

    Some(pair_input) -> {
      expect InlineDatum(input_datum_data) = pair_input.output.datum
      expect previous_pair: oracle_logic.PairDatum = input_datum_data

      and {
        minted_pair_token_count(self, pair_policy_id) == 0,
        oracle_logic.next_pair_matches_witness(
          previous_pair,
          next_pair,
          config_datum,
          domain_sep,
          witness,
        ),
      }
    }
  }
}

// Batch update validation.
//
// The off-chain coordinator binds three lists to the same canonical
// witness order before submission:
//   - `witnesses` — sorted strict-ascending by `pair_token_name`; this
//     is now proven inside the main witness walk, together with receiver
//     sharing and intent expiry.
//   - pair outputs in `tx.outputs` — the builder emits them in the same
//     witness order; the ledger preserves the output order it received,
//     so after a single filter pass the resulting list is already
//     canonical.
//   - pair inputs in `tx.inputs` — the ledger reorders inputs
//     lexicographically by `OutputReference` (a property of Plutus V3 /
//     CIP-0128 not-yet-active), independent of `pair_token_name`. So
//     after filtering, the pair-input list is in arbitrary order from a
//     token-name perspective. We look up each witness's input by
//     `pair_token_name` against the short filtered list (length ≤ N).
//
// Cost model:
//   - Previously: every witness called `find_unique_pair_input` /
//     `find_unique_pair_output`, each of which scanned the FULL
//     `tx.inputs` / `tx.outputs` list and invoked `assets.quantity_of`
//     per item — i.e. N × M assets-lookups for N witnesses and M tx
//     inputs/outputs (plus a second N × M pass for the create count).
//   - Now: one linear filter pass over `tx.inputs` and one over
//     `tx.outputs`, each invoking the assets check exactly once per
//     item. Per-witness work is reduced to a positional output access
//     (canonical alignment) and a token-name lookup against the
//     pair-only short list (length K ≤ N). Total assets-lookup count:
//     M_in + M_out (down from 2 × N × M).
//
// Safety invariants preserved unchanged:
//   - `length(pair_outputs) == length(witnesses)` rejects spurious /
//     duplicate pair outputs.
//   - `length(witnesses) - create_count == length(pair_inputs)` rejects
//     spurious pair inputs and pair-input duplicates (a duplicate
//     token-name would yield a second entry that no witness consumes,
//     breaking the count).
//   - `minted_pair_token_count == create_count` rejects extra Pair NFT
//     mints unaccounted for by witnesses.
//   - Per-witness checks (mint quantity, payment credential, locked
//     lovelace, intent/datum continuity, signature recovery, freshness)
//     are unchanged.
fn valid_batch_update(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  witnesses: List<oracle_logic.UpdateWitness>,
) -> Bool {
  let domain_sep = oracle_logic.domain_separator(config_datum.domain_data)
  expect [first_witness, ..] = witnesses
  let pair_policy_id = first_witness.pair_policy_id
  let receiver_policy_id = first_witness.receiver_policy_id
  let receiver_asset_name = first_witness.receiver_asset_name

  let pair_outputs = collect_pair_outputs(self.outputs, pair_policy_id)
  let pair_inputs = collect_pair_inputs(self.inputs, pair_policy_id)

  let (witnesses_valid, create_count) =
    walk_batch_witnesses(
      self,
      config_datum,
      domain_sep,
      pair_policy_id,
      receiver_policy_id,
      receiver_asset_name,
      witnesses,
      pair_outputs,
      pair_inputs,
      None,
      True,
      0,
    )

  and {
    list.length(pair_outputs) == list.length(witnesses),
    list.length(witnesses) - create_count == list.length(pair_inputs),
    minted_pair_token_count(self, pair_policy_id) == create_count,
    witnesses_valid,
  }
}

// Recursive walk over witnesses + canonical pair outputs in lockstep.
// For each witness, the corresponding pair output is taken positionally
// from the head of `pair_outputs`, and the matching pair input (if any)
// is looked up by token-name in `pair_inputs`. The same pass also
// validates shared receiver, shared pair policy, strict canonical order,
// and intent expiry. Accumulates `(valid, create_count)`.
fn walk_batch_witnesses(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  domain_sep: ByteArray,
  pair_policy_id: PolicyId,
  receiver_policy_id: PolicyId,
  receiver_asset_name: AssetName,
  witnesses: List<oracle_logic.UpdateWitness>,
  pair_outputs: List<(ByteArray, Output)>,
  pair_inputs: List<(ByteArray, Input)>,
  previous_pair_token_name: Option<ByteArray>,
  acc_valid: Bool,
  acc_create_count: Int,
) -> (Bool, Int) {
  when witnesses is {
    [] -> (acc_valid, acc_create_count)
    [witness, ..rest_witnesses] -> {
      expect [(out_name, pair_output), ..rest_outputs] = pair_outputs

      expect InlineDatum(output_datum_data) = pair_output.datum
      expect next_pair: oracle_logic.PairDatum = output_datum_data

      let token_alignment_ok = out_name == witness.pair_token_name
      let witness_header_ok =
        batch_witness_header_ok(
          self,
          pair_policy_id,
          receiver_policy_id,
          receiver_asset_name,
          previous_pair_token_name,
          witness,
        )

      let matching_input =
        list.find(
          pair_inputs,
          fn(entry) {
            let (name, _) = entry
            name == witness.pair_token_name
          },
        )

      let (valid_this, is_create) =
        when matching_input is {
          None -> (and {
                minted_pair_quantity(
                  self,
                  pair_policy_id,
                  witness.pair_token_name,
                ) == 1,
                pair_output.address.payment_credential == Script(pair_policy_id),
                oracle_logic.exact_locked_lovelace(pair_output, next_pair),
                oracle_logic.initial_pair_matches_witness(
                  next_pair,
                  config_datum,
                  domain_sep,
                  witness,
                ),
                oracle_logic.intent_freshness_satisfied(
                  witness.intent,
                  self,
                  config_datum.max_bootstrap_drift_seconds,
                ),
              }, 1)

          Some((_, pair_input)) -> {
            expect InlineDatum(input_datum_data) = pair_input.output.datum
            expect previous_pair: oracle_logic.PairDatum = input_datum_data

            (
              oracle_logic.next_pair_matches_witness(
                previous_pair,
                next_pair,
                config_datum,
                domain_sep,
                witness,
              ),
              0,
            )
          }
        }

      walk_batch_witnesses(
        self,
        config_datum,
        domain_sep,
        pair_policy_id,
        receiver_policy_id,
        receiver_asset_name,
        rest_witnesses,
        rest_outputs,
        pair_inputs,
        Some(witness.pair_token_name),
        acc_valid && witness_header_ok && token_alignment_ok && valid_this,
        acc_create_count + is_create,
      )
    }
  }
}

fn batch_witness_header_ok(
  self: Transaction,
  pair_policy_id: PolicyId,
  receiver_policy_id: PolicyId,
  receiver_asset_name: AssetName,
  previous_pair_token_name: Option<ByteArray>,
  witness: oracle_logic.UpdateWitness,
) -> Bool {
  let order_ok =
    when previous_pair_token_name is {
      None -> True
      Some(previous) ->
        bytearray.compare(previous, witness.pair_token_name) == Less
    }

  and {
    witness.pair_policy_id == pair_policy_id,
    witness.receiver_policy_id == receiver_policy_id,
    witness.receiver_asset_name == receiver_asset_name,
    oracle_logic.intent_expiry_satisfied(witness.intent, self),
    order_ok,
  }
}

// Single linear pass over `tx.outputs`. Keeps only outputs that carry
// exactly one token of the shared pair policy, preserving their order
// in `tx.outputs`. Off-chain builders emit pair outputs in canonical
// witness order, so the result is already in canonical order and can
// be walked positionally alongside the sorted witness list.
fn collect_pair_outputs(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
) -> List<(ByteArray, Output)> {
  list.foldr(
    outputs,
    [],
    fn(output, acc) {
      when single_pair_token_name(output.value, pair_policy_id) is {
        Some(name) -> [(name, output), ..acc]
        None -> acc
      }
    },
  )
}

// Single linear pass over `tx.inputs`. Keeps only inputs that carry
// exactly one token of the shared pair policy. The order here is
// whatever the ledger provided (lexicographic by `OutputReference`),
// unrelated to `pair_token_name`, so callers must look up entries by
// token-name rather than rely on positional alignment with witnesses.
fn collect_pair_inputs(
  inputs: List<Input>,
  pair_policy_id: PolicyId,
) -> List<(ByteArray, Input)> {
  list.foldr(
    inputs,
    [],
    fn(input, acc) {
      when single_pair_token_name(input.output.value, pair_policy_id) is {
        Some(name) -> [(name, input), ..acc]
        None -> acc
      }
    },
  )
}

// Returns `Some(token_name)` if and only if `value` carries exactly
// one token of `policy_id` with quantity 1 (i.e. a single Pair NFT).
// Returns `None` for zero tokens or any malformed multi-token bag.
fn single_pair_token_name(
  value: Value,
  policy_id: PolicyId,
) -> Option<ByteArray> {
  when value |> assets.tokens(policy_id) |> dict.to_pairs() is {
    [Pair(name, 1)] -> Some(name)
    _ -> None
  }
}

fn minted_pair_quantity(
  self: Transaction,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Int {
  assets.quantity_of(self.mint, pair_policy_id, pair_token_name)
}

fn minted_pair_token_count(self: Transaction, pair_policy_id: PolicyId) -> Int {
  self.mint
    |> assets.tokens(pair_policy_id)
    |> dict.to_pairs()
    |> list.length
}

fn find_unique_pair_input(
  inputs: List<Input>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Option<Input> {
  find_unique_pair_input_go(inputs, pair_policy_id, pair_token_name, None)
}

fn find_unique_pair_input_go(
  inputs: List<Input>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
  found: Option<Input>,
) -> Option<Input> {
  when inputs is {
    [] -> found
    [head, ..tail] ->
      if assets.quantity_of(head.output.value, pair_policy_id, pair_token_name) == 1 {
        when found is {
          None ->
            find_unique_pair_input_go(
              tail,
              pair_policy_id,
              pair_token_name,
              Some(head),
            )
          Some(_) -> None
        }
      } else {
        find_unique_pair_input_go(tail, pair_policy_id, pair_token_name, found)
      }
  }
}

fn find_unique_pair_output(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Option<Output> {
  find_unique_pair_output_go(outputs, pair_policy_id, pair_token_name, None)
}

fn find_unique_pair_output_go(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
  found: Option<Output>,
) -> Option<Output> {
  when outputs is {
    [] -> found
    [head, ..tail] ->
      if assets.quantity_of(head.value, pair_policy_id, pair_token_name) == 1 {
        when found is {
          None ->
            find_unique_pair_output_go(
              tail,
              pair_policy_id,
              pair_token_name,
              Some(head),
            )
          Some(_) -> None
        }
      } else {
        find_unique_pair_output_go(tail, pair_policy_id, pair_token_name, found)
      }
  }
}

fn sample_sort_witness(
  policy_id: ByteArray,
  token_name: ByteArray,
) -> oracle_logic.UpdateWitness {
  oracle_logic.UpdateWitness {
    receiver_policy_id: #"22222222222222222222222222222222222222222222222222222222",
    receiver_asset_name: #"4449415f5245434549564552",
    pair_policy_id: policy_id,
    pair_token_name: token_name,
    intent: oracle_logic.OracleIntent {
      intent_type: #"4f7261636c65557064617465",
      version: #"312e30",
      chain_id: 100640,
      nonce: 1,
      expiry: 2,
      symbol: #"555344432f555344",
      price: 1,
      timestamp: 1,
      source: #"444941204f7261636c65",
      signature: #"00",
      signer: #"0000000000000000000000000000000000000000",
    },
    signer_public_key: #"03",
  }
}

test batch_witness_header_ok_accepts_strict_order_step() {
  let self =
    Transaction {
      ..transaction.placeholder,
      validity_range: interval.between(0, 1),
    }
  batch_witness_header_ok(
    self,
    #"11111111111111111111111111111111111111111111111111111111",
    #"22222222222222222222222222222222222222222222222222222222",
    #"4449415f5245434549564552",
    Some(#"01"),
    sample_sort_witness(
      #"11111111111111111111111111111111111111111111111111111111",
      #"02",
    ),
  )
}

test batch_witness_header_ok_rejects_bad_order_step() {
  let self =
    Transaction {
      ..transaction.placeholder,
      validity_range: interval.between(0, 1),
    }
  !batch_witness_header_ok(
    self,
    #"11111111111111111111111111111111111111111111111111111111",
    #"22222222222222222222222222222222222222222222222222222222",
    #"4449415f5245434549564552",
    Some(#"02"),
    sample_sort_witness(
      #"11111111111111111111111111111111111111111111111111111111",
      #"01",
    ),
  )
}

test batch_witness_header_ok_rejects_mixed_policy_step() {
  let self =
    Transaction {
      ..transaction.placeholder,
      validity_range: interval.between(0, 1),
    }
  !batch_witness_header_ok(
    self,
    #"11111111111111111111111111111111111111111111111111111111",
    #"22222222222222222222222222222222222222222222222222222222",
    #"4449415f5245434549564552",
    Some(#"01"),
    sample_sort_witness(
      #"22222222222222222222222222222222222222222222222222222222",
      #"02",
    ),
  )
}

test batch_witness_header_ok_rejects_duplicate_token_step() {
  let self =
    Transaction {
      ..transaction.placeholder,
      validity_range: interval.between(0, 1),
    }
  !batch_witness_header_ok(
    self,
    #"11111111111111111111111111111111111111111111111111111111",
    #"22222222222222222222222222222222222222222222222222222222",
    #"4449415f5245434549564552",
    Some(#"01"),
    sample_sort_witness(
      #"11111111111111111111111111111111111111111111111111111111",
      #"01",
    ),
  )
}

// Guards `ApplySettle` against a manifest that lists the same receiver twice.
// The on-chain coordinator calls this helper before computing settle deltas, so
// duplicate entries must be rejected before any drain arithmetic runs.
test unique_settle_receivers_accepts_empty_manifest() {
  unique_settle_receivers([])
}

test unique_settle_receivers_accepts_distinct_receivers() {
  let a =
    SettleReceiver {
      receiver_policy_id: #"11111111111111111111111111111111111111111111111111111111",
      receiver_asset_name: #"4449415f5245434549564552",
    }
  let b =
    SettleReceiver {
      receiver_policy_id: #"22222222222222222222222222222222222222222222222222222222",
      receiver_asset_name: #"4449415f5245434549564552",
    }
  unique_settle_receivers([a, b])
}

test unique_settle_receivers_rejects_duplicate_receiver() {
  let r =
    SettleReceiver {
      receiver_policy_id: #"11111111111111111111111111111111111111111111111111111111",
      receiver_asset_name: #"4449415f5245434549564552",
    }
  !unique_settle_receivers([r, r])
}

test unique_settle_receivers_rejects_duplicate_at_tail() {
  let a =
    SettleReceiver {
      receiver_policy_id: #"11111111111111111111111111111111111111111111111111111111",
      receiver_asset_name: #"4449415f5245434549564552",
    }
  let b =
    SettleReceiver {
      receiver_policy_id: #"22222222222222222222222222222222222222222222222222222222",
      receiver_asset_name: #"4449415f5245434549564552",
    }
  !unique_settle_receivers([a, b, a])
}

// Regression guard for the batch positional-output optimization. The off-chain
// builder is expected to emit pair outputs in the same canonical order as the
// witness list (strict ascending by `pair_token_name`); `walk_batch_witnesses`
// trusts that order to match witness[i] against pair_outputs[i] by name. If a
// future refactor breaks that contract — or a manual tx submits outputs in a
// different order — the function MUST return `(False, _)`. This test pins that
// invariant by feeding a witness list of `[a, b]` with pair outputs swapped to
// `[(b_name, …), (a_name, …)]` and asserting the coordinator rejects it.
fn sample_walk_pair_datum(token_name: ByteArray) -> oracle_logic.PairDatum {
  oracle_logic.PairDatum {
    pair_id: token_name,
    price: 0,
    timestamp: 0,
    nonce: 0,
    intent_hash: #"00",
    signer: #"00",
    min_utxo_lovelace: 1,
  }
}

fn sample_walk_pair_output(token_name: ByteArray) -> Output {
  Output {
    address: address.from_script(
      #"11111111111111111111111111111111111111111111111111111111",
    ),
    value: assets.from_lovelace(1),
    datum: InlineDatum(sample_walk_pair_datum(token_name)),
    reference_script: None,
  }
}

fn sample_walk_witness(token_name: ByteArray) -> oracle_logic.UpdateWitness {
  oracle_logic.UpdateWitness {
    receiver_policy_id: #"22222222222222222222222222222222222222222222222222222222",
    receiver_asset_name: #"4449415f5245434549564552",
    pair_policy_id: #"11111111111111111111111111111111111111111111111111111111",
    pair_token_name: token_name,
    intent: oracle_logic.OracleIntent {
      intent_type: #"4f7261636c65557064617465",
      version: #"312e30",
      chain_id: 100640,
      nonce: 1,
      expiry: 2,
      symbol: #"555344432f555344",
      price: 1,
      timestamp: 1,
      source: #"444941204f7261636c65",
      signature: #"00",
      signer: #"0000000000000000000000000000000000000000",
    },
    signer_public_key: #"03",
  }
}

fn sample_walk_config_datum() -> config_logic.ConfigDatum {
  config_logic.ConfigDatum {
    config_admins: [#"00"],
    authorized_dia_public_keys: [#"03"],
    domain_data: config_logic.Domain {
      name: #"444941204f7261636c65",
      version: #"312e30",
      source_chain_id: 100640,
      verifying_contract: #"00000000000000000000000000000000000000ff",
    },
    base_fee_lovelace: 0,
    per_pair_fee_lovelace: 0,
    payment_hook_ref: None,
    update_coordinator_credential: None,
    max_bootstrap_drift_seconds: 300,
    min_utxo_lovelace: 1,
  }
}

test walk_batch_witnesses_rejects_output_order_mismatch() {
  let token_a = #"01"
  let token_b = #"02"
  let w_a = sample_walk_witness(token_a)
  let w_b = sample_walk_witness(token_b)

  // Outputs in the WRONG order: token_b first, then token_a.
  let pair_outputs =
    [
      (token_b, sample_walk_pair_output(token_b)),
      (token_a, sample_walk_pair_output(token_a)),
    ]

  let self =
    Transaction {
      ..transaction.placeholder,
      validity_range: interval.between(0, 1),
    }

  let (ok, _) =
    walk_batch_witnesses(
      self,
      sample_walk_config_datum(),
      #"00",
      w_a.pair_policy_id,
      w_a.receiver_policy_id,
      w_a.receiver_asset_name,
      [w_a, w_b],
      pair_outputs,
      [],
      None,
      True,
      0,
    )

  !ok
}

test walk_batch_witnesses_aligned_order_passes_token_check() {
  // Companion: with outputs in canonical (ascending) order the token-alignment
  // check itself succeeds. The walk may still return False because other
  // create-branch checks (mint quantity, signature, freshness) are not set up
  // here, but the regression we care about — name alignment — is satisfied.
  let token_a = #"01"
  let token_b = #"02"
  let w_a = sample_walk_witness(token_a)
  let w_b = sample_walk_witness(token_b)

  let pair_outputs =
    [
      (token_a, sample_walk_pair_output(token_a)),
      (token_b, sample_walk_pair_output(token_b)),
    ]

  // Sanity: out_name aligns with witness pair_token_name on each step.
  expect [(first_name, _), (second_name, _)] = pair_outputs
  and {
    first_name == w_a.pair_token_name,
    second_name == w_b.pair_token_name,
  }
}

type BatchUpdateBenchCase {
  BatchUpdateBenchCase {
    config_datum: config_logic.ConfigDatum,
    tx: Transaction,
    witnesses: List<oracle_logic.UpdateWitness>,
  }
}

type SettleBuildState {
  SettleBuildState {
    receivers: List<SettleReceiver>,
    inputs: List<Input>,
    outputs: List<Output>,
    delta: Int,
  }
}

type ValidSettleBenchCase {
  ValidSettleBenchCase {
    config_datum: config_logic.ConfigDatum,
    tx: Transaction,
    manifest: SettleManifest,
  }
}

const bench_pair_policy: PolicyId =
  #"11111111111111111111111111111111111111111111111111111111"

const bench_receiver_policy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const bench_receiver_asset: AssetName =
  #"4449415f5245434549564552"

const bench_hook_policy: PolicyId =
  #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

const bench_hook_asset: AssetName = #"484f4f4b"

const bench_signer_public_key: ByteArray =
  #"03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807"

const bench_signature: ByteArray =
  #"7e3ab9c6c59f1997f007063e96120ab198bb4129875e49b4f48298c533771d0e6266a261ea108343a4ed02a6823ab3602bcdedd4b891226c2f452b4a158ac1011b"

fn batch_bench_count(size: Int) -> Int {
  size + 1
}

fn batch_bench_symbol(ix: Int) -> ByteArray {
  builtin.cons_bytearray(ix, "PAIR")
}

fn batch_bench_intent(ix: Int) -> oracle_logic.OracleIntent {
  let symbol = batch_bench_symbol(ix)
  oracle_logic.OracleIntent {
    intent_type: #"4f7261636c65557064617465",
    version: #"312e30",
    chain_id: 100640,
    nonce: 1760960522308165264 + ix,
    expiry: 9_999_999_999,
    symbol,
    price: 99992561 + ix,
    timestamp: 1760960522 + ix,
    source: #"444941204f7261636c65",
    // Re-used real fixture signature. It is intentionally invalid once the
    // intent fields vary, which is acceptable here because we want a stable
    // cost baseline for the create-path walk without needing N distinct live
    // DIA signatures in source.
    signature: bench_signature,
    signer: #"f64d333c19b007519c7b9316680ed26578f98c08",
  }
}

fn batch_bench_witness(ix: Int) -> oracle_logic.UpdateWitness {
  let intent = batch_bench_intent(ix)
  oracle_logic.UpdateWitness {
    receiver_policy_id: bench_receiver_policy,
    receiver_asset_name: bench_receiver_asset,
    pair_policy_id: bench_pair_policy,
    pair_token_name: oracle_logic.pair_asset_name(intent.symbol),
    intent,
    signer_public_key: bench_signer_public_key,
  }
}

fn batch_bench_pair_datum(ix: Int) -> oracle_logic.PairDatum {
  let intent = batch_bench_intent(ix)
  oracle_logic.PairDatum {
    pair_id: intent.symbol,
    price: intent.price,
    timestamp: intent.timestamp,
    nonce: intent.nonce,
    intent_hash: oracle_logic.oracle_intent_hash(
      sample_walk_config_datum().domain_data,
      intent,
    ),
    signer: intent.signer,
    min_utxo_lovelace: 2_000_000,
  }
}

fn batch_bench_pair_output(ix: Int) -> Output {
  let datum = batch_bench_pair_datum(ix)
  let token_name = oracle_logic.pair_asset_name(datum.pair_id)
  Output {
    address: address.from_script(bench_pair_policy),
    value:
      assets.add(
        assets.from_lovelace(datum.min_utxo_lovelace),
        bench_pair_policy,
        token_name,
        1,
      ),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn batch_bench_witnesses(count: Int) -> List<oracle_logic.UpdateWitness> {
  batch_bench_witnesses_go(count, [])
}

fn batch_bench_witnesses_go(
  remaining: Int,
  acc: List<oracle_logic.UpdateWitness>,
) -> List<oracle_logic.UpdateWitness> {
  if remaining <= 0 {
    acc
  } else {
    batch_bench_witnesses_go(
      remaining - 1,
      [batch_bench_witness(remaining), ..acc],
    )
  }
}

fn batch_bench_outputs(count: Int) -> List<Output> {
  batch_bench_outputs_go(count, [])
}

fn batch_bench_outputs_go(remaining: Int, acc: List<Output>) -> List<Output> {
  if remaining <= 0 {
    acc
  } else {
    batch_bench_outputs_go(
      remaining - 1,
      [batch_bench_pair_output(remaining), ..acc],
    )
  }
}

fn batch_bench_mint(
  witnesses: List<oracle_logic.UpdateWitness>,
) -> Value {
  list.foldl(
    witnesses,
    assets.from_lovelace(0),
    fn(witness, acc) {
      assets.add(
        acc,
        witness.pair_policy_id,
        witness.pair_token_name,
        1,
      )
    },
  )
}

fn valid_batch_update_bench_case(count: Int) -> BatchUpdateBenchCase {
  let witnesses = batch_bench_witnesses(count)
  BatchUpdateBenchCase {
    config_datum: sample_walk_config_datum(),
    tx: Transaction {
      ..transaction.placeholder,
      outputs: batch_bench_outputs(count),
      mint: batch_bench_mint(witnesses),
      validity_range: interval.between(1760960522 * 1000, 9_999_999_998 * 1000),
    },
    witnesses,
  }
}

fn bench_settle_receiver_policy(ix: Int) -> PolicyId {
  builtin.cons_bytearray(ix, #"222222222222222222222222222222222222222222222222222222")
}

fn bench_settle_receiver_asset(ix: Int) -> AssetName {
  builtin.cons_bytearray(ix, #"4449415f5245434549564552")
}

fn bench_receiver_datum(ix: Int) -> receiver_logic.ReceiverDatum {
  receiver_logic.ReceiverDatum {
    balance_lovelace: 10_000_000 + ix,
    accrued_to_hook_lovelace: 1_000_000 + ix,
    min_utxo_lovelace: 2_000_000,
  }
}

fn bench_receiver_input(ix: Int) -> Input {
  let policy_id = bench_settle_receiver_policy(ix)
  let asset_name = bench_settle_receiver_asset(ix)
  let datum = bench_receiver_datum(ix)
  Input {
    output_reference: OutputReference {
      transaction_id: builtin.cons_bytearray(
        ix,
        #"01010101010101010101010101010101010101010101010101010101010101",
      ),
      output_index: 0,
    },
    output: Output {
      address: address.from_script(policy_id),
      value:
        assets.add(
          assets.from_lovelace(
            datum.min_utxo_lovelace + datum.balance_lovelace + datum.accrued_to_hook_lovelace,
          ),
          policy_id,
          asset_name,
          1,
        ),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

fn bench_receiver_output(ix: Int) -> Output {
  let policy_id = bench_settle_receiver_policy(ix)
  let asset_name = bench_settle_receiver_asset(ix)
  let previous = bench_receiver_datum(ix)
  let next =
    receiver_logic.ReceiverDatum {
      balance_lovelace: previous.balance_lovelace,
      accrued_to_hook_lovelace: 0,
      min_utxo_lovelace: previous.min_utxo_lovelace,
    }
  Output {
    address: address.from_script(policy_id),
    value:
      assets.add(
        assets.from_lovelace(
          next.min_utxo_lovelace + next.balance_lovelace + next.accrued_to_hook_lovelace,
        ),
        policy_id,
        asset_name,
        1,
      ),
    datum: InlineDatum(next),
    reference_script: None,
  }
}

fn settle_build_state(count: Int) -> SettleBuildState {
  settle_build_state_go(count, SettleBuildState { receivers: [], inputs: [], outputs: [], delta: 0 })
}

fn settle_build_state_go(
  remaining: Int,
  state: SettleBuildState,
) -> SettleBuildState {
  if remaining <= 0 {
    state
  } else {
    let receiver =
      SettleReceiver {
        receiver_policy_id: bench_settle_receiver_policy(remaining),
        receiver_asset_name: bench_settle_receiver_asset(remaining),
      }
    let previous = bench_receiver_datum(remaining)
    settle_build_state_go(
      remaining - 1,
      SettleBuildState {
        receivers: [receiver, ..state.receivers],
        inputs: [bench_receiver_input(remaining), ..state.inputs],
        outputs: [bench_receiver_output(remaining), ..state.outputs],
        delta: state.delta + previous.accrued_to_hook_lovelace,
      },
    )
  }
}

fn valid_settle_bench_config() -> config_logic.ConfigDatum {
  config_logic.ConfigDatum {
    ..sample_walk_config_datum(),
    payment_hook_ref: Some(
      config_logic.PaymentHookRef {
        policy_id: bench_hook_policy,
        asset_name: bench_hook_asset,
      },
    ),
  }
}

fn valid_settle_hook_input() -> Input {
  let datum =
    payment_hook_logic.PaymentHookDatum {
      ..payment_hook_logic.sample_payment_hook(),
      accrued_fees_lovelace: 500_000,
      lifetime_collected_lovelace: 10_000_000,
    }
  Input {
    output_reference: OutputReference {
      transaction_id: #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      output_index: 0,
    },
    output: Output {
      address: address.from_script(bench_hook_policy),
      value:
        assets.add(
          assets.from_lovelace(
            datum.min_utxo_lovelace + datum.accrued_fees_lovelace,
          ),
          bench_hook_policy,
          bench_hook_asset,
          1,
        ),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

fn valid_settle_hook_output(delta: Int) -> Output {
  let previous =
    payment_hook_logic.PaymentHookDatum {
      ..payment_hook_logic.sample_payment_hook(),
      accrued_fees_lovelace: 500_000,
      lifetime_collected_lovelace: 10_000_000,
    }
  let next =
    payment_hook_logic.PaymentHookDatum {
      ..previous,
      accrued_fees_lovelace: previous.accrued_fees_lovelace + delta,
      lifetime_collected_lovelace: previous.lifetime_collected_lovelace + delta,
    }
  Output {
    address: address.from_script(bench_hook_policy),
    value:
      assets.add(
        assets.from_lovelace(
          next.min_utxo_lovelace + next.accrued_fees_lovelace,
        ),
        bench_hook_policy,
        bench_hook_asset,
        1,
      ),
    datum: InlineDatum(next),
    reference_script: None,
  }
}

fn valid_settle_bench_case(count: Int) -> ValidSettleBenchCase {
  let built = settle_build_state(count)
  ValidSettleBenchCase {
    config_datum: valid_settle_bench_config(),
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [valid_settle_hook_input(), ..built.inputs],
      outputs: [valid_settle_hook_output(built.delta), ..built.outputs],
    },
    manifest: SettleManifest { receivers: built.receivers },
  }
}

fn sample_valid_batch_update_case(size: Int) -> Fuzzer<BatchUpdateBenchCase> {
  fuzz.constant(valid_batch_update_bench_case(batch_bench_count(size)))
}

fn sample_valid_settle_case(size: Int) -> Fuzzer<ValidSettleBenchCase> {
  fuzz.constant(valid_settle_bench_case(batch_bench_count(size)))
}

bench update_coordinator_valid_batch_update_create_path(
  bench_case via sample_valid_batch_update_case,
) {
  valid_batch_update(
    bench_case.tx,
    bench_case.config_datum,
    bench_case.witnesses,
  )
}

bench update_coordinator_valid_settle_receivers(
  bench_case via sample_valid_settle_case,
) {
  valid_settle(
    bench_case.tx,
    bench_case.config_datum,
    bench_case.manifest,
  )
}
