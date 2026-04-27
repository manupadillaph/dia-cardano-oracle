use aiken/collection/list
use cardano/address.{Address, VerificationKey}
use cardano/assets
use cardano/transaction.{Output}

pub type PaymentHookDatum {
  PaymentHookDatum {
    withdraw_address: Address,
    accrued_fees_lovelace: Int,
    lifetime_collected_lovelace: Int,
    lifetime_withdrawn_lovelace: Int,
    min_utxo_lovelace: Int,
  }
}

pub type PaymentHookRedeemer {
  ApplyFee
  AdminUpdate
  Withdraw { amount: Int }
}

pub fn valid_payment_hook_state(datum: PaymentHookDatum) -> Bool {
  and {
    datum.accrued_fees_lovelace >= 0,
    datum.lifetime_collected_lovelace >= 0,
    datum.lifetime_withdrawn_lovelace >= 0,
    datum.min_utxo_lovelace >= 0,
  }
}

pub fn exact_locked_lovelace(output: Output, datum: PaymentHookDatum) -> Bool {
  assets.lovelace_of(output.value) == datum.min_utxo_lovelace + datum.accrued_fees_lovelace
}

pub fn admin_update_transition(
  previous: PaymentHookDatum,
  next: PaymentHookDatum,
) -> Bool {
  and {
    next.accrued_fees_lovelace == previous.accrued_fees_lovelace,
    next.lifetime_collected_lovelace == previous.lifetime_collected_lovelace,
    next.lifetime_withdrawn_lovelace == previous.lifetime_withdrawn_lovelace,
  }
}

pub fn fee_charge_transition(
  previous: PaymentHookDatum,
  next: PaymentHookDatum,
  amount: Int,
) -> Bool {
  and {
    amount >= 0,
    next.withdraw_address == previous.withdraw_address,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
    next.accrued_fees_lovelace == previous.accrued_fees_lovelace + amount,
    next.lifetime_collected_lovelace == previous.lifetime_collected_lovelace + amount,
    next.lifetime_withdrawn_lovelace == previous.lifetime_withdrawn_lovelace,
  }
}

pub fn withdraw_transition(
  previous: PaymentHookDatum,
  next: PaymentHookDatum,
  amount: Int,
) -> Bool {
  and {
    amount >= 0,
    amount <= previous.accrued_fees_lovelace,
    next.withdraw_address == previous.withdraw_address,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
    next.accrued_fees_lovelace == previous.accrued_fees_lovelace - amount,
    next.lifetime_collected_lovelace == previous.lifetime_collected_lovelace,
    next.lifetime_withdrawn_lovelace == previous.lifetime_withdrawn_lovelace + amount,
  }
}

pub fn withdraw_paid_to_target(
  outputs: List<Output>,
  withdraw_address: Address,
  amount: Int,
) -> Bool {
  let total_paid =
    outputs
      |> list.filter(fn(output) { output.address == withdraw_address })
      |> list.foldl(
          0,
          fn(output, acc) { acc + assets.lovelace_of(output.value) },
        )

  total_paid >= amount
}

test valid_payment_hook_state_accepts_non_negative_values() {
  valid_payment_hook_state(sample_payment_hook())
}

test fee_charge_transition_increments_balances() {
  fee_charge_transition(
    sample_payment_hook(),
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      accrued_fees_lovelace: sample_payment_hook().accrued_fees_lovelace + 2_000_000,
      lifetime_collected_lovelace: sample_payment_hook().lifetime_collected_lovelace + 2_000_000,
      lifetime_withdrawn_lovelace: sample_payment_hook().lifetime_withdrawn_lovelace,
      min_utxo_lovelace: sample_payment_hook().min_utxo_lovelace,
    },
    2_000_000,
  )
}

test withdraw_transition_decrements_accrued_balance() {
  withdraw_transition(
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      accrued_fees_lovelace: 10_000_000,
      lifetime_collected_lovelace: 20_000_000,
      lifetime_withdrawn_lovelace: 5_000_000,
      min_utxo_lovelace: sample_payment_hook().min_utxo_lovelace,
    },
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      accrued_fees_lovelace: 7_000_000,
      lifetime_collected_lovelace: 20_000_000,
      lifetime_withdrawn_lovelace: 8_000_000,
      min_utxo_lovelace: sample_payment_hook().min_utxo_lovelace,
    },
    3_000_000,
  )
}

test fee_charge_transition_rejects_wrong_fee_amount() {
  !fee_charge_transition(
    sample_payment_hook(),
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      accrued_fees_lovelace: 1_500_000,
      lifetime_collected_lovelace: 1_500_000,
      lifetime_withdrawn_lovelace: sample_payment_hook().lifetime_withdrawn_lovelace,
      min_utxo_lovelace: sample_payment_hook().min_utxo_lovelace,
    },
    2_000_000,
  )
}

test withdraw_transition_rejects_above_accrued_fees() {
  !withdraw_transition(
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      accrued_fees_lovelace: 2_000_000,
      lifetime_collected_lovelace: 5_000_000,
      lifetime_withdrawn_lovelace: 1_000_000,
      min_utxo_lovelace: sample_payment_hook().min_utxo_lovelace,
    },
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      accrued_fees_lovelace: -1_000_000,
      lifetime_collected_lovelace: 5_000_000,
      lifetime_withdrawn_lovelace: 4_000_000,
      min_utxo_lovelace: sample_payment_hook().min_utxo_lovelace,
    },
    3_000_000,
  )
}

pub fn sample_payment_hook() -> PaymentHookDatum {
  PaymentHookDatum {
    withdraw_address: sample_address(),
    accrued_fees_lovelace: 0,
    lifetime_collected_lovelace: 0,
    lifetime_withdrawn_lovelace: 0,
    min_utxo_lovelace: 2_000_000,
  }
}

fn sample_address() -> Address {
  Address {
    payment_credential: VerificationKey(
      #"11111111111111111111111111111111111111111111111111111111",
    ),
    stake_credential: None,
  }
}
