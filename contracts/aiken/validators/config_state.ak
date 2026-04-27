use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}
use dia_cardano_oracle/config_logic

pub type ConfigMintAction {
  Bootstrap
}

validator config_state(
  bootstrap_ref: OutputReference,
  expected_asset_name: AssetName,
) {
  mint(action: ConfigMintAction, policy_id: PolicyId, self: Transaction) {
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

    and {
      consumes_bootstrap_input,
      asset_name == expected_asset_name,
      quantity == 1,
      has_valid_config_bootstrap_output(
        self.outputs,
        policy_id,
        expected_asset_name,
      ),
    }
  }

  spend(
    maybe_datum: Option<config_logic.ConfigDatum>,
    redeemer: config_logic.ConfigRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(current_datum) = maybe_datum
    let config_logic.AdminUpdate = redeemer
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    expect Script(own_policy_id) = own_input.output.address.payment_credential

    expect Some(config_output) =
      list.find(
        self.outputs,
        fn(output) {
          assets.quantity_of(output.value, own_policy_id, expected_asset_name) == 1
        },
      )

    expect InlineDatum(output_datum) = config_output.datum
    expect next_datum: config_logic.ConfigDatum = output_datum

    and {
      assets.quantity_of(
        own_input.output.value,
        own_policy_id,
        expected_asset_name,
      ) == 1,
      assets.quantity_of(
        config_output.value,
        own_policy_id,
        expected_asset_name,
      ) == 1,
      config_logic.valid_config_state(current_datum),
      config_logic.valid_config_state(next_datum),
      config_logic.has_config_signer(current_datum, self),
      assets.lovelace_of(own_input.output.value) == current_datum.min_utxo_lovelace,
      assets.lovelace_of(config_output.value) == next_datum.min_utxo_lovelace,
      config_logic.admin_update_transition(current_datum, next_datum),
    }
  }

  else(_) {
    False
  }
}

fn has_valid_config_bootstrap_output(
  outputs: List<Output>,
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
) -> Bool {
  when
    list.find(
      outputs,
      fn(output) {
        assets.quantity_of(output.value, config_policy_id, config_asset_name) == 1
      },
    )
  is {
    Some(config_output) ->
      when config_output.datum is {
        InlineDatum(output_datum) -> {
          expect config_datum: config_logic.ConfigDatum = output_datum
          and {
            config_logic.valid_config_state(config_datum),
            assets.lovelace_of(config_output.value) == config_datum.min_utxo_lovelace,
          }
        }

        _ -> False
      }

    None -> False
  }
}
