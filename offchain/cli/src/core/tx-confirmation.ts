import { getCliConfig } from "./config.js";

type AwaitTxLike = {
  awaitTx(txHash: string, checkInterval?: number): Promise<boolean>;
};

type FetchLike = typeof fetch;

type KoiosTxInfo = {
  tx_hash: string;
  block_height?: number | null;
};

export async function awaitTxConfirmation(args: {
  lucid: AwaitTxLike;
  txHash: string;
  reportProgress?: (message: string) => void;
  label?: string;
  koiosApiUrl?: string;
  fetchImpl?: FetchLike;
  koiosMaxAttempts?: number;
  koiosDelayMs?: number;
}): Promise<boolean> {
  const reportProgress = args.reportProgress ?? (() => undefined);

  try {
    const confirmed = await args.lucid.awaitTx(args.txHash, 3_000);
    if (confirmed) {
      return true;
    }

    reportProgress(
      `Primary confirmation provider did not observe ${args.txHash}; falling back to Koios confirmation.`,
    );
  } catch (error) {
    reportProgress(
      `Primary confirmation provider failed for ${args.txHash}; falling back to Koios confirmation (${describeError(error)}).`,
    );
  }

  const koiosApiUrl = args.koiosApiUrl ?? getCliConfig().koiosApiUrl;
  const fetchImpl = args.fetchImpl ?? fetch;
  const maxAttempts = args.koiosMaxAttempts ?? 10;
  const delayMs = args.koiosDelayMs ?? 3_000;
  const label = args.label ?? "transaction";
  let lastError: unknown = null;

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
        reportProgress(`Koios confirmed ${label} ${args.txHash}${location}.`);
        return true;
      }
    } catch (error) {
      lastError = error;
      reportProgress(
        `Koios confirmation attempt ${attempt + 1}/${maxAttempts} failed for ${args.txHash} (${describeError(error)}).`,
      );
    }

    if (attempt + 1 < maxAttempts) {
      await sleep(delayMs);
    }
  }

  if (lastError) {
    reportProgress(
      `Koios fallback exhausted for ${args.txHash}; last error: ${describeError(lastError)}.`,
    );
  }

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
    throw new Error(
      `Koios tx_info request failed (${response.status} ${response.statusText}).`,
    );
  }

  const payload = (await response.json()) as KoiosTxInfo[];
  return payload[0] ?? null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
