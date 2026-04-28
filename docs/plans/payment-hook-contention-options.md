# PaymentHook Contention: Design Options

This document explains a structural concern we found while finishing the milestone 1 implementation.

## Why this is a Cardano-specific problem

On EVM, a single transaction calls `handleIntentUpdate` and that one
transaction does everything atomically: it verifies the signature, debits the
client's prepaid balance, credits the protocol fee hook, and writes the new
price into storage. Two transactions for two different clients can run in
parallel inside the same block because the EVM serializes state at execution
time and conflicts are resolved by gas/state ordering. There is no shared
"slot" that both transactions must consume.

Cardano's eUTxO model is different. Every piece of mutable state lives inside
a UTxO. A transaction must explicitly consume the current UTxO it wants to
modify and produce a new UTxO that replaces it. Once a transaction is
submitted referencing a given UTxO, no other transaction can reference the
same UTxO until the first one either confirms or is dropped. Two transactions
that both need to update the same UTxO cannot run in parallel: one of them
will be rejected.

This is normally fine because most state in Cardano is per-asset (per pair,
per client, etc.). It becomes a bottleneck when one piece of state is shared
by every transaction in the system.

## Where the bottleneck is in our design

The current Milestone 1 contract layout has:

- One Pair UTxO per (client, pair). These are not a bottleneck because each
  pair has its own UTxO.
- One Receiver UTxO per client. Updates to different pairs of the same client
  contend on the same Receiver UTxO. This is already addressed by the
  existing `ApplyBatch` flow: a single transaction batches all of a client's
  pair updates and consumes the Receiver UTxO once.
- **One global PaymentHook UTxO**. Every successful update — for any client,
  for any pair — also consumes and recreates this single UTxO so the protocol
  fee can be added to its accrued balance.

The third item is the real problem. It means **at most one update
transaction can be in flight at any moment in the entire system, regardless
of how many clients we have**. If client A and client B both have intents
ready, only one of them can submit; the other has to wait for the first to
confirm before it can build its transaction against the new PaymentHook UTxO.

On EVM this would not exist as a problem. Two clients calling
`handleIntentUpdate` in the same block both touch the same `ProtocolFeeHook`
storage slot, but the EVM resolves that at execution time and both
transactions can land. On Cardano, the global PaymentHook UTxO is a hard
serialization point.

## Options

### Option A — One PaymentHook per client

Make the PaymentHook a per-client contract instead of a global one. Each
client gets their own PaymentHook UTxO, bootstrapped together with their
Receiver during onboarding.

- Pros:
  - Cross-client parallelism is fully solved. Client A and client B never
    touch the same UTxO.
  - Smallest conceptual change: it mirrors the per-client structure already
    used by the Receiver.
- Cons:
  - On-chain footprint grows linearly with clients (one extra UTxO per
    client).
  - Fee withdrawal becomes a per-client operation. DIA admins have to
    withdraw fees from N hooks instead of one.
  - Slightly diverges from the EVM reference, which has one global
    `ProtocolFeeHook`.

### Option B — Sharded PaymentHooks (N global hooks)

Keep the hook global but create N parallel hook UTxOs. The feeder picks any
free hook UTxO when submitting a transaction.

- Pros:
  - Allows up to N concurrent transactions globally without per-client
    coupling.
- Cons:
  - The validator has to authorize "any of N hooks", which requires either N
    distinct identifying NFTs or a more elaborate identity scheme.
  - Reconciling totals (`accrued_fees`, `lifetime_collected`,
    `lifetime_withdrawn`) across shards is awkward.
  - Withdrawing all collected fees in a single operation requires a
    coordinator validator that aggregates the N hooks atomically.
  - Does not actually scale. If N = 4, the fifth concurrent transaction still
    has to wait.
  - Highest implementation complexity for the smallest structural benefit.

### Option C — Decouple the fee transfer from the update transaction

Today the update transaction does three things atomically: verifies the DIA
signed intent, debits the client's Receiver, and credits the global
PaymentHook. On EVM this is the natural shape because all three live in the
same call. On Cardano we can split the third part into a separate transaction
without losing any guarantee.

How it would work:

- The update transaction only touches the Receiver and the Pair UTxOs (and
  reads Config as a reference input). It does **not** touch the PaymentHook.
- The Receiver datum gets a new field: `accrued_to_hook_lovelace`. On every
  update the transaction records:
  - `balance_lovelace -= fee`
  - `accrued_to_hook_lovelace += fee`
  - The lovelace physically held by the Receiver UTxO does not move yet; the
    fee is owed but still inside the Receiver.
- A new low-frequency maintenance transaction, "fee settlement", moves the
  accumulated fees from one or more Receivers to the global PaymentHook and
  resets `accrued_to_hook_lovelace` to zero on each Receiver consumed.

Pros:

- Cross-client parallelism is fully solved. The update transaction no longer
  touches any global UTxO.
- The update transaction becomes smaller and slightly cheaper because one
  fewer script is consumed per update.
- The PaymentHook keeps its current global identity and withdrawal flow; the
  only operational change is that fees arrive in batches via settlement
  transactions rather than one fee at a time.
- Same-client serialization on the Receiver still exists, but the existing
  `ApplyBatch` flow already handles that.

Cons:

- Diverges from the EVM "everything in one transaction" shape. The fee
  accounting becomes a two-step process on-chain: accrue inside the Receiver
  on each update, then settle to the PaymentHook periodically. On EVM there
  is no equivalent of this split because EVM does not have the underlying
  contention problem.
- The Receiver datum and invariant change. The Receiver's actual lovelace
  becomes `min_utxo + balance + accrued_to_hook`.
- The coordinator validator has to be reworked to remove the PaymentHook
  legs from the update tx and to add the new settlement tx.
- It is a breaking contract change relative to Milestone 1. Re-deployment of
  the on-chain contracts is required.

## Recommendation

We recommend **Option C**.

It is the only option that fully removes the global serialization point
without limiting parallelism to a fixed shard count, and it makes the update
transaction simpler rather than more complex. Option A is a viable fallback
if the rework cost of Option C is judged too high. Option B we would
discourage: it is the most invasive option and gives the smallest structural
improvement.

The split Option C introduces (accrue on update, settle later) is not the
shape EVM uses, but EVM does not face this contention because of how its
state model works. On Cardano, separating the fee transfer from the price
update is the cleanest way to express the same intent — accept a signed
price and charge the protocol fee — without forcing every update in the
system through one shared piece of state.
