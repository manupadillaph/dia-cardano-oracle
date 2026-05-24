// Structured file logger — four separate log streams:
//
//   feeder.log          Linear event stream from the daemon (one line per event).
//   intents/<hash>.log  Per-intent lifecycle: enriched → superseded OR
//                       building → signing → submitting → confirmed/failed.
//   transactions.jsonl  One JSON line per Cardano tx with step timings.
//   lane.jsonl          Lane state events: buffered, superseded, flushed, idle.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

// ---------------------------------------------------------------------------
// Per-intent log (intents/<hash>.log)
// ---------------------------------------------------------------------------

export type IntentLogEntry = {
  ts: string;
  level: LogLevel;
  intentHash: string;
  symbol: string;
  step: string;
  message: string;
  meta?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Transaction log (transactions.jsonl)
// ---------------------------------------------------------------------------

/**
 * One-line event emitted per step inside a tx submission pipeline.
 * Streams in real time so the log is readable even if the feeder is killed
 * mid-flight. `txHash` is only present from the "submitted" step onward.
 */
export type TransactionEventEntry = {
  ts: string;
  event: string;        // "tx_start" | "connecting" | "building" | "signing" |
                        // "submitting" | "submitted" | "waiting_confirm" |
                        // "waiting_utxo" | "writing_state" | "tx_confirmed" | "tx_failed"
  intentHash: string;
  symbol: string;
  txHash?: string;      // available from "submitted" onward
  isCreate?: boolean;   // available on "tx_confirmed"
  total_ms?: number;    // available on "tx_confirmed" / "tx_failed"
  errorCode?: string;
  errorMessage?: string;
};

/**
 * Final summary entry — one per completed tx with per-step ms timings.
 * Useful for Grafana / Prometheus queries.
 */
export type TransactionLogEntry = {
  ts: string;
  txHash: string;
  symbol: string;
  intentHash: string;
  isCreate: boolean;
  status: "confirmed" | "failed";
  errorCode?: string;
  errorMessage?: string;
  steps: {
    connecting_ms?: number;
    building_ms?: number;
    signing_ms?: number;
    submitting_ms?: number;
    waiting_confirm_ms?: number;
    waiting_utxo_ms?: number;
  };
  total_ms: number;
};

// ---------------------------------------------------------------------------
// Lane log (lane.jsonl)
// ---------------------------------------------------------------------------

export type LaneEventKind =
  | "intent_buffered"
  | "intent_superseded"
  | "flush_triggered"
  | "flush_empty"
  | "tx_confirmed_reflush"
  | "lane_idle";

export type LaneLogEntry = {
  ts: string;
  lane: string;
  event: LaneEventKind;
  symbol?: string;
  intentHash?: string;
  supersededByHash?: string;
  bufferSize?: number;
  fromState?: string;
  toState?: string;
};

// ---------------------------------------------------------------------------
// FileLogger interface
// ---------------------------------------------------------------------------

export type FileLogger = {
  logTerminal(line: string): Promise<void>;
  logIntentStep(entry: IntentLogEntry): Promise<void>;
  /** Real-time per-step event. One line per step, streamed as it happens. */
  logTransactionEvent(entry: TransactionEventEntry): Promise<void>;
  /** Final summary entry once a tx completes (ok or failed). */
  logTransaction(entry: TransactionLogEntry): Promise<void>;
  logLaneEvent(entry: LaneLogEntry): Promise<void>;
  getReportingFn(reportToConsole: (line: string) => void): (line: string) => void;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createFileLogger(logDir: string): Promise<FileLogger> {
  await mkdir(logDir, { recursive: true });
  await mkdir(path.join(logDir, "intents"), { recursive: true });

  const terminalLogPath     = path.join(logDir, "feeder.log");
  const transactionsLogPath = path.join(logDir, "transactions.jsonl");
  const laneLogPath         = path.join(logDir, "lane.jsonl");

  // First timestamp seen per intent hash — keeps the per-intent filename stable.
  const intentFirstTs = new Map<string, string>();

  async function appendLine(filePath: string, line: string): Promise<void> {
    await appendFile(filePath, line + "\n", "utf8");
  }

  function intentFilePath(intentHash: string, ts: string): string {
    const shortHash = intentHash.slice(0, 16);
    let firstTs = intentFirstTs.get(shortHash);
    if (!firstTs) {
      firstTs = ts;
      intentFirstTs.set(shortHash, firstTs);
    }
    const s = firstTs;
    const sortable = s.slice(0, 4) + s.slice(5, 7) + s.slice(8, 10)
      + "-" + s.slice(11, 13) + s.slice(14, 16) + s.slice(17, 19);
    return path.join(logDir, "intents", `${sortable}_${shortHash}.log`);
  }

  const logger: FileLogger = {
    async logTerminal(line: string): Promise<void> {
      await appendLine(terminalLogPath, `[${new Date().toISOString()}] ${line}`);
    },

    async logIntentStep(entry: IntentLogEntry): Promise<void> {
      const filePath = intentFilePath(entry.intentHash, entry.ts);
      let line = `[${entry.ts}] [${entry.step}] ${entry.message}`;
      if (entry.meta && Object.keys(entry.meta).length > 0) {
        line += `\n  meta: ${JSON.stringify(entry.meta)}`;
      }
      await appendLine(filePath, line);
    },

    async logTransactionEvent(entry: TransactionEventEntry): Promise<void> {
      await appendLine(transactionsLogPath, JSON.stringify(entry));
    },

    async logTransaction(entry: TransactionLogEntry): Promise<void> {
      await appendLine(transactionsLogPath, JSON.stringify(entry));
    },

    async logLaneEvent(entry: LaneLogEntry): Promise<void> {
      await appendLine(laneLogPath, JSON.stringify(entry));
    },

    getReportingFn(reportToConsole: (line: string) => void): (line: string) => void {
      return (line: string) => {
        reportToConsole(line);
        void logger.logTerminal(line);
      };
    },
  };

  return logger;
}
