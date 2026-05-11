Generated Preview/Mainnet state artifacts live here while running the CLI.

Do not commit generated protocol, client, pair, intent, batch, or build-only
JSON files. They are environment-specific outputs created by the operator CLI.

## Layout

```
state/
  <network>/                   e.g. preview/
    config-bootstrap.json      Protocol artifact: Config, Coordinator, PaymentHook, ReferenceHolder scripts + state
    clients/<client-id>/       Per-client artifacts:
      client.json              Client artifact (Receiver/Pair scripts, draft data)
      pairs/<pair-slug>.json   Per-pair artifacts (Pair NFT, latest datum)
    intents/                   Generated unsigned/signed DIA intent JSON
    batches/                   Generated batch update manifests
```

## Protocol artifact (`config-bootstrap.json`) — `scripts` block

The `scripts` field in the protocol artifact stores all derived script
identifiers. Fields follow the same grouping order as the setup sequence
(Config → Coordinator → ReferenceHolder → PaymentHook):

| Field | Set by | Notes |
| --- | --- | --- |
| `configPolicyId` | `preview:config:parameterize` | Config NFT minting policy id |
| `configUnit` | `preview:config:parameterize` | `policyId + assetName` unit |
| `configValidatorHash` | `preview:config:parameterize` | Config spend validator hash |
| `configValidatorAddress` | `preview:config:parameterize` | Config spend validator address |
| `coordinatorHash` | `preview:config:parameterize` | Coordinator stake validator hash |
| `coordinatorRewardAddress` | `preview:config:parameterize` | Coordinator withdrawal/reward address |
| `referenceHolderValidatorHash` | `preview:config:parameterize` | ReferenceHolder spend validator hash |
| `referenceHolderAddress` | `preview:config:parameterize` | Address where reference-script UTxOs are parked |
| `paymentHookPolicyId` | `preview:payment-hook:parameterize` | PaymentHook NFT minting policy id |
| `paymentHookUnit` | `preview:payment-hook:parameterize` | `policyId + assetName` unit |
| `paymentHookValidatorHash` | `preview:payment-hook:parameterize` | PaymentHook spend validator hash |
| `paymentHookValidatorAddress` | `preview:payment-hook:parameterize` | PaymentHook spend validator address |

All fields are `string` with `""` as the initial value before their
corresponding parameterize step runs. Config/Coordinator/ReferenceHolder
fields are set together by `preview:config:parameterize`. PaymentHook
fields are set by `preview:payment-hook:parameterize`. A non-empty value
means the script has been parameterized; an empty string means it has not.

## Protocol artifact — `compiledScripts` block

Stores the hex-encoded compiled (parameterized) script binary for every
validator and minting policy. Written once by the corresponding parameterize
command and read by every subsequent deploy and transaction command. No
downstream module recompiles these from scratch — it reads from this block
or throws.

| Field | Set by | Used as |
| --- | --- | --- |
| `configMintPolicy` | `preview:config:parameterize` | One-shot mint; attached inline to Config bootstrap tx |
| `configValidator` | `preview:config:parameterize` | Spend validator; published at `referenceScripts.global.config` |
| `coordinatorValidator` | `preview:config:parameterize` | Withdrawal validator; published at `referenceScripts.global.coordinator` |
| `referenceHolderValidator` | `preview:config:parameterize` | Spend validator for the `reference_holder` address itself |
| `paymentHookMintPolicy` | `preview:payment-hook:parameterize` | One-shot mint; attached inline to PaymentHook bootstrap tx |
| `paymentHookValidator` | `preview:payment-hook:parameterize` | Spend validator; published at `referenceScripts.global.paymentHook` |

Client artifact (`client.json`) stores an equivalent `compiledScripts` block:

| Field | Set by | Used as |
| --- | --- | --- |
| `receiverMintPolicy` | `preview:receiver:parameterize` | One-shot mint; attached inline to Receiver bootstrap tx |
| `receiverValidator` | `preview:receiver:parameterize` | Spend validator; published at `referenceScripts.client.receiver` |
| `pairMintPolicy` | `preview:receiver:parameterize` | Mint policy; attached **inline** to every update tx that creates a new pair (not published as a reference script) |
| `pairValidator` | `preview:receiver:parameterize` | Spend validator; published at `referenceScripts.client.pair` |

## Protocol artifact — `referenceScripts` block

Tracks the on-chain outRef (`txHash`, `outputIndex`) and `scriptHash` of each
published reference-script UTxO at the `reference_holder` address. These
outRefs are cited in transaction commands so validators do not need to be
embedded inline.

| `--script` value | What's at that UTxO | Published by | Output index |
| --- | --- | --- | --- |
| `config` | `config_state` spend validator | `preview:config:reference-scripts` | 0 |
| `coordinator` | `update_coordinator` withdrawal validator | `preview:config:reference-scripts` | 1 |
| `payment-hook` | `payment_hook` spend validator | `preview:payment-hook:reference-script` | 0 |
| `receiver` *(per client)* | `receiver` spend validator | `preview:reference-scripts:publish-client` | 0 |
| `pair` *(per client)* | `pair_state` spend validator | `preview:reference-scripts:publish-client` | 1 |
| `pairMint` *(per client)* | `pair_state` minting policy | `preview:reference-scripts:publish-client` | 2 |

Note: **config and coordinator are published in the same transaction** by
`preview:config:reference-scripts` (output 0 and output 1 respectively).
**receiver, pair, and pairMint are published in the same transaction** by
`preview:reference-scripts:publish-client` (outputs 0, 1, and 2 respectively).

Reclaim names match publish commands exactly — if a publish command puts N UTxOs,
its reclaim name spends those same N UTxOs in one transaction:

| `--script` value | UTxOs reclaimed | Clears entries |
| --- | --- | --- |
| `config` | global.config + global.coordinator (2 UTxOs) | `referenceScripts.global.config`, `.coordinator` |
| `payment-hook` | global.paymentHook (1 UTxO) | `referenceScripts.global.paymentHook` |
| `client` | client.receiver + client.pair + client.pairMint (3 UTxOs) | `referenceScripts.client.*` |

After `preview:reclaim-reference-script --script <name>`, the corresponding
entries are cleared to `{ txHash: "", outputIndex: 0, scriptHash: "" }` in the
artifact. If an update or settle transaction is submitted while a reference
UTxO is absent, the validator falls back to inline attachment automatically.

## Receiver state fields

The per-client `client.json` stores the off-chain mirror of the on-chain
`ReceiverDatum` under `receiver.receiverState`:

| Field | Type | Meaning (mirrors the on-chain datum) |
| --- | --- | --- |
| `balanceLovelace` | string (lovelace) | Client-prepaid pool, top-up adds here, `Withdraw` removes from here |
| `accruedToHookLovelace` | string (lovelace) | Per-update protocol fees that have been moved out of `balanceLovelace` and are waiting to be batched into the global PaymentHook by a `Settle` transaction |
| `minUtxoLovelace` | string (lovelace) | Locked min-UTxO floor; never moves |

Invariant (must match the on-chain check `exact_locked_lovelace`):

```
ReceiverUTxO.lovelace == minUtxoLovelace + balanceLovelace + accruedToHookLovelace
```

`accruedToHookLovelace` is increased by every `AccrueFee` redeemer using
the configured fee formula `baseFeeLovelace + N × perPairFeeLovelace`,
where `N = 1` for a single update and `N` is the batch size for batch
updates. It is drained back to `0` by every `Settle` redeemer. The
`Withdraw` redeemer cannot touch this field — it only moves lovelace out
of `balanceLovelace`.
