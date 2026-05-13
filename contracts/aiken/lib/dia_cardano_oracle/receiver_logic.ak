use aiken/collection/list
use cardano/address.{Address, VerificationKey}
use cardano/assets
use cardano/transaction.{NoDatum, Output}

pub type ReceiverDatum {
  ReceiverDatum {
    balance_lovelace: Int,
    accrued_to_hook_lovelace: Int,
    min_utxo_lovelace: Int,
  }
}

pub type ReceiverRedeemer {
  TopUp
  AccrueFee
  Settle
  Withdraw { amount: Int, recipient: Address }
  /// Admin-only update of the min_utxo_lovelace field.
  /// Requires config signer authorization at the validator level.
  UpdateMinUtxo { new_min_utxo_lovelace: Int }
}

pub fn valid_receiver_state(datum: ReceiverDatum) -> Bool {
  and {
    datum.balance_lovelace >= 0,
    datum.accrued_to_hook_lovelace >= 0,
    datum.min_utxo_lovelace > 0,
  }
}

pub fn exact_locked_lovelace(output: Output, datum: ReceiverDatum) -> Bool {
  assets.lovelace_of(output.value) == datum.min_utxo_lovelace + datum.balance_lovelace + datum.accrued_to_hook_lovelace
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
    added_lovelace > 0,
    next.balance_lovelace == previous.balance_lovelace + added_lovelace,
    next.accrued_to_hook_lovelace == previous.accrued_to_hook_lovelace,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
  }
}

/// Instead of moving the protocol fee to the global PaymentHook
/// inside the update tx, the fee is debited from `balance_lovelace` and
/// credited to `accrued_to_hook_lovelace` on the same Receiver UTxO. The
/// physical lovelace at the UTxO does not change — the obligation moves
/// from the client's prepaid pool to a per-receiver pending-fees pool,
/// which is later flushed to the hook by a settle transaction.
pub fn accrue_fee_transition(
  previous: ReceiverDatum,
  next: ReceiverDatum,
  fee_lovelace: Int,
) -> Bool {
  and {
    fee_lovelace >= 0,
    fee_lovelace <= previous.balance_lovelace,
    next.balance_lovelace == previous.balance_lovelace - fee_lovelace,
    next.accrued_to_hook_lovelace == previous.accrued_to_hook_lovelace + fee_lovelace,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
  }
}

/// Drains the Receiver's pending-fees pool to zero. The lovelace decrease
/// at the UTxO level is enforced by `exact_locked_lovelace` on both
/// input and output (the diff equals `previous.accrued_to_hook_lovelace`).
/// `previous.accrued_to_hook_lovelace > 0` rejects no-op settlements,
/// which would otherwise let any party churn an idle receiver.
pub fn settle_transition(
  previous: ReceiverDatum,
  next: ReceiverDatum,
) -> Bool {
  and {
    previous.accrued_to_hook_lovelace > 0,
    next.accrued_to_hook_lovelace == 0,
    next.balance_lovelace == previous.balance_lovelace,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
  }
}

/// Admin-gated emergency withdraw of `amount` from the client's
/// `balance_lovelace`. The receiver's `accrued_to_hook_lovelace` MUST be
/// preserved so admin cannot drain pending protocol fees through this
/// path.
pub fn withdraw_transition(
  previous: ReceiverDatum,
  next: ReceiverDatum,
  amount: Int,
) -> Bool {
  and {
    amount > 0,
    amount <= previous.balance_lovelace,
    next.balance_lovelace == previous.balance_lovelace - amount,
    next.accrued_to_hook_lovelace == previous.accrued_to_hook_lovelace,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
  }
}

/// Admin-only transition to update the min_utxo_lovelace field.
/// All other fields must remain unchanged. The ADA at the UTxO must
/// be adjusted externally to match the new min_utxo requirement.
pub fn update_min_utxo_transition(
  previous: ReceiverDatum,
  next: ReceiverDatum,
  new_min_utxo_lovelace: Int,
) -> Bool {
  and {
    new_min_utxo_lovelace > 0,
    next.min_utxo_lovelace == new_min_utxo_lovelace,
    next.balance_lovelace == previous.balance_lovelace,
    next.accrued_to_hook_lovelace == previous.accrued_to_hook_lovelace,
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
      |> list.foldl(
          0,
          fn(output, acc) { acc + assets.lovelace_of(output.value) },
        )

  total_paid >= amount
}

pub fn sample_receiver() -> ReceiverDatum {
  ReceiverDatum {
    balance_lovelace: 10_000_000,
    accrued_to_hook_lovelace: 0,
    min_utxo_lovelace: 2_000_000,
  }
}

fn sample_address() -> Address {
  Address {
    payment_credential: VerificationKey(
      #"00000000000000000000000000000000000000000000000000000000",
    ),
    stake_credential: None,
  }
}

fn sample_output_for(datum: ReceiverDatum) -> Output {
  Output {
    address: sample_address(),
    value: assets.from_lovelace(
      datum.min_utxo_lovelace + datum.balance_lovelace + datum.accrued_to_hook_lovelace,
    ),
    datum: NoDatum,
    reference_script: None,
  }
}

test valid_receiver_state_accepts_positive_min_utxo_and_non_negative_balances() {
  valid_receiver_state(sample_receiver())
}

test valid_receiver_state_rejects_negative_balance() {
  !valid_receiver_state(
    ReceiverDatum { ..sample_receiver(), balance_lovelace: -1 },
  )
}

test valid_receiver_state_rejects_negative_accrued() {
  !valid_receiver_state(
    ReceiverDatum { ..sample_receiver(), accrued_to_hook_lovelace: -1 },
  )
}

test valid_receiver_state_rejects_negative_min_utxo() {
  !valid_receiver_state(
    ReceiverDatum { ..sample_receiver(), min_utxo_lovelace: -1 },
  )
}

test valid_receiver_state_rejects_zero_min_utxo() {
  !valid_receiver_state(
    ReceiverDatum { ..sample_receiver(), min_utxo_lovelace: 0 },
  )
}

test exact_locked_lovelace_includes_balance_and_accrued() {
  let datum =
    ReceiverDatum {
      balance_lovelace: 10_000_000,
      accrued_to_hook_lovelace: 4_000_000,
      min_utxo_lovelace: 2_000_000,
    }
  exact_locked_lovelace(sample_output_for(datum), datum)
}

test exact_locked_lovelace_rejects_missing_accrued() {
  let datum =
    ReceiverDatum {
      balance_lovelace: 10_000_000,
      accrued_to_hook_lovelace: 4_000_000,
      min_utxo_lovelace: 2_000_000,
    }
  let bad_output =
    Output {
      ..sample_output_for(datum),
      value: assets.from_lovelace(
        datum.min_utxo_lovelace + datum.balance_lovelace,
      ),
    }
  !exact_locked_lovelace(bad_output, datum)
}

test top_up_transition_accepts_strictly_positive_addition() {
  let previous = sample_receiver()
  let next =
    ReceiverDatum { ..previous, balance_lovelace: previous.balance_lovelace + 1_000_000 }

  top_up_transition(
    sample_output_for(previous),
    sample_output_for(next),
    previous,
    next,
  )
}

test top_up_transition_rejects_zero_addition() {
  // Vector 1.4 — must reject so a third party cannot churn the UTxO.
  let previous = sample_receiver()
  let next = previous

  !top_up_transition(
    sample_output_for(previous),
    sample_output_for(next),
    previous,
    next,
  )
}

test top_up_transition_rejects_accrued_mutation() {
  let previous = sample_receiver()
  let next =
    ReceiverDatum {
      ..previous,
      balance_lovelace: previous.balance_lovelace + 1_000_000,
      accrued_to_hook_lovelace: previous.accrued_to_hook_lovelace + 1,
    }

  !top_up_transition(
    sample_output_for(previous),
    sample_output_for(next),
    previous,
    next,
  )
}

test accrue_fee_transition_moves_fee_from_balance_to_accrued() {
  let previous = sample_receiver()
  let next =
    ReceiverDatum {
      ..previous,
      balance_lovelace: previous.balance_lovelace - 2_000_000,
      accrued_to_hook_lovelace: previous.accrued_to_hook_lovelace + 2_000_000,
    }

  accrue_fee_transition(previous, next, 2_000_000)
}

test accrue_fee_transition_rejects_fee_above_balance() {
  let previous = sample_receiver()
  let next =
    ReceiverDatum {
      ..previous,
      balance_lovelace: -1,
      accrued_to_hook_lovelace: previous.accrued_to_hook_lovelace + previous.balance_lovelace + 1,
    }

  !accrue_fee_transition(previous, next, previous.balance_lovelace + 1)
}

test accrue_fee_transition_rejects_balance_underflow() {
  let previous = sample_receiver()
  let next =
    ReceiverDatum {
      ..previous,
      balance_lovelace: previous.balance_lovelace - 2_000_000,
      // attacker tries to credit accrued by the wrong amount
      accrued_to_hook_lovelace: previous.accrued_to_hook_lovelace + 1_500_000,
    }

  !accrue_fee_transition(previous, next, 2_000_000)
}

test accrue_fee_transition_rejects_min_utxo_change() {
  let previous = sample_receiver()
  let next =
    ReceiverDatum {
      balance_lovelace: previous.balance_lovelace - 2_000_000,
      accrued_to_hook_lovelace: previous.accrued_to_hook_lovelace + 2_000_000,
      min_utxo_lovelace: previous.min_utxo_lovelace + 1,
    }

  !accrue_fee_transition(previous, next, 2_000_000)
}

test settle_transition_drains_accrued_to_zero() {
  let previous =
    ReceiverDatum { ..sample_receiver(), accrued_to_hook_lovelace: 5_000_000 }
  let next = ReceiverDatum { ..previous, accrued_to_hook_lovelace: 0 }

  settle_transition(previous, next)
}

test settle_transition_rejects_zero_accrued() {
  // No-op settle would let an attacker churn an idle receiver UTxO.
  let previous = sample_receiver()
  let next = previous
  !settle_transition(previous, next)
}

test settle_transition_rejects_balance_mutation() {
  let previous =
    ReceiverDatum { ..sample_receiver(), accrued_to_hook_lovelace: 5_000_000 }
  let next =
    ReceiverDatum {
      balance_lovelace: previous.balance_lovelace + 1,
      accrued_to_hook_lovelace: 0,
      min_utxo_lovelace: previous.min_utxo_lovelace,
    }

  !settle_transition(previous, next)
}

test settle_transition_rejects_partial_drain() {
  let previous =
    ReceiverDatum { ..sample_receiver(), accrued_to_hook_lovelace: 5_000_000 }
  let next = ReceiverDatum { ..previous, accrued_to_hook_lovelace: 1 }

  !settle_transition(previous, next)
}

test withdraw_transition_decrements_balance() {
  let previous = sample_receiver()
  let next =
    ReceiverDatum { ..previous, balance_lovelace: previous.balance_lovelace - 3_000_000 }

  withdraw_transition(previous, next, 3_000_000)
}

test withdraw_transition_rejects_zero_amount() {
  // Withdraw of zero would let admin churn the UTxO at no benefit.
  let previous = sample_receiver()
  !withdraw_transition(previous, previous, 0)
}

test withdraw_transition_rejects_amount_above_balance() {
  let previous = sample_receiver()
  let next = ReceiverDatum { ..previous, balance_lovelace: -1 }
  !withdraw_transition(previous, next, previous.balance_lovelace + 1)
}

test withdraw_transition_rejects_accrued_drain() {
  // Critical: admin MUST NOT be able to take pending protocol fees out
  // through the client withdraw path. If `accrued_to_hook` shrinks,
  // the transition is rejected.
  let previous =
    ReceiverDatum { ..sample_receiver(), accrued_to_hook_lovelace: 5_000_000 }
  let next =
    ReceiverDatum {
      balance_lovelace: previous.balance_lovelace - 1_000_000,
      accrued_to_hook_lovelace: previous.accrued_to_hook_lovelace - 1_000_000,
      min_utxo_lovelace: previous.min_utxo_lovelace,
    }

  !withdraw_transition(previous, next, 1_000_000)
}

// --- UpdateMinUtxo transition tests ---

test update_min_utxo_transition_accepts_valid_update() {
  let previous = sample_receiver()
  let next =
    ReceiverDatum { ..previous, min_utxo_lovelace: 3_000_000 }

  update_min_utxo_transition(previous, next, 3_000_000)
}

test update_min_utxo_transition_rejects_zero() {
  let previous = sample_receiver()
  !update_min_utxo_transition(previous, previous, 0)
}

test update_min_utxo_transition_rejects_negative() {
  let previous = sample_receiver()
  let next = ReceiverDatum { ..previous, min_utxo_lovelace: -1 }
  !update_min_utxo_transition(previous, next, -1)
}

test update_min_utxo_transition_rejects_balance_change() {
  // Balance must remain unchanged during min_utxo update
  let previous = sample_receiver()
  let next =
    ReceiverDatum {
      ..previous,
      min_utxo_lovelace: 3_000_000,
      balance_lovelace: previous.balance_lovelace - 1_000_000,
    }

  !update_min_utxo_transition(previous, next, 3_000_000)
}

test update_min_utxo_transition_rejects_accrued_change() {
  // Accrued fees must remain unchanged during min_utxo update
  let previous =
    ReceiverDatum { ..sample_receiver(), accrued_to_hook_lovelace: 1_000_000 }
  let next =
    ReceiverDatum {
      ..previous,
      min_utxo_lovelace: 3_000_000,
      accrued_to_hook_lovelace: 0,
    }

  !update_min_utxo_transition(previous, next, 3_000_000)
}
