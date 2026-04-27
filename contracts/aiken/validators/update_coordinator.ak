use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Credential, Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/oracle_logic
use dia_cardano_oracle/payment_hook_logic
use dia_cardano_oracle/receiver_logic

pub type CoordinatorRedeemer {
  ApplySingle(oracle_logic.UpdateWitness)
  ApplyBatch(List<oracle_logic.UpdateWitness>)
}

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

    expect Some(payment_hook_ref) = config_datum.payment_hook_ref

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

    and {
      config_logic.valid_config_state(config_datum),
      config_datum.update_coordinator_credential == Some(own_credential),
      payment_hook_logic.valid_payment_hook_state(previous_hook),
      payment_hook_logic.valid_payment_hook_state(next_hook),
      payment_hook_logic.exact_locked_lovelace(hook_input.output, previous_hook),
      payment_hook_logic.exact_locked_lovelace(hook_output, next_hook),
      when redeemer is {
        ApplySingle(witness) -> and {
            payment_hook_logic.fee_charge_transition(
              previous_hook,
              next_hook,
              config_datum.protocol_fee_lovelace,
            ),
            valid_single_update(self, config_datum, witness),
            valid_receiver_fee(
              self,
              witness.receiver_policy_id,
              witness.receiver_asset_name,
              config_datum.protocol_fee_lovelace,
            ),
          }

        ApplyBatch(witnesses) -> and {
            witnesses_share_receiver(witnesses),
            payment_hook_logic.fee_charge_transition(
              previous_hook,
              next_hook,
              config_datum.protocol_fee_lovelace * list.length(witnesses),
            ),
            valid_batch_update(self, config_datum, witnesses),
            valid_batch_receiver_fee(
              self,
              witnesses,
              config_datum.protocol_fee_lovelace * list.length(witnesses),
            ),
          }
      },
    }
  }

  else(_) {
    False
  }
}

fn valid_batch_receiver_fee(
  self: Transaction,
  witnesses: List<oracle_logic.UpdateWitness>,
  fee_lovelace: Int,
) -> Bool {
  when witnesses is {
    [] -> False
    [head, ..] ->
      valid_receiver_fee(
        self,
        head.receiver_policy_id,
        head.receiver_asset_name,
        fee_lovelace,
      )
  }
}

fn valid_receiver_fee(
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
    receiver_logic.pay_fee_transition(
      previous_receiver,
      next_receiver,
      fee_lovelace,
    ),
  }
}

fn valid_single_update(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  witness: oracle_logic.UpdateWitness,
) -> Bool {
  let pair_policy_id = witness.pair_policy_id
  let pair_input_count =
    count_pair_token_inputs(
      self.inputs,
      pair_policy_id,
      witness.pair_token_name,
    )
  let pair_output_count =
    count_pair_token_outputs(
      self.outputs,
      pair_policy_id,
      witness.pair_token_name,
    )

  expect Some(pair_output) =
    find_pair_output(self.outputs, pair_policy_id, witness.pair_token_name)

  expect InlineDatum(output_datum_data) = pair_output.datum
  expect next_pair: oracle_logic.PairDatum = output_datum_data

  and {
    pair_output_count == 1,
    when pair_input_count is {
      0 -> and {
          minted_pair_quantity(self, pair_policy_id, witness.pair_token_name) == 1,
          minted_pair_token_count(self, pair_policy_id) == 1,
          pair_output.address.payment_credential == Script(pair_policy_id),
          oracle_logic.exact_locked_lovelace(pair_output, next_pair),
          oracle_logic.initial_pair_matches_witness(
            next_pair,
            config_datum,
            witness,
          ),
        }

      1 -> {
        expect Some(pair_input) =
          find_pair_input(self.inputs, pair_policy_id, witness.pair_token_name)
        expect InlineDatum(input_datum_data) = pair_input.output.datum
        expect previous_pair: oracle_logic.PairDatum = input_datum_data

        and {
          minted_pair_token_count(self, pair_policy_id) == 0,
          oracle_logic.next_pair_matches_witness(
            previous_pair,
            next_pair,
            config_datum,
            witness,
          ),
        }
      }

      _ -> False
    },
  }
}

fn valid_batch_update(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  witnesses: List<oracle_logic.UpdateWitness>,
) -> Bool {
  and {
    list.length(witnesses) > 0,
    unique_pair_units(witnesses),
    witnesses_share_pair_policy(witnesses),
    minted_pair_token_count(self, first_pair_policy_id(witnesses)) == create_witness_count(
      self,
      witnesses,
    ),
    list.all(
      witnesses,
      fn(witness) {
        let pair_policy_id = witness.pair_policy_id
        let pair_input_count =
          count_pair_token_inputs(
            self.inputs,
            pair_policy_id,
            witness.pair_token_name,
          )
        let pair_output_count =
          count_pair_token_outputs(
            self.outputs,
            pair_policy_id,
            witness.pair_token_name,
          )

        expect Some(pair_output) =
          find_pair_output(
            self.outputs,
            pair_policy_id,
            witness.pair_token_name,
          )

        expect InlineDatum(output_datum_data) = pair_output.datum
        expect next_pair: oracle_logic.PairDatum = output_datum_data

        and {
          pair_output_count == 1,
          when pair_input_count is {
            0 -> and {
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
                  witness,
                ),
              }

            1 -> {
              expect Some(pair_input) =
                find_pair_input(
                  self.inputs,
                  pair_policy_id,
                  witness.pair_token_name,
                )
              expect InlineDatum(input_datum_data) = pair_input.output.datum
              expect previous_pair: oracle_logic.PairDatum = input_datum_data

              oracle_logic.next_pair_matches_witness(
                previous_pair,
                next_pair,
                config_datum,
                witness,
              )
            }

            _ -> False
          },
        }
      },
    ),
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

fn create_witness_count(
  self: Transaction,
  witnesses: List<oracle_logic.UpdateWitness>,
) -> Int {
  witnesses
    |> list.filter(
        fn(witness) {
          count_pair_token_inputs(
            self.inputs,
            witness.pair_policy_id,
            witness.pair_token_name,
          ) == 0
        },
      )
    |> list.length
}

fn first_pair_policy_id(witnesses: List<oracle_logic.UpdateWitness>) -> PolicyId {
  expect [head, ..] = witnesses
  head.pair_policy_id
}

fn find_pair_input(
  inputs: List<Input>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Option<Input> {
  list.find(
    inputs,
    fn(input) {
      assets.quantity_of(input.output.value, pair_policy_id, pair_token_name) == 1
    },
  )
}

fn find_pair_output(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Option<Output> {
  list.find(
    outputs,
    fn(output) {
      assets.quantity_of(output.value, pair_policy_id, pair_token_name) == 1
    },
  )
}

fn count_pair_token_inputs(
  inputs: List<Input>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Int {
  inputs
    |> list.filter(
        fn(input) {
          assets.quantity_of(
            input.output.value,
            pair_policy_id,
            pair_token_name,
          ) == 1
        },
      )
    |> list.length
}

fn count_pair_token_outputs(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Int {
  outputs
    |> list.filter(
        fn(output) {
          assets.quantity_of(output.value, pair_policy_id, pair_token_name) == 1
        },
      )
    |> list.length
}

fn unique_pair_units(witnesses: List<oracle_logic.UpdateWitness>) -> Bool {
  when witnesses is {
    [] -> True
    [head, ..tail] -> and {
        !list.any(
          tail,
          fn(other) {
            and {
              other.pair_policy_id == head.pair_policy_id,
              other.pair_token_name == head.pair_token_name,
            }
          },
        ),
        unique_pair_units(tail),
      }
  }
}

fn witnesses_share_receiver(witnesses: List<oracle_logic.UpdateWitness>) -> Bool {
  when witnesses is {
    [] -> True
    [head, ..tail] ->
      list.all(
        tail,
        fn(other) {
          and {
            other.receiver_policy_id == head.receiver_policy_id,
            other.receiver_asset_name == head.receiver_asset_name,
          }
        },
      )
  }
}

fn witnesses_share_pair_policy(
  witnesses: List<oracle_logic.UpdateWitness>,
) -> Bool {
  when witnesses is {
    [] -> True
    [head, ..tail] ->
      list.all(tail, fn(other) { other.pair_policy_id == head.pair_policy_id })
  }
}
