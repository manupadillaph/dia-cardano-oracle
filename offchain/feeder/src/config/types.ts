// Modular configuration types — TypeScript mirror of
// `diadata-org/Spectra-interoperability/services/bridge/config/{modular_types,event_definitions,types}.go`.
//
// The shape is intentionally faithful to the upstream Go types so DIA's
// existing router YAMLs can be loaded by this feeder with only the
// destination block adapted: Spectra ships an EVM `method:` block per
// destination, and this feeder adds a parallel `cardano:` block (see
// `CardanoDestinationConfig` below).
//
// Fields the Cardano feeder does not consume today (cron service,
// replica failover, parts of the worker pool, recovery, etc.) are
// still typed here so a Spectra-shaped YAML loads without
// unknown-property errors. They become live when their consumers are
// wired in.

/**
 * Top-level shape of the entire feeder configuration, produced by the
 * modular loader. Each sub-section comes from a separate YAML file
 * (see `loader.ts` for the exact mapping).
 */
export type ModularConfig = {
  /** From `infrastructure.<network>.yaml`. Optional only because validation
   * surfaces the missing-file error itself with a clearer message. */
  infrastructure?: InfrastructureConfig;
  /** From `chains.yaml`. Keyed by a stable string id (e.g. `dia-testnet`). */
  chains: Record<string, ChainConfig>;
  /** From `contracts.yaml`. Keyed by a stable string id (e.g. `intent-registry-testnet`). */
  contracts: Record<string, ContractConfig>;
  /** From `events.yaml`, under the top-level `event_definitions:` key. */
  event_definitions: Record<string, EventDefinition>;
  /** Collected from every `routers/*.yaml`. Keyed by `router.id`. */
  routers: Record<string, RouterConfig>;
  /**
   * ABIs declared as strings in the YAML, parsed at load time and
   * attached here so downstream code (extractor, enricher,
   * registry-client) never re-parses. Populated by the loader; missing
   * only when the config dir does not declare events or contracts
   * (validator surfaces that).
   */
  parsedAbis: import("./abi-parser.js").ParsedAbis;
};

// ---------------------------------------------------------------------------
// infrastructure.<network>.yaml
// ---------------------------------------------------------------------------

/**
 * Everything that defines "how the daemon runs": the source chain it
 * scans, the database it persists to, the API surface it exposes,
 * timeouts and worker tuning. The bulk of these fields are 1:1 with
 * Spectra's `InfrastructureConfig`.
 */
export type InfrastructureConfig = {
  database: DatabaseConfig;
  source: SourceConfig;
  /** Optional fallback signing key embedded in the YAML. Strongly
   * discouraged — routers should reference an env var via
   * `private_key_env`. Kept for Spectra parity. */
  private_key?: string;
  private_key_env?: string;
  event_monitor?: EventMonitorConfig;
  block_scanner?: BlockScannerConfig;
  event_processor?: EventProcessorConfig;
  worker_pool?: WorkerPoolConfig;
  health_check?: HealthCheckConfig;
  recovery?: RecoveryConfig;
  api?: APIConfig;
  metrics?: MetricsConfig;
  /** Not consumed yet (replica failover). Kept typed for Spectra parity. */
  replica?: ReplicaConfig;
  dry_run?: boolean;
  /** Not consumed yet (periodic mandatory updates). Kept typed for Spectra parity. */
  cron_service?: CronServiceConfig;
};

/**
 * Persistence backend. Spectra is Postgres-only; the Cardano feeder
 * extends with a SQLite driver (`driver: sqlite` + `path` or `path_env`)
 * for low-friction local and CI deployments.
 */
export type DatabaseConfig = {
  driver: "sqlite" | "postgres";
  dsn?: string;
  dsn_env?: string;
  path?: string;
  path_env?: string;
};

/** The source chain the feeder scans (always DIA Lasernet). */
export type SourceConfig = {
  chain_id: number;
  name: string;
  rpc_urls: string[];
  ws_url?: string;
  /** Block to start scanning from on a cold start. Once the feeder has
   * persisted a checkpoint in `chain_state`, that value wins. */
  start_block?: number;
};

export type EventMonitorConfig = {
  enabled: boolean;
  reconnect_interval?: string;
  max_reconnect_attempts?: number;
};

export type BlockScannerConfig = {
  enabled: boolean;
  scan_interval?: string;
  block_range?: number;
  max_block_gap?: number;
  backward_sync?: boolean;
  head_tracker_interval?: string;
  gap_detection_interval?: string;
};

export type EventProcessorConfig = {
  batch_size?: number;
  validation_timeout?: string;
  dedup_cache_size?: number;
  dedup_cache_ttl?: string;
  enable_parallel_mode?: boolean;
  parallel_worker_count?: number;
  parallel_queue_size?: number;
  parallel_timeout?: string;
  /** Accumulation window on the idle→accumulating lane edge.
   *  Accepts duration strings ("2s", "500ms"). Default: "2s". */
  coalesce_window?: string;
  /** Drop buffered intents older than this at flush time.
   *  Accepts duration strings ("60s", "5m"). Default: no limit. */
  max_intent_age?: string;
};

export type WorkerPoolConfig = {
  max_workers?: number;
  task_queue_size?: number;
  task_timeout?: string;
  retry_delay?: string;
  max_retries?: number;
};

export type HealthCheckConfig = {
  enabled: boolean;
  check_interval?: string;
  timeout?: string;
  max_processing_lag?: string;
  max_queue_size?: number;
};

export type RecoveryConfig = {
  enabled: boolean;
  min_failures?: number;
  max_attempts?: number;
  retry_interval?: string;
  recovery_timeout?: string;
};

export type APIConfig = {
  enabled: boolean;
  listen_addr?: string;
  enable_cors?: boolean;
};

export type MetricsConfig = {
  enabled: boolean;
  namespace?: string;
};

export type ReplicaConfig = {
  enabled: boolean;
  role?: "primary" | "secondary";
  monitor_chain_id?: number;
};

export type CronServiceConfig = {
  enabled: boolean;
  interval?: string;
};

// ---------------------------------------------------------------------------
// chains.yaml
// ---------------------------------------------------------------------------

/**
 * A chain known to the feeder. In the Cardano feeder this is informational
 * (we don't dispatch EVM txs); destinations resolve their target chain by
 * `chain_id` against this map for documentation and metric labelling.
 */
export type ChainConfig = {
  chain_id: number;
  name: string;
  rpc_urls: string[];
  enabled: boolean;
  default_gas_limit?: number;
  gas_multiplier?: number;
  max_gas_price?: string;
};

// ---------------------------------------------------------------------------
// contracts.yaml
// ---------------------------------------------------------------------------

/**
 * A contract on a known chain. The feeder reads this for the source
 * `OracleIntentRegistry`; destination receivers do not appear here because
 * Cardano scripts are addressed by NFT+address, not by EVM-style ABI.
 */
export type ContractConfig = {
  name?: string;
  chain_id: number;
  address: string;
  type: string;
  enabled: boolean;
  abi: string;
  gas_limit?: number;
  gas_multiplier?: number;
  max_gas_price?: string;
  methods?: Record<string, MethodConfig>;
};

export type MethodConfig = {
  method_name: string;
  fields_mapping?: Record<string, string>;
  gas_limit?: number;
};

// ---------------------------------------------------------------------------
// events.yaml
// ---------------------------------------------------------------------------

/**
 * Definition of a source-chain event the feeder listens for. The pipeline
 * decodes logs against `abi`, projects them through `data_extraction`,
 * and optionally enriches via a view-call described by `enrichment`.
 *
 * Today there is exactly one event definition: `IntentRegistered`
 * with an enrichment that calls
 * `OracleIntentRegistry.getIntent(intentHash)`.
 */
export type EventDefinition = {
  contract: string;
  abi: string;
  data_extraction: Record<string, string>;
  enrichment?: EnrichmentConfig;
};

export type EnrichmentConfig = {
  contract?: string;
  method: string;
  abi?: string;
  params: string[];
  returns: Record<string, string>;
};

// ---------------------------------------------------------------------------
// routers/*.yaml
// ---------------------------------------------------------------------------

/**
 * A router binds a source-event subscription (with optional filters) to
 * one or more destinations. Each customer/destination combination is a
 * separate router file in `config/routers/`, exactly the way the
 * Spectra Bridge operates.
 */
export type RouterConfig = {
  id: string;
  name: string;
  /** Free-form label preserved for metrics/log correlation. Spectra uses
   * this the same way; it does not gate routing. */
  customer?: string;
  type: string;
  enabled: boolean;
  private_key?: string;
  private_key_env?: string;
  triggers: RouterTriggers;
  processing: ProcessingConfig;
  destinations: RouterDestination[];
};

export type RouterTriggers = {
  events: string[];
  conditions?: TriggerCondition[];
};

/** One condition in a router's filter chain. ALL conditions must pass
 *  (logical AND) for the router to dispatch — matches Spectra's semantics. */
export type TriggerCondition = {
  field: string;
  operator: TriggerConditionOperator;
  value: unknown;
};

export type TriggerConditionOperator =
  | "in"
  | "not_in"
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains";

export type ProcessingConfig = {
  /** Which pipeline stage feeds the destination payload templating.
   *  `enrichment` is the default for IntentRegistered (we want the full
   *  intent, not just the log's intentHash). */
  datasource: "event" | "enrichment" | "processed";
  transformations?: Transformation[];
  /** Spectra naming preserved verbatim (single-word, no underscore). */
  validationenabled?: boolean;
};

export type Transformation = {
  field: string;
  operation: string;
  input: string;
  params?: Record<string, unknown>;
};

/**
 * A single destination. Spectra-native destinations carry a `method:`
 * block (EVM ABI call). This feeder routes Cardano destinations
 * through a parallel `cardano:` block. Validation rejects both-or-neither.
 */
export type RouterDestination = {
  chain_id?: number;
  contract?: string;
  contract_ref?: string;
  method?: DestinationMethodConfig;
  cardano?: CardanoDestinationConfig;
  condition?: string;
  time_threshold?: string;
  price_deviation?: string;
  cron?: boolean;
  gas_limit?: number;
  gas_multiplier?: number;
  max_gas_price?: string;
};

export type DestinationMethodConfig = {
  name: string;
  abi: string;
  params: Record<string, string>;
  value?: string;
  gas_limit?: number;
  gas_multiplier?: number;
};

/**
 * Feeder extension over Spectra: a Cardano destination is addressed by
 * the (network, client_state, protocol_state, tx_mode) tuple instead of
 * by an EVM `(chain_id, contract, method_abi)` triple.
 */
export type CardanoDestinationConfig = {
  network: "Preview" | "Mainnet";
  client_state_path: string;
  protocol_state_path: string;
  /** single: one tx per intent. batch: always batch. auto: batch when N>1,
   *  single when N=1. Default: auto. */
  tx_mode: "single" | "batch" | "auto";
};
