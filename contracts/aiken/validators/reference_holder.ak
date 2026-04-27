use cardano/transaction.{OutputReference, Transaction}

validator reference_holder {
  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    _own_ref: OutputReference,
    _self: Transaction,
  ) {
    False
  }

  else(_) {
    False
  }
}
