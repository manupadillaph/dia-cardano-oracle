import { slotToUnixTime, type LucidEvolution } from "@lucid-evolution/lucid";

import { getCliConfig } from "./config.js";

const TX_VALIDITY_START_BACK_SLOTS = 60;

export type NetworkNow = {
  slot: number;
  unixTimeMs: number;
  unixTimeSec: bigint;
};

async function fetchBlockfrostTipSlot(apiUrl: string, projectId: string): Promise<number> {
  const response = await fetch(`${apiUrl}/blocks/latest`, {
    headers: { project_id: projectId },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `Blockfrost /blocks/latest failed (${response.status} ${response.statusText})`,
    );
  }
  const block = (await response.json()) as { slot: number };
  return block.slot;
}

export async function getNetworkNow(
  lucid: Awaited<ReturnType<typeof import("./lucid.js").makeConfiguredLucid>>,
): Promise<NetworkNow> {
  const config = getCliConfig();
  let slot: number;

  if (config.cardanoProvider === "Blockfrost") {
    slot = await fetchBlockfrostTipSlot(config.blockfrostApiUrl, config.blockfrostProjectId);
  } else {
    slot = lucid.currentSlot();
  }

  const network = lucid.config().network ?? config.cardanoNetwork;
  const unixTimeMs = Number(slotToUnixTime(network, slot));

  return {
    slot,
    unixTimeMs,
    unixTimeSec: BigInt(Math.floor(unixTimeMs / 1000)),
  };
}

export function slotBackoffUnixTimeMs(
  lucid: Pick<LucidEvolution, "config">,
  slot: number,
  slotsBack: number = TX_VALIDITY_START_BACK_SLOTS,
): number {
  const network = lucid.config().network ?? getCliConfig().cardanoNetwork;
  const safeSlot = Math.max(0, slot - slotsBack);
  return Number(slotToUnixTime(network, safeSlot));
}

export async function resolveIntentTimingFromNetwork(args: {
  lucid: Awaited<ReturnType<typeof import("./lucid.js").makeConfiguredLucid>>;
  expirySeconds: bigint;
  nonceBump?: bigint;
}): Promise<{
  timestamp: string;
  expiry: string;
  nonce: string;
}> {
  const now = await getNetworkNow(args.lucid);
  const nonceBump = args.nonceBump ?? 0n;
  const timestamp = now.unixTimeSec.toString();
  const expiry = (now.unixTimeSec + args.expirySeconds).toString();
  const nonce = (BigInt(now.unixTimeMs) + nonceBump).toString();

  return { timestamp, expiry, nonce };
}
