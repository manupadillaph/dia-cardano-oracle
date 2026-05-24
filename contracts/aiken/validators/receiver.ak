use aiken/collection/dict
use aiken/collection/list
use aiken/fuzz
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Redeemer, Transaction, Withdraw,
  placeholder,
}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/coordinator_logic.{
  ApplyBatch, ApplySettle, CoordinatorRedeemer, SettleManifest, SettleReceiver,
  IntentForReceiverAccrue, IntentForReceiverSettle, coordinator_intent_matches,
}
use dia_cardano_oracle/oracle_logic
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

        // The protocol fee is moved from `balance_lovelace` to
        // `accrued_to_hook_lovelace` on the same UTxO. The actual lovelace
        // does not move out of the Receiver until a settlement tx flushes
        // accrued to the global PaymentHook. Per the coordinator-witness
        // pattern, this spend only does the local invariant
        // check and defers cross-UTxO arithmetic to the coordinator.
        receiver_logic.AccrueFee -> {
          expect Some(config_input) =
            find_visible_config_input(self, config_policy_id, config_asset_name)
          expect InlineDatum(config_datum_data) = config_input.output.datum
          expect config_datum: config_logic.ConfigDatum = config_datum_data

          and {
            config_logic.valid_config_state(config_datum),
            coordinator_intent_matches(
              self,
              config_datum,
              IntentForReceiverAccrue {
                receiver_policy_id: own_policy_id,
                receiver_asset_name: expected_asset_name,
              },
            ),
            receiver_logic.accrue_fee_transition(
              current_datum,
              next_datum,
              current_datum.balance_lovelace - next_datum.balance_lovelace,
            ),
          }
        }

        // Drains pending fees to zero on this Receiver. Coordinator
        // verifies that the lovelace decrease here is summed into the
        // PaymentHook delta in the same tx. Local check only.
        receiver_logic.Settle -> {
          expect Some(config_input) =
            find_visible_config_input(self, config_policy_id, config_asset_name)
          expect InlineDatum(config_datum_data) = config_input.output.datum
          expect config_datum: config_logic.ConfigDatum = config_datum_data

          and {
            config_logic.valid_config_state(config_datum),
            coordinator_intent_matches(
              self,
              config_datum,
              IntentForReceiverSettle {
                receiver_policy_id: own_policy_id,
                receiver_asset_name: expected_asset_name,
              },
            ),
            receiver_logic.settle_transition(current_datum, next_datum),
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

        // Admin-only update of min_utxo_lovelace. Requires config signer.
        receiver_logic.UpdateMinUtxo { new_min_utxo_lovelace } -> {
          expect Some(config_input) =
            find_visible_config_input(self, config_policy_id, config_asset_name)
          expect InlineDatum(config_datum_data) = config_input.output.datum
          expect config_datum: config_logic.ConfigDatum = config_datum_data

          and {
            config_logic.valid_config_state(config_datum),
            config_logic.has_config_signer(config_datum, self),
            receiver_logic.update_min_utxo_transition(
              current_datum,
              next_datum,
              new_min_utxo_lovelace,
            ),
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

// ---------------------------------------------------------------------------
// Benchmarks
//
// These benches intentionally target the hot spend branches that currently
// decode the full coordinator redeemer. They give us a stable baseline before
// fee-oriented refactors of receiver/coordinator binding.

const bench_bootstrap_ref: OutputReference =
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: 0,
  }

const bench_receiver_ref: OutputReference =
  OutputReference {
    transaction_id: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    output_index: 0,
  }

const bench_config_ref: OutputReference =
  OutputReference {
    transaction_id: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    output_index: 0,
  }

const bench_config_policy: PolicyId =
  #"cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00"

const bench_config_asset: AssetName =
  #"4449415f434f4e464947"

const bench_receiver_policy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const bench_receiver_asset: AssetName =
  #"4449415f5245434549564552"

const bench_pair_policy: PolicyId =
  #"11111111111111111111111111111111111111111111111111111111"

const bench_coord_credential =
  Script(#"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd")

const bench_signer_public_key: ByteArray =
  #"03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807"

const bench_signature: ByteArray =
  #"7e3ab9c6c59f1997f007063e96120ab198bb4129875e49b4f48298c533771d0e6266a261ea108343a4ed02a6823ab3602bcdedd4b891226c2f452b4a158ac1011b"

type ReceiverSpendBenchCase {
  ReceiverSpendBenchCase {
    own_ref: OutputReference,
    current_datum: receiver_logic.ReceiverDatum,
    tx: Transaction,
  }
}

fn bench_config_datum() -> config_logic.ConfigDatum {
  config_logic.ConfigDatum {
    ..config_logic.sample_config(),
    payment_hook_ref: Some(
      config_logic.PaymentHookRef {
        policy_id: #"abababababababababababababababababababababababababababab",
        asset_name: #"484f4f4b",
      },
    ),
    update_coordinator_credential: Some(bench_coord_credential),
  }
}

fn bench_receiver_output(datum: receiver_logic.ReceiverDatum) -> Output {
  Output {
    address: address.from_script(bench_receiver_policy),
    value:
      assets.add(
        assets.from_lovelace(
          datum.min_utxo_lovelace + datum.balance_lovelace + datum.accrued_to_hook_lovelace,
        ),
        bench_receiver_policy,
        bench_receiver_asset,
        1,
      ),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn bench_receiver_input(
  own_ref: OutputReference,
  datum: receiver_logic.ReceiverDatum,
) -> Input {
  Input { output_reference: own_ref, output: bench_receiver_output(datum) }
}

fn bench_config_input() -> Input {
  Input {
    output_reference: bench_config_ref,
    output: Output {
      address: address.from_script(
        #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      ),
      value: assets.from_asset(bench_config_policy, bench_config_asset, 1),
      datum: InlineDatum(bench_config_datum()),
      reference_script: None,
    },
  }
}

fn bench_witness() -> oracle_logic.UpdateWitness {
  let symbol = #"555344432f555344"
  oracle_logic.UpdateWitness {
    receiver_policy_id: bench_receiver_policy,
    receiver_asset_name: bench_receiver_asset,
    pair_policy_id: bench_pair_policy,
    pair_token_name: oracle_logic.pair_asset_name(symbol),
    intent: oracle_logic.OracleIntent {
      intent_type: #"4f7261636c65557064617465",
      version: #"312e30",
      chain_id: 100640,
      nonce: 1760960522308165264,
      expiry: 1760964122,
      symbol,
      price: 99992561,
      timestamp: 1760960522,
      source: #"444941204f7261636c65",
      signature: bench_signature,
      signer: #"f64d333c19b007519c7b9316680ed26578f98c08",
    },
    signer_public_key: bench_signer_public_key,
  }
}

fn repeat_batch_witnesses(count: Int) -> List<oracle_logic.UpdateWitness> {
  if count <= 0 {
    []
  } else {
    [bench_witness(), ..repeat_batch_witnesses(count - 1)]
  }
}

fn bench_settle_receivers_before_own(count: Int) -> List<SettleReceiver> {
  if count <= 1 {
    [
      SettleReceiver {
        receiver_policy_id: bench_receiver_policy,
        receiver_asset_name: bench_receiver_asset,
      },
    ]
  } else {
    let tail = bench_settle_receivers_before_own(count - 1)
    [
      SettleReceiver {
        receiver_policy_id: #"99999999999999999999999999999999999999999999999999999999",
        receiver_asset_name: #"4449415f52454345495645525f4f54484552",
      },
      ..tail
    ]
  }
}

fn receiver_accrue_fee_bench_case(count: Int) -> ReceiverSpendBenchCase {
  let current =
    receiver_logic.ReceiverDatum {
      balance_lovelace: 10_000_000,
      accrued_to_hook_lovelace: 0,
      min_utxo_lovelace: 2_000_000,
    }
  let next =
    receiver_logic.ReceiverDatum {
      balance_lovelace: 9_100_000,
      accrued_to_hook_lovelace: 900_000,
      min_utxo_lovelace: 2_000_000,
    }
  let coord_redeemer: CoordinatorRedeemer =
    ApplyBatch(repeat_batch_witnesses(count))
  let payload: Redeemer = coord_redeemer

  ReceiverSpendBenchCase {
    own_ref: bench_receiver_ref,
    current_datum: current,
    tx: Transaction {
      ..placeholder,
      inputs: [bench_receiver_input(bench_receiver_ref, current)],
      reference_inputs: [bench_config_input()],
      outputs: [bench_receiver_output(next)],
      redeemers: [Pair(Withdraw(bench_coord_credential), payload)],
    },
  }
}

fn receiver_settle_bench_case(count: Int) -> ReceiverSpendBenchCase {
  let current =
    receiver_logic.ReceiverDatum {
      balance_lovelace: 10_000_000,
      accrued_to_hook_lovelace: 2_000_000,
      min_utxo_lovelace: 2_000_000,
    }
  let next =
    receiver_logic.ReceiverDatum {
      balance_lovelace: 10_000_000,
      accrued_to_hook_lovelace: 0,
      min_utxo_lovelace: 2_000_000,
    }
  let coord_redeemer: CoordinatorRedeemer =
    ApplySettle(
      SettleManifest { receivers: bench_settle_receivers_before_own(count) },
    )
  let payload: Redeemer = coord_redeemer

  ReceiverSpendBenchCase {
    own_ref: bench_receiver_ref,
    current_datum: current,
    tx: Transaction {
      ..placeholder,
      inputs: [bench_receiver_input(bench_receiver_ref, current)],
      reference_inputs: [bench_config_input()],
      outputs: [bench_receiver_output(next)],
      redeemers: [Pair(Withdraw(bench_coord_credential), payload)],
    },
  }
}

fn sample_receiver_accrue_fee_case(size: Int) -> Fuzzer<ReceiverSpendBenchCase> {
  fuzz.constant(receiver_accrue_fee_bench_case(size + 1))
}

fn sample_receiver_settle_case(size: Int) -> Fuzzer<ReceiverSpendBenchCase> {
  fuzz.constant(receiver_settle_bench_case(size + 1))
}

bench receiver_spend_accrue_fee_decodes_batch_redeemer(
  bench_case via sample_receiver_accrue_fee_case,
) {
  receiver.spend(
    bench_bootstrap_ref,
    bench_receiver_asset,
    bench_config_policy,
    bench_config_asset,
    Some(bench_case.current_datum),
    receiver_logic.AccrueFee,
    bench_case.own_ref,
    bench_case.tx,
  )
}

bench receiver_spend_settle_scans_manifest(
  bench_case via sample_receiver_settle_case,
) {
  receiver.spend(
    bench_bootstrap_ref,
    bench_receiver_asset,
    bench_config_policy,
    bench_config_asset,
    Some(bench_case.current_datum),
    receiver_logic.Settle,
    bench_case.own_ref,
    bench_case.tx,
  )
}
