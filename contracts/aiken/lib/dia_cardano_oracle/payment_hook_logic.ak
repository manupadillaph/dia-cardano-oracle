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
  ApplySettle
  AdminUpdate
  Withdraw { amount: Int }
}

pub fn valid_payment_hook_state(datum: PaymentHookDatum) -> Bool {
  and {
    datum.accrued_fees_lovelace >= 0,
    datum.lifetime_collected_lovelace >= 0,
    datum.lifetime_withdrawn_lovelace >= 0,
    datum.min_utxo_lovelace > 0,
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

/// When one or more Receivers are settled in a single tx, this
/// transition records the lump-sum delta on the global PaymentHook. The
/// `delta` parameter is the sum of `accrued_to_hook_lovelace` values
/// drained from the consumed Receivers. The coordinator validates that
/// the sum equals the hook's accrued increase, so this transition only
/// has to express the local hook invariants.
pub fn apply_settle_transition(
  previous: PaymentHookDatum,
  next: PaymentHookDatum,
  delta: Int,
) -> Bool {
  and {
    delta > 0,
    next.withdraw_address == previous.withdraw_address,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
    next.accrued_fees_lovelace == previous.accrued_fees_lovelace + delta,
    next.lifetime_collected_lovelace == previous.lifetime_collected_lovelace + delta,
    next.lifetime_withdrawn_lovelace == previous.lifetime_withdrawn_lovelace,
  }
}

pub fn withdraw_transition(
  previous: PaymentHookDatum,
  next: PaymentHookDatum,
  amount: Int,
) -> Bool {
  and {
    amount > 0,
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

test valid_payment_hook_state_accepts_positive_min_utxo_and_non_negative_counters() {
  valid_payment_hook_state(sample_payment_hook())
}

test apply_settle_transition_increments_balances() {
  apply_settle_transition(
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

test apply_settle_transition_rejects_zero_delta() {
  // No-op settles must be rejected so attackers cannot churn the hook.
  !apply_settle_transition(
    sample_payment_hook(),
    sample_payment_hook(),
    0,
  )
}

test apply_settle_transition_rejects_lifetime_collected_mismatch() {
  !apply_settle_transition(
    sample_payment_hook(),
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      accrued_fees_lovelace: sample_payment_hook().accrued_fees_lovelace + 2_000_000,
      lifetime_collected_lovelace: sample_payment_hook().lifetime_collected_lovelace + 1_999_999,
      lifetime_withdrawn_lovelace: sample_payment_hook().lifetime_withdrawn_lovelace,
      min_utxo_lovelace: sample_payment_hook().min_utxo_lovelace,
    },
    2_000_000,
  )
}

test apply_settle_transition_rejects_lifetime_withdrawn_mutation() {
  !apply_settle_transition(
    sample_payment_hook(),
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      accrued_fees_lovelace: sample_payment_hook().accrued_fees_lovelace + 2_000_000,
      lifetime_collected_lovelace: sample_payment_hook().lifetime_collected_lovelace + 2_000_000,
      lifetime_withdrawn_lovelace: sample_payment_hook().lifetime_withdrawn_lovelace + 1,
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

test withdraw_transition_rejects_zero_amount() {
  !withdraw_transition(sample_payment_hook(), sample_payment_hook(), 0)
}

test apply_settle_transition_rejects_wrong_delta() {
  !apply_settle_transition(
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

test valid_payment_hook_state_rejects_negative_accrued() {
  !valid_payment_hook_state(
    PaymentHookDatum { ..sample_payment_hook(), accrued_fees_lovelace: -1 },
  )
}

test valid_payment_hook_state_rejects_negative_lifetime_collected() {
  !valid_payment_hook_state(
    PaymentHookDatum {
      ..sample_payment_hook(),
      lifetime_collected_lovelace: -1,
    },
  )
}

test valid_payment_hook_state_rejects_negative_lifetime_withdrawn() {
  !valid_payment_hook_state(
    PaymentHookDatum {
      ..sample_payment_hook(),
      lifetime_withdrawn_lovelace: -1,
    },
  )
}

test valid_payment_hook_state_rejects_negative_min_utxo() {
  !valid_payment_hook_state(
    PaymentHookDatum { ..sample_payment_hook(), min_utxo_lovelace: -1 },
  )
}

test valid_payment_hook_state_rejects_zero_min_utxo() {
  !valid_payment_hook_state(
    PaymentHookDatum { ..sample_payment_hook(), min_utxo_lovelace: 0 },
  )
}

test withdraw_transition_rejects_accrued_not_decremented_by_amount() {
  // amount = 1_000_000 but next.accrued only drops by 500_000.
  let prev =
    PaymentHookDatum {
      ..sample_payment_hook(),
      accrued_fees_lovelace: 5_000_000,
      lifetime_collected_lovelace: 10_000_000,
      lifetime_withdrawn_lovelace: 0,
    }
  let next =
    PaymentHookDatum {
      ..prev,
      accrued_fees_lovelace: 4_500_000,
      lifetime_withdrawn_lovelace: 1_000_000,
    }
  !withdraw_transition(prev, next, 1_000_000)
}

test withdraw_transition_rejects_lifetime_withdrawn_not_incremented() {
  // lifetime_withdrawn must increase by amount; here it stays unchanged.
  let prev =
    PaymentHookDatum {
      ..sample_payment_hook(),
      accrued_fees_lovelace: 5_000_000,
      lifetime_collected_lovelace: 10_000_000,
      lifetime_withdrawn_lovelace: 0,
    }
  let next =
    PaymentHookDatum {
      ..prev,
      accrued_fees_lovelace: 4_000_000,
      lifetime_withdrawn_lovelace: 0,
    }
  !withdraw_transition(prev, next, 1_000_000)
}

test admin_update_transition_accepts_withdraw_address_rotation() {
  let prev = sample_payment_hook()
  let other_address =
    Address {
      payment_credential: VerificationKey(
        #"22222222222222222222222222222222222222222222222222222222",
      ),
      stake_credential: None,
    }
  admin_update_transition(
    prev,
    PaymentHookDatum { ..prev, withdraw_address: other_address },
  )
}

test admin_update_transition_rejects_accrued_change() {
  let prev =
    PaymentHookDatum {
      ..sample_payment_hook(),
      accrued_fees_lovelace: 5_000_000,
    }
  !admin_update_transition(
    prev,
    PaymentHookDatum { ..prev, accrued_fees_lovelace: 5_000_001 },
  )
}

test admin_update_transition_rejects_lifetime_collected_change() {
  let prev =
    PaymentHookDatum {
      ..sample_payment_hook(),
      lifetime_collected_lovelace: 5_000_000,
    }
  !admin_update_transition(
    prev,
    PaymentHookDatum { ..prev, lifetime_collected_lovelace: 5_000_001 },
  )
}

test admin_update_transition_rejects_lifetime_withdrawn_change() {
  let prev =
    PaymentHookDatum {
      ..sample_payment_hook(),
      lifetime_withdrawn_lovelace: 5_000_000,
    }
  !admin_update_transition(
    prev,
    PaymentHookDatum { ..prev, lifetime_withdrawn_lovelace: 5_000_001 },
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
