# Milestone 2 Feeder Strategy

This note explains the proposed Cardano feeder for Milestone 2, using the same
high-level pattern already present in DIA's Spectra services.

## The short version

We are not building the part of DIA that discovers prices.

For Cardano, we are building the destination side:

1. DIA produces or exposes a signed price update.
2. Our feeder reads that signed update.
3. Our feeder builds a Cardano transaction.
4. The Cardano validator verifies the DIA signature.
5. The Pair UTxO is updated with the latest price.

The important idea is this: the feeder does not make the price true. DIA's
signature makes the price authoritative. The feeder is only the delivery
mechanism that brings that signed message onto Cardano.

## Names translated

### Lumina

Lumina is DIA's newer oracle system.

Think of Lumina as the full factory that produces oracle data:

- some nodes collect raw market data;
- DIA aggregates/checks that data;
- final values become available from DIA infrastructure;
- those values can then be delivered to other chains.

For us, Lumina matters because it is the source side of the data. We do not
need to re-create Lumina in Cardano.

### Lasernet

Lasernet is DIA's own EVM-compatible chain/rollup.

Think of it as DIA's internal/public data chain where Lumina data lives. DIA
feeders submit data there, and DIA contracts aggregate it there.

For us, Lasernet matters because the signed Cardano updates may come from a
contract or service connected to Lasernet.

### Feeder

This word is confusing because it can mean two different things.

In DIA/Lumina docs, a feeder is a source-side process that collects market data
from exchanges and sends it into DIA.

In our Milestone 2, "feeder" means a Cardano updater service. It does not fetch
raw exchange prices. It reads DIA-approved updates and submits Cardano
transactions.

So the M2 feeder is closer to a bridge/relayer than a price-discovery engine.

### Spectra

Spectra is DIA's cross-chain delivery layer.

Think of Lumina as the factory, Lasernet as the DIA data chain, and Spectra as
the delivery truck that carries oracle data from DIA to other blockchains.

On EVM chains, Spectra uses Hyperlane-style messaging. Cardano does not need to
implement Hyperlane inside Aiken for this requirement. The requirement
explicitly excludes Hyperlane-specific receiver features such as mailbox and
ISM.

For us, Spectra matters because the reference contracts come from that world,
especially `PushOracleReceiverV2`.

### OracleIntent

An OracleIntent is the key payload.

It is a signed message that says, in effect:

```text
For symbol BTC/USD,
the price is 123456789,
the timestamp is T,
the nonce is N,
and this was signed by an authorized DIA signer.
```

The exact fields in the DIA Solidity reference are:

- intent type;
- version;
- source chain id;
- nonce;
- expiry;
- symbol;
- price;
- timestamp;
- source;
- signature;
- signer.

Our Cardano contract verifies the same idea: the update is accepted only if the
signature matches an authorized DIA signer and the update is newer than the
previous one.

### OracleIntentRegistry

This is the source-chain registry for signed intents.

Think of it as a public bulletin board where DIA-signed price messages can be
registered or emitted.

Our feeder should read production intents from this registry path: scan
`IntentRegistered` events, then fetch the full intent by `intentHash` with the
registry view method.

### PushOracleReceiverV2

This is the EVM receiver contract used as the reference.

It can receive oracle updates and store the latest value by pair. It has logic
for:

- authorized signers;
- EIP-712 signature verification;
- stale update rejection;
- replay protection;
- batch updates;
- protocol fee handling.

Our Cardano scripts are the Cardano-native equivalent of this behavior, but
implemented with UTxOs instead of EVM storage.

### ProtocolFeeHook

This is the EVM fee collection helper.

In Cardano, our `payment_hook` plays the same conceptual role: each successful
update pays the configured protocol fee into the hook state.

## How a price reaches Cardano

The intended M2 path is:

```text
DIA Lumina / Lasernet
  -> OracleIntentRegistry emits IntentRegistered
  -> Cardano feeder
  -> Cardano transaction
  -> update_coordinator validates the update
  -> Pair UTxO stores latest price
  -> dApp/indexer reads latest value
```

The feeder does not decide whether the price is correct. That belongs to
Lumina/DIA. The feeder also does not create DIA's source-side oracle cadence.

In the Spectra reference stack, cadence belongs to the DIA `attestor`: it has
configured symbols and a configured polling interval, signs intents, and
publishes them to `OracleIntentRegistry`. The bridge side is event-driven: it
scans or subscribes to registry events and forwards the intents that already
exist.

For Cardano, the same split should apply:

- DIA/source side decides which symbols are attested and how often intents are
  produced.
- Cardano feeder watches the registry and forwards matching intents to Cardano.
- Cardano feeder may still have an allowlist/mapping so one Cardano deployment
  only forwards the pairs that belong to that receiver/client.

Important: the `OracleIntent` is not client-specific. It is a DIA-signed price
message for a symbol. The client/destination is chosen by bridge configuration.

In the Spectra bridge this is handled by routers:

- router trigger: which event to listen to, for example `IntentRegistered`;
- router condition: which symbols or fields match this route;
- router destination: which destination chain and receiver contract should get
  the update;
- destination policy: optional time threshold and/or price deviation threshold.

For Cardano, the equivalent router entry should say:

```text
when an IntentRegistered event arrives
and the full intent symbol is BTC/USD
send it to Cardano receiver/client X
using the Cardano update transaction builder
only if the Cardano freshness/threshold policy allows it
```

So the Cardano updater learns the client from its own routing config, not from
the DIA intent itself.

Example Cardano route:

```yaml
routes:
  - id: btc_usd_preview_demo
    trigger_event: IntentRegistered
    symbol: BTC/USD
    client: preview-demo
    receiver: <cardano receiver/client id>
    min_interval: 1h
    price_deviation: 0.5%
```

This means: when `BTC/USD` intents appear in the registry, the Cardano feeder
may forward them to the configured Cardano receiver, but only when the
destination policy allows it.

The scanner itself should run faster than the most demanding destination route.
For example, if the fastest client route allows updates every 30 seconds, the
scanner should check much more frequently than that, or subscribe by WebSocket.
The scanner is the radar; the route policy decides whether to actually submit a
Cardano transaction.

## What we already have from Milestone 1

Milestone 1 already gives the feeder the destination it needs:

- Aiken validators for Config, Receiver, Pair, PaymentHook, and Coordinator.
- EIP-712/secp256k1 verification against authorized DIA signers.
- stale/replay protection through timestamp, nonce, and intent hash.
- single update transaction flow.
- batch update transaction flow.
- CLI code that can build the Cardano transactions.

That means M2 should not start from zero. The feeder should reuse or wrap the
existing transaction-building logic.

## What M2 should build

M2 should build an operator service around the existing CLI/transaction logic.

Minimum useful shape:

| Piece | What it does |
|---|---|
| Source reader | Scans or subscribes to `IntentRegistered` logs from `OracleIntentRegistry` and fetches the full signed intent by hash. |
| Pair/router mapping | Maps registry symbols to the Cardano receiver/client that should receive them. This is not price discovery; it is routing. |
| Update policy | Skips stale intents, avoids resubmitting the same intent hash, groups safe batches, retries failed transactions. |
| Cardano submitter | Builds and submits the Cardano transaction using the DIA-operated updater wallet. |
| Logger | Writes reproducible logs: pair, price, timestamp, nonce, intent hash, tx hash, fee, status, error if any. |
| Health command | Shows wallet balance, latest submitted update, latest on-chain Pair datum, and stale/failure status. |

For local tests and reviewer evidence, the same source-reader interface can be
backed by recorded `OracleIntent` fixtures. That is a testing convenience, not
the production data path.

## Existing DIA/Spectra config pattern

The existing services already show the config split:

| Existing service | What it configures |
|---|---|
| `services/attestor` | `ATTESTOR_ATTESTOR_SYMBOLS`, `ATTESTOR_ATTESTOR_POLLING_TIME`, batch mode, source oracle address, registry address, signer key. This service creates and publishes signed intents. |
| `services/bridge` | source chain RPC/WebSocket, start block, event scanner interval, retry/worker settings, routers, destinations, destination contract/method mapping, optional per-destination time/deviation thresholds. This service routes existing intents to receivers. |

So the Cardano feeder should behave like a Cardano destination bridge, not like
a DIA source attestor.

## Existing Spectra inspiration

The proposal above is based on the current structure in
`diadata-org/Spectra-interoperability`:

| Reference path | Relevant behavior |
|---|---|
| `services/attestor/pkg/config/config.go` | Defines symbols, polling interval, batch mode, source oracle address, registry address, signer key, and guardian parameters. |
| `services/attestor/pkg/service/attestor.go` | Reads oracle values, signs intents, and publishes them to the registry. |
| `services/attestor/pkg/intent/intent.go` | Builds the EIP-712 `OracleIntent` payload and signature. |
| `services/bridge/internal/scanner/block_scanner_enhanced.go` | Scans blocks and also attempts WebSocket subscription for real-time events. |
| `services/bridge/internal/contracts/registry.go` | Defines the `IntentRegistered` event and `getIntent(bytes32)` view used to retrieve the full intent. |
| `services/bridge/internal/pipeline/enricher.go` | Enriches an event by calling a view method, such as fetching the full intent from the registry. |
| `services/bridge/pkg/router/generic_router.go` | Routes events by trigger conditions, destination mappings, time thresholds, and price-deviation thresholds. |
| `services/bridge/internal/processor/generic_event_processor.go` | Connects scanner, enrichment, router decisions, destination config, and transaction submission. |

The Cardano-specific change is the final submit step. In Spectra/EVM, the
bridge routes to a destination contract method such as `handleIntentUpdate`.
For Cardano, the route should call the Cardano transaction builder that updates
the matching Pair UTxO.

## Practical implementation order

1. Extract or expose the current CLI update/build logic so a long-running
   service can call it without copy-pasting transaction code.
2. Implement registry scanning/subscription for `IntentRegistered`, plus
   `getIntent(intentHash)` enrichment.
3. Add a fixture-backed source only for automated tests and reproducible
   reviewer evidence.
4. Implement Cardano receiver/client routing and stale/retry policy.
5. Submit live Preview transactions using the DIA-operated updater wallet.
6. Add structured logs and evidence packaging for reviewers.

## DIA source configuration

The architecture is clear: signed intents come from the DIA
`OracleIntentRegistry` path used by Spectra. The bridge does not discover this
at runtime; it is configured with the source network, RPC endpoint, registry
address, and start block.

Known public values from DIA/Spectra references:

| Environment | Source chain | RPC |
|---|---:|---|
| DIA Lasernet mainnet | `1050` | `https://rpc.diadata.org/` |
| DIA Lasernet testnet | `100640` | `https://testnet-rpc.diadata.org` |

The Spectra configs also show testnet registry examples such as:

- `0xC1ca83b5df6ce7e21Fb462C86f0C90E182d6db5d`
- `0xd2313dcabB0E9447d800546b953E05dD47EB2eB9`

Those are useful references, but the Cardano feeder should use the registry
address selected for the Cardano deployment environment.

The expected registry interface is:

- `IntentRegistered(bytes32 indexed intentHash, string indexed symbol, uint256 price, uint256 timestamp, address signer)`
- `getIntent(bytes32 intentHash)`

The EIP-712 domain values should match the same registry used as the source,
because the `OracleIntent` signature is bound to the registry domain.

Everything else can move forward against the registry interface, with fixtures
used only for tests and reproducible evidence.

## Cardano destination concerns

The source-side picture is clear: registry, scanner, enricher, router. The
destination side adds concerns that the operator CLI did not have to solve,
because the CLI was designed for one interactive command at a time. A
long-running service has to handle these explicitly.

The items below are recorded as open problems. The intent of this section is
to make them visible, not to prescribe a solution.

### Updater wallet key management

The feeder signs Cardano transactions continuously with the updater wallet.

Today the CLI reads the signing key from `.env` (`CARDANO_WALLET_SEED` or
`CARDANO_PRIVATE_KEY`). That is fine for Preview and interactive use. For a
long-running service, how the updater key is provisioned and protected at
runtime needs to be defined.

Open: how the daemon obtains and holds the updater signing key.

### UTxO contention

This is the most important destination-side issue and may also affect the
Milestone 1 mainnet flow, not only Milestone 2.

The CLI is interactive: one update at a time, sequentially, each command
re-reading chain state before building the next transaction. A daemon can have
many intents in flight, and that exposes a structural property of the current
contract layout:

- The Pair UTxOs are not the bottleneck. Each subscribed pair has its own Pair
  UTxO, so updates to BTC/USD and ETH/USD do not contend with each other on
  the Pair side.
- The Receiver UTxO is shared across all pairs of a client. Every update for
  any pair of that client consumes the same Receiver UTxO.
- The PaymentHook UTxO is global. Every update of every client consumes the
  same PaymentHook UTxO.

So two updates submitted in parallel for the same client cannot both succeed:
the second transaction cites a Receiver input that the first one already
spent, and is rejected. Across clients, the same collision can still happen
on the PaymentHook UTxO.

The existing `ApplyBatch` path is the natural Cardano-friendly response for
the per-client case (one tx per client per submission window, batching all
pending intents for that client). The cross-client PaymentHook contention is
a separate problem that batching per-client does not solve on its own.

Open: how the daemon serializes/batches submissions so concurrent intents do
not destroy each other on the Receiver and PaymentHook UTxOs, and whether the
contract layout needs an adjustment to relax the global PaymentHook
bottleneck.

### Finality and tx-in-flight tracking

Cardano blocks are ~20 seconds. After submitting a transaction, the feeder
cannot immediately reuse the new Receiver and PaymentHook outputs from its
local copy: the next tx must reference an output that is actually confirmed in
a block.

A daemon needs to:

- Detect confirmation of submitted transactions before reusing their outputs.
- Avoid double-submitting the same intent across restarts.
- Decide what to do when a submitted transaction does not confirm within a
  budget (rebuild from current chain tip vs retry).

Open: the confirmation mechanism, the persistence model for in-flight state,
and the timeout/rebuild policy.

### Operator surface

The CLI exposes one-shot commands. A long-running service needs a different
operator surface: liveness/readiness signals, metrics, structured logs, and a
control to pause or drain submission without losing in-flight state.

The "Health command" row in the M2 table above should be read as this
operator surface, not as a one-shot CLI command.

Open: what is exposed (health endpoints, metrics, controls) and through which
transport.
