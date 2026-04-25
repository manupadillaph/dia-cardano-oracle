use aiken/collection/list
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{Output}

pub type ReceiverDatum {
  ReceiverDatum {
    balance_lovelace: Int,
    min_utxo_lovelace: Int,
  }
}

pub type ReceiverRedeemer {
  TopUp
  PayFee
  Withdraw { amount: Int, recipient: Address }
}

pub fn valid_receiver_state(datum: ReceiverDatum) -> Bool {
  and {
    datum.balance_lovelace >= 0,
    datum.min_utxo_lovelace >= 0,
  }
}

pub fn exact_locked_lovelace(output: Output, datum: ReceiverDatum) -> Bool {
  assets.lovelace_of(output.value) ==
    datum.min_utxo_lovelace + datum.balance_lovelace
}

pub fn top_up_transition(
  previous_output: Output,
  next_output: Output,
  previous: ReceiverDatum,
  next: ReceiverDatum,
) -> Bool {
  let previous_lovelace = assets.lovelace_of(previous_output.value)
  let next_lovelace = assets.lovelace_of(next_output.value)
  let added_lovelace = next_lovelace - previous_lovelace

  and {
    added_lovelace >= 0,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
    next.balance_lovelace == previous.balance_lovelace + added_lovelace,
  }
}

pub fn pay_fee_transition(
  previous: ReceiverDatum,
  next: ReceiverDatum,
  fee_lovelace: Int,
) -> Bool {
  and {
    fee_lovelace >= 0,
    fee_lovelace <= previous.balance_lovelace,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
    next.balance_lovelace == previous.balance_lovelace - fee_lovelace,
  }
}

pub fn withdraw_transition(
  previous: ReceiverDatum,
  next: ReceiverDatum,
  amount: Int,
) -> Bool {
  and {
    amount >= 0,
    amount <= previous.balance_lovelace,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
    next.balance_lovelace == previous.balance_lovelace - amount,
  }
}

pub fn paid_to_recipient(
  outputs: List<Output>,
  recipient: Address,
  amount: Int,
) -> Bool {
  let total_paid =
    outputs
      |> list.filter(fn(output) { output.address == recipient })
      |> list.foldl(0, fn(output, acc) { acc + assets.lovelace_of(output.value) })

  total_paid >= amount
}

pub fn sample_receiver() -> ReceiverDatum {
  ReceiverDatum {
    balance_lovelace: 10_000_000,
    min_utxo_lovelace: 2_000_000,
  }
}

test valid_receiver_state_accepts_non_negative_values() {
  valid_receiver_state(sample_receiver())
}

test pay_fee_transition_decrements_balance() {
  pay_fee_transition(
    sample_receiver(),
    ReceiverDatum {
      balance_lovelace: 8_000_000,
      min_utxo_lovelace: sample_receiver().min_utxo_lovelace,
    },
    2_000_000,
  )
}

test pay_fee_transition_rejects_wrong_fee_amount() {
  !pay_fee_transition(
    sample_receiver(),
    ReceiverDatum {
      balance_lovelace: 8_500_000,
      min_utxo_lovelace: sample_receiver().min_utxo_lovelace,
    },
    2_000_000,
  )
}

test pay_fee_transition_rejects_balance_underflow() {
  !pay_fee_transition(
    sample_receiver(),
    ReceiverDatum {
      balance_lovelace: -1,
      min_utxo_lovelace: sample_receiver().min_utxo_lovelace,
    },
    10_000_001,
  )
}
