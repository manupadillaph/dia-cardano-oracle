// CLI flag parser for the feeder binary. Lives in its own module so
// the entry point can be a thin orchestrator and the parser can be
// unit-tested without spawning a process.
//
// Flags supported:
//
//   --config <dir>       (default: ./config)
//   --log-level <level>  (default: info)
//   --validate-only      mutually exclusive with --scan
//   --scan               mutually exclusive with --validate-only
//   --transport <kind>   one of: http | ws (default: http, applies to --scan)
//   --dry-run            also reachable via DRY_RUN=true (see .env.example)
//   --clean              delete feeder-generated state before starting
//   --help, -h

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Transport = "http" | "ws";

/** Mutually exclusive top-level "mode" the binary runs in. */
export type FeederMode = "daemon" | "validate" | "scan";

export type ParsedArgs = {
  configPath: string;
  logLevel: LogLevel;
  mode: FeederMode;
  transport: Transport;
  dryRun: boolean;
  cleanState: boolean;
  showHelp: boolean;
};

const VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const VALID_TRANSPORTS: readonly Transport[] = ["http", "ws"];

const DEFAULTS: ParsedArgs = {
  configPath: "./config",
  logLevel: "info",
  mode: "daemon",
  transport: "http",
  dryRun: false,
  cleanState: false,
  showHelp: false,
};

/**
 * Parse a raw `argv` slice (the part after node + script). Throws on
 * unknown flags, invalid values, or conflicting modes so the entry
 * point can print usage and exit non-zero.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { ...DEFAULTS };
  applyEnvOverrides(parsed);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.showHelp = true;
        break;
      case "--validate-only":
        setMode(parsed, "validate", arg);
        break;
      case "--scan":
        setMode(parsed, "scan", arg);
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--clean":
        parsed.cleanState = true;
        break;
      case "--config":
        parsed.configPath = requireValue(argv, ++i, "--config");
        break;
      case "--log-level":
        parsed.logLevel = parseLogLevel(requireValue(argv, ++i, "--log-level"));
        break;
      case "--transport":
        parsed.transport = parseTransport(requireValue(argv, ++i, "--transport"));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

/** Read environment variables that act as flag fallbacks. Mirrors how
 *  the Spectra Bridge picks up `DRY_RUN` from the environment. */
function applyEnvOverrides(target: ParsedArgs): void {
  if (process.env.DRY_RUN?.trim().toLowerCase() === "true") {
    target.dryRun = true;
  }
}

function setMode(target: ParsedArgs, mode: FeederMode, flag: string): void {
  if (target.mode !== "daemon" && target.mode !== mode) {
    throw new Error(`Cannot combine ${flag} with --${target.mode}-only / --${target.mode}.`);
  }
  target.mode = mode;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value argument`);
  }
  return value;
}

function parseLogLevel(raw: string): LogLevel {
  if (!(VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(
      `--log-level must be one of ${VALID_LOG_LEVELS.join("|")}, got "${raw}"`,
    );
  }
  return raw as LogLevel;
}

function parseTransport(raw: string): Transport {
  if (!(VALID_TRANSPORTS as readonly string[]).includes(raw)) {
    throw new Error(
      `--transport must be one of ${VALID_TRANSPORTS.join("|")}, got "${raw}"`,
    );
  }
  return raw as Transport;
}
