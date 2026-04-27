use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Credential, Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/receiver_logic

pub type ReceiverMintAction {
  Bootstrap
}

validator receiver(
  bootstrap_ref: OutputReference,
  expected_asset_name: AssetName,
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
) {
  mint(action: ReceiverMintAction, policy_id: PolicyId, self: Transaction) {
    let Bootstrap = action

    expect [Pair(asset_name, quantity)] =
      self.mint
        |> assets.tokens(policy_id)
        |> dict.to_pairs()

    let consumes_bootstrap_input =
      list.any(
        self.inputs,
        fn(input) { input.output_reference == bootstrap_ref },
      )

    expect Some(config_input) =
      find_visible_config_input(self, config_policy_id, config_asset_name)
    expect InlineDatum(config_datum_data) = config_input.output.datum
    expect config_datum: config_logic.ConfigDatum = config_datum_data

    and {
      consumes_bootstrap_input,
      asset_name == expected_asset_name,
      quantity == 1,
      config_logic.valid_config_state(config_datum),
      config_logic.has_config_signer(config_datum, self),
      has_valid_receiver_output(self.outputs, policy_id, expected_asset_name),
    }
  }

  spend(
    maybe_datum: Option<receiver_logic.ReceiverDatum>,
    redeemer: receiver_logic.ReceiverRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(current_datum) = maybe_datum
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    expect Script(own_policy_id) = own_input.output.address.payment_credential

    expect Some(next_output) =
      list.find(
        self.outputs,
        fn(output) {
          assets.quantity_of(output.value, own_policy_id, expected_asset_name) == 1
        },
      )

    expect InlineDatum(next_output_datum) = next_output.datum
    expect next_datum: receiver_logic.ReceiverDatum = next_output_datum

    and {
      receiver_logic.valid_receiver_state(current_datum),
      receiver_logic.valid_receiver_state(next_datum),
      own_policy_id == expected_receiver_hash(own_input.output),
      assets.quantity_of(
        own_input.output.value,
        own_policy_id,
        expected_asset_name,
      ) == 1,
      assets.quantity_of(next_output.value, own_policy_id, expected_asset_name) == 1,
      next_output.address.payment_credential == Script(own_policy_id),
      receiver_logic.exact_locked_lovelace(own_input.output, current_datum),
      receiver_logic.exact_locked_lovelace(next_output, next_datum),
      when redeemer is {
        receiver_logic.TopUp ->
          receiver_logic.top_up_transition(
            own_input.output,
            next_output,
            current_datum,
            next_datum,
          )

        receiver_logic.PayFee -> {
          expect Some(config_input) =
            find_visible_config_input(self, config_policy_id, config_asset_name)
          expect InlineDatum(config_datum_data) = config_input.output.datum
          expect config_datum: config_logic.ConfigDatum = config_datum_data

          and {
            config_logic.valid_config_state(config_datum),
            coordinator_witness_present(self.withdrawals, config_datum),
            receiver_logic.pay_fee_transition(
              current_datum,
              next_datum,
              current_datum.balance_lovelace - next_datum.balance_lovelace,
            ),
          }
        }

        receiver_logic.Withdraw { amount, recipient } -> {
          expect Some(config_input) =
            find_visible_config_input(self, config_policy_id, config_asset_name)
          expect InlineDatum(config_datum_data) = config_input.output.datum
          expect config_datum: config_logic.ConfigDatum = config_datum_data

          and {
            config_logic.valid_config_state(config_datum),
            config_logic.has_config_signer(config_datum, self),
            receiver_logic.withdraw_transition(
              current_datum,
              next_datum,
              amount,
            ),
            receiver_logic.paid_to_recipient(self.outputs, recipient, amount),
          }
        }
      },
    }
  }

  else(_) {
    False
  }
}

fn has_valid_receiver_output(
  outputs: List<Output>,
  receiver_policy_id: PolicyId,
  receiver_asset_name: AssetName,
) -> Bool {
  when
    list.find(
      outputs,
      fn(output) {
        assets.quantity_of(
          output.value,
          receiver_policy_id,
          receiver_asset_name,
        ) == 1
      },
    )
  is {
    Some(receiver_output) ->
      when receiver_output.datum is {
        InlineDatum(output_datum) -> {
          expect receiver_datum: receiver_logic.ReceiverDatum = output_datum
          and {
            receiver_output.address.payment_credential == Script(
              receiver_policy_id,
            ),
            receiver_logic.valid_receiver_state(receiver_datum),
            receiver_logic.exact_locked_lovelace(
              receiver_output,
              receiver_datum,
            ),
          }
        }

        _ -> False
      }

    None -> False
  }
}

fn find_visible_config_input(
  self: Transaction,
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
) -> Option<Input> {
  when
    list.find(
      self.inputs,
      fn(input) {
        assets.quantity_of(
          input.output.value,
          config_policy_id,
          config_asset_name,
        ) == 1
      },
    )
  is {
    Some(input) -> Some(input)
    None ->
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
  }
}

fn expected_receiver_hash(output: Output) -> PolicyId {
  expect Script(receiver_hash) = output.address.payment_credential
  receiver_hash
}

fn coordinator_witness_present(
  withdrawals: Pairs<Credential, Int>,
  config_datum: config_logic.ConfigDatum,
) -> Bool {
  when config_datum.update_coordinator_credential is {
    Some(expected_credential) ->
      list.any(
        withdrawals,
        fn(withdrawal) { withdrawal.1st == expected_credential },
      )

    None -> False
  }
}
