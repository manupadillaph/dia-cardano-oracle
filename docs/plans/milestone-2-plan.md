# Milestone 2 Implementation Plan

Operational task breakdown for Milestone 2 (Data Feeder and Documentation).

This is the executable checklist. The conceptual reference (why and how) lives
in [`milestone-2-feeder-strategy.md`](./milestone-2-feeder-strategy.md). The
Catalyst milestone text lives in
[`../milestones/final-cardano-milestones.md`](../milestones/final-cardano-milestones.md)
(Milestone 2). The cross-workstream view lives in [`work-plan.md`](./work-plan.md)
(Workstream C).

## Scope

Build and operate a Cardano-side feeder service that:

- reads DIA-signed `OracleIntent` payloads from `OracleIntentRegistry` on
  DIA Lasernet (testnet then mainnet),
- routes each intent to the corresponding Cardano client receiver,
- builds and submits the matching Cardano oracle update transaction,
- captures verifiable evidence (tx hashes, logs, QA dashboards) for the
  Catalyst milestone.

## Canonical endpoints

The DIA endpoints below were confirmed by DIA on 2026-05-20. Full context and
re-runnable verification commands are in
[`milestone-2-feeder-strategy.md` § DIA source configuration](./milestone-2-feeder-strategy.md#dia-source-configuration).

| Environment | Source chain ID | RPC | `OracleIntentRegistry` |
| --- | ---: | --- | --- |
| **DIA Mainnet** | `1050` | `https://rpc.diadata.org` | `0x5612599CF48032d7428399d5Fcb99eDcc75c06A7` |
| **DIA Testnet** | `10050` | `https://testnet-rpc.diadata.org` | `0xF8c614A483A0427A13512F52ac72A576678bE317` |

The Cardano `Config` datum's `domain.source_chain_id` and
`domain.verifying_contract` MUST match whichever DIA environment the feeder
is consuming, because `OracleIntent` signatures are bound to those values.

## Open dependencies on DIA

These items must be answered before the corresponding phase can start. They
are tracked as "Open questions for DIA" in
[`milestone-2-feeder-strategy.md`](./milestone-2-feeder-strategy.md#open-questions-for-dia).

- [x] **D1 — Authorized signer set.** Resolved 2026-05-21 by recovering
  signer public keys directly from live `IntentRegistered` events via
  EIP-712 signature recovery. Keys documented in
  [`milestone-2-feeder-strategy.md` § Authorized signer sets](./milestone-2-feeder-strategy.md#authorized-signer-sets-resolved-2026-05-21).
  DIA confirmation of completeness pending (message sent 2026-05-21);
  **Phase 1 can proceed** with the observed sets.
- [x] **D2 — WebSocket credentials (optional).** Resolved 2026-05-21. DIA's
  RPC is hosted on Conduit; the API key is passed as the URL path (no `/ws`
  suffix, no header, no query string). Confirmed working:
  `wss://testnet-rpc.diadata.org/<credential>` (chain id `0x2742`) and
  `wss://rpc.diadata.org/<credential>` (chain id `0x41a`). Credentials are
  loaded from `.env` as `DIA_WS_CREDENTIAL_TESTNET` /
  `DIA_WS_CREDENTIAL_MAINNET` (see Annex A). See
  [feeder-strategy § open question 2](./milestone-2-feeder-strategy.md#open-questions-for-dia)
  and probe script
  [`offchain/cli/scripts/tools/probe-dia-ws.ts`](../../offchain/cli/scripts/tools/probe-dia-ws.ts).
  WebSocket transport in Phase 3 (`source/scanner-ws.ts`) is now unblocked;
  HTTP polling remains the fallback.
- [ ] **D3 — Change-notification policy.** How DIA will communicate future
  changes to chain ids, registry addresses, or signer sets. Not blocking;
  needed before Phase 5 mainnet rollout.
- [ ] **D4 — Repo location.** Confirm whether the feeder lives in the
  existing `diadata-org/dia-cardano-oracle` monorepo as
  `offchain/feeder/` (recommended), or in a new
  `diadata-org/dia-cardano-feeder` repo. Blocks Phase 3.
- [ ] **D5 — Updater wallet ownership and custody.** Which party operates
  the Cardano updater wallet that signs the long-running submission
  transactions, and how the signing key is provisioned at runtime. Blocks
  Phase 4 live submission.
- [ ] **D6 — Expected update cadence per pair.** Polling interval the DIA
  attestor uses for the 10 Catalyst-listed pairs, so the feeder's
  per-route `min_interval` and `price_deviation` policies can be sized.
  Needed before Phase 4.

---

## Phase 0 — Documentation alignment with confirmed DIA data

Goal: bring repo docs in sync with the canonical endpoints DIA confirmed.

- [x] Refactor `milestone-2-feeder-strategy.md`: replace prior "Live
  verification" section with the canonical endpoints table (mainnet +
  testnet), resolve open questions 1–4, keep the remaining open items
  (signer-set completeness confirmation and change-notification policy;
  WebSocket auth was resolved 2026-05-21 — Conduit path-style key), move
  historical curl/discrepancy material to Appendix A.
- [x] Annotate that **Cardano Mainnet `Config` requires a `config:update`**
  before the first live feed (current Mainnet datum was bootstrapped with
  the old `source_chain_id = 100640`).
- [x] Create this plan document (`milestone-2-plan.md`) and link it from
  `work-plan.md` Workstream C and from the strategy doc.
- [x] Update `work-plan.md` Workstream C with a 1-paragraph summary and
  link to this plan.

**Acceptance**: a reader landing on `work-plan.md` reaches the operational
M2 checklist in one click; the strategy doc no longer carries an open
debate about chain ids or registry addresses.

## Phase 1 — Re-point Cardano `Config` to the confirmed DIA domain

Goal: make signature validation against live DIA intents possible.

Depends on **D1** (authorized signer set).

- [x] Authorized signer sets recovered from live registries (D1 resolved
  — see above). Testnet: `[03aafe60…b807, 03c7d448…b2d]`.
  Mainnet: `[02fa12f4…706d, 02571284…b958bd]`.
- [x] Submit `config:update` on **Cardano Preview** — tx
  `5f2d52183c6c56bd90259dfefe46427b1af8c844fc6580c0170743688001d1dc`
  confirmed 2026-05-21. Draft:
  `offchain/cli/state/preview_run_20260516-090057/config-updates/config-update-draft-m2-phase1.json`.

**Acceptance**: Cardano Preview `Config` datum now points at
`source_chain_id = 10050`, `verifying_contract = 0xF8c614…8bE317`,
with `authorized_dia_public_keys = [03aafe60…b807, 03c7d448…9b2d]`.
A fresh signed `OracleIntent` from the DIA testnet registry will
validate against this datum.

> **Mainnet `config:update` and fixture/test regeneration are
> deliberately deferred to Phase 5.** Mainnet will not be touched
> until the feeder is validated end-to-end on Preview + DIA testnet
> (Phase 4). See Phase 5 below.

## Phase 2 — CLI refactor: tx builders as a reusable library

Goal: let the long-running feeder call the existing tx-build logic in-process,
without spawning the interactive CLI as a subprocess.

- [x] Audit `offchain/cli/src/transactions/` to identify which functions
  mix prompts/state I/O with pure tx-building logic.
- [x] Extract pure builders for the three priority targets, returning a
  built (but not signed/submitted) Lucid `Tx`:
  - [x] `update.ts` → `buildOracleUpdateTx(...)` in
    `offchain/cli/src/lib/transactions/build-oracle-update.ts`.
  - [x] `update-batch.ts` → `buildBatchOracleUpdateTx(...)` in
    `offchain/cli/src/lib/transactions/build-batch-oracle-update.ts`.
  - [x] `settle.ts` → `buildSettleTx(...)` in
    `offchain/cli/src/lib/transactions/build-settle.ts`.
- [x] Keep the existing CLI commands working as thin wrappers over the
  pure builders. Wrapper structure now uniform across all non-deploy txs:
  build → sign → submit → wait1 (`awaitTxConfirmation`) → wait2
  (`waitForWalletSettlement`) → wait3 (`waitForUnitUtxoReplacement` /
  `waitForOutRefAvailable` / `waitForOutRefGone`) → persist.
- [x] Export the pure builders from `offchain/cli/src/lib/index.ts` so
  `offchain/feeder/` can import them without reaching into private paths.
- [x] **Tx-construction audit (2026-05-21).** Confirmed no manual coin
  selection / collateral / change handling in any non-deploy tx; Lucid
  `.complete()` handles balancing throughout. Removed manual
  `fundingUtxos` from the three bootstraps
  (`config-bootstrap.ts`, `payment-hook-bootstrap.ts`,
  `receiver-bootstrap.ts`) and the forced `fundingUtxo` from the three
  reference-script publishes
  (`config-reference-scripts.ts`,
  `payment-hook-reference-script.ts`,
  `client-reference-scripts.ts`). Bootstraps keep their one-shot seed
  input (the parameterized minting-policy ref). Added
  `waitForOutRefAvailable` (wait 3 for ref-script publishes) and
  `waitForOutRefGone` (wait 3 for `pair-burn` and
  `reclaim-reference-script`) so every tx now ends with the same three
  waits regardless of whether the script UTxO is replaced, created, or
  destroyed.
- [ ] **(Deferred to Phase 4 acceptance)** Run `run-all-cli.sh` Preview
  end-to-end to validate the post-refactor wrappers; held back so the
  evidence captured in Phase 4 already includes the cleaned-up tx
  shapes.

**Acceptance**: pure builders importable from `offchain/feeder/`;
`run-all-cli.sh` deferred to Phase 4 acceptance window.

## Phase 3 — Feeder service implementation (`offchain/feeder/`)

Goal: ship the M2 daemon, **architecturally aligned with the DIA Spectra
Bridge** (`diadata-org/Spectra-interoperability/services/bridge`), so DIA
ops can configure it with the same router YAML shape they already use for
EVM destinations. See Annex C for the full Spectra↔Cardano mapping.

**Status**: unblocked 2026-05-21 — Phase 2 closed. Pure builders are
importable from `offchain/cli/src/lib/index.ts`.

Repo location is `offchain/feeder/` in this monorepo, sibling of
`offchain/cli/`. Pending **D4** confirmation.

### Target folder structure

```text
offchain/feeder/
├── README.md
├── package.json
├── tsconfig.json
├── Dockerfile
├── cmd/
│   └── feeder/main.ts                # entry: --config <dir> --log-level <lvl>
├── config/
│   ├── infrastructure.preview.yaml   # source RPC/WS, scanner, dedup, API, DB
│   ├── infrastructure.mainnet.yaml
│   ├── chains.yaml                   # DIA Testnet/Mainnet chain definitions
│   ├── events.yaml                   # IntentRegistered ABI + getIntent enrichment
│   ├── contracts.yaml                # OracleIntentRegistry per network
│   └── routers/
│       ├── client-a.preview.yaml
│       └── client-a.mainnet.yaml
└── src/
    ├── config/{loader,types,validate}.ts
    ├── source/{registry-client,scanner-http,scanner-ws,extractor}.ts
    ├── pipeline/{enricher,transformer,pipeline}.ts
    ├── processor/{dedup-cache,price-cache,event-processor}.ts
    ├── router/{registry,router,policy}.ts
    ├── submitter/{cardano-write-client,queue-manager,queue,inflight}.ts
    ├── persistence/{db,schema,migrations/}            # sqlite | postgres
    ├── api/{server,health,metrics,prices}.ts
    ├── ops/{logger,shutdown}.ts
    └── lib-bridge/index.ts            # re-export from offchain/cli/src/lib
```

The 5-file modular config layout (`infrastructure.yaml` + `chains.yaml` +
`contracts.yaml` + `events.yaml` + `routers/*.yaml`) **mirrors Spectra's
`ModularLoader` exactly**, so DIA's existing router YAMLs can be dropped
into `config/routers/` with only the destination block adapted.

### Sub-phases (each is a mergeable PR)

#### Phase 3.0 — Bootstrap (`offchain/feeder/`) — **done 2026-05-21**

- [x] Create the package: `package.json`, `tsconfig.json`,
  matching `offchain/cli/` conventions (NodeNext, strict, target ES2022).
- [x] `src/lib-bridge/index.ts` stub. The actual cross-package wiring
  to `buildOracleUpdateTx`, `buildBatchOracleUpdateTx`, `buildSettleTx`
  is deferred to Phase 3.4 (when there is something to call) to keep
  3.0 self-contained.
- [x] `cmd/feeder/main.ts`: arg parsing (`--config`, `--log-level`,
  `--help`), graceful shutdown on SIGINT/SIGTERM, no-op start that
  logs the parsed args.
- [x] Multi-stage `Dockerfile` skeleton (filled out further in 3.6).
- [x] `README.md` + `.gitignore`.

**Acceptance**: `npm run feeder:dev -- --help` prints CLI usage; `tsc
--noEmit` exits 0.

#### Phase 3.1 — Modular config — **done 2026-05-21**

- [x] `src/config/types.ts`: TypeScript mirror of Spectra's
  `modular_types.go` / `event_definitions.go` (`InfrastructureConfig`,
  `ChainConfig`, `ContractConfig`, `EventDefinition`, `RouterConfig`,
  `RouterTriggers`, `TriggerCondition`, `RouterDestination`).
- [x] `src/config/yaml-fs.ts`: shared FS + YAML helpers (`readYaml`,
  `readYamlIfExists`, `readYamlTopLevelMap`, `fileExists`,
  `directoryExists`) — every load path goes through these so error
  messages always carry the file path.
- [x] `src/config/loader.ts`: load the 5-file modular layout, glob
  `routers/*.yaml`, merge into a typed object; tolerate the three
  router YAML shapes Spectra has shipped (`router:`, `routers:`,
  `config.routers:`).
- [x] `src/config/issues.ts`: `IssueCollector` with scoped prefixes
  and `required` / `oneOf` assertion helpers — keeps the per-section
  validators terse and consistent.
- [x] `src/config/validate.ts`: per-section validators
  (`validateInfrastructure`, `validateChainsMap`,
  `validateContractsMap`, `validateEventDefinitionsMap`,
  `validateRoutersMap`) plus stricter Cardano-destination checks
  (reject EVM `method:`, validate `cardano:` block shape).
- [x] `src/config/index.ts`: single public re-export surface.
- [x] `RouterDestination` carries a Cardano-specific `cardano:` block
  (parallel to the EVM `method:` block) declaring `network`,
  `client_state_path`, `protocol_state_path`, `tx_mode: single|batch`.
- [x] `cmd/feeder/args.ts` + `cmd/feeder/validate-cmd.ts` split out of
  `main.ts` so the entry point is a thin orchestrator.
- [x] Bootstrap configs: `infrastructure.preview.yaml`,
  `infrastructure.mainnet.yaml`, `chains.yaml`, `contracts.yaml`,
  `events.yaml`, `routers/client-a.preview.yaml`.

**Acceptance**:
`npm run feeder:dev -- --config ./config --validate-only` on the
shipped sample configs reports `0 error(s), 0 warning(s)` for both
`CARDANO_NETWORK=Preview` and `CARDANO_NETWORK=Mainnet`; a smoke test
with an intentionally bad router file surfaces 3 errors + 1 warning at
correctly-scoped paths (`routers.<id>.triggers.events`,
`routers.<id>.triggers.conditions[0].operator`,
`routers.<id>.destinations[0]`, `routers.<id>.private_key_env`).

#### Phase 3.2 — Source pipeline + dual transport (HTTP + WS) — **done 2026-05-22**

- [x] `src/source/abi.ts`: typed (`as const`) ABI fragments for
  `IntentRegistered` and `getIntent`. Source-of-truth signature
  verified against the deployed testnet registry — the event is
  `IntentRegistered(bytes32 indexed intentHash, string indexed symbol, uint256 indexed price, uint256 timestamp, address signer)`.
- [x] `src/source/env.ts`: per-network env resolver (`envVarFor`,
  `requireNetworkEnv`, `readNetworkEnv`) used by every source-side
  module to keep the `_TESTNET` / `_MAINNET` suffix scheme in one place.
- [x] `src/source/registry-client.ts`: narrow `RegistryClient` facade
  with HTTP and WS factories (`createHttpRegistryClient`,
  `createWsRegistryClient`); exposes `getHeadBlockNumber`,
  `getIntentRegisteredLogs`, `getIntent`, `close`.
- [x] `src/source/extractor.ts`: ABI decode `IntentRegistered`
  topics and data into the canonical `ExtractedEvent`.
- [x] `src/source/checkpoint.ts`: JSON-backed `Checkpoint` (atomic
  write via temp file + rename, default path
  `state/<network>/feeder-checkpoint.json`); DB-backed variants land
  in Phase 3.5 behind the same interface.
- [x] `src/source/scan-handler.ts`: shared decode, checkpoint
  advance, and delivery, used by both scanners (no duplication
  between transports).
- [x] `src/source/scanner-http.ts`: `eth_getLogs` polling with
  per-confirmation finalisation trail, chunked range fetches, and
  abort-aware sleep.
- [x] `src/source/scanner-ws.ts`: WebSocket subscription via
  `watchEvent`, auto-reconnect with budget, abort-aware shutdown;
  fails over to throwing on budget exhaustion so the supervisor can
  switch to HTTP.
- [x] `src/pipeline/enricher.ts`: `createRegistryEnricher` calls
  `getIntent(intentHash)` to enrich each event with the full
  `OracleIntent`.
- [x] `src/pipeline/transformer.ts`: identity transformer with an
  explicit "no transformations yet" guard so silent expectations
  cannot creep in.
- [x] `src/processor/dedup-cache.ts`: in-memory LRU + TTL keyed on
  `intentHash`; `stats()` ready for `/metrics`.
- [x] `cmd/feeder/args.ts`: `--scan`, `--transport <http|ws>`, and
  `--dry-run` flags added; mutually exclusive with `--validate-only`.
  `DRY_RUN=true` env var is honoured for Spectra parity.
- [x] `cmd/feeder/args.ts`: `--from-block <N>` and `--from-latest`
  flags added (2026-05-24); mutually exclusive with each other.
  `--from-block` validates a non-negative integer at parse time.
  `--clean` flag added to wipe persisted state before startup.
  Tests: `cmd/feeder/__tests__/args.test.ts` (all new flag suites).
- [x] `cmd/feeder/scan-cmd.ts`: composes scanner + dedup + enricher
  end-to-end; wires the abort signal from `main.ts` for graceful
  shutdown; prints each enriched intent as a one-line summary + JSON
  for grep ergonomics.

**Acceptance** (verified 2026-05-22 against live DIA testnet):

`npm run feeder:dev -- --config ./config --scan --transport http`
ingests live `IntentRegistered` events, enriches each via
`getIntent(intentHash)`, and prints them; observed real symbols
`KERNEL/USD`, `NEIRO/USD`, etc., with valid prices, timestamps,
signers, and full EIP-712 signatures. A restart resumes from the
persisted `state/<network>/feeder-checkpoint.json`. The WS transport
without `DIA_WS_CREDENTIAL_<network>` fails loudly with the missing
env var name (live WS smoke test is gated on the operator setting
the credential).

#### Phase 3.2.5 — Config canonicalisation (YAML = single source of truth) — **done 2026-05-22**

**Why this phase exists.** Phase 3.2 shipped working but left two
honest defects that contradict the goal of Spectra-shape parity:

1. The runtime ABI was a TypeScript `as const` constant
   (`src/source/abi.ts`), not the YAML's `events.yaml::IntentRegistered::abi`.
   Editing the YAML therefore did **not** change the feeder's
   behaviour. This betrays the modular design — DIA's bridge uses the
   YAML ABI at runtime so legacy support, contract upgrades, and
   schema migrations all happen via config swap.
2. Public source-side coordinates (`chain_id`, `rpc_urls`, `ws_url`,
   `registry address`) were declared twice — once in env
   (`DIA_RPC_URL_*`, `DIA_REGISTRY_ADDRESS_*`, etc.) and once in YAML
   (`infrastructure.yaml::source`, `chains.yaml`, `contracts.yaml`).
   Two sources of truth for the same fact.

This phase fixes both. Rules:

- **The YAML directory is the single source of truth** for every
  public data point: chain ids, RPC URLs, WS URLs, registry
  addresses, ABIs, EIP-712 domain, explorer URLs.
- **`.env` carries only secrets and operational selectors.** Concretely:
  - selectors: `CARDANO_NETWORK`, `CARDANO_PROVIDER`, `LOG_LEVEL`, `DRY_RUN`;
  - secrets: `BLOCKFROST_PROJECT_ID_*`, `CARDANO_WALLET_SEED_*`,
    `CARDANO_PRIVATE_KEY_*`, `DIA_WS_CREDENTIAL_*`, `DATABASE_DSN_*`;
  - daemon-only: `API_LISTEN_ADDR`, `API_ENABLE_CORS`,
    `METRICS_ENABLED`, `METRICS_NAMESPACE`, `DATABASE_DRIVER`,
    `DATABASE_PATH_*`.
- **No env interpolation in YAML.** No `${VAR}` substitution at load
  time. If two YAML files happen to repeat the same value (e.g.
  `chains.yaml::dia-testnet::rpc_urls` and
  `infrastructure.preview.yaml::source.rpc_urls`), that is **intentional
  parity with Spectra** — the upstream config layout duplicates the
  same way and it is left untouched.
- **No magic merging of network suffixes inside YAML.** Spectra ships
  one infrastructure file per deployment; we ship one per network
  (`infrastructure.preview.yaml`, `infrastructure.mainnet.yaml`)
  picked by `CARDANO_NETWORK`. The files are mostly identical but
  carry different `source` blocks. This matches Spectra's
  one-deployment-one-file model.

Tasks (gated on operator approval before any code change):

- [x] **Delete the TS ABI source-of-truth.** Remove
  `offchain/feeder/src/source/abi.ts`. Any module that imported from
  it now reads the ABI from the loaded `ModularConfig`.
- [x] **Extend the loader** to parse the ABI strings declared in
  `events.yaml` (one entry per `event_definitions.<name>.abi` plus
  `event_definitions.<name>.enrichment.abi`) and in `contracts.yaml`
  (one entry per `contracts.<id>.abi`). Parsed ABIs are attached to
  the same `ModularConfig` object the validator already produces,
  under a new `parsedAbis` field, so downstream code never re-parses.
- [x] **`src/source/extractor.ts`** receives the parsed event ABI
  from the config and uses it with viem instead of importing from
  `abi.ts`. Type assertions replace the `as const` inference at the
  decode boundary.
- [x] **`src/source/registry-client.ts`** takes the source chain
  coordinates from the loaded config:
  - `chain_id`, `rpc_urls`, `ws_url` from `infrastructure.yaml::source`,
  - `registryAddress` from the entry in `contracts.yaml` whose
    `chain_id` matches `infrastructure.yaml::source.chain_id` (and
    whose `type` is `registry`).
- [x] **`src/pipeline/enricher.ts`** consumes the enrichment ABI
  from `event_definitions.IntentRegistered.enrichment.abi` instead
  of the hardcoded `GET_INTENT_FUNCTION`.
- [x] **Validator** is extended:
  - every `event_definitions.<name>.abi` must parse as valid JSON
    and describe exactly one event input;
  - every `contracts.<id>.abi` must parse as valid JSON and contain
    the methods/events referenced from `event_definitions`;
  - the loader fails loudly on parse errors with a `file:fragment`
    pointer.
- [x] **Delete env vars that duplicate YAML facts**, from
  `offchain/feeder/.env.example`:
  - `DIA_SOURCE_CHAIN_ID_TESTNET` / `_MAINNET` — lives in
    `infrastructure.<network>.yaml::source.chain_id` and in
    `chains.yaml`.
  - `DIA_RPC_URL_TESTNET` / `_MAINNET` — lives in
    `infrastructure.<network>.yaml::source.rpc_urls` and in
    `chains.yaml`.
  - `DIA_WS_URL_TESTNET` / `_MAINNET` — lives in
    `infrastructure.<network>.yaml::source.ws_url`.
  - `DIA_REGISTRY_ADDRESS_TESTNET` / `_MAINNET` — lives in
    `contracts.yaml::<id>.address`.
- [x] **Delete env vars the feeder does not consume**:
  - `DIA_DOMAIN_NAME`, `DIA_DOMAIN_VERSION` — the EIP-712 domain is
    needed by intent signers (the CLI) and by on-chain verifiers
    (the Cardano `Config` datum). The feeder consumes intents
    already signed and verified; it never reaches for the domain.
- [x] **Keep**, unchanged, the env vars that are not present in
  Spectra's YAML schema:
  - `DIA_EXPLORER_URL_TESTNET` / `_MAINNET` — informational only
    (used in future link rendering for logs and `/prices`). Spectra
    does not catalogue explorer URLs in `chains.yaml`; we therefore
    do **not** invent that field — the value stays in env.
  - all secrets and selectors listed earlier in this section.
- [x] **`src/source/env.ts`** survives but loses every `DIA_*` helper
  for fields that moved into YAML. The explorer-URL reader stays
  (env-only). Only the secret + selector readers + explorer reader
  remain.
- [x] **`src/source/registry-client.ts::resolveRegistryCoordinates`**
  is replaced by a `resolveSourceFromConfig(config: ModularConfig)`
  helper that pulls every coordinate from the YAML.
- [x] **No new fields are added to any YAML schema.** The
  `chains.yaml`, `contracts.yaml`, `events.yaml`, and
  `infrastructure.<network>.yaml` shapes match Spectra's upstream
  exactly. The only feeder-side schema extension is the `cardano:`
  block inside `RouterDestination` (a variant on an existing field,
  not a new field on the other config files).
- [x] **Update the validator's smoke-test fixture** so the bad-router
  test still passes after the schema tightening.
- [x] **Re-run `--validate-only` and `--scan --transport http`** as
  Phase 3.2 acceptance gates; both must still pass against the live
  testnet with the env-vars-deleted .env.

**Acceptance** (will be checked after implementation):

- `grep -rE "DIA_RPC_URL|DIA_REGISTRY_ADDRESS|DIA_SOURCE_CHAIN_ID|DIA_WS_URL|DIA_EXPLORER_URL|DIA_DOMAIN_(NAME|VERSION)" offchain/feeder/src offchain/feeder/cmd offchain/feeder/.env.example` returns **zero** matches.
- `npm run feeder:dev -- --config ./config --scan --transport http` against the live DIA testnet produces enriched intents — proving the ABI in `events.yaml` actually drives the decode and that the registry address in `contracts.yaml` actually drives `getIntent`.
- Editing the `IntentRegistered` ABI in `events.yaml` to a deliberately wrong shape (e.g. swap two parameter types) causes the next `--validate-only` to fail at load time, before the scanner connects. This is the regression test for "YAML changes change behaviour".

See **Annex D** for the conceptual rationale and the env-vs-YAML
field map.

#### Phase 3.3 — Router + policy gating — **done 2026-05-24**

- [x] `src/router/registry.ts`: collect enabled routers; index by event
  name; provide `dispatch(event)`.
- [x] `src/router/router.ts`: evaluate `triggers.conditions` (operator `in`,
  `eq`, `gt`, etc. — match the operator set used by Spectra).
- [x] `src/router/policy.ts`: `time_threshold` and `price_deviation` gating
  per destination, with the cache of last (price, timestamp) per
  `(routerId, destination, symbol)` — mirror Spectra's
  `DestinationState`.
- [x] `src/processor/price-cache.ts`: shared cache feeding both
  `router/policy.ts` and the `/prices` API endpoint.

**Acceptance**: verified — `feeder scan --dry-run` annotates each intent
with `routed:` or `filtered:` reason via `routeIntent` in `daemon-cmd.ts`.

**Price deviation behaviour confirmed against Spectra source
(`services/bridge/pkg/router/generic_router.go`):**

`price_deviation` is a **minimum update threshold** (not a maximum alert
threshold). Spectra calculates `abs((newPrice - oldPrice) / oldPrice) * 100`
and compares to the configured threshold per destination. Two outcomes:

- **Change ≥ threshold** → the intent IS published to that destination.
  This is the "divergent enough to be worth publishing" path.
- **Change < threshold** → the destination is **filtered out**; the intent
  is silently skipped for that destination. No alert is raised, no on-chain
  update is submitted. A counter `intents_filtered_total{reason="price_deviation"}`
  is incremented.

**There is no "publish but alert" mode.** The price deviation gate is purely
a submission filter. If you want alerting on large deviations (potential
price manipulation, oracle issues), that must be a separate rule in the
metrics/alerting layer (e.g. `dia_bridge_price_deviation_percent{symbol}` histogram
with a Grafana alert on p99 > threshold).

Our `src/router/policy.ts` already implements this behaviour: intents with
insufficient price change are filtered at the router layer before they reach
the Cardano submitter. We are **fully aligned with Spectra on this point**.

#### Phase 3.4 — Cardano write client + queue — **done 2026-05-24**

- [x] `src/submitter/cardano-write-client.ts`: one instance per
  `(network, clientId)`; consumes the Cardano destination block from
  `RouterDestination.cardano`; calls `buildOracleUpdateTx` or
  `buildBatchOracleUpdateTx` from `lib-bridge`.
- [x] `src/submitter/queue-manager.ts`: per-`(clientStatePath, protocolStatePath)`
  serial queue (Cardano analogue of Spectra's per-`(wallet, chainID)`
  queue). Key is `clientStatePath::protocolStatePath`, which uniquely
  identifies a Cardano deployment.
- [x] `src/submitter/queue.ts`: serial executor (sign → submit →
  `awaitTxConfirmation` → `waitForUnitUtxoReplacement`).
- [x] `src/submitter/inflight.ts`: in-memory table of in-flight txs keyed
  by `receiverUnit`; blocks reuse until the previous tx confirms.
- [x] `src/submitter/retry-policy.ts`: `createDefaultRetryPolicy` with
  `NON_RETRIABLE_CODES` and `DEFAULT_MAX_RETRIES` (3) / `DEFAULT_RETRY_DELAY_MS` (5 000).

**Acceptance**: verified in live Preview run (2026-05-23). Serial
submission confirmed; queue drains one tx at a time per lane.

#### Phase 3.4.5 — Feeder operational robustness

Goal: turn the feeder from a "happy-path-only" submitter into an
operator-grade daemon that diagnoses real failure modes, reconciles
from chain when local artifacts go stale, and never marks a
genuinely-confirmed transaction as failed because of provider lag.

Driven by observed defects in the 2026-05-23 Preview run
(`offchain/feeder/state/preview/logs/feeder.log`): wait3 timeouts
falsely tagged confirmed updates as `submit failed`; errors collapsed
to opaque strings with no remediation; `isCreate` decided from a local
JSON file instead of chain state; the inflight key was a placeholder
that over-serialised independent symbols.

##### 3.4.5.a — Raise the post-tx wait timeouts to operational levels — **done 2026-05-24**

The four wait helpers in `offchain/cli/src/core/chain-helpers.ts` ship
with 18-30s ceilings — fine for the interactive CLI (which spends
seconds between steps doing I/O and waits in shell scripts), too short
for the feeder (which submits back-to-back). When Blockfrost lags
indexing a fresh block beyond ~30s, the feeder's wait3 throws even
though the tx is firmly on-chain and the new UTxO will appear shortly.

- [x] Raise the **defaults** in `chain-helpers.ts` (not new params at
  call sites) so the helpers tolerate real provider lag:
  - `waitForUnitUtxoReplacement`: `maxAttempts 20 → 800` (~20 min ceiling). ✅
  - `waitForOutRefAvailable`:     `maxAttempts 20 → 800` (~20 min ceiling). ✅
  - `waitForOutRefGone`:          `maxAttempts 20 → 800` (~20 min ceiling). ✅
  - `waitForWalletSettlement`:    `maxAttempts 12 → 480` (~12 min ceiling). ✅
  - `delayMs` stays at `1_500` everywhere. ✅
- [ ] Add an **inner sanity check** every 60 attempts (~90s) inside the
  three UTxO-shape waits: call `getTx(txHash)` against the configured
  provider; if the tx is no longer visible on-chain (rollback or
  drop), abort early with a distinct error (`TxDroppedFromChain`)
  instead of waiting out the full ceiling. The wait stays blocking;
  the sanity check only short-circuits unrecoverable cases.
  **(deferred — not blocking Phase 4; the 20-min ceiling is sufficient
  for the evidence window)**
- [x] No call-site changes in the CLI — all builders inherit the new
  defaults transparently.

**Acceptance**: verified — chain-helpers.ts defaults are 800/480 attempts.
The inner sanity check is deferred and not blocking.

##### 3.4.5.b — Chain-as-truth reconciliation — **done 2026-05-24**

The bridge currently rebuilds state from the pair-state JSON sitting
under `state/<network>/clients/<id>/pairs/<slug>.json`. When that file
goes stale (because wait3 threw before `writePairState` ran, or
because the feeder restarted mid-submission, or because someone hand-
edited an artifact), the next submission may build against a phantom
outRef.

- [x] `reconcilePairState` in `offchain/cli/src/lib/reconcile/pair-state.ts`:
  queries all pair UTxOs at `pairValidatorAddress` filtered by `pairPolicyId`,
  decodes inline datums, writes/updates pair-state JSON files. Exported from
  `offchain/cli/src/lib/index.ts`.
- [x] `reconcileAllDestinations` in `offchain/feeder/src/lib-bridge/reconcile.ts`:
  collects unique destinations from enabled routers, calls `reconcilePairState`
  per destination. Per-destination failures are warnings, not fatal.
- [x] Called once at feeder startup (step 9.5 in `daemon-cmd.ts`) before the
  queue starts draining. Skipped when `--dry-run`.
- [x] If on-chain pair UTxO absent but local file exists → local file treated
  as stale; removed; subsequent submission hits the mint path.

**Acceptance**: verified — stale pair-state JSON triggers reconcile at boot;
next submission builds against chain-derived outRef.

##### 3.4.5.c — Mint-vs-update decided from chain, not local file — **done 2026-05-24**

`lib-bridge/index.ts:237` sets `isCreate = !existingPair` from the
local pair-state file. The on-chain reality should be the source of
truth: a missing local file with an existing pair UTxO would silently
try to mint a duplicate token; a present file with a burned pair UTxO
would try to spend nothing.

- [x] Replaced local-file check with
  `const chainPairUtxos = await lucid.utxosAtWithUnit(pairValidatorAddress, pairUnit);`
  `const isCreate = chainPairUtxos.length === 0;`
  using the pair validator address + computed pair unit.
- [x] If `isCreate` is true, the feeder submits a mint tx (existing
  CLI wallet already has admin access for Preview evidence runs;
  `SignerNotAuthorizedToMint` preflight check guards the non-admin case).
- [x] Fallback reconstruction: if `!isCreate && !existingPair && currentPairUtxo?.datum`,
  decode the on-chain datum via `decodePairDatum` and reconstruct a
  minimal `PairStateArtifact` — so the feeder can proceed even if the
  local pair-state file was never written.

**Acceptance**: verified — chain query determines mint vs update; local
file is authoritative only when chain and local agree.

##### 3.4.5.d — Error taxonomy + preflight diagnostics — **done 2026-05-24**

Today every failure surfaces as `submit failed ... error=<opaque>`.
The feeder must name what went wrong and what the operator should do.

- [x] `FeederErrorCode` in `src/errors/codes.ts`:
  `WalletInsufficientFunds`, `ReceiverInsufficientFunds`,
  `SignerNotAuthorizedToMint`, `IntentExpired`, `NonMonotonicNonce`,
  `ProviderLag`, `UtxoNotFound`, `TxDroppedFromChain`,
  `BuilderError`, `Unknown`.
- [x] `runPreflight` in `src/submitter/preflight.ts`: checks wallet
  balance, receiver UTxO ADA, intent expiry, and nonce monotonicity
  before any tx-build. Returns `{ ok, code, reason, remediation }`.
- [x] Called in `processOneEvent` (`daemon-cmd.ts`) before
  `coalescerManager.accept(req)` — rejected intents never enter the queue.
- [x] `SubmitResult` carries `{ ok, code, message, remediation }` on failure.
  File logger emits structured JSON-line per intent lifecycle step.

**Acceptance**: each preflight condition produces one structured error
event with a distinct `code` and one-line `remediation`.

##### 3.4.5.e — Retry policy per error category — **done 2026-05-24**

The queue today is fire-and-forget: no retry, no lane halt, no
backoff. Different errors need different responses.

- [x] `createDefaultRetryPolicy` in `src/submitter/retry-policy.ts`:
  - `NON_RETRIABLE_CODES`: `IntentExpired`, `NonMonotonicNonce`,
    `SignerNotAuthorizedToMint`, `WalletInsufficientFunds`,
    `ReceiverInsufficientFunds`, `TxDroppedFromChain` — deterministic
    skip, no retry.
  - Retriable (`ProviderLag`, `UtxoNotFound`, `Unknown`, `BuilderError`):
    up to `DEFAULT_MAX_RETRIES` (3) attempts, `DEFAULT_RETRY_DELAY_MS` (5 000 ms).
- [x] Queue applies retry policy after each failed attempt before resolving.

**Note**: lane `blocked` state surfaced on `/healthz` is Phase 3.5 scope
(API server). The retry policy itself is implemented here.

##### 3.4.5.f — Real inflight key (`receiverUnit`, not placeholder) — **done 2026-05-24**

`offchain/feeder/src/submitter/queue.ts:89` records the inflight
entry as `pending:${result.intentHash}`. That key is unique per
intent, so it never blocks anything — defeating the purpose of the
inflight table.

- [x] `QueueManager` keys lanes by `clientStatePath::protocolStatePath`
  (unique per Cardano deployment). Implemented in `queue-manager.ts`.
- [x] `result.receiverUnit` is surfaced in `SubmitResultOk` and used
  by `queue.ts` to record the inflight entry
  (`makeInflightEntry(cardanoTxHash, intentHash, receiverUnit, ...)`).
- [x] Two destinations with different `clientStatePath` run in parallel
  (separate queues); same destination serialises (one shared queue).

**Acceptance**: verified by design — each distinct `clientStatePath`
gets its own `SubmissionQueue` instance in the manager's `queues` Map.

##### 3.4.5.g — Lane state machine, supersession, and batch coalescing

This is the single largest behavioural change in Phase 3.4.5. It
combines what was previously split across two ideas — a 2-second
coalescing window and per-symbol supersession — into one coherent
lane state machine that handles real-world Cardano latency.

**Problem.** A Cardano tx takes 30 s – 2 min to confirm. If DIA
emits intents faster than the chain confirms (e.g. one per second
for the same symbol), a naive FIFO lane queue accumulates unbounded
lag: tx N+30 reaches the front of the queue carrying a price 30 s
behind reality. With multiple symbols sharing one receiver UTxO,
the problem compounds.

**Approach.** The lane buffer is not a FIFO of intents — it is a
`Map<symbol, newestIntent>`. Newer intents for the same symbol
supersede older ones immediately (mirrors the on-chain
`is_fresh_update` rule in `oracle_logic.ak`: a later
`(timestamp, nonce)` invalidates the earlier one). The lane has a
small state machine that decides **when to flush** the buffer:

```text
ESTADO       BUFFER     DISPARADOR              SIGUIENTE
─────────    ──────     ──────────              ─────────
idle         empty      new intent X arrives    accumulating
                        (insert X, start `coalesce_window` timer)

accumulating non-empty  another intent Y        accumulating
                        (supersede in buffer;
                        timer keeps running)

accumulating non-empty  timer expires           in-flight
                        (flush buffer → tx)

in-flight    any        new intent Z arrives    in-flight
                        (supersede in buffer;
                        NO timer — free
                        accumulation while tx
                        is on-chain)

in-flight    empty      tx confirms             idle
in-flight    non-empty  tx confirms             in-flight
                        (FLUSH IMMEDIATELY,
                        no extra window)
```

**The `coalesce_window` applies only on `idle → accumulating`.**
After an `in-flight` cycle, the lane has already been accumulating
naturally for as long as the chain took. Imposing another 2 s wait
would be pure latency.

Example — one symbol, 1 intent/s, 60 s tx time:

| t (s) | event | lane state | buffer |
| ---: | --- | --- | --- |
| 0 | intent #1 BTC | idle→accum (timer 2 s starts) | `{BTC:#1}` |
| 0..2 | (nothing) | accum | `{BTC:#1}` |
| 2 | timer expires | **flush** → in-flight | `{}` |
| 3..60 | intents #2..#61 arrive | in-flight | superseded → `{BTC:#61}` |
| 60 | tx #1 confirms | in-flight → **flush immediately** → in-flight | `{}` |
| 60..120 | intents #62..#121 | in-flight | superseded → `{BTC:#121}` |
| 120 | tx #2 confirms | flush immediately → in-flight | … |

Intrinsic lag ≈ one Cardano tx time. **Does not grow with
intent rate.** The feeder publishes the freshest price the chain
can accept, never an obsolete one.

Example — multi-symbol burst during in-flight:

```text
buffer evolves on every arrival (supersede or add):

t=5    {BTC:#1}
t=8    {BTC:#1,  ETH:#1}
t=12   {BTC:#2,  ETH:#1}                    ← BTC#1 superseded
t=15   {BTC:#2,  ETH:#1,  USDC:#1}
t=20   {BTC:#5,  ETH:#2,  USDC:#1}
t=58   {BTC:#58, ETH:#44, USDC:#12}         ← snapshot at flush time
t=60   tx #0 confirms → flush 3 entries as one batch tx
```

Tasks (implemented subset for M2 — see note below):

- [x] `tx_mode: single | batch | auto` added to `CardanoDestinationConfig`
  in `src/config/types.ts`. Router config uses `tx_mode: single` for
  the Preview evidence run.
- [x] `coalesce_window` and `max_intent_age` added to `EventProcessorConfig`.
- [x] **Lane state machine** implemented in `src/submitter/coalescer.ts`:
  `idle → accumulating → in-flight` state transitions, per-symbol buffer
  (`Map<symbol, SubmitRequest>`), supersession on `(timestamp, nonce)`.
  Coalesce window applies only on `idle → accumulating` edge.
- [x] Per-symbol gating (`time_threshold`, `price_deviation`) runs in the
  router/policy layer **before** the coalescer — filtered symbols never
  enter the buffer.
- [x] `onResult(result, req)` callback carries both the result and the
  originating request — DB log + price cache update happen in `onResult`
  rather than at `accept()` time, avoiding orphaned DB rows for superseded
  intents.

**Deferred to post-M2** (not blocking the evidence run):

- Full `tx_mode: auto` batch coalescing (currently behaves as `single` — one
  tx per intent, serially). `buildBatchOracleUpdateTx` is available in
  `lib-bridge` but the coalescer flush does not yet call it.
- Size-budget fallback ladder (`BatchSizeExceeded` → split).
- Mixed mint + update batches in one tx.
- Per-entry `IntentAgedOut` / `lane_overrun` lifecycle events.
- `intent_superseded` event emission.

These are optimizations for production throughput; the M2 evidence window
(5-min `time_threshold`, ~1 intent per confirm cycle) does not exercise
batch paths.

**Acceptance** (implemented subset):

- **Lane state machine correct**: idle → accumulating on first intent,
  timer fires → in-flight, tx confirms → idle (or in-flight if buffer
  non-empty). Verified in code review.
- **Supersession**: a newer intent for the same symbol replaces the buffered
  one before flush. DB insert happens in `onResult`, not at `accept()`.
- **Coalesce window**: `coalesce_window` in `infrastructure.preview.yaml`
  drives the 2 s default; configurable via YAML.

##### 3.4.5.h — Startup checkpoint seeding (--from-block / --from-latest) — **done 2026-05-24**

When the feeder starts against a new network (no persisted checkpoint),
the default behaviour is to scan from `source.start_block` in the YAML.
Operators often want to skip history and start from the chain tip or a
specific block — without editing YAML.

- [x] `cmd/feeder/checkpoint-seed.ts`: `seedCheckpointIfNeeded` —
  injectable helper (takes `checkpoint`, `fromBlock?`, `fromLatest`,
  `getLatestBlock`, `report`). No side-effects when neither flag is set.
  `fromLatest` saves the chain tip; `fromBlock N` saves `N-1` so the
  scanner's first batch starts at exactly N. Clamps at 0.
- [x] `cmd/feeder/args.ts`: `--from-block <N>` and `--from-latest`
  flags added; mutual exclusion enforced at parse time.
  `--clean` flag added to wipe persisted state before the seed write.
- [x] Wired in `daemon-cmd.ts` (step after checkpoint open, before
  scanner start) and `scan-cmd.ts` (same position).
- [x] Tests: `cmd/feeder/__tests__/checkpoint-seed.test.ts` — 13 tests
  covering no-op, `fromLatest`, `fromBlock`, clamp at 0, priority.
- [x] `README.md`: "Starting from a specific block" section added with
  three-tier priority doc (`--from-latest` / `--from-block` →
  persisted checkpoint → YAML `start_block`) and copy-paste examples.

**Acceptance**: `--from-latest` seeds the tip block and the scanner
emits no intents older than that block; `--from-block 7200000` seeds
`7199999` so the first log fetch starts at block `7200000`; `--clean
--from-latest` wipes state then seeds tip in one invocation.

##### 3.4.5.i — One Cardano tx per flush (M2-blocking)

**Status: implemented in feeder + covered by tests (2026-05-26).**
Each lane flush now produces one shared submission path:

- `N = 1` → single-symbol submit path
- `N >= 2` → batch submit path
- mixed mint + update entries are decided per entry at flush time from the
  chain state and can coexist in the same batch tx

**Behavioural model (per-flush):**

| Buffer at flush | Cardano tx path |
| --- | --- |
| 1 entry | `buildOracleUpdateTx` (the existing single-symbol path) |
| ≥ 2 entries | `buildBatchOracleUpdateTx` (one tx with N pair updates) |
| ≥ 2 entries, some pairs not yet minted on-chain | Same batch tx: each entry decides `mint` or `update` independently based on the chain-as-truth `isCreate` check. Mint and update entries coexist in the same tx. |

There is **no `tx_mode` config knob**. The decision is intrinsic to the
flush count — always one tx, batched when the buffer holds more than one
entry. Mint vs update is per-entry, determined at flush time by
`lucid.utxosAtWithUnit(pairUnit)` (the chain-as-truth check already in
`lib-bridge/index.ts`).

**Verification completed during implementation:**

- [x] Confirm `buildBatchOracleUpdateTx`
  (`offchain/cli/src/lib/transactions/build-batch-oracle-update.ts`)
  supports mixed mint + update entries in one tx.

**Tasks:**

- [x] Batch submit path implemented in
  `offchain/feeder/src/lib-bridge/index.ts` via
  `submitOracleUpdateBatch(params[])`, wrapping `buildBatchOracleUpdateTx`.
- [x] `coalescer.ts` flush path now routes `entries.length === 1` through the
  single path and `entries.length >= 2` through the batch path.
- [x] Per-entry `isCreate` is determined inside the bridge from
  `lucid.utxosAtWithUnit(pairUnit)` at submit time.
- [x] `max_batch_size` is read from YAML and large flushes are chunked into
  successive submissions inside the same in-flight cycle.
- [x] `size_fallback_enabled` is read from YAML and `BatchSizeExceeded`
  triggers recursive split-and-retry.
- [x] Per-entry `IntentAgedOut` handling exists at flush time, and lane events
  are emitted for buffering, supersession, flush, reflush, and idle transitions.
- [x] Tests cover N=1, N=2, mixed batch member actions, `max_batch_size`
  chunking, and `BatchSizeExceeded` fallback.

**Configuration (all from YAML, no hardcoding):**

New fields under `event_processor` in `infrastructure.<network>.yaml`:

- `max_batch_size: 10` — hard cap on entries per batch tx
- `size_fallback_enabled: true` — halve-and-retry on `BatchSizeExceeded`

Both fields documented with Zod validators in `src/config/types.ts` and
in `offchain/feeder/README.md` under "Configuration → event_processor".

**Why this matters**: with 10+ pairs and ~1 intent/symbol/minute, the
serial single-symbol path submits 10 sequential Cardano txs per cycle
(each 30–120 s). One batch tx collapses them into one — 10× lower fee
spend, 10× lower confirmation wait, 10× fewer UTxO round-trips.

**Acceptance**: a flush with N=1 submits exactly one tx via the single
path; a flush with N=5 submits exactly one tx via the batch path; a flush
with 3 existing pairs and 2 new pairs submits one tx with 3 update
redeemers and 2 mint redeemers; a flush of 25 entries with
`max_batch_size: 10` submits three successive txs (10, 10, 5);
`BatchSizeExceeded` triggers the halve-and-retry ladder.

##### Phase 3.4.5 rolled-up acceptance

Against Cardano Preview + DIA testnet, a 30-minute feeder run:

- produces **0** false `submit failed` events from wait3 lag,
- emits structured JSON-line logs, one per intent, every failure
  carrying a `FeederErrorCode` and a `remediation` string,
- correctly halts the lane and surfaces the reason on `/health/ready`
  when the wallet or the receiver is drained,
- on restart with a deliberately corrupted pair-state JSON, boots
  green by reconciling from chain.

#### Phase 3.5 — Persistence + API + metrics

##### Configuration constraint (applies to ALL remaining M2 work)

**Nothing may be hardcoded.** Every tunable — defaults, thresholds,
intervals, paths, confirmation depths, batch sizes, retry counts, timeouts,
alert ceilings — must be read from YAML or environment variables. The code
that consumes the value must include a docstring or comment pointing to
*where* the value is configured (which YAML key, which env var) and *what
valid values mean*. The `offchain/feeder/README.md` (and CLI README where
applicable) must document every new config key.

Existing hardcoded values flagged for promotion to YAML/env during M2:

- `confirmations = 6n` in `scanner-http.ts` → YAML `block_scanner.confirmations`
- 3-minute wait ceilings in `tx-confirmation.ts` → env vars (already partially
  there: `TX_CONFIRMATION_*`) — verify completeness
- Any new tunable introduced by 3.4.5.i, 3.5.x, 3.6, 3.8 → YAML or env from day one

##### M2 implementation order

Audit (2026-05-26) confirmed Persistence (3.5.1) is already complete and
the API + Metrics layers exist but with gaps. The remaining M2 work is
sequenced as follows. Each step builds on the previous; do not start
step N+1 until step N is functionally complete and its tests pass.

1. **3.5.1 — Persistence — DONE.** SQLite + Postgres drivers, all three
   tables, repos, tests. See Step 1 verification checklist.
2. **3.5.3 — Prometheus metrics** — core metric surface is implemented in
   code and tests. Remaining work is operational: live receiver/coordinator
   balance gauges, top-up warning emission, and monitoring profile wiring.
   See Step 2.
3. **3.5.2 — HTTP API endpoints** — implemented in code and tests. See Step 3.
4. **3.6 — Monitoring profile — DONE (2026-05-26).** `monitoring/prometheus.yml`,
   `monitoring/alerts.yml`, Grafana provisioning + dashboard JSON, docker-compose
   `monitoring` profile with Prometheus + Grafana services.
4.5. **3.6 — Docker: unified feeder + CLI image — DONE (2026-05-26).** Dockerfile
   rewritten as 3-stage build (cli-build, feeder-build, runtime) with `dia-cli`
   wrapper. Compose: context moved to `offchain/`, `cli` service added (profile
   `cli`), `feeder-artifacts` volume, monitoring services. `offchain/Makefile`
   created. `lib-bridge` env override `CARDANO_FEEDER_CLI_DIST_ROOT` added.
   Latent `ERR_MODULE_NOT_FOUND` bug fixed. See Step 4.5.
5. **3.4.5.i — One Cardano tx per flush** — DONE in feeder code and tests.
6. **3.8 — Rollbacks & finality — DONE (2026-05-26).** Core code/config
   implemented. README finality narrative added: what `confirmedAtDepth` means,
   the Ouroboros Praos finality model, reorg handling, config key. API response
   already carries `confirmedAtDepth`. Live verification deferred to Phase 4.
7. **Phase 4 — Evidence run** — 30-min Preview ↔ DIA testnet run with
   metrics + Grafana screenshots + tx hashes captured.

Post-M2 (kept in plan so it is not forgotten):

- **3.7 — Automatic settle tx** — design TBD; needs trigger policy and
  authorization model resolved.
- **3.9 — Batch settle CLI** — verified in contracts and still pending in
  CLI/feeder. On-chain support exists via
  `SettleManifest { receivers: List<SettleReceiver> }` and
  `CoordinatorRedeemer.ApplySettle(SettleManifest)` in
  `contracts/aiken/lib/dia_cardano_oracle/coordinator_logic.ak`, with the
  corresponding settle paths enforced in the Receiver and PaymentHook
  validators. CLI `settle.ts` currently handles one receiver only.
  Pending: extend `buildSettleTx` and `settle.ts` to accept multiple
  `(clientStatePath, receiverUtxo)` pairs, build one settle tx for all,
  and update payment hook in a single on-chain step. Design TBD (together
  with 3.7 signer model).

##### Implementation contract for remaining M2 work

This section is the executable spec. **An agent picking up M2 work should
read this section first.** The per-phase sections (3.5.1, 3.5.2, 3.5.3,
3.6, 3.4.5.i, 3.8) below are background and rationale; the concrete file
paths, function signatures, YAML keys, and acceptance criteria live here.

###### Global conventions

- **Language / runtime**: TypeScript on Node 22 (LTS), ESM only.
- **Module layout**: existing convention — `offchain/feeder/src/<area>/`
  with `index.ts` re-exporting public surface. New areas in M2:
  `src/persistence/`, `src/metrics/`, `src/api/`, `src/monitoring/`.
- **Config loading**: every new tunable is added to the Zod schema in
  `src/config/types.ts`, validated by `src/config/loader.ts`, and
  consumed via the resolved config object — **never** read directly
  from `process.env` outside the loader except for secrets and
  per-deployment selectors. README and docstring must point to the
  YAML key (and the env override, if any).
- **Logging**: existing 4-stream pattern stays — `feeder.log`,
  `lane.jsonl`, `transactions.jsonl`, `intents/*.log`. New events go to
  the existing streams via `src/logger/file-logger.ts`.
- **Testing**: `vitest`. Unit tests next to source as `__tests__/*.test.ts`.
  DB tests use in-memory SQLite (`:memory:`). HTTP tests use `supertest`.
- **Code style**: no comments unless the WHY is non-obvious; no
  `Phase X.Y` refs in code (use NOTE/TODO for future work, PR description
  for context); no "backward-compatible" language (say "existing callers
  unaffected" or "new params are optional"); no hardcoded values.

###### Runtime dependencies — already in `package.json`

**No new deps needed for M2 work.** Audit (2026-05-26) confirmed:

- `better-sqlite3` ^12.10.0 + `@types/better-sqlite3` ^7.6.13 — present (optional dep)
- `prom-client` ^15.1.3 — present (optional dep)
- `pg` ^8.21.0 + `@types/pg` ^8.20.0 — present (optional dep; post-M2)
- HTTP server uses **Node's built-in `node:http`** — no express, no
  framework. New routes are added by extending the `if (url === ...)`
  chain in `src/api/server.ts`.
- Testing uses the built-in `node:test` runner — no vitest, no supertest.
  HTTP tests open a server on an ephemeral port and use `fetch`.

###### Step 1 — 3.5.1 Persistence — **DONE (audit 2026-05-26)**

Audit found a complete implementation already present. No work required;
this step is a verification checklist for the implementer.

**What exists:**

- `src/persistence/db.ts` (467 lines) — factory `createDb(config)`,
  driver dispatch `"sqlite"` / `"postgres"`, all three tables created
  via `CREATE TABLE IF NOT EXISTS`, both drivers register identically.
- Tables (created in `db.ts` lines 313–389):
  - `processed_events` (intent_hash PK + chain_id, block_number, tx_hash,
    log_index, symbol, price, timestamp, signer, router_id,
    destination_index, processed_at_ms)
  - `chain_state` (composite PK chain_id + contract_id, last_processed_block,
    updated_at_ms)
  - `transaction_log` (id auto + intent_hash, cardano_tx_hash, router_id,
    destination_index, client_state_path, status, error_message,
    submitted_at_ms, confirmed_at_ms)
- Repos exposed on the adapter: `upsertProcessedEvent`, `hasProcessedEvent`,
  `getLastProcessedBlock`, `setLastProcessedBlock`, `insertTransactionLog`,
  `updateTransactionLog`, `getTransactionLog`, `migrate`.
- `src/config/types.ts` already declares `DatabaseConfig` with
  `driver: "sqlite" | "postgres"`.
- `cmd/feeder/daemon-cmd.ts` already opens the DB (line 873 reads
  `DATABASE_DRIVER` env; default path `state/<network>/feeder.sqlite`).
- `clean-state.test.ts` already deletes `feeder.sqlite{,-shm,-wal}` files.

**Verification for the implementer (no code changes expected):**

- [ ] Run `npm run feeder` against Preview; confirm
  `state/preview/feeder.sqlite` is created and accumulates rows in
  `transaction_log` as txs are submitted.
- [ ] `sqlite3 state/preview/feeder.sqlite ".schema"` shows all three
  tables matching the columns above.
- [x] Confirm the existing `transaction_log` schema is sufficient for
  the API endpoints in Step 3 (`/api/v1/transactions/{txHash}` and
  `/api/v1/symbols/{symbol}/updates`). If a column is needed and missing
  (e.g. `symbol` is NOT in `transaction_log` currently — only in
  `processed_events`), add a migration in `db.ts` and bump the schema
  version. This is a gap to confirm/fix during Step 3.
- [x] Confirm the existing tests pass: `npm test`.

###### Step 2 — 3.5.3 Prometheus metrics — **partial surface; multiple gauges defined but never emitted**

**2026-05-26 audit correction**: Several checkboxes were previously marked
done that are actually false. The corrected status:

Implemented and emitted at runtime:

- [x] Default namespace renamed to `dia_bridge`.
- [x] Constant labels now include `destination_chain`, `network`, and
  `source_chain_id`.
- [x] HTTP instrumentation is emitted with route-pattern labels.
- [x] Stage histograms exist for scan→processing, processing→submission,
  submission→confirmation, and end-to-end latency (all four emitted in
  `daemon-cmd.ts`).
- [x] Pipeline counters for detected, duplicate, invalid, scanned, routed,
  filtered, submitted, confirmed, failed are emitted at runtime.
- [x] Price-quality metrics for deviation and age — both emitted.
- [x] Cardano tx context metrics for last confirmed timestamp and
  pair action (`mint`/`update`) — both emitted.
- [x] Tests cover namespace/default labels and registry output.

Defined but **NEVER EMITTED** (corrected from previous false [x]):

- [ ] `transactionsReorg` counter — no reorg detection code exists.
  Addressed in Phase 3.5.5 below.
- [ ] `scannerLastBlock`, `scannerBlockLag`, `scannerRpcErrors` — defined
  in `metrics.ts` but `scanner-http.ts` and `scanner-ws.ts` do not receive
  the metrics object. Addressed in Phase 3.5.4 Etapa 5 below.
- [ ] `cardanoReceiverBalanceLovelace` — no post-confirm chain query.
  Addressed in Phase 3.5.4 below.
- [ ] `cardanoCoordinatorBalanceLovelace` — **wrong metric name** (the
  coordinator is a withdrawal validator with no UTxO). Replaced by three
  correctly-named gauges in Phase 3.5.4 below.
- [ ] `cardanoReceiverTopupWarnings` — no threshold + check logic.
  Addressed in Phase 3.5.4 below.

Still open before calling this area fully closed operationally:

- [ ] Run Preview verification so the documented non-zero metrics are proven
  against live traffic rather than unit tests only (Phase 4).

###### Step 3 — 3.5.2 HTTP API — **implemented in code and tests**

- [x] Routes renamed to `/health`, `/health/live`, `/health/ready`,
  `/metrics`, and `/api/v1/prices`.
- [x] `GET /api/v1/prices/:symbol` returns one symbol across destinations.
- [x] `GET /api/v1/symbols` lists configured router symbols.
- [x] `GET /api/v1/symbols/:symbol/updates` returns joined DB history.
- [x] `GET /api/v1/transactions/:txHash` returns enriched transaction views.
- [x] `GET /api/v1/chains` and `GET /api/v1/chains/:id/status` expose source
  chain status from YAML + runtime state.
- [x] The persistence schema is sufficient for these queries; no migration
  was required.
- [x] `PriceCacheEntry` now carries confirmation depth and the API exposes it.
- [x] `api.host`, `api.port` are wired from YAML.
- [ ] `api.readiness.max_last_confirmed_age` — declared in YAML but **never
  read into the health state** (2026-05-26 audit). Addressed in Phase 3.5.4
  Etapa 8 below.
- [x] HTTP request metrics are emitted with matched route labels.
- [x] Tests cover every new endpoint and the route/error surface.

###### Step 3.5.4 — Balance gauges, alerting block, confirmation depth, hardcoded values (2026-05-26 corrections)

**Trigger**: 2026-05-26 audit found that the metrics surface has multiple
gauges defined but never emitted; the `confirmation_depth` config is read
but not enforced; `max_last_confirmed_age` is declared in YAML but never
wired; and several tunables (in-flight timeout, retry policy defaults)
are hardcoded constants. This step closes all of those.

**Units convention (applies repo-wide)**

- Balances: **lovelace** (1 ADA = 1 000 000 lovelace). All metric names
  ending in `_lovelace` carry lovelace values. All YAML keys ending in
  `_lovelace` carry lovelace values.
- Time intervals: **seconds** unless suffix is `_ms`.
- Price deviation: **percent (0–100)**.

**Threshold authority**

Two locations with explicit purpose:

| Threshold lives in | Used for |
| --- | --- |
| `infrastructure.<network>.yaml::alerting.<key>` | The **feeder code** reads these to emit counters/warnings (e.g. `cardanoReceiverTopupWarnings`). |
| `monitoring/alerts.yml` (Prometheus rules) | Prometheus evaluates these and fires alerts to operators. |

The `alerts.yml` thresholds **must mirror** the YAML keys and carry an
inline comment pointing at the canonical YAML location so the two cannot
drift silently.

**Etapa 0 — Cleanup of dead config + document Spectra divergences**

**Trigger**: 2026-05-26 deeper audit (cross-checked against
`diadata-org/Spectra-interoperability/services/bridge`) found two
categories of cruft:

1. Config keys declared in our YAML/types but **never read** by our code
   AND **never read** by Spectra's code either (dead in both repos).
2. Config keys we have that mention "deferred to M3" but Spectra actually
   uses them and they are chain-agnostic — they belong in M2 (addressed
   in Etapas B.1 and B.2 below).

This Etapa removes (1) and tags genuine M3 placeholders (2) so an
operator no longer sees confusing knobs that do nothing.

**Spectra-parity reference table (canonical, all configs)**

| Config key | Spectra uses? | Our feeder uses? | Decision |
| --- | --- | --- | --- |
| `event_processor.batch_size` | NO (declared, unused) | NO | **Delete** from types + YAML + validate |
| `event_processor.validation_timeout` | NO | NO | **Delete** |
| `recovery.*` (whole block) | NO (declared, unused) | NO | **Delete** entire block |
| `health_check.timeout` | NO | NO | **Delete** |
| `health_check.max_queue_size` | NO | NO | **Delete** |
| `worker_pool.max_workers` | YES (per-router pool) | NO — Cardano lane model | **Delete from YAML + types**; document divergence in README (Spectra parity section). Reason: Cardano EUTxO requires per-receiver serialization; concurrency comes from multiple lanes (different clients), not workers within a lane. |
| `worker_pool.task_queue_size` | YES | NO | **Delete**; same reason as `max_workers` |
| `event_processor.enable_parallel_mode` | YES (parallel enrichment) | NO | **Keep declared; mark M3 in YAML comment**. Genuine optimisation for future high-throughput scenarios. |
| `event_processor.parallel_worker_count` | YES | NO | **Keep declared; mark M3** |
| `event_processor.parallel_queue_size` | YES | NO | **Keep declared; mark M3** |
| `event_processor.parallel_timeout` | YES | NO | **Keep declared; mark M3** |
| `block_scanner.backward_sync` | YES (active in scanner) | NO | **Implement in Etapa B.1 (this milestone)** |
| `block_scanner.max_block_gap` | YES | NO | **Implement in Etapa B.1** |
| `block_scanner.head_tracker_interval` | YES | NO | **Implement in Etapa B.1** |
| `block_scanner.gap_detection_interval` | YES | NO | **Implement in Etapa B.1** |
| `cron_service.*` (whole block) | YES (per-router cron) | NO | **Implement in Etapa B.2 (this milestone)** — required for `time_threshold` liveness when DIA events are filtered by deviation |
| `replica.*` (whole block) | YES (HA failover) | NO | **Keep declared; mark M3**. Operational HA, doesn't affect functional correctness. |
| `health_check.check_interval` | YES (ticker cadence) | NO | **Implement** as part of Etapa 8 (health rework) |
| `health_check.max_processing_lag` | NO (declared, unused in Spectra) | YES — **our extension** | Keep; document as Cardano-feeder extension in README. |
| `cardano.confirmation_depth` | N/A | YES | Keep; Cardano-specific. |
| `alerting.*` | N/A | YES (added Etapa 1) | Keep; chain-agnostic but new in our feeder. |
| `worker_pool.inflight_timeout_ms` | N/A | YES — **our extension** | Keep; Cardano-specific (EUTxO lock semantics). |

**Files to modify in Etapa 0**

- `src/config/types.ts` — delete dead fields from interfaces
  (`EventProcessorConfig.batch_size`, `.validation_timeout`;
  `HealthCheckConfig.timeout`, `.max_queue_size`;
  `WorkerPoolConfig.max_workers`, `.task_queue_size`;
  whole `RecoveryConfig` type and its reference in `InfrastructureConfig`).
- `src/config/validate.ts` — remove validation for the deleted fields.
- `config/infrastructure.preview.yaml` and `infrastructure.mainnet.yaml`:
  - Delete the dead keys.
  - Add `# M3 — declared but not implemented yet in this feeder`
    comment ABOVE each block we keep as placeholder
    (`enable_parallel_mode` + `parallel_*`, `replica` block).
  - Add `cron_service:` block placeholder (filled in Etapa B.2).
- `offchain/feeder/README.md` — new section
  "Spectra parity and Cardano divergences" with the table above.

**Acceptance**: `npm run feeder:dev -- --validate-only` accepts the new
shape; deleted keys produce a YAML parse warning only if the user keeps
the old key in their local .yaml (loader ignores unknown keys, no break).
README documents every divergence with one sentence each.

**Etapa 1 — Config schema and YAML**

Files: `src/config/types.ts`, `src/config/validate.ts`,
`config/infrastructure.preview.yaml`, `config/infrastructure.mainnet.yaml`,
`offchain/feeder/README.md`.

Add to both `infrastructure.<network>.yaml` files:

```yaml
alerting:
  # All thresholds in lovelace (1 ADA = 1 000 000 lovelace) unless suffix
  # says otherwise. These values are the canonical source; monitoring/alerts.yml
  # must mirror them.
  receiver_balance_low_lovelace: 2000000000          # 2 ADA — top-up needed
  settle_overdue_lovelace: 10000000                  # 10 ADA accrued — run settle
  payment_hook_withdraw_ready_lovelace: 50000000     # 50 ADA accumulated — DIA can withdraw
  admin_wallet_low_lovelace: 5000000000              # 5 ADA — refill operator wallet
  oracle_pair_stale_seconds: 3600                    # 1 h since last confirm — pair stale
  price_deviation_high_percent: 5                    # p95 deviation > 5 % — possible misreport
  price_age_high_seconds: 600                        # p95 source age > 10 min — DIA source stale

worker_pool:
  inflight_timeout_ms: 900000   # 15 min — previously hardcoded in inflight.ts
  max_retries: 3                # was hardcoded fallback in retry-policy.ts
  retry_delay_ms: 5000          # was hardcoded fallback in retry-policy.ts
```

Add the corresponding zod schemas in `types.ts`. `validate.ts` rejects
load when any required key is missing — no silent fallbacks. README
documents every new key with default + unit + meaning.

Wire `api.readiness.max_last_confirmed_age` (already declared in YAML
but never read) into the resolved config object.

**Acceptance**: `npm run feeder:dev -- --validate-only` reports the new
keys; missing keys produce a clear validation error.

**Etapa 2 — Metrics types and renames**

File: `src/api/metrics.ts`.

- **Delete** `cardanoCoordinatorBalanceLovelace` (wrong concept — the
  coordinator is a withdrawal validator with no UTxO balance).
- **Add** these three gauges:
  - `cardanoReceiverAccruedLovelace: FeedGauge` with label `client_id` —
    the Receiver's `accruedToHookLovelace` (fees pending settle).
  - `cardanoPaymentHookAccruedLovelace: FeedGauge` no labels —
    the PaymentHook's `accruedFeesLovelace` (singleton across protocol).
  - `cardanoAdminWalletLovelace: FeedGauge` no labels — sum of lovelace
    in the operator wallet UTxOs (post-confirm).

`noopMetrics` updated to match. Public Prometheus metric names:

| Field | Prometheus name |
| --- | --- |
| `cardanoReceiverBalanceLovelace` | `dia_bridge_cardano_receiver_balance_lovelace` |
| `cardanoReceiverAccruedLovelace` | `dia_bridge_cardano_receiver_accrued_lovelace` |
| `cardanoPaymentHookAccruedLovelace` | `dia_bridge_cardano_payment_hook_accrued_lovelace` |
| `cardanoAdminWalletLovelace` | `dia_bridge_cardano_admin_wallet_lovelace` |

**Etapa 3 — Bridge exposes post-confirm state**

File: `src/lib-bridge/index.ts`.

After `waitForUnitUtxoReplacement` succeeds (current line ~487), and
before `return { txHash, ... }` (current line ~519), perform three
on-chain queries via Lucid:

1. Re-fetch Receiver UTxO with `findSingleUtxoAtUnit(lucid, receiverValidatorAddress, receiverUnit, "receiver")`, decode via `decodeReceiverDatum()`. Extract `balanceLovelace`, `accruedToHookLovelace`.
2. Fetch PaymentHook UTxO with `findSingleUtxoAtUnit(lucid, state.scripts.paymentHookValidatorAddress, state.scripts.paymentHookUnit, "payment hook")`, decode via `decodePaymentHookDatum()`. Extract `accruedFeesLovelace`.
3. Fresh `wallet.getUtxos()` → sum `assets.lovelace` of each UTxO.

Extend `OracleUpdateResult` and `OracleBatchUpdateResult` with a
`postState` field carrying these four bigints:

```ts
postState: {
  receiverBalanceLovelace: bigint;
  receiverAccruedLovelace: bigint;
  paymentHookAccruedLovelace: bigint;
  adminWalletLovelace: bigint;
};
```

`SubmitResultOk` in `src/submitter/types.ts` carries the same structure
so the daemon receives it.

Failure modes: if any of the three queries fails (chain provider hiccup),
the bridge still returns the tx as confirmed but logs a warning and emits
`postState` with whatever values could be obtained; missing values are
**not silently zeroed** — they are omitted (typed as optional) so the
daemon does not emit a misleading 0-value gauge.

**Etapa 4 — Daemon emits gauges and topup warning**

File: `cmd/feeder/daemon-cmd.ts`, inside the `onResult` callback (current
line ~537), right after the existing `cardanoOracleLastConfirmedTimestampSeconds.set`
block.

```ts
if (result.ok && result.postState) {
  const { postState } = result;
  metrics.cardanoReceiverBalanceLovelace.set(
    { client_id: clientId },
    Number(postState.receiverBalanceLovelace),
  );
  metrics.cardanoReceiverAccruedLovelace.set(
    { client_id: clientId },
    Number(postState.receiverAccruedLovelace),
  );
  metrics.cardanoPaymentHookAccruedLovelace.set(
    {},
    Number(postState.paymentHookAccruedLovelace),
  );
  metrics.cardanoAdminWalletLovelace.set(
    {},
    Number(postState.adminWalletLovelace),
  );
  if (
    postState.receiverBalanceLovelace <
    BigInt(alerting.receiver_balance_low_lovelace)
  ) {
    metrics.cardanoReceiverTopupWarnings.inc({ client_id: clientId });
  }
}
```

`alerting` is destructured from the resolved infrastructure config at
daemon startup.

**Etapa 5 — Scanner metrics**

Files: `src/source/scanner-http.ts`, `src/source/scanner-ws.ts`,
`cmd/feeder/daemon-cmd.ts`.

Add a `metrics: FeedMetrics` field to `HttpScannerOptions` and
`WsScannerOptions`. Pass the metrics object from `daemon-cmd.ts` where
the scanners are constructed.

In `scanner-http.ts` per tick:

```ts
metrics.scannerLastBlock.set({ chain_id, scanner_type: "http" }, Number(head));
metrics.scannerBlockLag.set({ chain_id }, Number(head - cursor));
```

On RPC error (catch block around `client.getHeadBlockNumber()` and
`getIntentRegisteredLogs()`):

```ts
metrics.scannerRpcErrors.inc({ chain_id, error_type });
```

`scanner-ws.ts` emits the same metrics on each batch + reconnect failure.
`error_type` is one of: `"network"`, `"timeout"`, `"protocol"`, `"unknown"`.

**Etapa 6 — Reorg detection + counter**

Files: `src/errors/codes.ts`, `src/lib-bridge/index.ts`, `cmd/feeder/daemon-cmd.ts`.

1. Add `FeederErrorCode.CARDANO_REORG_DROPPED` with remediation:
   "A confirmed tx was rolled back. The feeder re-queued the intent."
2. In the bridge, immediately after `awaitTxConfirmation` returns `true`
   but before the wallet/UTxO replacement wait, re-query the tx by hash.
   If the provider returns "not found" for a previously-confirmed tx, throw
   a typed error carrying that code.
3. In `daemon-cmd.ts`, when `result.ok === false && result.code === "CARDANO_REORG_DROPPED"`:

   ```ts
   metrics.transactionsReorg.inc({ symbol, client_id });
   ```

   The queue manager already re-enters the intent; no extra wiring needed.

**Etapa 7 — `confirmation_depth` actually enforced**

File: `src/lib-bridge/index.ts`.

Today: `cardano.confirmation_depth` is read into the daemon's
`cardanoConfirmationDepth` constant and written into the price cache
entry, but the bridge does **not** wait that many blocks. Fix:

After `awaitTxConfirmation` reports inclusion, capture
`inclusionBlock = await lucid.provider.getTxBlockHeight(txHash)`.
Loop:

```ts
while (true) {
  const head = await lucid.provider.getBlockHeight();
  if (head >= inclusionBlock + (confirmationDepth - 1)) break;
  await sleep(20_000);
}
```

`confirmationDepth` is passed into the bridge factory via
`createRealOracleIntentBridge({ confirmationDepth })`. Default = 1 (current
behaviour preserved).

The daemon's `confirmedAtDepth` field in the price cache now correctly
reflects the depth actually waited.

**Etapa 8 — `/health/ready` honours `max_last_confirmed_age`**

Files: `src/api/health.ts`, `cmd/feeder/daemon-cmd.ts`.

Currently `health.ts` accepts an optional `maxLastSubmitAgeMs` and skips
the check if missing. `daemon-cmd.ts` never sets it. Fix:

1. Read `api.readiness.max_last_confirmed_age` (seconds) from the
   resolved config.
2. Pass it through to the health state factory as
   `maxLastConfirmedAgeMs = api.readiness.max_last_confirmed_age * 1000`.
3. In `readinessResult()`, return 503 when
   `now - healthState.lastConfirmedMs > maxLastConfirmedAgeMs`.
4. `daemon-cmd.ts` updates `healthState.lastConfirmedMs` in the existing
   `onResult` block where `lastSubmitMs` is currently set.

**Etapa 9 — Hardcoded fallbacks eliminated**

Files: `src/submitter/inflight.ts`, `src/submitter/retry-policy.ts`,
`cmd/feeder/daemon-cmd.ts`.

- Delete `DEFAULT_TIMEOUT_MS = 15 * 60_000` from `inflight.ts`.
  Accept the timeout as a required option in `makeInflightEntry(...)`.
- Delete `DEFAULT_MAX_RETRIES` and `DEFAULT_RETRY_DELAY_MS` from
  `retry-policy.ts`. Accept both as required options.
- `daemon-cmd.ts` reads `worker_pool.{inflight_timeout_ms, max_retries,
  retry_delay_ms}` from the validated config and passes them in.
- Zod schema rejects load when any of the three are missing.

**Etapa 10 — Tests**

New / completed:

- `src/api/__tests__/metrics.test.ts` — assert that the registry produces
  the expected metric **lines and label values** when the gauges/counters
  are exercised; cover all 4 balance gauges, topup warning, scanner
  metrics, reorg counter.
- `src/persistence/__tests__/db.test.ts` — direct CRUD against SQLite
  in-memory; assert idempotent upserts.
- `src/source/__tests__/scanner-http.test.ts` — fake `RegistryClient`;
  assert `scannerLastBlock` / `scannerBlockLag` / `scannerRpcErrors`
  emitted with correct labels.
- `src/source/__tests__/scanner-ws.test.ts` — similar with WS mock.
- `src/errors/__tests__/codes.test.ts` — every `FeederErrorCode` has a
  remediation string; `classifyError()` matches expected inputs.
- `src/lib-bridge/__tests__/post-state.test.ts` — assert `postState`
  fields are populated and exposed through `OracleUpdateResult`; degraded
  case (one query fails) leaves the field undefined, not zeroed.
- `cmd/feeder/__tests__/reorg.test.ts` — simulate `CARDANO_REORG_DROPPED`
  result and verify counter increments.

**Etapa 11 — `monitoring/alerts.yml` rewritten**

File: `offchain/feeder/monitoring/alerts.yml`.

- **Remove** `CoordinatorBalanceLow` (metric never emitted; concept wrong).
- **Keep** `OraclePairStale`, `ReceiverBalanceLow`, `PriceDeviationHigh`,
  `PriceAgeHigh`.
- **Add**:
  - `SettleOverdue` — fires when
    `cardano_receiver_accrued_lovelace > settle_overdue_lovelace` for 10 min.
  - `PaymentHookWithdrawReady` — fires when
    `cardano_payment_hook_accrued_lovelace > payment_hook_withdraw_ready_lovelace` for 10 min.
  - `AdminWalletLow` — fires when
    `cardano_admin_wallet_lovelace < admin_wallet_low_lovelace` for 5 min.
  - `ReorgRateHigh` — fires when
    `increase(dia_bridge_transactions_reorg_total[1h]) > 3`.
- Every rule carries a header comment:
  ```yaml
  # Canonical threshold: infrastructure.<network>.yaml::alerting.<key>
  ```
- The numeric value in `expr` matches the YAML key.

**Etapa 12 — Grafana dashboard updated**

File: `offchain/feeder/monitoring/grafana/dashboards/feeder.json`.

- Replace "Coordinator balance (per client)" panel with **three stat
  panels** side by side: Receiver accrued (per client), PaymentHook
  accrued (singleton), Admin wallet (singleton).
- Keep "Receiver balance (per client)" — now backed by real data.
- All four balance panels use a `currency_display` template variable so
  the operator can toggle ADA / lovelace display.
- Add `Reorg rate (1h)` panel sourced from `transactionsReorg`.

**Etapa 13 — Plan doc updates**

This section. Done as the spec is written.

**Etapa B.1 — Block scanner gap recovery (Spectra parity)**

**Trigger**: Spectra's `block_scanner_enhanced.go` has gap recovery the
feeder lacks. After a restart with a stale checkpoint (or after a network
outage that prevented checkpoint advance), Spectra detects the gap and
backfills in chunks of 5000 blocks until caught up. Our scanner currently
advances `block_range` blocks per tick (default 500), so a 9000-block gap
takes 18 ticks (~3 min at `scan_interval: 10s`) to catch up — and during
that window every event is processed sequentially via the regular flush
path, which is slow and noisy.

This Etapa replicates the Spectra behaviour for the DIA Lasernet source
chain. It is chain-agnostic (the destination is irrelevant; the gap is
in the source-chain scanner).

**Config keys (already declared in `BlockScannerConfig`, now activated)**

- `block_scanner.backward_sync: true|false` — master switch. When true,
  the scanner runs gap detection alongside the normal poll loop.
- `block_scanner.max_block_gap: number` — gap threshold (in blocks) above
  which backfill kicks in. Default 5000.
- `block_scanner.head_tracker_interval: duration` — how often a dedicated
  loop polls the chain head (independent of `scan_interval`). Default
  `30s`.
- `block_scanner.gap_detection_interval: duration` — how often the gap
  detector compares persisted checkpoint vs head. Default `60s`.

**Files to modify / create**

- `src/source/scanner-http.ts` — accept `maxBlockGap`,
  `headTrackerInterval`, `gapDetectionInterval` in options. The existing
  per-tick poll stays as-is.
- New `src/source/head-tracker.ts` — async loop that calls
  `client.getHeadBlockNumber()` every `head_tracker_interval` and updates
  an in-memory `latestHead` shared with the gap detector.
- New `src/source/gap-detector.ts` — async loop that every
  `gap_detection_interval` reads the persisted checkpoint and compares
  against `latestHead`. If `head - checkpoint > max_block_gap`, schedule a
  `backfillRange(from, to)` task.
- `src/source/backfill.ts` — runs `getIntentRegisteredLogs(from, to)` in
  5000-block chunks (mirrors Spectra constant `backwardBatchSize`); emits
  each batch via the same `processLogBatch` sink as the regular scanner.
  Advances checkpoint atomically per chunk so a crash mid-backfill resumes
  from the last completed chunk.
- `cmd/feeder/daemon-cmd.ts` — wire the new loops alongside the existing
  scanner; pass `metrics` so backfill activity emits its own counter:
  `dia_bridge_scanner_backfill_blocks_total{chain_id}` and
  `dia_bridge_scanner_backfill_chunks_total{chain_id}`.
- `src/api/metrics.ts` — add the two new counters.

**Concurrency note**: the regular polling loop and the backfill loop must
not race on the same range. The backfill claims a `[from, to]` window
ATOMICALLY by writing a "backfill_in_progress" marker into the checkpoint
table; the polling loop respects the marker (waits until backfill clears
it before advancing). Same pattern as Spectra.

**Tests**: `src/source/__tests__/backfill.test.ts` with a fake
`RegistryClient` that reports a 12 000-block gap; assert the backfill
processes in 3 chunks of 5000+5000+2000.

**Acceptance**: start the feeder with `--clean` against a checkpoint set
12 000 blocks behind head; feeder catches up via backfill (visible in
metrics) in 1–2 ticks of `gap_detection_interval`; normal poll resumes
afterwards.

**Etapa B.2 — Cron service for `time_threshold` liveness (Spectra parity)**

**Trigger**: Spectra's `internal/cron/cron_service.go` runs a per-router
timer that re-pushes the latest cached price to the destination chain
when the `time_threshold` for that destination has elapsed since the
last on-chain confirmation. Without this, a pair can stay stale on chain
even when DIA is emitting events — because the router policy (price
deviation filter) may drop every event for hours if the price barely
moves.

The Catalyst M2 milestone requires "uptime and accuracy reports of the
oracle data" and "demonstrates oracle liveness". Cron service is the
mechanism that guarantees a configurable per-pair maximum staleness.

**Config keys (new)**

In `infrastructure.<network>.yaml`:

```yaml
cron_service:
  # Master switch. When false, all routers behave as today (purely
  # event-driven). When true, each destination with `cron: true` gets a
  # per-(routerId, symbol) timer.
  enabled: true
  # Cadence at which the cron service checks every monitored destination.
  # Spectra uses a per-router cron expression; we use a single tick interval
  # for simplicity and apply each destination's own time_threshold inside
  # the tick.
  tick_interval: 30s
```

In `routers/<router>.yaml` per destination (additive — does not break
existing configs):

```yaml
destinations:
  - cardano:
      network: Preview
      client_state_path: ...
      protocol_state_path: ...
    triggers:
      conditions: [...]
    # NEW: enable cron-driven liveness for this destination.
    cron: true
    # NEW: max staleness before cron forces an update.
    time_threshold: 5m
```

**Files to modify / create**

- `src/config/types.ts` — add `CronServiceConfig` to `InfrastructureConfig`.
  Add `cron: boolean` and `time_threshold: string` to `RouterDestination`.
- `src/config/validate.ts` — validate `tick_interval` and the new
  per-destination fields.
- New `src/cron/cron-service.ts` — schedules a `setInterval` at
  `tick_interval`. Each tick:
  1. For every router with at least one `cron: true` destination, iterate
     its destinations.
  2. For each cron-enabled destination, look up the **last confirmed tx**
     for the (clientId, symbol) pair in the price cache or DB.
  3. If `now - lastConfirmedMs > timeThresholdMs`, take the latest intent
     for that symbol from the price cache (the most recent enriched
     intent seen by the feeder), and re-submit it via
     `queueManager.submit(...)` with a synthetic `SubmitRequest` carrying
     `source: "cron"` in metadata.
  4. The queue's normal retry policy and inflight-locking apply.
- `cmd/feeder/daemon-cmd.ts` — wire the cron service after queue manager
  setup; pass `metrics`, `priceCache`, `db`, and `routerRegistry`.
- `src/api/metrics.ts` — add counter
  `cron_resubmissions_total{router_id, symbol, client_id, outcome}` where
  `outcome` is `"submitted"`, `"skipped_already_fresh"`, or
  `"skipped_no_intent"`.
- `src/api/__tests__/server.test.ts` — extend `/api/v1/transactions/:hash`
  test to assert the response includes a `triggered_by: "event" | "cron"`
  field so consumers can distinguish.
- `src/persistence/db.ts` — add `triggered_by` column to `transaction_log`
  (default `"event"`). Backfill existing rows with `"event"`.

**Why this matches Spectra's behaviour**

Spectra's cron service:
1. Iterates `monitoredDestinations` per cron tick.
2. For each: reads the latest `priceCache` entry and the last on-chain
   timestamp.
3. If `time_threshold` exceeded → calls the same `sendToChain` path the
   event-driven flow uses.
4. The destination contract's own monotonicity check prevents replay of
   already-submitted intents (`nextTimestamp > lastTimestamp`).

Our implementation mirrors this 1:1. The Cardano destination contract
already enforces monotonicity on `(timestamp, nonce)` so replaying an
older intent is a no-op at chain level; the cron service additionally
gates by checking the price-cache `intentHash` against the last submitted
hash for that pair.

**Tests**

- `src/cron/__tests__/cron-service.test.ts` — fake clock; assert tick
  every `tick_interval`; assert submission when time_threshold elapsed;
  assert NO submission when within the window; assert NO submission when
  the cached intent is the same hash as last submitted.
- Integration: extend `cmd/feeder/__tests__/daemon-pipeline.test.ts` with
  a cron path scenario.

**Acceptance**: with `cron_service.enabled: true` and a router's
destination set to `cron: true` + `time_threshold: 30s`, freeze the
DIA source (no new events) — the feeder still pushes the last cached
intent every 30s as long as a newer-than-on-chain intent exists in the
cache. Counter `cron_resubmissions_total{outcome="submitted"}` increments
once per tick that triggers.

**Etapa 14 — README updates**

File: `offchain/feeder/README.md`.

- New section "Thresholds and alerts" with the full table mapping each
  alert → metric → YAML key → unit.
- Clarify that `confirmedAtDepth` now reflects the depth actually waited
  by the feeder (was previously misleading).
- Document the `alerting:` and `worker_pool:` blocks under "Config layout".

**Acceptance (rolled up)**

- `npm run typecheck` — clean.
- `npm test` — all tests pass including new ones.
- `npm run feeder:dev -- --validate-only` — accepts the new config
  blocks; clearly errors when a required key is missing.
- A confirmed oracle update tx produces non-zero values for the four
  balance gauges, the receiver-accrued counter (when above threshold),
  and the topup-warning counter (when receiver is below threshold).
- A simulated reorg (provider returns 404 for a previously-confirmed tx)
  increments `transactionsReorg` and re-queues the intent.
- `/health/ready` returns 503 when the last confirmed tx is older than
  `api.readiness.max_last_confirmed_age`.
- `alerts.yml` thresholds match `infrastructure.<network>.yaml::alerting.<key>`
  one-to-one.

###### Step 4 — 3.6 Monitoring profile

**Files to create:**

- `offchain/feeder/monitoring/prometheus.yml` — scrape config:
  ```yaml
  global:
    scrape_interval: 15s
  scrape_configs:
    - job_name: feeder
      static_configs:
        - targets: ["feeder-sqlite:8080"]
      metrics_path: /metrics
  rule_files:
    - alerts.yml
  ```
- `offchain/feeder/monitoring/alerts.yml` — three alert rules (staleness,
  receiver balance, coordinator balance) as defined in 3.6 above.
- `offchain/feeder/monitoring/grafana/provisioning/datasources/prometheus.yml`
  — Prometheus datasource pointing at `prometheus:9090`.
- `offchain/feeder/monitoring/grafana/provisioning/dashboards/dashboards.yml`
  — provisioning manifest pointing at `/var/lib/grafana/dashboards`.
- `offchain/feeder/monitoring/grafana/dashboards/feeder.json` — single
  pre-provisioned dashboard with these panels (designed by implementer
  per user instruction):

  | Row | Panel | Type | Query |
  |---|---|---|---|
  | 1 | Pair staleness (per symbol) | Stat / Table | `time() - dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds` |
  | 1 | Receiver balance (per client) | Gauge | `dia_bridge_cardano_receiver_balance_lovelace` |
  | 1 | Coordinator balance (per client) | Gauge | `dia_bridge_cardano_coordinator_balance_lovelace` |
  | 2 | End-to-end latency (p50/p95/p99) | TimeSeries | `histogram_quantile(0.5/0.95/0.99, sum(rate(dia_bridge_end_to_end_latency_seconds_bucket[5m])) by (le, symbol))` |
  | 2 | Tx confirmed rate (5m) | TimeSeries | `sum by (symbol) (rate(dia_bridge_transactions_confirmed_total[5m]))` |
  | 2 | Tx failed rate (5m) | TimeSeries | `sum by (error_code) (rate(dia_bridge_transactions_failed_total[5m]))` |
  | 3 | Reorg counter | Stat | `sum(increase(dia_bridge_transactions_reorg_total[1h]))` |
  | 3 | Scanner block lag | TimeSeries | `dia_bridge_scanner_block_lag` |
  | 3 | Intents filtered by reason | TimeSeries | `sum by (reason) (rate(dia_bridge_intents_filtered_total[5m]))` |
  | 4 | Price deviation distribution | Heatmap | `sum by (le, symbol) (rate(dia_bridge_price_deviation_percent_bucket[5m]))` |

  All dashboard JSON values that look like thresholds (panel `min`, alert
  ceilings) must reference Grafana variables loaded from a `dashboard.yaml`
  variables block — not hardcoded.

**Files to modify:**

- `offchain/feeder/docker-compose.yml` — add `monitoring` profile with
  `prometheus` and `grafana` services. Both have healthchecks and persistent
  volumes. Network: same as feeder (default).
- `offchain/feeder/README.md` — "Monitoring" section: how to start the
  monitoring stack, how to access Grafana (port 3000, default credentials
  from env), how to add a new alert rule.

**Acceptance:**

- `docker-compose --profile sqlite --profile monitoring up` brings up
  feeder + Prometheus + Grafana; Grafana shows the dashboard with live
  data within 30 seconds.
- All three alert rules visible in Prometheus `/alerts`.

###### Step 4.5 — Docker: unified feeder + CLI image (M2-blocking)

**Why this step exists**

The feeder (`offchain/feeder/`) and the CLI (`offchain/cli/`) are two
TypeScript packages but **one operational system**. An operator running
the feeder also needs the CLI for:

- bootstrap (`protocol:init`, `client:init`, `receiver:bootstrap`,
  `receiver:parameterize`, `reference-scripts:publish-client`)
- pair lifecycle (`pair:burn`, `pair:dedup`, `pair:update-min-utxo`)
- treasury (`receiver:top-up`, `receiver:withdraw`,
  `payment-hook:withdraw`)
- settle and reconciliation (`settle`, `reclaim-reference-script`,
  `config:update`)
- diagnostics (`protocol`, `wallet`, `wallet:utxos`, `blueprint:list`)

There is no scenario where an operator runs the feeder Docker container
but does **not** want CLI access. Without a documented Docker path for
the CLI, operators are forced to install Node 22, `npm ci` two
packages, and resolve any platform-specific `node-gyp` issues
(better-sqlite3, lucid-evolution) on the host — the very pain Docker is
supposed to eliminate.

**Latent runtime bug this step also fixes:** the feeder's
`src/lib-bridge/index.ts:110` and `reconcile.ts:52` dynamically import
CLI modules at runtime via
`path.resolve(__dirname, "../../../cli/src")`. The current Dockerfile
copies only `offchain/feeder/{cmd,src}` — it does **not** include
`offchain/cli/` — so `submitOracleUpdate` would fail at runtime in the
container with `ERR_MODULE_NOT_FOUND` the first time it tries
`import("/app/cli/src/core/config.js")`. This step copies the
**compiled** CLI dist into the image and overrides the bridge's
`cliSrcRoot` to that path, fixing both the bug and the CLI-access need
in one stroke.

**Architecture decision: one image, two compose services**

The single image `dia-cardano-feeder:local` contains:

- compiled feeder (`/app/feeder/dist/`) with feeder's prod deps in
  `/app/feeder/node_modules/`
- compiled CLI (`/app/cli/dist/`) with CLI's prod deps in
  `/app/cli/node_modules/`
- a thin wrapper script `/usr/local/bin/dia-cli` that execs
  `node /app/cli/dist/index.js "$@"` so operators can type
  `dia-cli protocol` instead of the full path

The compose file declares two services backed by this same image:

- `feeder-sqlite` / `feeder-postgres` — long-running daemon
  (existing behaviour, no change beyond pointing at the new entrypoint)
- `cli` — short-lived, on-demand container under profile `cli`,
  invoked by `docker compose run --rm cli <command> [args...]`

**Why one image and not two:**

- The image already has to include the CLI source/dist to fix the
  lib-bridge runtime bug. Maintaining a second image with the same
  artefacts is duplication.
- Operators publish, version, and pin **one** artefact tag
  (`dia-cardano-feeder:vX.Y.Z`). No risk of feeder and CLI drifting to
  different versions in production.
- The size delta is small (CLI dist + lucid-evolution prod deps overlap
  heavily with feeder prod deps).

**Files to modify**

**1. `offchain/feeder/Dockerfile` — rewrite to build both packages.**

The Dockerfile currently lives in `offchain/feeder/` and runs with
build context `offchain/feeder/` (set by `docker-compose.yml`). To
build the CLI alongside the feeder, the **build context must move up
to `offchain/`** so the Dockerfile can `COPY cli/ ./cli/` and
`COPY feeder/ ./feeder/`.

New Dockerfile structure (full file, replaces the existing 47-line
Dockerfile):

```dockerfile
# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Stage 1 — build CLI: compile TypeScript → JavaScript
# ---------------------------------------------------------------------------
FROM node:22-alpine AS cli-build
WORKDIR /build/cli

# Build tools needed by better-sqlite3 / lucid-evolution native deps.
RUN apk add --no-cache python3 make g++

COPY cli/package.json cli/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY cli/tsconfig.json ./
COPY cli/src ./src
RUN npm run build

# Prune dev deps for the runtime stage.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 — build feeder
# ---------------------------------------------------------------------------
FROM node:22-alpine AS feeder-build
WORKDIR /build/feeder

RUN apk add --no-cache python3 make g++

COPY feeder/package.json feeder/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY feeder/tsconfig.json ./
COPY feeder/cmd ./cmd
COPY feeder/src ./src
RUN npm run build

RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 3 — runtime: feeder + CLI in one lean image
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# Feeder artefacts.
COPY --from=feeder-build /build/feeder/package.json /app/feeder/package.json
COPY --from=feeder-build /build/feeder/node_modules /app/feeder/node_modules
COPY --from=feeder-build /build/feeder/dist /app/feeder/dist

# CLI artefacts.
COPY --from=cli-build /build/cli/package.json /app/cli/package.json
COPY --from=cli-build /build/cli/node_modules /app/cli/node_modules
COPY --from=cli-build /build/cli/dist /app/cli/dist

# Convenience wrapper for operators: `dia-cli <command>` from any shell.
RUN printf '#!/bin/sh\nexec node /app/cli/dist/index.js "$@"\n' > /usr/local/bin/dia-cli \
    && chmod +x /usr/local/bin/dia-cli

# Mount points for config and on-chain artefacts (see "Volume layout" below).
RUN mkdir -p /config /state /artifacts \
    && chown -R node:node /config /state /artifacts

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health/live || exit 1

USER node

# Default: feeder daemon. Override `command:` in compose to invoke CLI.
# Entrypoint deliberately NOT set so each service can specify its own.
CMD ["node", "/app/feeder/dist/cmd/feeder/main.js", "--config", "/config"]
```

Notes for the implementer:

- The `apk add python3 make g++` only runs in the build stages; the
  runtime image stays slim (just `node:22-alpine`).
- `npm prune --omit=dev` after `npm run build` keeps `node_modules`
  production-only without re-installing.
- The runtime stage does **not** run `npm ci` — it copies pruned
  `node_modules` from the build stages.
- `dia-cli` wrapper is set up in `/usr/local/bin` so it is on `$PATH`
  inside any exec/run session.
- `ENTRYPOINT` is intentionally removed. Each compose service declares
  its own `command:` (feeder daemon vs CLI). This avoids the previous
  setup where `ENTRYPOINT ["node", "dist/cmd/feeder/main.js"]` made it
  awkward to invoke a different binary.

**2. `offchain/feeder/src/lib-bridge/index.ts` and `reconcile.ts` — make
the CLI module root configurable via env, default to current behaviour.**

Add a new env-driven override so the feeder can locate CLI modules
inside the Docker image (where `cli` is a sibling of `feeder`, not of
`feeder/src/lib-bridge`):

- At [src/lib-bridge/index.ts:108-110](offchain/feeder/src/lib-bridge/index.ts#L108-L110)
  and [src/lib-bridge/reconcile.ts:50-52](offchain/feeder/src/lib-bridge/reconcile.ts#L50-L52),
  replace the current resolution with:

  ```ts
  // CLI module root resolution priority (highest to lowest):
  //   1. explicit options.cliSrcRoot (programmatic override, tests)
  //   2. env CARDANO_FEEDER_CLI_DIST_ROOT
  //      (set by Docker image to /app/cli/dist; documented in YAML schema
  //       comment block "Runtime paths — env-only" of routers/preview.yaml)
  //   3. fallback: ../../../cli/src relative to this module (dev mode under tsx)
  const cliSrcRoot = options.cliSrcRoot
    ? path.resolve(options.cliSrcRoot)
    : process.env.CARDANO_FEEDER_CLI_DIST_ROOT
      ? path.resolve(process.env.CARDANO_FEEDER_CLI_DIST_ROOT)
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../cli/src");
  ```

- Document `CARDANO_FEEDER_CLI_DIST_ROOT` in
  [offchain/feeder/.env.example](offchain/feeder/.env.example) with a
  comment: "Absolute path to the directory containing compiled CLI
  JavaScript (`index.js`, `core/`, `lib/transactions/`). Defaults to
  `<feeder>/../cli/src` in dev mode. In the published Docker image
  this is set automatically to `/app/cli/dist`."

- In the Dockerfile add: `ENV CARDANO_FEEDER_CLI_DIST_ROOT=/app/cli/dist`
  immediately before the `CMD` line.

This follows the "no hardcoded values" rule: the path is env-driven
with a sane dev-mode default.

**3. `offchain/feeder/docker-compose.yml` — move build context up,
add `cli` service, add named volume for artefacts.**

Replace the existing file with (annotated):

```yaml
# Build context moves from `.` (feeder/) up to `..` (offchain/) so both
# packages are visible. dockerfile path becomes feeder/Dockerfile.

services:
  feeder-sqlite:
    profiles: ["sqlite"]
    build:
      context: ..
      dockerfile: feeder/Dockerfile
      target: runtime
    image: dia-cardano-feeder:local
    restart: unless-stopped
    ports: ["8080:8080"]
    volumes:
      - ./config:/config:ro
      - feeder-state-sqlite:/state
      - feeder-artifacts:/artifacts   # CLI writes here; feeder reads
    env_file: [.env]
    environment:
      DATABASE_DRIVER: sqlite
      DATABASE_PATH_PREVIEW: /state/preview/feeder.sqlite
      DATABASE_PATH_MAINNET: /state/mainnet/feeder.sqlite
      # CARDANO_FEEDER_CLI_DIST_ROOT already set by Dockerfile ENV.
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health/live"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  feeder-postgres:
    profiles: ["postgres"]
    build: { context: .., dockerfile: feeder/Dockerfile, target: runtime }
    image: dia-cardano-feeder:local
    # ... (same as today plus the artifacts volume) ...
    volumes:
      - ./config:/config:ro
      - feeder-artifacts:/artifacts

  postgres:
    # ... (unchanged) ...

  # ----- NEW: CLI service -----
  cli:
    profiles: ["cli"]
    build: { context: .., dockerfile: feeder/Dockerfile, target: runtime }
    image: dia-cardano-feeder:local
    # No restart, no healthcheck — short-lived one-shot container.
    entrypoint: ["dia-cli"]
    command: ["help"]              # default if `run` invoked without args
    volumes:
      - ./config:/config:ro
      - feeder-artifacts:/artifacts # writes protocol/client state here
      - feeder-state-sqlite:/state  # for `settle`/`pair:dedup` which may
                                    # consult feeder DB (mount even when
                                    # postgres profile is active; settle
                                    # CLI does not touch sqlite directly,
                                    # so the unused mount is harmless)
    env_file: [.env]
    stdin_open: true               # for interactive prompts (@inquirer)
    tty: true

  prometheus:
    profiles: ["monitoring"]
    # ... (see Step 4) ...

  grafana:
    profiles: ["monitoring"]
    # ... (see Step 4) ...

volumes:
  feeder-state-sqlite:
  feeder-artifacts:                 # shared between feeder + cli services
  postgres-data:
```

Key changes vs. today's compose file:

- `build.context` moves from `.` (feeder/) to `..` (offchain/) so the
  Dockerfile can see `cli/` and `feeder/` as siblings. `dockerfile`
  becomes `feeder/Dockerfile`.
- New named volume `feeder-artifacts` mounted at `/artifacts` in **all
  services**. This is where the CLI writes
  `state/<network>/protocol.json`, `state/<network>/clients/<id>/...`,
  and where the feeder reads `client_state_path` /
  `protocol_state_path` from.
- New `cli` service under `profiles: ["cli"]`. Same image, different
  entrypoint, short-lived. `stdin_open + tty` so `@inquirer/prompts`
  works for interactive CLI commands.

**4. `offchain/feeder/.env.example` — document new variables.**

Add:

```dotenv
# Path inside the container where the compiled CLI is installed.
# The Docker image sets this automatically to /app/cli/dist; only override
# if running the feeder outside Docker against a non-standard CLI checkout.
# CARDANO_FEEDER_CLI_DIST_ROOT=/app/cli/dist

# Where the CLI writes (and the feeder reads) protocol/client state files.
# In Docker this is the `feeder-artifacts` named volume mounted at /artifacts.
# In bare-node dev mode it defaults to offchain/cli/state/.
# CARDANO_ARTIFACTS_ROOT=/artifacts
```

The second var (`CARDANO_ARTIFACTS_ROOT`) is consumed wherever
client/protocol state paths are resolved. If this env-var pathway
does not exist yet today (the CLI uses `process.cwd()`-relative
`state/<network>/...`), the implementer must check the CLI's
`core/config.ts` and `core/intent-paths.ts` and add an env override
there before the Docker work — otherwise the CLI inside the container
will create files relative to `/app` instead of `/artifacts`. This is
a hard prerequisite for the CLI service to be useful in Docker.

**5. New: `offchain/Makefile` — operator ergonomics.**

A short Makefile at the **`offchain/`** root (so commands work from
either `feeder/` or `cli/`) wrapping the most common operator
gestures. No make-magic; just aliases that document themselves with
`make help`.

```makefile
# DIA Cardano Oracle — operator shortcuts.
# All targets run from offchain/feeder/ (where docker-compose.yml lives).

COMPOSE := docker compose -f feeder/docker-compose.yml --project-directory feeder

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F: '{printf "  %-22s %s\n", $$1, $$NF}'

.PHONY: build
build: ## Build the unified feeder + CLI image
	$(COMPOSE) --profile sqlite build

.PHONY: up
up: ## Start the feeder daemon (sqlite profile)
	$(COMPOSE) --profile sqlite up -d

.PHONY: up-postgres
up-postgres: ## Start the feeder daemon (postgres profile)
	$(COMPOSE) --profile postgres up -d

.PHONY: up-monitoring
up-monitoring: ## Start feeder + Prometheus + Grafana
	$(COMPOSE) --profile sqlite --profile monitoring up -d

.PHONY: down
down: ## Stop everything
	$(COMPOSE) down

.PHONY: logs
logs: ## Tail feeder logs
	$(COMPOSE) logs -f feeder-sqlite

.PHONY: cli
cli: ## Run a CLI command. Usage: make cli CMD="protocol"
	$(COMPOSE) --profile cli run --rm cli $(CMD)

.PHONY: bootstrap
bootstrap: ## End-to-end protocol bootstrap (one-shot)
	$(COMPOSE) --profile cli run --rm cli protocol:init
	$(COMPOSE) --profile cli run --rm cli config:parameterize
	$(COMPOSE) --profile cli run --rm cli config:reference-scripts
	$(COMPOSE) --profile cli run --rm cli config:bootstrap
```

The `bootstrap` target is illustrative; the implementer should adapt
it to the canonical bootstrap sequence documented in
`docs/operator/bootstrap.md` (whichever order is current there).

**6. Documentation deliverables — UPDATE existing files.**

These files exist today; they describe the bare-node (`npm run cli`)
workflow only. **Update them, do not create parallel "Docker setup"
files.** Each file gets a "Running with Docker" subsection that
mirrors the existing bare-node instructions step-for-step.

- [offchain/cli/README.md](offchain/cli/README.md) — for every
  command example currently written as `npm run cli -- <cmd>`, add a
  second example block immediately below:
  `docker compose --profile cli run --rm cli <cmd>`. Add a top-level
  "Running in Docker" subsection that explains the unified image
  (one image, daemon = feeder, on-demand = CLI), the
  `feeder-artifacts` volume layout, and how to inspect state files
  from the host (`docker compose run --rm cli ls /artifacts`).

- [offchain/feeder/README.md](offchain/feeder/README.md) — currently
  contains the daemon-only Docker quickstart. Expand the "Docker"
  section into three subsections:
  - **Daemon only**: existing `docker-compose --profile sqlite up`
    flow.
  - **Daemon + monitoring**: `--profile sqlite --profile monitoring up`,
    Grafana on port 3000.
  - **Admin commands (CLI)**: `docker compose --profile cli run --rm
    cli <command>`. List the top-10 commands an operator needs in
    practice (protocol, wallet, wallet:utxos, protocol:init,
    client:init, receiver:bootstrap, receiver:top-up,
    reference-scripts:publish-client, settle, pair:burn).
  - **One-shot full bootstrap**: `make bootstrap` or the equivalent
    series of `docker compose run --rm cli ...` calls.

- [README.md](README.md) (repo root) — the project README currently
  points at the two sub-READMEs. Add a single paragraph "Running with
  Docker" that says: "Both the feeder daemon and all CLI admin
  commands ship in one Docker image. See
  [`offchain/feeder/README.md`](offchain/feeder/README.md#docker) for
  the canonical quickstart." Do not duplicate compose commands here.

- Any operator runbook under `docs/operator/` that today says
  `npm run cli -- <cmd>` — update to show both forms with the Docker
  form **listed first** (since that is the supported deployment).
  If no such runbook exists yet, mark this as a separate doc task; do
  not block this Step on writing one.

**Volume layout reference (for both Dockerfile + README):**

| Host path | Container path | Mode | Used by | Contents |
|---|---|---|---|---|
| `./config/` | `/config` | ro | feeder, cli | modular YAML config |
| `.env` | env_file | ro | feeder, cli | secrets + selectors |
| Volume `feeder-state-sqlite` | `/state` | rw | feeder, cli | SQLite DB, scanner checkpoint, JSONL logs |
| Volume `feeder-artifacts` | `/artifacts` | rw | feeder, cli | protocol/client/pair JSON state files |
| Volume `postgres-data` | (postgres svc) | rw | postgres | Postgres data dir (postgres profile only) |
| Volume `grafana-data` | `/var/lib/grafana` | rw | grafana | dashboard state (monitoring profile only) |

**Operator use cases — every flow we support, with exact commands.**

The README must document each of these explicitly. The list is the
acceptance source-of-truth: if any flow is missing from the README
the step is not done.

1. **First-time bootstrap (fresh Preview deployment):**
   ```bash
   cp offchain/feeder/.env.example offchain/feeder/.env
   # edit .env: Blockfrost keys, signer keys, etc.
   cd offchain && make build
   make cli CMD="wallet:create"
   make cli CMD="protocol:init"
   make cli CMD="config:parameterize"
   make cli CMD="config:reference-scripts"
   make cli CMD="config:bootstrap"
   make cli CMD="client:init"
   make cli CMD="receiver:bootstrap"
   make cli CMD="receiver:parameterize"
   make cli CMD="reference-scripts:publish-client"
   ```

2. **Start the feeder (sqlite):**
   `make up` then `make logs`.

3. **Start the feeder with monitoring:**
   `make up-monitoring`, open `http://localhost:3000`.

4. **Top up the receiver:**
   `make cli CMD="receiver:top-up --amount-lovelace 1000000000"`.

5. **Trigger a manual settle (until Phase 3.7 auto-settle lands):**
   `make cli CMD="settle"`.

6. **Burn a pair / dedup a pair / inspect protocol state:**
   `make cli CMD="pair:burn --symbol BTC/USD"`
   `make cli CMD="pair:dedup --symbol BTC/USD"`
   `make cli CMD="protocol"`

7. **Inspect what's inside the artefacts volume:**
   `make cli CMD="wallet:utxos"`
   or for raw inspection:
   `docker compose --profile cli run --rm --entrypoint sh cli -c "ls -R /artifacts"`

8. **Switch network (Preview → Mainnet):**
   set `CARDANO_NETWORK=Mainnet` in `.env`, restart. All artefact and
   state paths inside the container key off `CARDANO_NETWORK`; the
   `feeder-artifacts` volume can hold both networks side by side
   under `/artifacts/preview/` and `/artifacts/mainnet/`.

9. **Run the CLI against a host-side state directory (dev only):**
   ```bash
   docker compose --profile cli run --rm \
     -v $(pwd)/offchain/cli/state:/artifacts \
     cli protocol
   ```
   Useful for inspecting an existing local state tree from a
   throwaway container.

**Acceptance — Step 4.5 is done when:**

- `cd offchain && docker compose -f feeder/docker-compose.yml --profile sqlite build`
  succeeds and produces image `dia-cardano-feeder:local`.
- `docker compose --profile sqlite up -d` brings the feeder up and
  `curl localhost:8080/health/live` returns 2xx (no regression — fixes
  the latent lib-bridge bug since CLI dist is now in the image).
- `docker compose --profile cli run --rm cli protocol` runs the
  CLI's `protocol` command against the mounted config and prints
  protocol state without errors.
- `docker compose --profile cli run --rm cli help` prints the full
  command list.
- The `feeder-artifacts` volume is shared: a file written by `make
  cli CMD="protocol:init"` is visible to the daemon when it starts.
- `offchain/feeder/README.md`, `offchain/cli/README.md`, and the root
  `README.md` all reflect the unified-image model and the 9 use
  cases above.
- `make help` lists every target documented in the Makefile.
- No `npm`/Node install is required on the host for any of the 9 use
  cases above. The only host prereqs are Docker, `docker compose`,
  `make`, and an editor for `.env`.

**Ordering vs. other Steps:**

- Step 4.5 depends on **Step 2** (metrics rename) and **Step 3**
  (route rename) being merged first, so the Dockerfile and README
  examples reference final names — no churn.
- Step 4.5 must be merged before **Step 4** (monitoring profile)
  because Step 4's `prometheus.yml` scrape target is the compose
  service name `feeder-sqlite:8080`, which only stabilises once this
  step has finalised service names.
- Step 4.5 is independent of **Step 5** (batch tx) and **Step 6**
  (confirmation_depth YAML).

###### Step 5 — 3.4.5.i One Cardano tx per flush

**Prerequisite verification — CONFIRMED (audit 2026-05-26):**

`buildBatchOracleUpdateTx` at
`offchain/cli/src/lib/transactions/build-batch-oracle-update.ts:66` already
accepts mixed mint + update entries in one call:

- Each `BatchUpdateEntry` carries an `isCreate: boolean` (lines 33–42).
- The build loop at lines 201–209 emits `collectFrom` for entries with
  `isCreate=false` (update redeemers).
- The build loop at lines 221–226 emits `mintAssets` for entries with
  `isCreate=true` (mint redeemers).
- The output loop at lines 236–245 produces continuation outputs for all
  entries regardless of role.

No CLI changes are required. Proceed directly with the feeder integration.

**Implementation status (2026-05-26):**

- [x] Batch submit path implemented in `src/lib-bridge/index.ts`.
- [x] `coalescer.ts` flushes N=1 through the single path and N>=2 through
  the batch path.
- [x] `queue.ts` and `queue-manager.ts` preserve batch ordering and keep one
  lane per `(clientState, protocolState)`.
- [x] `max_batch_size` and `size_fallback_enabled` are wired from YAML.
- [x] Logging now includes batch-level transaction summaries and per-intent
  batch membership metadata.
- [x] Tests cover single, batch, mixed member actions, chunking, and
  oversize split-and-retry.

**Acceptance:** implemented in code and `npm test` passes. Preview evidence
run remains part of Phase 4, not Step 5.

###### Step 6 — 3.8 Rollbacks & finality

**Implementation status (2026-05-26):**

- [x] Source-chain `block_scanner.confirmations` is wired from YAML.
- [x] Destination `cardano.confirmation_depth` is wired from YAML.
- [x] `PriceCacheEntry` carries confirmation depth and the prices API exposes it.
- [x] `TxDroppedFromChain` increments `dia_bridge_transactions_reorg_total`
  in addition to the failed counter.
- [x] Long wait helpers in `offchain/cli/src/core/chain-helpers.ts` perform
  periodic `assertTxStillOnChain(...)` checks during extended waits.
- [ ] Finality narrative still needs a dedicated README/API explanation.
- [ ] Live verification of non-default depths remains pending for the
  evidence run.

##### 3.5.1 — Persistence — **DONE (audit 2026-05-26)**

See "Step 1" in the Implementation contract above for the verification
checklist. Both SQLite and Postgres drivers, all three tables
(`processed_events`, `chain_state`, `transaction_log`), repos, and tests
exist in `src/persistence/db.ts` (467 lines).

##### 3.5.2 — HTTP API

Endpoint shape aligned with `diadata-org/Spectra-interoperability/services/bridge`.

- [x] `src/api/server.ts`: HTTP server (default `:8080`).
- [x] `src/api/health.ts`:
  - `GET /health` — liveness
  - `GET /health/ready` — readiness: registry reachable + last submission age within budget
  - `GET /health/live` — liveness alias
- [x] `src/api/prices.ts`:
  - `GET /api/v1/prices` — full price cache
  - `GET /api/v1/prices/{symbol}` — single symbol lookup
- [x] `src/api/symbols.ts`:
  - `GET /api/v1/symbols` — list of tracked symbols
  - `GET /api/v1/symbols/{symbol}/updates` — recent update history for a symbol
- [x] `src/api/transactions.ts`:
  - `GET /api/v1/transactions/{txHash}` — Cardano tx record from DB
- [x] `src/api/chains.ts`:
  - `GET /api/v1/chains` — DIA source chain status (last scanned block, lag)
  - `GET /api/v1/chains/{id}/status` — single chain status
- [x] Request instrumentation in `server.ts` emits HTTP counters and latency histograms.

##### 3.5.3 — Prometheus metrics (`/metrics`)

Implemented in `src/api/metrics.ts` using `prom-client`.

**Metric naming: use `dia_bridge_*` prefix (same as Spectra).**
Rationale: we ARE a bridge service (DIA Lasernet → Cardano). Using `dia_bridge_*`
makes our metrics immediately recognisable to anyone familiar with Spectra and
allows a single Prometheus instance to scrape both Spectra and our feeder with
unified dashboards. The `destination_chain` constant label (see below)
disambiguates our metrics from Spectra's without a different prefix.

**Standard constant labels — set at registry level, appear on every metric:**

```yaml
destination_chain: "cardano"
network: "preview" | "mainnet"   # from CARDANO_NETWORK env
source_chain_id: "1050" | "10050"  # from YAML chains.yaml
```

These three labels are registered once on the `prom-client` default registry
(not repeated on each metric definition). Every scraped series automatically
carries them — zero overhead at call sites.

**Gap analysis vs Spectra (`diadata-org/Spectra-interoperability/services/bridge`):**

| Category | Spectra has | Our plan | Status |
|---|---|---|---|
| Intent lifecycle counters | `dia_bridge_intents_scanned_total{symbol,scanner_type}` etc. | vague list | Align names + add labels |
| Tx counters | `bridge_transactions_submitted_total{chain}` | planned | Add `{symbol,error_code}` labels |
| End-to-end latency | `bridge_end_to_end_latency_seconds{symbol}` | one histogram | Break into stages |
| Chain/scanner health | `bridge_chain_connection_status`, `blockLag`, `lastBlockNumber` | none | Add |
| Price deviation | `bridge_price_deviation_percent{symbol}` histogram | none | Add |
| HTTP middleware | `bridge_http_requests_total{method,endpoint,status}` | none | Add |
| Reorg/rollback counter | implicit in `tx_failed` | implicit | Add explicit counter |
| Receiver balance | not applicable (EVM) | planned | Cardano-specific |
| Pair staleness | not in Spectra | planned | Cardano-specific |
| Per-intent-hash gauges | `bridge_intent_timestamp{intent_hash,symbol}` | — | **Skip** (high cardinality) |
| Failover metrics | `bridge_failover_*` | — | **Not applicable** (no Hyperlane on Cardano) |

**Metrics status** (all prefixed `dia_bridge_`, constant labels applied automatically):

*Event pipeline counters:*

- [x] `dia_bridge_events_detected_total{scanner_type}` — raw EVM logs seen
- [x] `dia_bridge_events_duplicate_total` — dedup cache hits
- [x] `dia_bridge_events_invalid_total{reason}` — events that failed parsing/validation
- [x] `dia_bridge_intents_scanned_total{symbol, scanner_type}` — intents entering the pipeline
- [x] `dia_bridge_intents_routed_total{symbol, router_id}` — intents accepted by a router
- [x] `dia_bridge_intents_filtered_total{symbol, router_id, reason}` — intents dropped by policy
  (`reason` values: `"price_deviation"`, `"time_threshold"`, `"expired"`, `"aged_out"`)

*Cardano tx counters:*

- [x] `dia_bridge_transactions_submitted_total{symbol, client_id}` — txs submitted on-chain
- [x] `dia_bridge_transactions_confirmed_total{symbol, client_id}` — txs confirmed
- [x] `dia_bridge_transactions_failed_total{symbol, client_id, error_code}` — txs failed
  (`error_code` = `FeederErrorCode`: `WalletInsufficientFunds`, `NonMonotonicNonce`,
  `TxDroppedFromChain`, `ProviderLag`, `ReceiverInsufficientFunds`, etc.)
- [x] `dia_bridge_transactions_reorg_total{symbol, client_id}` — txs lost to Cardano rollback
  (explicit counter, not buried in `failed_total`; incremented on `TxDroppedFromChain`)

*Latency histograms — broken into pipeline stages:*

- [x] `dia_bridge_scan_to_processing_seconds{symbol}` — EVM event detected → processing start
- [x] `dia_bridge_processing_to_submission_seconds{symbol, client_id}` — processing → Cardano tx submitted
- [x] `dia_bridge_submission_to_confirmation_seconds{symbol, client_id}` — submitted → confirmed on Cardano
- [x] `dia_bridge_end_to_end_latency_seconds{symbol, client_id}` — EVM intent registration → Cardano confirmed

*Price quality:*

- [x] `dia_bridge_price_deviation_percent{symbol}` — histogram of `abs((new-old)/old)*100`
  computed by router policy. Buckets: 0.01%, 0.1%, 0.5%, 1%, 5%, 10% (mirrors Spectra).
- [x] `dia_bridge_price_age_seconds{symbol}` — age of the price inside the intent at processing time

*Chain/scanner health:*

- [x] `dia_bridge_scanner_last_block{chain_id, scanner_type}` — last processed EVM block (gauge)
- [x] `dia_bridge_scanner_block_lag{chain_id}` — blocks behind chain tip (gauge)
- [x] `dia_bridge_scanner_rpc_errors_total{chain_id, error_type}` — RPC call failures

*Cardano-specific (no Spectra equivalent):*

- [x] `dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds{symbol, client_id}` —
  last confirmed on-chain pair timestamp (gauge). Grafana alert:
  `time() - metric > time_threshold * 2` → CRITICAL (pair stale).
- [ ] `dia_bridge_cardano_receiver_balance_lovelace{client_id}` — receiver UTxO balance (gauge).
  Polled after every confirmed tx. Alert when `< protocol_fee * 10`.
- [ ] `dia_bridge_cardano_coordinator_balance_lovelace{client_id}` — coordinator UTxO balance (gauge).
  Alert when low (settle needed).
- [ ] `dia_bridge_cardano_receiver_topup_warnings_total{client_id}` — counter incremented on
  every `ReceiverInsufficientFunds` error (surfaces trend before hard failure).
- [x] `dia_bridge_cardano_pair_is_create{symbol, client_id}` — gauge (1=mint, 0=update) for
  the last submitted tx. Alerts on unexpected re-mints.

*HTTP middleware:*

- [x] `dia_bridge_http_requests_total{method, endpoint, status}` — auto-instrumented
- [x] `dia_bridge_http_request_duration_seconds{method, endpoint}` — request latency histogram

**Acceptance**: `curl :8080/health`, `/health/ready`, `/metrics`, `/api/v1/prices`
all respond; a feeder restart resumes from `chain_state.last_processed_block`;
switching `DATABASE_DRIVER` between sqlite and postgres in
`infrastructure.yaml` works without code changes; Grafana staleness alert
fires when a pair has not been updated for > `time_threshold * 2`.

#### Phase 3.6 — Dockerization — **partially done**

**What exists today** (`offchain/feeder/`):

- [x] `Dockerfile` — multi-stage (`node:22-alpine`): build stage compiles
  TypeScript → JavaScript; runtime stage copies `dist/` + prod deps only.
  Exposes port 8080. `HEALTHCHECK` on `/health/live` (30 s interval, 3 retries).
  Entrypoint: `node dist/cmd/feeder/main.js --config /config`.
  Config mounted read-only at `/config`; state at `/state`.
- [x] `docker-compose.yml` — two profiles:
  - `sqlite`: feeder only, state written to named volume `feeder-state-sqlite`.
    `DATABASE_DRIVER=sqlite`. Health probe on `/health/live`.
  - `postgres`: feeder + `postgres:15-alpine` sidecar. Feeder starts only
    after postgres healthcheck passes. `DATABASE_DRIVER=postgres`.
    `DATABASE_DSN_PREVIEW` / `DATABASE_DSN_MAINNET` from `.env`.

**What is still pending:**

- [ ] **Unified feeder + CLI image (Step 4.5).** The current Dockerfile
  only builds the feeder package and does not include `offchain/cli/`.
  This blocks operators from running CLI admin commands (bootstrap,
  settle, pair lifecycle, treasury) in Docker, **and** leaves a latent
  runtime bug: the feeder's `lib-bridge` dynamically imports CLI
  modules from `../../../cli/src` at runtime, a path that does not
  exist inside the current image. Step 4.5 (below) rewrites the
  Dockerfile to build both packages, adds a `cli` compose service, a
  shared `feeder-artifacts` volume, a top-level `Makefile`, and
  updates all three READMEs.
- [ ] `monitoring` docker-compose profile: add `prometheus` and `grafana`
  services to `docker-compose.yml` under a `monitoring` profile.
  - Prometheus: scrapes `host.docker.internal:8080/metrics` (or service
    name if feeder is in same compose network). Ships a `prometheus.yml`
    mounted read-only with scrape config.
  - Grafana: pre-provisioned datasource (Prometheus) and one dashboard
    JSON with panels: pair staleness gauge, receiver balance gauge,
    tx confirmed/failed counters, end-to-end latency histogram.
  - Alert rules:
    - `time() - dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds{symbol} > time_threshold * 2`
      → CRITICAL (pair stale)
    - `dia_bridge_cardano_receiver_balance_lovelace{client_id} < protocol_fee * 10`
      → WARNING (receiver needs top-up)
    - `dia_bridge_cardano_coordinator_balance_lovelace{client_id} < settle_threshold`
      → WARNING (settle needed)
- [ ] `README.md` for `offchain/feeder/`: `cp .env.example .env`,
  `docker-compose --profile sqlite up`, `--profile postgres up`,
  `--profile sqlite --profile monitoring up` (monitoring overlay).
  Link to operator runbook.

**Acceptance**: `docker-compose --profile sqlite up` already works (Dockerfile
and compose exist). `--profile monitoring up` brings Prometheus + Grafana;
staleness alert fires when a pair stalls; receiver balance alert fires when
balance drops below threshold. Both profile combos serve `/health` on 8080.

#### Phase 3.7 — Automatic settle tx (post-M2, design TBD)

**Status: NOT designed.** The settle flow currently requires a manual
CLI invocation (`npm run cli -- settle ...`). This phase will make the
feeder trigger settle automatically under defined conditions.

Open design questions (must be answered before implementation):

- **When to trigger**: on a timer (e.g. every N hours)? When the
  coordinator UTxO balance falls below a threshold? After a configurable
  number of confirmed oracle-update txs? Or on an explicit operator signal
  via API?
- **Who triggers**: the feeder daemon itself (needs coordinator-spend
  authority) or a separate sidecar process?
- **Authorization**: settle requires a `config_admins` signer. Is the
  feeder wallet the same as the admin wallet in production, or separate?
  If separate, the feeder cannot sign settle txs without key access.
- **Failure handling**: if settle fails (e.g. wallet drained), how does
  the feeder surface this? As a `FeederErrorCode`? Via `/health/ready`?

Planned items (subject to design resolution):

- [ ] Define settle trigger policy in YAML:
  `settle.mode: manual | timer | threshold | tx_count`.
- [ ] Implement `src/lib-bridge/settle.ts`: `submitSettle(params)` wrapping
  `buildSettleTx` from `offchain/cli/src/lib/transactions/build-settle.ts`.
- [ ] Wire into daemon loop: check settle condition after each confirmed
  oracle-update tx; submit settle if condition met.
- [ ] Add metric `cardano_oracle_settle_triggered_total{client_id}` and
  `cardano_oracle_coordinator_balance_lovelace{client_id}` gauge so
  Grafana can alert on low coordinator balance before settle is needed.
- [ ] Tests: settle trigger at threshold, settle failure surfaced on
  `/health/ready`.

**Acceptance**: feeder auto-triggers a settle tx when coordinator balance
falls below the configured threshold; settle failure is surfaced in
`/health/ready` and in the Prometheus metrics.

#### Phase 3.9 — Batch settle CLI (post-M2, contract-ready)

**Status: NOT implemented in CLI; contract support verified on-chain.**

The Cardano contracts already allow a single settle tx to drain multiple
Receiver UTxOs at once. Verified on-chain in the coordinator, receiver,
and payment-hook validators. The core coordinator types are:

```aiken
pub type SettleReceiver { receiver_policy_id: PolicyId, receiver_asset_name: AssetName }
pub type SettleManifest { receivers: List<SettleReceiver> }
// CoordinatorRedeemer variant: ApplySettle(SettleManifest)
```

The current CLI `settle.ts` / `buildSettleTx` always produces a manifest
with exactly one receiver entry. A batch variant would:

1. Accept N `(clientStatePath, receiverUtxo)` pairs as CLI arguments.
2. Build one `SettleManifest` listing all N receivers.
3. Spend all N Receiver UTxOs and the single PaymentHook UTxO in the same tx.
4. Persist updated state for each client after confirmation.

**Why this matters operationally:** in a multi-client deployment every
settle invocation today requires one tx per client. A batch tx reduces
on-chain fees, reduces coordinator churn, and simplifies automation.

**What must be decided before implementing:**

- Same signer/authorization design questions as 3.7 (admin key, feeder
  wallet, or separate key).
- How to handle partial failure (one receiver stale, others valid).

**Planned items (not yet scheduled):**

- [ ] Extend `buildSettleTx` signature to accept a list of receiver/client
  contexts; build the full `SettleManifest` with all entries.
- [ ] Add `settle --all` flag (or `batch-settle`) to the CLI that
  discovers all receivers under a given `protocolStatePath` and settles
  them in one tx.
- [ ] Update state files for all N clients after confirmation.
- [ ] Add `--dry-run` to preview total lovelace before submitting.

**Acceptance**: `dia-cli settle --all --protocol-state <path>` submits a
single tx that drains all receivers to the PaymentHook and saves updated
state for each client.

#### Phase 3.8 — Rollbacks, finality, and consumer guarantees (M2-blocking)

**Status: partially handled today; formal finality API is M2 work.**

##### What "confirmed" means in our system today

When the feeder emits a `tx_confirmed` event or updates `/api/v1/prices`,
the Cardano tx has been **included in one block** and observed by at least
one indexer (Blockfrost primary, Koios or Blockfrost REST as fallback).
This is **probabilistically final but not cryptographically final**.

##### Cardano finality model

Cardano uses Ouroboros Praos. The security parameter is `k = 2160` blocks.
With ~20 s/block, the theoretical maximum rollback window is:

`k × 20 s = 43 200 s ≈ 12 hours`

In practice, rollbacks deeper than 1–2 blocks are essentially unobserved on
mainnet. The risk curve is:

| Confirmation depth | Practical rollback probability |
| --- | --- |
| 1 block (~20 s) | Very low (< 0.1% on mainnet) |
| 3 blocks (~1 min) | Negligible |
| 20 blocks (~7 min) | Near-zero |
| 2 160 blocks (~12 h) | Cryptographically impossible |

For a price oracle feed, 1-block confirmation is practically sufficient.
Consumer applications that need absolute guarantees (e.g. DeFi settlement)
should wait for their own depth threshold.

##### What we already handle — `TxDroppedFromChainError`

Already implemented in `offchain/cli/src/core/tx-onchain-check.ts`:

- After a tx confirms, the UTxO-wait phase polls every ~90 s via **both**
  Blockfrost and Koios independently.
- Only when **both providers** report the tx absent → `TxDroppedFromChainError`
  is thrown. This dual-provider consensus avoids false positives from
  transient indexer lag.
- `classifyError` maps it to `FeederErrorCode = "TxDroppedFromChain"`.
- The feeder logs the reorg, increments `dia_bridge_transactions_reorg_total`,
  and re-queues the intent on the next incoming source event.

##### Source chain (DIA Lasernet) rollback tolerance

The EVM scanner already trails the chain tip by `confirmations = 6` blocks
(currently hardcoded in `scanner-http.ts` — promoted to YAML as part of this
phase). Events from blocks within the trailing window are never checkpointed,
so a reorg within those 6 blocks causes the affected range to be re-scanned
automatically. The dedup cache (4 096 entries, 1-hour TTL) prevents
re-submitting the same intent twice.

##### How Spectra handles EVM finality

On EVM destination chains, Spectra configures a per-chain `confirmations`
count (number of blocks to wait before treating a tx as settled). It does NOT
follow chain-specific finality semantics (e.g. Ethereum's 2-epoch PoS finality
or Avalanche's sub-second finality) — it uses a fixed block count as a safe
approximation. Our equivalent for the Cardano destination is the
`cardano_confirmation_depth` setting in `infrastructure.<network>.yaml`
(default 1, configurable per deployment).

##### M2 work items (all values from YAML or env, never hardcoded)

- [x] Expose confirmation depth in `/api/v1/prices` response so consumers
  know at which block depth the price was declared confirmed. Field is populated
  from the same value used by the destination confirmation depth (next item),
  so consumers can correlate "what we waited for" with "what we report".
- [x] Make source-chain `confirmations` configurable via YAML
  (`block_scanner.confirmations`) in `infrastructure.<network>.yaml`. Currently
  hardcoded to `6n` in `scanner-http.ts`. The Zod loader must validate the
  field, the consumer in `scanner-http.ts` must read it, and
  `offchain/feeder/README.md` must document it (default value, valid range,
  what it means for reorg tolerance).
- [x] Add `cardano_confirmation_depth` setting for the destination chain in
  `infrastructure.<network>.yaml` (suggested location: under a new
  `cardano` block, sibling to `block_scanner`). Default value: **`1`**
  (preserves current behaviour for the M2 evidence run). The code that consumes
  it (`tx-confirmation.ts` or the bridge wrapper) must include a docstring
  explaining: "Number of blocks the feeder waits past inclusion before
  declaring `tx_confirmed`. Default 1 — practically final for oracle feeds.
  Operators needing stricter guarantees set it higher (3–5 for DeFi
  settlement, etc.). See README and Phase 3.8 for the finality discussion."
- [x] Document finality model in `offchain/feeder/README.md` (2026-05-26):
  what `confirmedAtDepth` means, Ouroboros Praos k=2160 model, reorg
  handling. The `/api/v1/prices` response already carries `confirmedAtDepth`.
- [x] `dia_bridge_transactions_reorg_total{symbol, client_id}` counter (see
  metrics section) — already planned; make sure it is distinct from
  `transactions_failed_total` so Grafana can alert on reorg rate separately.

#### Phase 3 acceptance (rolled up)

`npm run feeder:dev -- --config offchain/feeder/config/` against
`CARDANO_NETWORK=Preview` scans the live DIA testnet registry over both
HTTP and WS, applies routers, gates by `time_threshold` /
`price_deviation`, and submits Cardano Preview update transactions for
the 10 Catalyst pairs; restart resumes from persisted state; metrics
and `/prices` track every intent end-to-end.

## Phase 4 — End-to-end validation on Preview ↔ DIA testnet

Goal: produce reviewer-ready M2 evidence on Preview before touching mainnet.

D5 (wallet) is resolved — same wallet as the CLI (`CARDANO_WALLET_SEED_TESTNET`).
D6 (cadence) is configured — `time_threshold: 5m`, `price_deviation: 0.1%`.

### Phase 4.0 — Identify the 10 active pairs on DIA testnet

The router config currently lists pairs that were created manually with the
CLI. The DIA testnet attests a different, changing set of symbols. Before
minting anything on Cardano Preview, we must verify which symbols actually
have live `IntentRegistered` events on DIA testnet so that our 10 chosen
pairs will receive updates during the evidence window.

- [ ] **Scan DIA testnet for active symbols.** Run
  `npm run feeder:dev -- --config ./config --scan --dry-run --transport http`
  for 15–30 minutes and collect all enriched intent symbols. Sort by
  frequency. The top N (N ≥ 10) are the candidate pairs. Alternatively,
  query `eth_getLogs` for the last ~2 000 blocks on the testnet registry
  and decode unique symbols. Script:
  `offchain/cli/scripts/tools/scan-dia-intents.ts` (to be created).
- [ ] **Select 10 symbols** from the observed set. Prefer symbols with the
  highest intent frequency (updated most often), which maximises the
  number of captured Cardano tx hashes during the evidence window.
  Record the final selection and observed frequencies in a note under
  `docs/milestones/evidence/m2-pair-selection.md`.
- [ ] **Update the router config** (`config/routers/client-a.preview.yaml`)
  `conditions[0].value` list to match the 10 selected symbols exactly.

**Acceptance**: `--scan --dry-run` output shows intents for all 10 selected
symbols with no `policy-filtered` or `condition-filtered` rejections.

### Phase 4.1 — Initialize 10 pairs on Cardano Preview

The feeder's wallet must already hold the Pair UTxOs on Preview for the
selected symbols. Minting is an admin action (not the feeder's job at
runtime — see 3.4.5.c).

- [ ] For each of the 10 selected symbols that does NOT already have a
  minted Pair UTxO on Preview: run the CLI `pair:create` command
  (or equivalent `update` command that triggers `isCreate = true`).
  Use the same CLI wallet configured in `CARDANO_WALLET_SEED_TESTNET`.
- [ ] Verify all 10 pair UTxOs exist on Preview (via Blockfrost / Cardanoscan).
- [ ] Ensure the local pair-state JSON files are current (or let feeder
  startup reconciliation handle it via `reconcileAllDestinations`).

**Acceptance**: `reconcileAllDestinations` at feeder startup reports
10 pairs synced with no `stale` warnings.

### Phase 4.2 — Run feeder and capture evidence

- [ ] Run the feeder against Cardano Preview + DIA testnet for a
  **multi-day window** (minimum 48 h; 72 h preferred). Use WS transport
  for real-time delivery; HTTP polling as fallback.

  ```bash
  npm run feeder:dev -- --config offchain/feeder/config \
    --transport ws --log-level info 2>&1 | tee feeder-$(date +%Y%m%d).log
  ```

- [ ] Capture per the Catalyst evidence format:
  - [ ] daemon logs (structured JSON, one file per day),
  - [ ] every confirmed Cardano tx hash with the originating `intentHash`
    and `signer` (extracted from `state/preview/logs/events.jsonl`),
  - [ ] uptime stats (target ≥ 99.9% for the window),
  - [ ] freshness stats (per-pair p50/p95 latency from `IntentRegistered`
    to Cardano confirmation — derivable from `events.jsonl` timestamps),
  - [ ] anomaly events (skipped intents, retries, failures).
- [ ] **Settle accrued fees** at least once during the window. Capture the
  settle tx hash. This demonstrates the Settle flow is live.
- [ ] Package evidence under
  `docs/milestones/evidence/m2-preview-<YYYYMMDD-HHMMSS>/`
  with the same layout used by M1 evidence packs.

### Phase 4.3 — Demo video

- [ ] Record a short demo video (5–10 min) showing:
  - the live feeder dashboard / logs,
  - the feed status for the 10 pairs (`/prices` or `events.jsonl`),
  - a few representative tx hashes verified on Cardanoscan and the
    DIA testnet explorer.

**Acceptance**: evidence pack contains verified tx hashes for ≥ 10 pairs,
structured logs covering the full window, a `pair-selection.md` note
explaining why those 10 symbols were chosen, and a demo video.

## Phase 5 — Cardano Mainnet rollout

Goal: deliver the Catalyst-required mainnet evidence.

Depends on **D1**, **D5** confirmed for mainnet. Blocked until Phase 4
(feeder end-to-end on Preview) is complete.

- [ ] Submit `config:update` on **Cardano Mainnet** with
  `source_chain_id = 1050`,
  `verifying_contract = 0x5612599CF48032d7428399d5Fcb99eDcc75c06A7`,
  `authorized_dia_public_keys = [02fa12f4143fca6652fa5a365fd1ada14495aab0dd3c1e568755e2230b38a4706d, 02571284d2657052e68dc506c879f710d997a9801a5502339ff22f26bf85b958bd]`.
  Capture evidence under `docs/milestones/evidence/m2-config-update-mainnet-<date>/`.
- [ ] Regenerate any test fixtures that hard-code `sourceChainId = 100640`
  and the prior `verifyingContract`. Targets:
  `offchain/cli/src/__tests__/run-tests.ts`, `oracle/intent-create.ts`,
  `core/dia-intent.ts`, `init/protocol-init.ts`,
  `init/config-update-create.ts` (and any others surfaced by `grep`).
- [ ] Re-run the Aiken contract test suite and the off-chain Lucid emulator
  benchmark against the regenerated fixtures; fail the phase if any test
  regresses.
- [ ] Verify Phase 1 mainnet `config:update` is in place (done above).
- [ ] Promote the feeder config to `feeder.mainnet.yaml` and target the
  mainnet registry `0x5612…06A7` on `https://rpc.diadata.org`.
- [ ] Run the feeder against Cardano Mainnet + DIA mainnet for the
  Catalyst evidence window. Capture the same artifact set as Phase 4
  but tagged `mainnet`.
- [ ] Package evidence under
  `docs/milestones/evidence/m2-mainnet-<YYYYMMDD-HHMMSS>/`.
- [ ] Update the M2 Proof-of-Achievement document and submit to Catalyst.

**Acceptance**: verified Cardano Mainnet tx hashes covering the 10
Catalyst pairs over the evidence window; M2 PoA submitted.

---

## Workstream B/F items folded into M2

Some Workstream B (off-chain CLI) and Workstream F (deployment / docs) tasks
naturally finish during M2 and are tracked here so they do not slip:

- [ ] Developer documentation aligned with M2 acceptance criteria
  (oracle configuration, all relevant smart contracts, integration
  example for the feeder), published on the DIA developer documentation
  website (Workstream F).
- [ ] `run-all-cli.sh` updated so the Preview end-to-end smoke test
  exercises the post-Phase-2 pure builders (Workstream B).

## Annex A — Env hygiene (network endpoints out of code)

Goal: eliminate every hardcoded network endpoint, chain id, registry
address, RPC/WS/explorer URL from the CLI source so that switching
between Cardano Preview ↔ DIA Testnet and Cardano Mainnet ↔ DIA Mainnet
is a single env flip (`CARDANO_NETWORK`). Implemented as part of M2
because the feeder (Phase 3) will read the same env block.

**Scheme:** one `.env`, suffix `_TESTNET` / `_MAINNET` on **every**
endpoint, credential and secret. `CARDANO_NETWORK` is the only
unsuffixed variable; it selects which suffix the code reads.
`CARDANO_NETWORK=Preview` → `*_TESTNET`; `CARDANO_NETWORK=Mainnet` →
`*_MAINNET`. This lets a single `.env` carry both environments' creds
side by side; switching networks is a one-line change.

Full env block (added to / replacing `offchain/cli/.env.example`):

```dotenv
# Active network selector. ONLY unsuffixed variable in the file.
# Supported: Preview | Mainnet. Drives which *_TESTNET / *_MAINNET
# values the CLI reads.
CARDANO_NETWORK=Preview

# Cardano provider switch. Network-agnostic.
CARDANO_PROVIDER=Blockfrost   # Blockfrost | Koios

# --- Cardano — Testnet (Preview) ---
BLOCKFROST_PROJECT_ID_TESTNET=
BLOCKFROST_API_URL_TESTNET=https://cardano-preview.blockfrost.io/api/v0
KOIOS_API_URL_TESTNET=https://preview.koios.rest/api/v1
CARDANO_WALLET_SEED_TESTNET=
CARDANO_PRIVATE_KEY_TESTNET=

# --- Cardano — Mainnet ---
BLOCKFROST_PROJECT_ID_MAINNET=
BLOCKFROST_API_URL_MAINNET=https://cardano-mainnet.blockfrost.io/api/v0
KOIOS_API_URL_MAINNET=https://api.koios.rest/api/v1
CARDANO_WALLET_SEED_MAINNET=
CARDANO_PRIVATE_KEY_MAINNET=

# --- DIA source — Testnet (paired with Cardano Preview) ---
DIA_SOURCE_CHAIN_ID_TESTNET=10050
DIA_RPC_URL_TESTNET=https://testnet-rpc.diadata.org
DIA_WS_URL_TESTNET=wss://testnet-rpc.diadata.org
DIA_REGISTRY_ADDRESS_TESTNET=0xF8c614A483A0427A13512F52ac72A576678bE317
DIA_EXPLORER_URL_TESTNET=https://testnet-explorer.diadata.org
DIA_EVM_PRIVATE_KEY_TESTNET=
DIA_WS_CREDENTIAL_TESTNET=

# --- DIA source — Mainnet (paired with Cardano Mainnet) ---
DIA_SOURCE_CHAIN_ID_MAINNET=1050
DIA_RPC_URL_MAINNET=https://rpc.diadata.org
DIA_WS_URL_MAINNET=wss://rpc.diadata.org
DIA_REGISTRY_ADDRESS_MAINNET=0x5612599CF48032d7428399d5Fcb99eDcc75c06A7
DIA_EXPLORER_URL_MAINNET=https://explorer.diadata.org
DIA_EVM_PRIVATE_KEY_MAINNET=
DIA_WS_CREDENTIAL_MAINNET=

# --- DIA EIP-712 domain (network-independent) ---
DIA_DOMAIN_NAME=DIA Oracle
DIA_DOMAIN_VERSION=1.0

# --- Tx confirmation timeouts (network-agnostic, optional) ---
# TX_CONFIRMATION_PRIMARY_TIMEOUT_MS=180000
# TX_CONFIRMATION_KOIOS_ATTEMPTS=60
# TX_CONFIRMATION_KOIOS_DELAY_MS=3000
# TX_CONFIRMATION_BLOCKFROST_ATTEMPTS=30
# TX_CONFIRMATION_BLOCKFROST_DELAY_MS=6000
```

Tasks (implemented 2026-05-21):

- [x] Add `pickNetworkEnv(name)` helper in
  `offchain/cli/src/core/config.ts` that reads `<name>_TESTNET` when
  `CARDANO_NETWORK=Preview` and `<name>_MAINNET` when
  `CARDANO_NETWORK=Mainnet`.
- [x] Extend `getCliConfig()` to centralize **every** per-network
  read: Blockfrost project id and API URL, Koios API URL, wallet
  seed / private key, DIA chain id / RPC / WS / registry / explorer,
  DIA EVM private key, DIA WS credential, DIA EIP-712 domain.
- [x] Refactor every consumer (`core/lucid.ts`, `oracle/intent-sign.ts`,
  `init/protocol-init.ts`, `oracle/intent-create.ts`,
  `scripts/tools/probe-dia-ws.ts`, `scripts/emulator-benchmark.ts`,
  `scripts/run-all-cli.sh`) so that no `process.env.<unsuffixed>` read
  remains for per-network vars.
- [x] Strip the obsolete chain-id `100640` and registry address from
  the CLI usage example in `offchain/cli/src/index.ts`; point the user
  at `.env` for canonical defaults.
- [x] Replace `offchain/cli/.env.example` with the full block above so
  a fresh `cp .env.example .env` carries every endpoint pre-filled;
  operators only fill secrets (Blockfrost project ids, wallet seeds,
  signing keys).

**Out of scope (tracked in Phase 5):** test fixtures in
`offchain/cli/src/__tests__/run-tests.ts` still carry the legacy
`sourceChainId = 100640`. They are regenerated during Phase 5 alongside
the Mainnet `config:update`, as already listed in that phase's tasks.

**Acceptance**: `grep -rE "(diadata\\.org|0xF8c614|0x5612599|100640|1050|10050)" offchain/cli/src offchain/cli/scripts` returns
only test files (`__tests__/`) and no source-code matches outside them.

## Annex B — DIA Spectra Bridge: canonical reference for the feeder

The Cardano feeder follows the DIA Spectra Bridge architecture so DIA ops
can configure it with the same operational primitives they use for EVM
destinations.

**Canonical source:** `diadata-org/Spectra-interoperability/services/bridge`
(Go service). Confirmed 2026-05-21 by `gh api` inspection of the repo;
the `config.feeder.txt` example provided by the client matches the
`RouterConfig` schema defined in
`services/bridge/config/event_definitions.go` and
`services/bridge/config/modular_types.go`.

**Why other DIA / Protofire feeders are NOT relevant references:**

- `protofire/dia-xrpl-feeder`, `diadata-org/soroban-oracle-feeders` →
  legacy pre-Spectra pattern, poll `api.diadata.org` REST directly. Not
  intent-based.
- `diadata-org/dia-kadena-oracles`, `protofire/dia-midnight-oracle` →
  on-chain contracts + deploy CLI only; no daemon/feeder.
- `diadata-org/decentral-data-feeder` (Lumina) → a different DIA product
  (decentralized feeder network), unrelated architecture.

The Spectra Bridge is currently **EVM-only**; our Cardano feeder is the
first non-EVM consumer of `OracleIntentRegistry`.

## Annex C — Spectra Bridge → Cardano feeder mapping

Component-level parallelism. Left column is the Spectra reference, right
is what the Cardano feeder does in `offchain/feeder/src/`.

| Spectra (Go) | Cardano feeder (TS) | Notes |
| --- | --- | --- |
| `cmd/bridge/main.go` (`--config <dir>`) | `cmd/feeder/main.ts` | Same flag surface (`--config`, `--log-level`). Daemon, no subcommands. |
| `config/modular_loader.go` + 5 YAML files | `src/config/loader.ts` + same 5 YAML files | `infrastructure.yaml`, `chains.yaml`, `contracts.yaml`, `events.yaml`, `routers/*.yaml`. |
| `config/event_definitions.go` (RouterConfig) | `src/config/types.ts` (same shape) | DIA's existing router YAMLs drop in unchanged except destination block. |
| `internal/scanner/block_scanner_enhanced.go` | `src/source/scanner-http.ts` | `eth_getLogs` polling with checkpoint persistence. |
| `internal/bridge/event_source.go` (WS) | `src/source/scanner-ws.ts` | WebSocket subscribe + reconnect + HTTP fallback. |
| `internal/pipeline/extractor.go` | `src/source/extractor.ts` | ABI decode `IntentRegistered` topics+data. |
| `internal/pipeline/enricher.go` | `src/pipeline/enricher.ts` | `getIntent(intentHash)` view-call. |
| `internal/pipeline/transformer.go` | `src/pipeline/transformer.ts` | Stub; placeholder for future transforms. |
| `internal/processor/dedup_cache.go` | `src/processor/dedup-cache.ts` | LRU+TTL keyed on `intentHash`. |
| `internal/processor/price_cache.go` | `src/processor/price-cache.ts` | Last `(price, ts)` per `(routerId, dest, symbol)`. |
| `internal/processor/generic_event_processor.go` | `src/processor/event-processor.ts` | Central loop. |
| `pkg/router/generic_router.go` (dispatch) | `src/router/router.ts` | Trigger evaluator + destination iterator. |
| `pkg/router/generic_registry.go` | `src/router/registry.ts` | Enabled routers keyed by event. |
| Router `DestinationState` + `time_threshold` + `price_deviation` | `src/router/policy.ts` | Identical gating semantics. |
| `internal/bridge/write_client.go` (EVM ABI calls) | `src/submitter/cardano-write-client.ts` | **Adapted.** Consumes `buildOracleUpdateTx` / `buildBatchOracleUpdateTx` from `offchain/cli/src/lib/`. |
| `internal/contracts/nonce_manager.go` | (n/a) — replaced by UTxO in-flight lock | Cardano has no nonce; serialization key is `(updaterWallet, receiverUnit)`. |
| `internal/transaction/queue_manager.go` (per `(wallet, chainID)`) | `src/submitter/queue-manager.ts` (per `(updaterWallet, receiverUnit)`) | Same FIFO-per-key shape, different key. |
| `internal/transaction/queue.go` / `executor.go` | `src/submitter/queue.ts` | Serial: sign → submit → `awaitTxConfirmation` → `waitForUnitUtxoReplacement`. |
| `internal/database/schema.go` (Postgres) | `src/persistence/{db,schema,migrations}.ts` | **Dual driver.** SQLite default; Postgres opt-in via `DATABASE_DRIVER=postgres`. Same logical tables: `processed_events`, `chain_state`, `transaction_log` (Cardano-adapted columns). |
| `internal/api/server.go` (`/healthz`, `/prices`, etc.) | `src/api/{server,health,metrics,prices}.ts` | Same endpoints + `/metrics` via `prom-client`. |
| `internal/metrics/collector.go` | `src/api/metrics.ts` | Counters + histograms; same naming where it makes sense. |
| `internal/cron/cron_service.go` (mandatory periodic update) | (deferred to M3) | Spectra fires periodic updates if no event was seen for `time_threshold`. Out of M2 scope. |
| `internal/leader/onchain_monitor.go` (replica failover) | (deferred to M3) | Active-passive HA needs ≥2 instances; single-node is fine for M2 evidence. |
| `internal/processor/event_worker_pool.go` + `parallel_pipeline.go` | (deferred) | Optimization; sequential processing is enough until QPS demands otherwise. |

**RouterDestination extension for Cardano.** Spectra's destination block
hard-codes EVM concepts (`chain_id`, `contract`, `method.abi`,
`method.params`). For Cardano we ship a parallel `cardano:` block; both
forms can coexist in the same YAML so DIA can copy an EVM router and
just swap the destination payload:

```yaml
# EVM destination (Spectra-native)
destinations:
  - chain_id: 50312
    contract: 0xCACc...
    method:
      name: handleIntentUpdate
      abi: '{"name":"handleIntentUpdate", ...}'
      params: { intent: ${enrichment.fullIntent} }

# Cardano destination (added by this feeder)
destinations:
  - cardano:
      network: Preview                                    # Preview | Mainnet
      client_state_path: state/preview/clients/client-a.json
      protocol_state_path: state/preview/config-bootstrap.json
      tx_mode: single                                      # single | batch
    time_threshold: 1m
    price_deviation: "0.1%"
```

When the dispatcher sees `destination.cardano`, it routes to
`CardanoWriteClient`; when it sees `destination.method`, it errors out
loudly (we don't silently no-op EVM destinations — that would mask
misconfiguration).

## Annex D — Config canonicalisation: YAML as single source of truth

### Background

Phase 3.2 shipped a feeder that scans and enriches `IntentRegistered`
end-to-end. During operator review, two architectural defects
surfaced:

1. The runtime ABI was hard-coded in
   `offchain/feeder/src/source/abi.ts` as a TypeScript `as const`
   constant. The same ABI also appeared in
   `offchain/feeder/config/events.yaml` and
   `offchain/feeder/config/contracts.yaml`, but those copies were
   **inert** — nothing in the runtime read them. Editing the YAML
   had no effect on decoding.
2. Public source-side coordinates (DIA chain id, RPC URL, WS URL,
   registry address, explorer URL, EIP-712 domain) were declared in
   **both** `.env` (`DIA_RPC_URL_*` etc.) and YAML
   (`infrastructure.yaml::source`, `chains.yaml`, `contracts.yaml`).
   Two sources of truth for the same fact.

Both defects break the modularity spirit Spectra's design carries.
In the upstream DIA Bridge the YAML ABI is read at runtime by
`services/bridge/internal/pipeline/extractor.go` and
`services/bridge/internal/pipeline/enricher.go`, and the contract
addresses come from `contracts.yaml` — never from env.

Phase 3.2.5 fixes both defects.

### Decision

**YAML is the single source of truth for every public data point.**
`.env` carries only secrets and operational selectors. There is no
env-to-YAML interpolation: if a value appears in two YAML files (the
way Spectra's own configs do — `chains.yaml::dia-testnet::rpc_urls`
and `infrastructure.yaml::source.rpc_urls` carry the same string),
that repetition is intentional and inherited from upstream. Drift is
caught by the validator (Phase 3.2.5 tightens it).

### Env-vs-YAML field map

| Field | Source of truth |
| --- | --- |
| DIA source chain id | `infrastructure.<network>.yaml::source.chain_id` (also catalogued in `chains.yaml`) |
| DIA source RPC URLs | `infrastructure.<network>.yaml::source.rpc_urls` (also `chains.yaml::<id>.rpc_urls`) |
| DIA source WS URL | `infrastructure.<network>.yaml::source.ws_url` |
| DIA registry address | `contracts.yaml::<id>.address` (the entry whose `chain_id` matches `source.chain_id` and whose `type` is `registry`) |
| DIA explorer URL | `chains.yaml::<id>.explorer_url` (field added in 3.2.5) |
| `IntentRegistered` ABI | `events.yaml::event_definitions.IntentRegistered.abi` (authoritative; runtime parses + uses) |
| `getIntent` ABI | `events.yaml::event_definitions.IntentRegistered.enrichment.abi` (authoritative) |
| EIP-712 domain (name, version) | `contracts.yaml::<id>.eip712_domain.{name,version}` (field added in 3.2.5; feeder does not use it at runtime but a sibling CLI/monitor reads from the same place) |
| Active network selector | `.env::CARDANO_NETWORK` (only) |
| Provider selector | `.env::CARDANO_PROVIDER` (only) |
| Log level | `.env::LOG_LEVEL` or `--log-level` flag |
| Dry-run flag | `.env::DRY_RUN` or `--dry-run` flag |
| API listen addr / CORS | `.env::API_LISTEN_ADDR`, `API_ENABLE_CORS` |
| Metrics enabled / namespace | `.env::METRICS_ENABLED`, `METRICS_NAMESPACE` |
| Database driver | `.env::DATABASE_DRIVER` |
| SQLite path | `.env::DATABASE_PATH_<network>` |
| Postgres DSN (contains password) | `.env::DATABASE_DSN_<network>` |
| Blockfrost project id | `.env::BLOCKFROST_PROJECT_ID_<network>` |
| Updater wallet seed / PK | `.env::CARDANO_WALLET_SEED_<network>` / `CARDANO_PRIVATE_KEY_<network>` |
| DIA WS credential | `.env::DIA_WS_CREDENTIAL_<network>` |

### Env vars removed by Phase 3.2.5

These are deleted from `offchain/feeder/.env.example` because they
duplicate YAML facts:

- `DIA_SOURCE_CHAIN_ID_TESTNET`, `DIA_SOURCE_CHAIN_ID_MAINNET`
- `DIA_RPC_URL_TESTNET`, `DIA_RPC_URL_MAINNET`
- `DIA_WS_URL_TESTNET`, `DIA_WS_URL_MAINNET`
- `DIA_REGISTRY_ADDRESS_TESTNET`, `DIA_REGISTRY_ADDRESS_MAINNET`
- `DIA_EXPLORER_URL_TESTNET`, `DIA_EXPLORER_URL_MAINNET`
- `DIA_DOMAIN_NAME`, `DIA_DOMAIN_VERSION`

The CLI (`offchain/cli/.env.example`) keeps these vars because the
CLI's roles include intent signing — which **does** require the
EIP-712 domain and the registry address at runtime. The feeder does
not sign intents, only consumes them already signed; the feeder
therefore drops the EVM-side env block entirely.

### Why we keep five YAML files (not collapse to two)

A simpler design — fold `chains.yaml`, `contracts.yaml`,
`events.yaml` into a single combined file or into env — was
considered and rejected. The modular split exists in Spectra for
three reasons the feeder will eventually need:

1. **Contract version coexistence.** A future
   `IntentRegistryV2` would be a second entry in `contracts.yaml`
   and a parallel `IntentRegisteredV2` entry in `events.yaml`, with
   legacy routers still referencing the V1 names. Collapsing the
   files makes this expansion painful.
2. **Multiple event types.** When DIA adds `IntentCanceled` or
   `IntentReplaced`, `events.yaml` gains entries with their own
   ABIs and enrichment routing.
3. **Ops / engineering separation.** Routers (`routers/`) belong to
   ops; events and contracts belong to engineering. Folding them
   into one file mixes change-control boundaries.

The redundancy between files (RPC URLs in both `chains.yaml` and
`infrastructure.yaml::source`) is upstream behaviour and is left
as-is: validation runs at load time, drift fails loudly.

### Acceptance regression for "YAML changes change behaviour"

After 3.2.5 lands, the following operator workflow must work
end-to-end without any code change:

```sh
# 1. Edit the IntentRegistered ABI in events.yaml to add a fictional
#    `uint256 epoch` field at the end of the inputs list.
$ $EDITOR offchain/feeder/config/events.yaml

# 2. The validator catches the mismatch (the contract still emits
#    the original shape, so live logs won't decode against the new
#    ABI) — fails before the scanner connects.
$ npm run feeder:dev -- --config ./config --validate-only
[feeder] [ERROR] event_definitions.IntentRegistered.abi:
        decoded payload length 160 bytes does not match expected layout for the
        declared ABI (extra `epoch` input declared but absent on chain).

# 3. Revert events.yaml. Validation passes, scanner picks up logs
#    again.
$ git checkout offchain/feeder/config/events.yaml
$ npm run feeder:dev -- --config ./config --validate-only
[feeder] validation: 0 error(s), 0 warning(s).
```

(The exact diagnostic wording is illustrative — the implementation
decides the precise check, e.g. a sanity decode against a known
log fixture at validate time.)

## Annex E — Phase 3.4.5 implementation impact map

This annex enumerates every file the operational-robustness work touches,
the new modules it introduces, the decisions that shape them, the order
in which the seven sub-phases land, and the blast radius for the CLI.
It is the artifact the operator approves before any code change.

### E.1 Module impact map

#### New modules (clean home for new concerns)

| Path | Belongs to | Purpose |
| --- | --- | --- |
| `offchain/cli/src/core/tx-onchain-check.ts` | CLI core | `assertTxStillOnChain(lucid, txHash)` — single chain probe used by `chain-helpers` waits to short-circuit on rollback. |
| `offchain/cli/src/lib/reconcile/pair-state.ts` | CLI lib (reusable) | `reconcilePairStateFromChain({ clientStatePath, symbol })` — reads pair UTxO + datum on-chain, writes the JSON the bridge consumes. Pure builder; no submission. |
| `offchain/cli/src/lib/reconcile/index.ts` | CLI lib | Public re-export surface (consumed by feeder via `lib-bridge`). |
| `offchain/feeder/src/errors/codes.ts` | Feeder errors | `FeederErrorCode` enum + `FeederError` class carrying `{ code, message, remediation, cause? }`. |
| `offchain/feeder/src/errors/classify.ts` | Feeder errors | `classifyError(err): FeederErrorCode` — maps Lucid / bridge / chain-helpers errors to taxonomy. Single chokepoint, no `instanceof` checks scattered. |
| `offchain/feeder/src/errors/index.ts` | Feeder errors | Public re-export. |
| `offchain/feeder/src/submitter/preflight.ts` | Submitter | Cheap chain probes before tx build: wallet ADA, receiver UTxO ADA, expiry, monotonicity. Returns `null` on pass or a `FeederError` on fail. |
| `offchain/feeder/src/submitter/retry-policy.ts` | Submitter | `decideRetry(code, attempt): "skip" \| "retry" \| "halt"` + per-code backoff. Pure function, table-driven. |
| `offchain/feeder/src/submitter/lane-state.ts` | Submitter | Per-`(updaterWallet, receiverUnit)` lane status: `running \| blocked \| halted`. Read by `/healthz`; written by queue on `halt`. |
| `offchain/feeder/src/submitter/coalescer.ts` | Submitter | Per-lane coalescing window. Buffers `SubmitRequest`s for `coalesce_window` ms; flushes as single or batch based on count + `tx_mode`. |
| `offchain/feeder/src/lib-bridge/oracle-update.ts` | Bridge | `submitOracleUpdate` (extracted from current `index.ts`). |
| `offchain/feeder/src/lib-bridge/oracle-update-batch.ts` | Bridge | `submitOracleUpdateBatch` — new entry, wraps `buildBatchOracleUpdateTx`. |
| `offchain/feeder/src/lib-bridge/reconcile.ts` | Bridge | Thin shim over CLI's reconcile helper; same dynamic-import pattern as the others. |
| `offchain/feeder/src/lib-bridge/cli-loader.ts` | Bridge | The `Promise.all` of dynamic imports moves here so all three entries share one loader. Removes the 50-line import block currently duplicated inline. |

#### Modified modules

| Path | Change |
| --- | --- |
| `offchain/cli/src/core/chain-helpers.ts` | Raise defaults: `maxAttempts 20 → 800` for `waitForUnitUtxoReplacement`, `waitForOutRefAvailable`, `waitForOutRefGone`; `12 → 480` for `waitForWalletSettlement`. Wire `assertTxStillOnChain` into the three UTxO-shape loops (every 60 attempts). Update the helper-level doc comments to state the new ceilings and rollback short-circuit. No call-site changes. |
| `offchain/cli/src/lib/index.ts` | Re-export reconcile. |
| `offchain/feeder/src/lib-bridge/index.ts` | Reduce to thin re-exports of the three new files + the loader. The current 495-line monolith disappears. |
| `offchain/feeder/src/submitter/types.ts` | `SubmitResultOk` gains `receiverUnit: string` and (optional) `pairUnit: string`. `SubmitResultErr` gains `code: FeederErrorCode`, `remediation: string`. Single source of truth — every queue/inflight/api consumer reads from these. |
| `offchain/feeder/src/submitter/cardano-write-client.ts` | Bridge call returns `{ txHash, receiverUnit, pairUnit }`; client surfaces those on the result. Preflight is called BEFORE `bridge.submitOracleUpdate` and classifies failure when it returns non-null. Catch block delegates to `classifyError`. |
| `offchain/feeder/src/submitter/queue.ts` | Use real `receiverUnit` from `SubmitResultOk` for the inflight key — `pending:${intentHash}` placeholder removed. On `SubmitResultErr`, consult `retry-policy.ts`; `halt` flips `lane-state`, `skip` advances, `retry` re-enqueues with backoff. |
| `offchain/feeder/src/submitter/queue-manager.ts` | Lane key changes from `clientStatePath::protocolStatePath` to `(updaterWallet, receiverUnit)`. Coalescer is inserted in front of each lane's queue. Existing top-level retry loop (lines 115-121) is removed — retry decisions move into `queue.ts` per the policy. |
| `offchain/feeder/src/submitter/inflight.ts` | No code change (interface already takes a real `receiverUnit`). Just gets fed correct data. |
| `offchain/feeder/src/config/types.ts` | `CardanoDestinationConfig.tx_mode: "single" \| "batch" \| "auto"` (was `"single" \| "batch"`). New optional field `coalesce_window: string` (duration). |
| `offchain/feeder/src/config/validate.ts` | Accept new `tx_mode` value; validate duration string for `coalesce_window`. |
| `offchain/feeder/config/routers/client-a.preview.yaml` | Flip `tx_mode: single → auto`; add `coalesce_window: 2s` with a one-line comment. |
| `offchain/feeder/src/logger/file-logger.ts` | Add a canonical `events.jsonl` sink in `logDir`: one JSON line per lifecycle event (`enriched`, `routed`, `submit`, `confirm`, `failed`, `halted`, `reconciled`). Per-intent `*.log` files stay for operator readability. Schema lives in a new `intent-event.ts`. |
| `offchain/feeder/src/logger/intent-event.ts` | NEW. Canonical typed event schema (`IntentLifecycleEvent`). Both `file-logger` and any future log sink (Loki, stdout) consume this type. |
| `offchain/feeder/src/api/health.ts` | `/healthz` reports per-lane state from `lane-state.ts`. `/readyz` returns 503 when any lane is `halted`. |
| `offchain/feeder/cmd/feeder/daemon-cmd.ts` | Wire `lane-state` into the queue manager + api server. The 50+ lines of inline `logIntentStep` calls move behind a single `emitLifecycle(event)` helper that consumes the typed event. |

#### Files NOT touched (intentionally)

- `offchain/cli/src/transactions/*.ts` — wrappers stay as-is; they inherit the new wait defaults transparently. No behavior change for `run-all-cli.sh`.
- `offchain/cli/src/lib/transactions/*.ts` — pure builders are already feeder-friendly; the bridge calls them, not vice versa.
- `offchain/feeder/src/source/*.ts`, `offchain/feeder/src/router/*.ts`, `offchain/feeder/src/pipeline/*.ts` — Phase 3.4.5 is submission-side; the scanner / router / pipeline are out of scope.
- `offchain/feeder/src/persistence/*.ts` — DB schema unchanged. Status strings (`submitted`, `confirmed`, `failed`) become `submitted`, `confirmed`, `failed`, `halted` only if we want lane history; deferred to Phase 3.5.

### E.2 Decisions & non-decisions

- **Reconciliation lives in CLI lib, not feeder.** Reason: the CLI may also need it (operator running a recovery from a hand-edited artifact). Building it once in `lib/reconcile/` and re-exporting through `lib-bridge` mirrors how `buildOracleUpdateTx` already works.
- **Error taxonomy lives in the feeder, not the CLI.** Reason: the CLI is interactive and prints errors at the prompt; the feeder needs a closed enum to drive retry decisions and metrics labels. The CLI keeps throwing plain `Error`s.
- **Preflight in `submitter/`, not in the bridge.** Reason: preflight wants access to lane-state (skip preflight on a `halted` lane to avoid log spam). The bridge stays a pure Cardano-tx surface.
- **No new YAML files.** All schema changes are extensions of existing `cardano:` destination block. Spectra-parity preserved.
- **Logger: keep per-intent files, add `events.jsonl`.** Reason: per-intent files are gold for operators reading one intent end-to-end; `events.jsonl` is the machine-readable feed for `/metrics` and external tools. Not "or" — both.
- **No retry loop in `queue-manager.ts`.** Retry decisions move into `queue.ts` so a single component owns submit + classify + retry. The top-level retry (lines 115-121) is dead code after Phase 3.4.5.e.
- **Coalescing window is per-lane, not global.** Each `(updaterWallet, receiverUnit)` has its own buffer. Two clients with different receivers never share a window.
- **`coalesce_window` applies only on `idle → accumulating`.** After an in-flight cycle, the lane has already been accumulating for the full Cardano latency (30 s – 2 min). Imposing another window after every confirm would be pure added latency, not coalescing. The buffer flushes immediately on confirm when non-empty.
- **Supersession at the lane buffer, not the coalescing window.** The buffer is `Map<symbol, newestIntent>` for the **entire** life of the lane, not just during the 2 s window. Newer `(timestamp, nonce)` evicts older for the same symbol whether the lane is `accumulating` or `in-flight`. Mirrors the on-chain `is_fresh_update` rule exactly.
- **Empty post-preflight flush is silent in `idle` paths, loud on `confirm` path.** An empty `accumulating → flush` is normal (everything aged out before flush — operator picks `max_intent_age_at_flush` and accepts the trade-off). An empty `in-flight-confirm → flush` is `lane_overrun` (chain slower than DIA's expiry budget — operator must investigate).
- **`receiverUnit` and `pairUnit` are required in `SubmitResultOk`.** Optional was tempting; making them required forces every code path to plumb them through, killing the "we'll add it later" trap.
- **Mint-vs-update on chain check is per-symbol, on every submit.** Cost: one `findSingleUtxoAtUnit` call per intent. Already pay this for `currentPairUtxo` resolution; the only new chain read is when the intent IS a create.

### E.3 Implementation order (each is a mergeable PR)

| # | Sub-phase | Lines touched (est.) | New files | Risk to CLI |
| --- | --- | --- | --- | --- |
| 1 | **3.4.5.a** Raise wait timeouts | 4 lines + 1 new helper | 1 | none — CLI inherits new ceilings, no path change |
| 2 | **3.4.5.d** Error taxonomy + preflight | ~300 | 4 | none |
| 3 | **3.4.5.e** Retry policy | ~150 | 1 | none |
| 4 | **3.4.5.f** Real inflight key (`receiverUnit`) | ~80 | 0 | none |
| 5 | **3.4.5.b** Reconciliation | ~250 | 3 (2 CLI lib, 1 bridge) | additive; no existing call sites change |
| 6 | **3.4.5.c** Mint-vs-update from chain | ~30 | 0 | none — only `lib-bridge` decides; CLI flow is interactive and keeps its own decision |
| 7 | **3.4.5.g** Lane state machine + supersession + batch coalescing | ~550 | 3 | none |

Each PR keeps the test suites green for both packages independently;
each is reviewable on its own.

PR #7 grew from the original 400 LoC estimate because the lane state
machine (idle → accumulating → in-flight → idle) and the per-symbol
supersession buffer are part of the same module
(`submitter/coalescer.ts`) — they share the buffer data structure and
the flush trigger logic, so splitting into separate PRs would force
the first one to ship dead code. The state machine is small (~80
LoC); the supersession map is small (~60 LoC); the rest is
preflight integration, fallback ladder, and per-entry result
correlation.

### E.4 Blast-radius statement

After all seven PRs land:

- `run-all-cli.sh` Preview produces the same artifact set as today, with
  the only observable difference being potentially higher wait latencies
  under adverse provider conditions (the new ceiling, not the typical
  case). Acceptance: the M1 evidence-pack workflow still produces a
  green run.
- The feeder's external surface (`/healthz`, `/readyz`, `/metrics`,
  `/prices`) gains the lane-state fields; existing fields are preserved.
- The router YAML schema gains `tx_mode: "auto"`, `coalesce_window`,
  `min_batch_size`, `max_batch_size`, `size_fallback_enabled`, and
  `max_intent_age_at_flush`; existing files with `tx_mode: "single"`
  or `"batch"` and no other knobs keep working with safe defaults.
- `.env.example` files are untouched.
- No on-chain script change. No re-deployment of any artifact.

### E.5 Test strategy

- **Unit (no chain):** `errors/classify.ts`, `submitter/retry-policy.ts`,
  `submitter/coalescer.ts`, `submitter/preflight.ts` (chain calls
  dependency-injected). Existing fakes in `__tests__/` are extended; no
  new harness.
- **Integration (Lucid Emulator):** `lib-bridge/oracle-update.ts` and
  `oracle-update-batch.ts` against the M1 emulator harness;
  `reconcile/pair-state.ts` against a pre-staged emulator state.
- **Smoke (live Preview + DIA testnet):** rerun
  `npm run feeder:dev -- --config ./config --daemon` for 30 min, post
  the structured logs to `docs/milestones/evidence/m2-preview-phase-3-4-5/`.
  Hits the Phase 3.4.5 rolled-up acceptance defined in the phase
  description.
- **CLI regression:** `run-all-cli.sh` Preview end-to-end (the Phase 4
  acceptance gate already on the plan) — runs unchanged; verifies the
  new wait ceilings did not break any existing call.

### E.6 Documentation updates

| File | Change |
| --- | --- |
| `offchain/feeder/README.md` | Operator section: lane-halt states (`blocked`, `halted`), how to read `events.jsonl`, `tx_mode: auto`, what the wait timeouts mean. |
| `offchain/cli/README.md` | One paragraph noting the new wait ceilings (no API change). |
| `docs/plans/work-plan.md` | Workstream C summary: reference Phase 3.4.5 by name. |
| `docs/plans/milestone-2-feeder-strategy.md` | Add a one-paragraph forward-link to Annex E for the conceptual rationale. |

### E.7 Batch composition rules (mints + updates mixed)

The on-chain `buildBatchOracleUpdateTx` already accepts a heterogeneous
list of entries: each carries `isCreate: boolean`, the resulting tx
mints exactly the new pair tokens (`mintAssets[pairUnit] = 1n`) for
`isCreate: true` entries and consumes the existing pair UTxO for the
others. All entries share a single receiver UTxO and a single
`config-update` redeemer.

`ensureCompatibleBatch` ([`offchain/cli/src/transactions/update-batch.ts:545`](../../offchain/cli/src/transactions/update-batch.ts#L545))
enforces the invariants the coalescer must honour:

- every entry has the **same `receiverUnit`** (this is the lane key —
  guaranteed by construction);
- every entry shares **`configUnit`, `paymentHookUnit`, `pairPolicyId`**
  (one client deployment per batch — guaranteed since lanes are
  per-client);
- every entry has the **same `pairValidatorAddress`** (same property);
- **no duplicate `pairUnit`** in the same batch. The coalescer
  enforces this naturally because the lane buffer is keyed by
  `symbol`: at any given moment there is at most one buffered
  intent per symbol. Supersession is **continuous across the
  entire lane lifetime**, not limited to the
  `coalesce_window` (2 s). Whether the lane is `accumulating` or
  `in-flight`, every arrival for an already-buffered symbol replaces
  the existing entry if its `(timestamp, nonce)` is greater. This
  matches the on-chain `is_fresh_update` rule
  ([`oracle_logic.ak:96`](../../contracts/aiken/lib/dia_cardano_oracle/oracle_logic.ak#L96))
  exactly — pushing a non-fresh intent would be rejected by the
  validator regardless.

Authority rules for a mixed batch:

- **All `isCreate: true` entries** require the feeder wallet to be a
  config admin (the existing on-chain rule
  `assertPaymentKeyHashIsConfigSigner`). When the wallet is not an
  admin, preflight (3.4.5.d) emits `SignerNotAuthorizedToMint` for
  each create entry, the coalescer drops those entries, and the
  remaining update-only entries form the batch.
- **A batch with only create entries on a non-admin wallet** results
  in an empty post-filter list → no tx is built. The lane is **not**
  halted (it's a per-entry capability gap, not a wallet-wide
  problem); subsequent updates still flow.

Effect on the CLI: zero. The CLI's `update:batch` command keeps its
existing semantics; the feeder uses the same builder via `lib-bridge`.

### E.8 Configuration surface — the complete knob list

This section is the single place an operator looks to find every
runtime knob the feeder reads, where it lives, what the default is,
and what it controls. Knobs introduced by Phase 3.4.5 are marked
**NEW**; everything else is already in place.

#### E.8.1 — Router YAML — per-`cardano:` destination

Lives under `routers.<routerId>.destinations[].cardano:` in each
`config/routers/<file>.yaml`.

| Knob | Type | Default | New? | Controls |
| --- | --- | --- | --- | --- |
| `network` | `Preview \| Mainnet` | required | existing | Must match `CARDANO_NETWORK`. |
| `client_state_path` | path | required | existing | CLI client-state JSON (per `(client, network)`). |
| `protocol_state_path` | path | required | existing | CLI protocol-state JSON. |
| `tx_mode` | `single \| batch \| auto` | `auto` | **NEW** | Submission mode. `auto` = coalesce, decide single/batch by count; `single` = always one tx per intent; `batch` = always batch (even N=1 is wrapped — useful for ops parity). |
| `coalesce_window` | duration (e.g. `2s`, `500ms`) | `2s` | **NEW** | Lane buffering window **only on `idle → accumulating`** (first intent after the lane has been quiet). NOT applied on the `in-flight → flush` path — after a confirm, a non-empty buffer flushes immediately. Set to `0` to flush every idle-arrival immediately (no coalescing of simultaneous arrivals). Ignored in `single` mode. |
| `min_batch_size` | int ≥ 2 | `2` | **NEW** | In `auto` mode, the minimum count at flush time required to emit a batch tx; below this, buffered intents flush as individual single txs. |
| `max_batch_size` | int ∈ `[2, 15]` | `10` | **NEW** | Hard cap on entries per batch tx. Aligned with the CLI's empirical ceiling (the `run-all-cli.sh` ladder validates up to 10). When the buffer at flush time exceeds the cap, the lane emits successive batches of `max_batch_size`, all serialised in the same in-flight cycle. |
| `size_fallback_enabled` | bool | `true` | **NEW** | Whether to halve-and-retry on `BatchSizeExceeded`. Off in `batch` mode if the operator wants hard failures for debugging; default on. |
| `max_intent_age_at_flush` | duration | `0` (disabled) | **NEW** | If `>0`, at flush time drop any buffered intent whose `intent.timestamp` is older than this threshold (relative to `now`), with a `IntentAgedOut` event. Independent of DIA's `intent.expiry` — this is an operator-side staleness gate for sparse symbols. Default disabled (DIA's expiry is the contract; the per-symbol supersession buffer already prevents stale prices for active symbols). |

#### E.8.2 — Router YAML — per-router policy (existing)

| Knob | Type | Default | Controls |
| --- | --- | --- | --- |
| `triggers.events` | list of event names | required | Which Spectra events the router reacts to (only `IntentRegistered` supported). |
| `triggers.conditions` | list of `{field, operator, value}` | required | Symbol allowlist. AND-combined. |
| `processing.datasource` | `enrichment` | `enrichment` | Source of values for routing (currently the only supported value). |
| `processing.transformations` | list | `[]` | Reserved; must be empty for Cardano. |
| `time_threshold` | duration | (router-level) | Minimum gap between two updates for the same symbol on a destination. |
| `price_deviation` | percent string | (router-level) | Minimum relative price change to forward. |
| `private_key_env` | env var name | required | Env var holding the Cardano wallet seed. |
| `enabled` | bool | `true` | Pause a router without removing the file. |

#### E.8.3 — `.env` — secrets and runtime selectors

These are confirmed by Annex D as the only env values the feeder reads.

| Knob | Used by | Required | Controls |
| --- | --- | --- | --- |
| `CARDANO_NETWORK` | runtime | yes | `Preview` or `Mainnet`; drives `_TESTNET` / `_MAINNET` suffix resolution. |
| `CARDANO_PROVIDER` | runtime | yes | `Blockfrost` or `Koios`. |
| `LOG_LEVEL` | logger | optional | `debug \| info \| warn \| error` (default `info`). Also `--log-level`. |
| `DRY_RUN` | submitter | optional | `true` to disable actual Cardano submissions. Also `--dry-run`. |
| `BLOCKFROST_PROJECT_ID_<NETWORK>` | provider | yes (if `Blockfrost`) | Project id for the network. |
| `CARDANO_WALLET_SEED_<NETWORK>` | wallet | yes | Mnemonic for the updater wallet. Referenced from `private_key_env`. |
| `CARDANO_PRIVATE_KEY_<NETWORK>` | wallet | alt to seed | Raw private key. Only if `private_key_env` points here. |
| `DIA_WS_CREDENTIAL_<NETWORK>` | source-ws | yes (if `--transport ws`) | Conduit path-style credential. |
| `DIA_EXPLORER_URL_<NETWORK>` | logger | optional | Used for explorer links in logs. |
| `API_LISTEN_ADDR` | api | optional | `host:port` for the HTTP API (default `:8080`). |
| `API_ENABLE_CORS` | api | optional | `true` to enable CORS. |
| `METRICS_ENABLED` | metrics | optional | `true` to enable `/metrics`. |
| `METRICS_NAMESPACE` | metrics | optional | Default `dia_feeder`. |
| `DATABASE_DRIVER` | persistence | optional | `sqlite` (default) or `postgres`. |
| `DATABASE_PATH_<NETWORK>` | persistence | optional (sqlite) | Default `state/<network>/feeder.sqlite`. |
| `DATABASE_DSN_<NETWORK>` | persistence | yes (if postgres) | DSN with password. |
| `FEEDER_LOG_DIR` | logger | optional | Default `state/<network>/logs`. |

#### E.8.4 — `infrastructure.<network>.yaml` — scanner and processor knobs (existing)

These are the Spectra-shape infrastructure knobs the daemon already
reads. None of them are introduced by Phase 3.4.5; they are listed
here to make the configuration map complete.

| Knob | Default | Controls |
| --- | --- | --- |
| `block_scanner.scan_interval` | `10s` | HTTP poll cadence. |
| `block_scanner.block_range` | `500` | Max blocks per `eth_getLogs` request. |
| `source.start_block` | `0` (or checkpoint) | Initial scan boundary. |
| `event_processor.dedup_cache_size` | `4096` | LRU capacity. |
| `event_processor.dedup_cache_ttl` | `1h` | LRU TTL. |
| `event_monitor.reconnect_interval` | `5s` | WS reconnect cadence. |
| `event_monitor.max_reconnect_attempts` | `60` | WS reconnect budget. |
| `health_check.max_processing_lag` | `5m` | `/readyz` staleness threshold. |
| `worker_pool.task_timeout` | `60s` | Per-submit wall-clock ceiling. After 3.4.5.e this becomes the inflight timeout; retries are governed by `retry-policy.ts`. |
| `worker_pool.retry_delay` | `5s` | Base backoff between retries. |
| `worker_pool.max_retries` | `3` | Max retries for retryable error codes. |
| `api.listen_addr` | `:8080` | YAML override of `API_LISTEN_ADDR`. |
| `metrics.enabled` | `false` | YAML override of `METRICS_ENABLED`. |
| `metrics.namespace` | `dia_feeder` | YAML override of `METRICS_NAMESPACE`. |
| `dry_run` | `false` | YAML override of `DRY_RUN`. |

#### E.8.5 — Helper-internal constants (CLI core)

After 3.4.5.a these are the only timeouts in the codebase that are
not config-driven; the values are intentionally hard-coded because
they describe Cardano realities, not operator policy.

| Constant | File | New default | Controls |
| --- | --- | --- | --- |
| `waitForUnitUtxoReplacement.maxAttempts` | `chain-helpers.ts` | `800` (was 20) | ~20 min ceiling. |
| `waitForOutRefAvailable.maxAttempts` | `chain-helpers.ts` | `800` | ~20 min ceiling. |
| `waitForOutRefGone.maxAttempts` | `chain-helpers.ts` | `800` | ~20 min ceiling. |
| `waitForWalletSettlement.maxAttempts` | `chain-helpers.ts` | `480` (was 12) | ~12 min ceiling. |
| All four `delayMs` | `chain-helpers.ts` | `1500` (unchanged) | Poll interval. |
| `assertTxStillOnChain` interval | `tx-onchain-check.ts` | every `60` attempts | Sanity check inside the loops. |

#### E.8.6 — Where knobs do **not** live (intentional)

- Coalescer behaviour (`max_batch_size`, `coalesce_window`) does NOT
  appear in `infrastructure.yaml`. It lives per-destination because
  different clients legitimately want different policies.
- Wait-helper ceilings (E.9.5) are NOT YAML-tunable. Reason: they
  represent provider-lag tolerance which is a property of Cardano +
  Blockfrost/Koios, not of any one router. If we ever needed per-
  network overrides, the natural home would be
  `infrastructure.<network>.yaml::chain.wait_ceilings` — out of scope
  for M2.
- `FeederErrorCode` retry policy lives in code (`retry-policy.ts`),
  not in YAML. Each code's response is a design decision, not an
  operator dial. Per-error-code retry counts can be exposed via env
  if a future incident requires it; deferred.

### E.9 Approval checklist (operator)

- [ ] Module placements (E.1) match your mental model of the codebase.
- [ ] Decisions in E.2 are the right defaults (especially: reconcile in
      CLI lib, error taxonomy in feeder).
- [ ] PR order in E.3 is acceptable.
- [ ] Blast-radius statement (E.4) is acceptable.
- [ ] Test strategy (E.5) is sufficient before the live evidence window.
- [ ] Documentation list (E.6) is complete.
- [ ] Lane state machine in 3.4.5.g is correct: `coalesce_window`
      applies only on `idle → accumulating`; `in-flight → flush`
      is immediate when the buffer is non-empty; per-symbol
      supersession runs continuously across both `accumulating`
      and `in-flight` states. The example tables (single-symbol
      sustained load, multi-symbol burst) match operator
      expectations.
- [ ] Batch composition rules in E.7 (mints + updates in one tx,
      partial-failure semantics, no-empty-batch rule, supersession
      across the lane lifetime) are correct.
- [ ] Configuration surface in E.8 — defaults, ranges, and where
      each knob lives — is acceptable. In particular:
      `max_batch_size: 10` aligned with the CLI evidence ladder,
      `coalesce_window: 2s` default (idle path only),
      `max_intent_age_at_flush: 0` default (DIA's expiry is the
      contract), no YAML for wait ceilings.

When this box is checked, implementation starts at row 1 of E.3 and
nothing else changes until the corresponding sub-phase acceptance is
green.

## Open questions for DIA (extension of the D-list above)

These come out of the Spectra-alignment analysis and need DIA's input
before Phase 3.1 (`routers/*.yaml` schema is finalized) and Phase 4
(live evidence window):

- [ ] **D7 — Feeder operator.** Will DIA operate the Cardano feeder
  themselves (like they operate the EVM bridge), or does Protofire
  run it? Affects who owns `config/routers/*.yaml` and the updater
  wallet custody policy. Blocks Phase 3 finalization.
- [ ] **D8 — `customer` field semantics.** In Spectra Bridge the
  `customer` router field is a metrics label only — confirm we should
  preserve it as a label and that it does not gate routing for our
  feeder either.
- [ ] **D9 — Customer → pair mapping for M2.** Which `customer`
  identifiers and which pairs per customer for the 10 Catalyst-listed
  pairs in M2? Needed to write `config/routers/*.preview.yaml`.
  Blocks Phase 4 routes config.
- [ ] **D10 — Gating granularity.** In Spectra `time_threshold` and
  `price_deviation` are per destination, shared across all symbols
  matched by `triggers.conditions`. Confirm this matches DIA's intent,
  or whether they want per-`(destination × symbol)` granularity for
  Cardano.

## Out of scope for M2

These belong to M3 (monitoring) or M4 (final close-out) and are not gating
M2 acceptance:

- Production-grade alerting / on-call rotation.
- Long-running uptime SLA contracts.
- The 2,500+ price feeds catalogue and self-serve request flow (M4).

## Reference index

- Conceptual reference: [`milestone-2-feeder-strategy.md`](./milestone-2-feeder-strategy.md)
- Catalyst milestone text: [`../milestones/final-cardano-milestones.md`](../milestones/final-cardano-milestones.md) (M2)
- Cross-workstream plan: [`work-plan.md`](./work-plan.md) (Workstream C)
- Architecture: [`../architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md)
- M1 mainnet evidence (with the `100640` config that Phase 1 supersedes):
  [`../milestones/evidence/m1-mainnet-20260517-063917/`](../milestones/evidence/m1-mainnet-20260517-063917/)
