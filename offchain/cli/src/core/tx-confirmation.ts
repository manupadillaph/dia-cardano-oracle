import { getCliConfig } from "./config.js";

type AwaitTxLike = {
  awaitTx(txHash: string, checkInterval?: number): Promise<boolean>;
};

type FetchLike = typeof fetch;

type KoiosTxInfo = {
  tx_hash: string;
  block_height?: number | null;
};

class KoiosServiceDownError extends Error {
  constructor(public readonly status: number, statusText: string) {
    super(`Koios tx_info request failed (${status} ${statusText}).`);
    this.name = "KoiosServiceDownError";
  }
}

// Defaults for the multi-provider confirmation pipeline. Each stage can be
// independently overridden via env vars when the network is congested:
//   TX_CONFIRMATION_PRIMARY_TIMEOUT_MS    (default 180_000  = 3 min)
//   TX_CONFIRMATION_KOIOS_ATTEMPTS        (default 60)
//   TX_CONFIRMATION_KOIOS_DELAY_MS        (default 3_000)   = 60 × 3 s = 3 min
//   TX_CONFIRMATION_BLOCKFROST_ATTEMPTS   (default 30)
//   TX_CONFIRMATION_BLOCKFROST_DELAY_MS   (default 6_000)   = 30 × 6 s = 3 min
// Total worst-case window with defaults: ~9 minutes across 3 providers.
const DEFAULT_PRIMARY_TIMEOUT_MS = 180_000;
const DEFAULT_KOIOS_ATTEMPTS = 60;
const DEFAULT_KOIOS_DELAY_MS = 3_000;
const DEFAULT_BLOCKFROST_ATTEMPTS = 30;
const DEFAULT_BLOCKFROST_DELAY_MS = 6_000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid ${name}=${raw}: expected a positive number of milliseconds or attempts.`,
    );
  }
  return value;
}

export async function awaitTxConfirmation(args: {
  lucid: AwaitTxLike;
  txHash: string;
  reportProgress?: (message: string) => void;
  label?: string;
  koiosApiUrl?: string;
  blockfrostApiUrl?: string;
  blockfrostProjectId?: string;
  fetchImpl?: FetchLike;
  koiosMaxAttempts?: number;
  koiosDelayMs?: number;
  primaryTimeoutMs?: number;
  blockfrostRetryAttempts?: number;
  blockfrostRetryDelayMs?: number;
}): Promise<boolean> {
  const reportProgress = args.reportProgress ?? (() => undefined);
  const primaryTimeoutMs =
    args.primaryTimeoutMs ??
    envNumber("TX_CONFIRMATION_PRIMARY_TIMEOUT_MS", DEFAULT_PRIMARY_TIMEOUT_MS);
  const label = args.label ?? "transaction";

  // Wrap lucid.awaitTx so that an internal fetch rejection inside Lucid's
  // polling loop cannot escape as an unhandled rejection. The batch-10
  // crash in m1-mainnet-20260517-063917 happened because such a rejection
  // killed the process before any Koios/Blockfrost-REST fallback ran.
  const primaryConfirmed = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    Promise.resolve()
      .then(() => args.lucid.awaitTx(args.txHash, 3_000))
      .then((ok) => finish(Boolean(ok)))
      .catch((error) => {
        reportProgress(
          `Blockfrost lookup failed for ${args.txHash}; trying Koios (${describeError(error)}).`,
        );
        finish(false);
      });
    setTimeout(() => {
      if (!settled) {
        reportProgress(
          `Blockfrost did not see ${args.txHash} within ${primaryTimeoutMs}ms; trying Koios.`,
        );
      }
      finish(false);
    }, primaryTimeoutMs);
  });

  if (primaryConfirmed) {
    reportProgress(`Confirmed by Blockfrost: ${label} ${args.txHash}.`);
    return true;
  }

  const config = getCliConfig();
  const koiosApiUrl = args.koiosApiUrl ?? config.koiosApiUrl;
  const fetchImpl = args.fetchImpl ?? fetch;
  const maxAttempts =
    args.koiosMaxAttempts ??
    envNumber("TX_CONFIRMATION_KOIOS_ATTEMPTS", DEFAULT_KOIOS_ATTEMPTS);
  const delayMs =
    args.koiosDelayMs ??
    envNumber("TX_CONFIRMATION_KOIOS_DELAY_MS", DEFAULT_KOIOS_DELAY_MS);
  let lastError: unknown = null;
  let koiosDownCount = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const txInfo = await fetchKoiosTxInfo({
        koiosApiUrl,
        txHash: args.txHash,
        fetchImpl,
      });

      if (txInfo) {
        const location = txInfo.block_height
          ? ` at block ${txInfo.block_height}`
          : "";
        reportProgress(`Confirmed by Koios: ${label} ${args.txHash}${location}.`);
        return true;
      }
    } catch (error) {
      lastError = error;
      if (error instanceof KoiosServiceDownError && error.status >= 500) {
        koiosDownCount += 1;
        reportProgress(
          `Koios attempt ${attempt + 1}/${maxAttempts} failed for ${args.txHash} (${describeError(error)}).`,
        );
        if (koiosDownCount >= 3) {
          reportProgress(
            `Koios appears to be down (${koiosDownCount} consecutive 5xx); falling back to Blockfrost REST.`,
          );
          break;
        }
      } else {
        koiosDownCount = 0;
        reportProgress(
          `Koios attempt ${attempt + 1}/${maxAttempts} failed for ${args.txHash} (${describeError(error)}).`,
        );
      }
    }

    if (attempt + 1 < maxAttempts) {
      await sleep(delayMs);
    }
  }

  if (lastError && !(lastError instanceof KoiosServiceDownError && lastError.status >= 500)) {
    reportProgress(
      `Koios fallback exhausted for ${args.txHash}; last error: ${describeError(lastError)}.`,
    );
  }

  const blockfrostApiUrl = args.blockfrostApiUrl ?? config.blockfrostApiUrl;
  const blockfrostProjectId = args.blockfrostProjectId ?? config.blockfrostProjectId;
  const bfRetryAttempts =
    args.blockfrostRetryAttempts ??
    envNumber("TX_CONFIRMATION_BLOCKFROST_ATTEMPTS", DEFAULT_BLOCKFROST_ATTEMPTS);
  const bfRetryDelayMs =
    args.blockfrostRetryDelayMs ??
    envNumber("TX_CONFIRMATION_BLOCKFROST_DELAY_MS", DEFAULT_BLOCKFROST_DELAY_MS);

  reportProgress(
    `Retrying confirmation via Blockfrost REST for ${args.txHash} (up to ${bfRetryAttempts} attempts).`,
  );

  for (let attempt = 0; attempt < bfRetryAttempts; attempt += 1) {
    try {
      const confirmed = await fetchBlockfrostTxExists({
        blockfrostApiUrl,
        blockfrostProjectId,
        txHash: args.txHash,
        fetchImpl,
      });
      if (confirmed) {
        reportProgress(`Confirmed by Blockfrost REST: ${label} ${args.txHash}.`);
        return true;
      }
    } catch (error) {
      reportProgress(
        `Blockfrost REST attempt ${attempt + 1}/${bfRetryAttempts} failed for ${args.txHash} (${describeError(error)}).`,
      );
    }

    if (attempt + 1 < bfRetryAttempts) {
      await sleep(bfRetryDelayMs);
    }
  }

  reportProgress(`All confirmation fallbacks exhausted for ${args.txHash}.`);
  return false;
}

async function fetchKoiosTxInfo(args: {
  koiosApiUrl: string;
  txHash: string;
  fetchImpl: FetchLike;
}): Promise<KoiosTxInfo | null> {
  const response = await args.fetchImpl(`${args.koiosApiUrl}/tx_info`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ _tx_hashes: [args.txHash] }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    if (response.status >= 500) {
      throw new KoiosServiceDownError(response.status, response.statusText);
    }
    throw new Error(
      `Koios tx_info request failed (${response.status} ${response.statusText}).`,
    );
  }

  const payload = (await response.json()) as KoiosTxInfo[];
  return payload[0] ?? null;
}

async function fetchBlockfrostTxExists(args: {
  blockfrostApiUrl: string;
  blockfrostProjectId: string;
  txHash: string;
  fetchImpl: FetchLike;
}): Promise<boolean> {
  const response = await args.fetchImpl(
    `${args.blockfrostApiUrl}/txs/${args.txHash}`,
    {
      headers: { project_id: args.blockfrostProjectId },
      signal: AbortSignal.timeout(20_000),
    },
  );

  if (response.status === 404) return false;

  if (!response.ok) {
    throw new Error(
      `Blockfrost REST tx lookup failed (${response.status} ${response.statusText}).`,
    );
  }

  return true;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
