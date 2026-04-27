use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Credential, Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/payment_hook_logic

pub type PaymentHookMintAction {
  Bootstrap
}

validator payment_hook(
  bootstrap_ref: OutputReference,
  expected_asset_name: AssetName,
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
  coordinator_credential: Credential,
) {
  mint(action: PaymentHookMintAction, policy_id: PolicyId, self: Transaction) {
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

    expect Some(config_output) =
      list.find(
        self.outputs,
        fn(output) {
          assets.quantity_of(output.value, config_policy_id, config_asset_name) == 1
        },
      )

    expect InlineDatum(config_input_datum) = config_input.output.datum
    expect previous_config: config_logic.ConfigDatum = config_input_datum

    expect InlineDatum(config_output_datum) = config_output.datum
    expect next_config: config_logic.ConfigDatum = config_output_datum

    and {
      consumes_bootstrap_input,
      asset_name == expected_asset_name,
      quantity == 1,
      config_logic.valid_config_state(previous_config),
      config_logic.valid_config_state(next_config),
      previous_config.payment_hook_ref == None,
      previous_config.update_coordinator_credential == None,
      next_config.payment_hook_ref == Some(
        config_logic.PaymentHookRef {
          policy_id,
          asset_name: expected_asset_name,
        },
      ),
      next_config.update_coordinator_credential == Some(coordinator_credential),
      config_logic.has_config_signer(previous_config, self),
      has_valid_payment_hook_output(
        self.outputs,
        policy_id,
        expected_asset_name,
      ),
    }
  }

  spend(
    maybe_datum: Option<payment_hook_logic.PaymentHookDatum>,
    redeemer: payment_hook_logic.PaymentHookRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(current_datum) = maybe_datum
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    expect Script(own_policy_id) = own_input.output.address.payment_credential

    expect Some(config_input) =
      find_visible_config_input(self, config_policy_id, config_asset_name)
    expect InlineDatum(config_datum_data) = config_input.output.datum
    expect config_datum: config_logic.ConfigDatum = config_datum_data

    expect Some(next_output) =
      list.find(
        self.outputs,
        fn(output) {
          assets.quantity_of(output.value, own_policy_id, expected_asset_name) == 1
        },
      )

    expect InlineDatum(next_output_datum) = next_output.datum
    expect next_datum: payment_hook_logic.PaymentHookDatum = next_output_datum

    and {
      payment_hook_logic.valid_payment_hook_state(current_datum),
      payment_hook_logic.valid_payment_hook_state(next_datum),
      assets.quantity_of(
        own_input.output.value,
        own_policy_id,
        expected_asset_name,
      ) == 1,
      assets.quantity_of(next_output.value, own_policy_id, expected_asset_name) == 1,
      payment_hook_logic.exact_locked_lovelace(own_input.output, current_datum),
      payment_hook_logic.exact_locked_lovelace(next_output, next_datum),
      when redeemer is {
        payment_hook_logic.ApplyFee -> {
          let collected_lovelace =
            next_datum.accrued_fees_lovelace - current_datum.accrued_fees_lovelace

          and {
            has_expected_hook_ref(
              config_datum,
              own_policy_id,
              expected_asset_name,
            ),
            coordinator_witness_present(self.withdrawals, config_datum),
            payment_hook_logic.fee_charge_transition(
              current_datum,
              next_datum,
              collected_lovelace,
            ),
          }
        }

        payment_hook_logic.AdminUpdate -> and {
            config_logic.has_config_signer(config_datum, self),
            payment_hook_logic.admin_update_transition(
              current_datum,
              next_datum,
            ),
          }

        payment_hook_logic.Withdraw { amount } -> and {
            config_logic.has_config_signer(config_datum, self),
            payment_hook_logic.withdraw_transition(
              current_datum,
              next_datum,
              amount,
            ),
            payment_hook_logic.withdraw_paid_to_target(
              self.outputs,
              current_datum.withdraw_address,
              amount,
            ),
          }
      },
    }
  }

  else(_) {
    False
  }
}

fn has_valid_payment_hook_output(
  outputs: List<Output>,
  hook_policy_id: PolicyId,
  hook_asset_name: AssetName,
) -> Bool {
  when
    list.find(
      outputs,
      fn(output) {
        assets.quantity_of(output.value, hook_policy_id, hook_asset_name) == 1
      },
    )
  is {
    Some(hook_output) ->
      when hook_output.datum is {
        InlineDatum(output_datum) -> {
          expect hook_datum: payment_hook_logic.PaymentHookDatum = output_datum
          and {
            payment_hook_logic.valid_payment_hook_state(hook_datum),
            payment_hook_logic.exact_locked_lovelace(hook_output, hook_datum),
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

fn has_expected_hook_ref(
  config_datum: config_logic.ConfigDatum,
  hook_policy_id: PolicyId,
  hook_asset_name: AssetName,
) -> Bool {
  config_datum.payment_hook_ref == Some(
    config_logic.PaymentHookRef {
      policy_id: hook_policy_id,
      asset_name: hook_asset_name,
    },
  )
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
