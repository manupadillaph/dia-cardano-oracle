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

## Live verification of the DIA endpoints

Before assuming the configuration above is current, we tested both RPC
endpoints directly. Some details do not match what is documented.

**Both servers are alive and respond.** The mainnet endpoint identifies
itself as chain `1050`, which matches the table. The testnet endpoint
identifies itself as chain `10050`, **not** `100640` as listed above. These
are two different numbers for the same testnet, and it matters because every
signed intent embeds that number in its signature; signer and verifier must
use the same value or signature checks will fail.

**The two testnet registry addresses listed above are not in use, but they
are real DIA-published addresses.** Both come from the public
`diadata-org/Spectra-interoperability` repository, where they are explicitly
labeled as `OracleIntentRegistry` for testnet chain `100640`:

- `0xC1ca83b5df6ce7e21Fb462C86f0C90E182d6db5d` is documented in
  [`state.md`](https://github.com/diadata-org/Spectra-interoperability/blob/fa4292db7330b8595a1b4709ae4c0df9138fece9/state.md)
  as the `OracleIntentRegistry` deployment, and is used as `oracle_registry`
  for chain `100640` ("DIA Testnet") in
  [`services/hyperlane-monitor/config/config.json`](https://github.com/diadata-org/Spectra-interoperability/blob/fa4292db7330b8595a1b4709ae4c0df9138fece9/services/hyperlane-monitor/config/config.json).
- `0xd2313dcabB0E9447d800546b953E05dD47EB2eB9` is used as the
  `Registry.Address` in
  [`services/attestor/test/integration_test.go`](https://github.com/diadata-org/Spectra-interoperability/blob/fa4292db7330b8595a1b4709ae4c0df9138fece9/services/attestor/test/integration_test.go)
  against `https://testnet-rpc.diadata.org`, and is hardcoded as the
  `OracleIntentRegistry` constant for chain id `100640` in
  [`services/hyperlane-monitor/internal/blockchain/decoder.go`](https://github.com/diadata-org/Spectra-interoperability/blob/fa4292db7330b8595a1b4709ae4c0df9138fece9/services/hyperlane-monitor/internal/blockchain/decoder.go).

So DIA's own repository contains **two different addresses, both labeled
`OracleIntentRegistry`, for the same testnet chain `100640`**. This is an
internal inconsistency in the Spectra repository itself, not a discrepancy
we introduced. Neither address has any contract code on
`https://testnet-rpc.diadata.org` today.

**A third contract is live and active on testnet, and we cannot trace it
back to any public DIA source.** The address
`0xf8c614a483a0427a13512f52ac72a576678be317` does have deployed bytecode on
the testnet RPC and is currently emitting `IntentRegistered` events. We
verified in step 9 below that calling `getIntent(bytes32)` on it returns
fully decoded `OracleIntent` structs, so it implements the same interface
DIA documents. The example transaction the requirement document itself
offers as the reference for retrieving an intent
(`0x82af92bdfb51bc1049cf832b1d85f219b033aea6c1cc38cd1857872c0a3cea55`, via
`testnet-explorer.diadata.org/tx/...`) is also no longer available: both
the testnet RPC and the testnet explorer return "not found" for that hash.
DIA needs to confirm whether this address is the current
`OracleIntentRegistry` and document it somewhere public.

**The chain id reported by the live RPC differs from what DIA's own
configuration files state.** DIA's `config.json`, integration test, and
chain decoder all say `https://testnet-rpc.diadata.org` is chain
`100640`. The same RPC, queried today (step 2 below), returns chain id
`10050`. Live `OracleIntent` structs returned by `getIntent` (step 9
below) sign with `sourceChainId = 10050`. So the discrepancy is not
between our code and DIA — it is between **DIA's own published
configuration and DIA's own live RPC**. Our M1 fixtures and Config datum
were generated against the documented value (`100640`), so they would have
to be regenerated with `10050` before our Cardano contracts can validate
signatures from the live DIA testnet.

**Mainnet has no DIA registry deployed yet.** None of the addresses we know
about — neither the Spectra examples nor the contract that is alive on
testnet — has any code at the same address on mainnet. Until DIA deploys
the mainnet registry, the feeder cannot run end-to-end against mainnet.

### Commands used to verify this

These are the exact requests we ran against the live RPCs to produce the
findings above. They can be re-run by anyone with `curl` and an internet
connection. Hex results are annotated with their decimal value where useful.

**1. Mainnet RPC is alive, reports chain id `1050`, current block ~23M.**

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  https://rpc.diadata.org/
# => {"jsonrpc":"2.0","result":"0x41a","id":1}        (0x41a = 1050)

curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  https://rpc.diadata.org/
# => {"jsonrpc":"2.0","result":"0x15ee0d6","id":1}    (~22,995,158)
```

**2. Testnet RPC is alive, reports chain id `10050` (not `100640`), current block ~2.46M.**

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  https://testnet-rpc.diadata.org
# => {"jsonrpc":"2.0","result":"0x2742","id":1}       (0x2742 = 10050)

curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  https://testnet-rpc.diadata.org
# => {"jsonrpc":"2.0","result":"0x25a5ed","id":1}     (~2,467,309)
```

**3. Both RPCs are fully synced.**

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_syncing","params":[],"id":1}' \
  https://rpc.diadata.org/
# => {"jsonrpc":"2.0","result":false,"id":1}

curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_syncing","params":[],"id":1}' \
  https://testnet-rpc.diadata.org
# => {"jsonrpc":"2.0","result":false,"id":1}
```

**4. The two registry addresses listed in the Spectra config are empty on testnet.**

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0xC1ca83b5df6ce7e21Fb462C86f0C90E182d6db5d","latest"],"id":1}' \
  https://testnet-rpc.diadata.org
# => {"jsonrpc":"2.0","result":"0x","id":1}           (no contract at this address)

curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0xd2313dcabB0E9447d800546b953E05dD47EB2eB9","latest"],"id":1}' \
  https://testnet-rpc.diadata.org
# => {"jsonrpc":"2.0","result":"0x","id":1}           (no contract at this address)
```

**5. The Milestone 1 fixture verifying contract is alive on testnet (real bytecode returned).**

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0xf8c614a483a0427a13512f52ac72a576678be317","latest"],"id":1}' \
  https://testnet-rpc.diadata.org
# => {"jsonrpc":"2.0","result":"0x60806040526004361015...","id":1}  (long bytecode)
```

**6. The same address has no contract on mainnet.**

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0xf8c614a483a0427a13512f52ac72a576678be317","latest"],"id":1}' \
  https://rpc.diadata.org/
# => {"jsonrpc":"2.0","result":"0x","id":1}           (no contract at this address)
```

**7. Reading recent events from the live testnet contract — confirms HTTP polling works.**

```sh
# fromBlock = roughly the last ~2000 blocks before "latest"; adjust as needed.
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getLogs","params":[{"fromBlock":"0x259f0b","toBlock":"latest","address":"0xf8c614a483a0427a13512f52ac72a576678be317"}],"id":1}' \
  https://testnet-rpc.diadata.org
# => {"jsonrpc":"2.0","result":[ { ...real event entry... }, ... ],"id":1}
```

**8. WebSocket endpoint exists but rejects unauthenticated connections.**

```sh
curl -i -s \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://rpc.diadata.org/ws
# => HTTP/2 401   (the /ws endpoint exists; credentials are required to subscribe)
```

**9. Fetching a full intent by its hash (`getIntent(bytes32)`).**

The `OracleIntentRegistry` exposes a view function `getIntent(bytes32)` that
returns the full signed intent for a given intent hash (the same value the
event indexes as `topic1` of `IntentRegistered`). The 4-byte function
selector is the first four bytes of `keccak256("getIntent(bytes32)")`:

```sh
node -e "console.log(require('ethers').id('getIntent(bytes32)').slice(0, 10))"
# => 0xf13c46aa
```

The `eth_call` request concatenates that selector with the 32-byte intent
hash. Using a real hash observed in the testnet logs above
(`0x813ba9ea1b439f755ac2bf104cd854afa47c4ca6f5019647ee07746b8b2f2ff6`):

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xf8c614a483a0427a13512f52ac72a576678be317","data":"0xf13c46aa813ba9ea1b439f755ac2bf104cd854afa47c4ca6f5019647ee07746b8b2f2ff6"},"latest"],"id":1}' \
  https://testnet-rpc.diadata.org
# => {"jsonrpc":"2.0","result":"0x0000...long ABI-encoded struct...","id":1}
```

The returned bytes are an ABI-encoded `OracleIntent` struct. Decoded with
`ethers`:

```sh
export DATA=$(curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xf8c614a483a0427a13512f52ac72a576678be317","data":"0xf13c46aa813ba9ea1b439f755ac2bf104cd854afa47c4ca6f5019647ee07746b8b2f2ff6"},"latest"],"id":1}' \
  https://testnet-rpc.diadata.org | jq -r '.result')
 
node -e "
const { AbiCoder } = require('ethers');
const [intent] = AbiCoder.defaultAbiCoder().decode(
  ['tuple(string intentType, string version, uint256 sourceChainId, uint256 price, uint256 expiry, string symbol, uint256 nonce, uint256 timestamp, string source, bytes signature, address signer)'],
  process.env.DATA
);
console.log(intent);
"
```

For the example hash above, the decoded fields are:

| Field | Value |
| --- | --- |
| intentType | `OracleUpdate` |
| version | `1.0` |
| sourceChainId | `10050` |
| price | `1777292303280293532` |
| expiry | `1777365980` (unix seconds) |
| symbol | `XVG/USD` |
| nonce | `3286397304062500` |
| timestamp | `1777362380` (unix seconds) |
| source | `DIA Oracle` |
| signature | `0xda599e61…1b` (65 bytes) |
| signer | `0xf64D333c19B007519C7B9316680ED26578f98C08` |

This confirms the registry interface advertised in the Spectra docs is the
one in use (`IntentRegistered` event + `getIntent(bytes32)` view), and it
also confirms that live DIA testnet intents are being signed with
`sourceChainId = 10050`.

### How events can be read

There are two ways to read intents from the registry:

- **Polling over HTTP.** The feeder asks the RPC every few seconds for new
  events in the recent block range. This is verified working today against
  the live testnet contract, with no special access required. It is enough
  to run the feeder.
- **Real-time subscription over WebSocket.** The RPC exposes a WebSocket
  endpoint at `/ws`, but unauthenticated connections are rejected. If
  real-time delivery is desired instead of polling, DIA needs to provide
  credentials.

The feeder will start with polling. Real-time subscription is an
optimization that can be added later if DIA grants access.

### Open questions for DIA

Before the feeder targets mainnet, the following items need confirmation
from DIA:

1. **Testnet chain id mismatch inside DIA's own infra**: DIA's published
   configuration files
   ([`config.json`](https://github.com/diadata-org/Spectra-interoperability/blob/fa4292db7330b8595a1b4709ae4c0df9138fece9/services/hyperlane-monitor/config/config.json),
   [`integration_test.go`](https://github.com/diadata-org/Spectra-interoperability/blob/fa4292db7330b8595a1b4709ae4c0df9138fece9/services/attestor/test/integration_test.go),
   [`decoder.go`](https://github.com/diadata-org/Spectra-interoperability/blob/fa4292db7330b8595a1b4709ae4c0df9138fece9/services/hyperlane-monitor/internal/blockchain/decoder.go))
   all state that `https://testnet-rpc.diadata.org` is chain `100640`. The
   same RPC live today returns `10050`, and live signed intents use
   `sourceChainId = 10050`. Please confirm which value is authoritative,
   and update the corresponding Spectra files (or the RPC) so they agree.
2. **Two different `OracleIntentRegistry` addresses inside DIA's own repo**:
   `state.md` and the hyperlane-monitor config use
   `0xC1ca83b5df6ce7e21Fb462C86f0C90E182d6db5d`; the attestor integration
   test and the decoder use `0xd2313dcabB0E9447d800546b953E05dD47EB2eB9`.
   Neither has code on the live testnet RPC. Please confirm the canonical
   testnet `OracleIntentRegistry` address.
3. **Provenance of `0xf8c614a483a0427a13512f52ac72a576678be317`**: this is
   the only address that is actually live on testnet and implements the
   expected interface, yet it does not appear in any public DIA repository
   or documentation, and the example transaction DIA itself referenced as
   the way to retrieve an intent (testnet tx `0x82af92bd…`) is no longer
   available on either the RPC or the explorer. Please confirm whether
   this address is the current testnet `OracleIntentRegistry`, who
   deployed it, and where it should be documented going forward so future
   readers do not have to rediscover it from chain data.
4. **Mainnet registry**: has the registry been deployed on mainnet? If not,
   when, and at what address?
5. **Real-time access**: are credentials available for the WebSocket
   endpoint, or is HTTP polling the only supported access path?
6. **Authorized signer set**: please confirm that
   `0xf64D333c19B007519C7B9316680ED26578f98C08` (the `signer` returned by
   the example `getIntent` call) is an authorized DIA signer on testnet,
   and share the full authorized signer set we should configure on the
   Cardano `Config` for both testnet and mainnet.
7. **Change notification**: how will DIA communicate future changes to
   chain ids, registry addresses, or authorized signer sets, so the feeder
   does not run against stale values?

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
