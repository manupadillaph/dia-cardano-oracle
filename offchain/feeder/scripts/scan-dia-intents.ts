// Scan DIA testnet for active IntentRegistered symbols.
//
// Usage (from offchain/feeder/):
//   npx tsx scripts/scan-dia-intents.ts [--blocks <n>] [--top <n>] [--chunk <n>]
//
// Flags:
//   --blocks  Number of past blocks to scan. Default: 2000 (~8 h on DIA testnet).
//   --top     How many symbols to show in the ranked output. Default: 10.
//   --chunk   getLogs batch size (blocks per request). Default: 500.
//
// How it works:
//   IntentRegistered has `symbol` as an indexed string param. Indexed dynamic
//   types are stored as keccak256(value) in the topic — the original string is
//   NOT recoverable from the topic alone. So the script:
//     1. Fetches all IntentRegistered logs in the window.
//     2. Groups logs by topic[2] (the symbol hash) to find unique symbols.
//     3. Calls getIntent(intentHash) exactly ONCE per unique symbol hash to
//        recover the actual symbol string.
//     4. Reports the ranked table and the YAML snippet for the router config.

import {
  createPublicClient,
  http,
  type Hex,
  type AbiEvent,
  type AbiFunction,
} from "viem";

// ---------------------------------------------------------------------------
// Hardcoded coordinates (DIA Testnet — no config file needed for a one-shot tool)
// ---------------------------------------------------------------------------

const RPC_URL     = "https://testnet-rpc.diadata.org";
const CHAIN_ID    = 10050;
const REGISTRY    = "0xF8c614A483A0427A13512F52ac72A576678bE317" as const;

const EVENT_ABI: AbiEvent = {
  type: "event",
  name: "IntentRegistered",
  anonymous: false,
  inputs: [
    { name: "intentHash", type: "bytes32", indexed: true },
    { name: "symbol",     type: "string",  indexed: true  },
    { name: "price",      type: "uint256", indexed: true  },
    { name: "timestamp",  type: "uint256", indexed: false },
    { name: "signer",     type: "address", indexed: false },
  ],
};

const GET_INTENT_ABI: AbiFunction = {
  type: "function",
  name: "getIntent",
  stateMutability: "view",
  inputs:  [{ name: "intentHash", type: "bytes32" }],
  outputs: [
    {
      name: "intent",
      type: "tuple",
      components: [
        { name: "intentType", type: "string"  },
        { name: "version",    type: "string"  },
        { name: "chainId",    type: "uint256" },
        { name: "nonce",      type: "uint256" },
        { name: "expiry",     type: "uint256" },
        { name: "symbol",     type: "string"  },
        { name: "price",      type: "uint256" },
        { name: "timestamp",  type: "uint256" },
        { name: "source",     type: "string"  },
        { name: "signature",  type: "bytes"   },
        { name: "signer",     type: "address" },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseFlag(flag: string, fallback: number): number {
  const arg = process.argv.find(a => a.startsWith(`--${flag}=`) || a === `--${flag}`);
  if (!arg) return fallback;
  const next = process.argv[process.argv.indexOf(arg) + 1];
  const raw = arg.includes("=") ? arg.split("=")[1] : next;
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const BLOCK_WINDOW = parseFlag("blocks", 2000);
const TOP_N        = parseFlag("top",    10);
const CHUNK_SIZE   = parseFlag("chunk",  500);

// ---------------------------------------------------------------------------
// viem client
// ---------------------------------------------------------------------------

const client = createPublicClient({
  transport: http(RPC_URL),
  chain: {
    id: CHAIN_ID,
    name: "DIA Testnet",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  },
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("DIA testnet — IntentRegistered symbol scanner");
  console.log(`Registry : ${REGISTRY}`);
  console.log(`RPC      : ${RPC_URL}`);
  console.log(`Window   : last ${BLOCK_WINDOW} blocks, chunk ${CHUNK_SIZE}`);
  console.log("");

  const head = await client.getBlockNumber();
  const from = head - BigInt(BLOCK_WINDOW);
  console.log(`Block range: ${from} → ${head}`);

  // Fetch logs in chunks to stay within RPC limits.
  const allLogs: Array<{ topics: readonly Hex[]; blockNumber: bigint }> = [];
  let cursor = from;
  while (cursor <= head) {
    const to = cursor + BigInt(CHUNK_SIZE) - 1n < head
      ? cursor + BigInt(CHUNK_SIZE) - 1n
      : head;
    process.stdout.write(`  getLogs ${cursor}…${to} ... `);
    const chunk = await client.getLogs({
      address: REGISTRY,
      event: EVENT_ABI,
      fromBlock: cursor,
      toBlock: to,
    });
    process.stdout.write(`${chunk.length} events\n`);
    for (const log of chunk) {
      allLogs.push({
        topics: log.topics,
        blockNumber: log.blockNumber ?? 0n,
      });
    }
    cursor = to + 1n;
  }

  console.log(`\nTotal events: ${allLogs.length}`);
  if (allLogs.length === 0) {
    console.log("No IntentRegistered events in this window. Try a larger --blocks value.");
    return;
  }

  // Group by symbol topic (topics[2] = keccak256 of the symbol string).
  // All logs for the same symbol have identical topics[2] regardless of price.
  type SymbolGroup = {
    sampleHash: Hex;    // one intentHash to call getIntent with
    count: number;
    lastBlock: bigint;
  };
  const bySymbolTopic = new Map<Hex, SymbolGroup>();

  for (const log of allLogs) {
    const symbolTopic = log.topics[2] as Hex;
    const intentHash  = log.topics[1] as Hex;
    if (!bySymbolTopic.has(symbolTopic)) {
      bySymbolTopic.set(symbolTopic, {
        sampleHash: intentHash,
        count: 0,
        lastBlock: 0n,
      });
    }
    const g = bySymbolTopic.get(symbolTopic)!;
    g.count++;
    if (log.blockNumber > g.lastBlock) g.lastBlock = log.blockNumber;
  }

  console.log(`Unique symbol hashes: ${bySymbolTopic.size}`);
  console.log("Resolving symbol names via getIntent (one call per unique symbol)...\n");

  // Recover actual symbol strings via getIntent.
  const resolved: Array<{ symbol: string; count: number; lastBlock: bigint }> = [];
  let idx = 0;
  for (const [, { sampleHash, count, lastBlock }] of bySymbolTopic) {
    idx++;
    process.stdout.write(`  [${idx}/${bySymbolTopic.size}] getIntent(${sampleHash.slice(0, 10)}…) → `);
    try {
      const intent = await client.readContract({
        address: REGISTRY,
        abi: [GET_INTENT_ABI],
        functionName: "getIntent",
        args: [sampleHash],
      }) as { symbol: string };
      const symbol = intent.symbol;
      resolved.push({ symbol, count, lastBlock });
      process.stdout.write(`${symbol} (${count} intents)\n`);
    } catch (err) {
      process.stdout.write(`ERROR — ${(err as Error).message.slice(0, 60)}\n`);
    }
  }

  // Rank by intent count descending.
  resolved.sort((a, b) => b.count - a.count);

  const bar = "=".repeat(62);
  const sep = "-".repeat(62);
  console.log(`\n${bar}`);
  console.log(`TOP ${TOP_N} SYMBOLS  (last ${BLOCK_WINDOW} blocks, ${allLogs.length} total intents)`);
  console.log(bar);
  console.log(`${"#".padEnd(4)} ${"SYMBOL".padEnd(28)} ${"INTENTS".padStart(7)}  LAST BLOCK`);
  console.log(sep);
  const top = resolved.slice(0, TOP_N);
  for (let i = 0; i < top.length; i++) {
    const { symbol, count, lastBlock } = top[i]!;
    console.log(`${String(i + 1).padEnd(4)} ${symbol.padEnd(28)} ${String(count).padStart(7)}  ${lastBlock}`);
  }
  console.log(bar);
  console.log(`Total unique symbols found in window: ${resolved.length}`);

  if (resolved.length < TOP_N) {
    console.log(`\nOnly ${resolved.length} symbols found — increase --blocks to scan more history.`);
  }

  console.log("\n--- Suggested router YAML (conditions[0].value) ---");
  console.log("        value:");
  for (const { symbol } of top) {
    console.log(`          - "${symbol}"`);
  }
  console.log("");
}

main().catch((err: unknown) => {
  console.error("\nFatal:", (err as Error).message);
  process.exit(1);
});
