import { CONFIG } from "../shared";
import type {
  AccountQuery,
  CheckerNetwork,
  CheckerSummaryMetrics,
  ExportPayload,
  ImportedTradesResult,
  LighterTrade,
  ParsedTradeView,
  StitchedTradesResult,
} from "./types";

function getBaseApiUrl(network: CheckerNetwork): string {
  return network === "rh" ? CONFIG.RH_API_URL : CONFIG.CORE_API_URL;
}

function getNetworkDisplayName(network: CheckerNetwork): string {
  return network === "rh" ? "Robinhood Chain (RH)" : "Lighter Mainnet (Core)";
}

/**
 * Normalizes timestamp into milliseconds (handles both sec and ms).
 */
export function normalizeTimestampMs(ts: number): number {
  if (!ts || isNaN(ts)) return 0;
  // If timestamp is less than 1e11, it is in seconds (e.g. 1727865600)
  return ts < 1e11 ? ts * 1000 : ts;
}

const STATIC_MARKET_MAP: Record<CheckerNetwork, Record<number, string>> = {
  rh: {
    0: "ETH",
    1: "BTC",
    2: "HYPE",
    3: "SOL",
    4: "ZEC",
    5: "LIT",
    6: "XRP",
    7: "NEAR",
    8: "VVV",
    9: "SUI",
    10: "AAPL",
    11: "AMZN",
    12: "GOOGL",
    13: "META",
    14: "MSFT",
    15: "NVDA",
    16: "TSLA",
    17: "ORCL",
    18: "SPCX",
    19: "BABA",
    20: "BE",
    22: "USO",
    23: "COIN",
    24: "CRCL",
    25: "QQQ",
    26: "SPY",
    27: "SGOV",
    28: "SLV",
    29: "AMD",
    30: "INTC",
    31: "MU",
    33: "CRWV",
    34: "PLTR",
    35: "SOXL",
    36: "CASHCAT",
    37: "SKHY",
    38: "ANTHROPIC",
    39: "ANSEM",
    40: "XAU",
    41: "XAG",
    42: "OPENAI",
    43: "SHEIN",
    44: "PONS",
    45: "AI",
    46: "TSM",
    53: "SMCI",
  },
  mainnet: {
    0: "ETH",
    1: "BTC",
    2: "SOL",
    6: "WLD",
    7: "XRP",
    10: "NEAR",
    16: "SUI",
    24: "HYPE",
    90: "ZEC",
    92: "XAU",
    93: "XAG",
    108: "HOOD",
    109: "COIN",
    110: "NVDA",
    111: "PLTR",
    112: "TSLA",
    113: "AAPL",
    114: "AMZN",
    115: "MSFT",
    116: "GOOGL",
    117: "META",
    120: "LIT",
    128: "SPY",
    129: "QQQ",
    137: "INTC",
    138: "AMD",
    164: "MU",
    165: "ORCL",
    168: "TSM",
    177: "BABA",
    193: "ANTHROPIC",
    194: "SPCX",
    196: "BE",
    197: "SOXL",
    216: "SKHY",
    221: "CASHCAT",
    230: "SHEIN",
    231: "PONS",
    232: "AI",
  },
};

export function getStaticMarketMap(network: CheckerNetwork): Map<number, string> {
  const map = new Map<number, string>();
  const staticEntries = STATIC_MARKET_MAP[network] || {};
  for (const [id, symbol] of Object.entries(staticEntries)) {
    map.set(Number(id), symbol);
  }
  return map;
}

/**
 * Fetches market definitions from orderBookDetails to map market_id -> Symbol.
 * Falls back to STATIC_MARKET_MAP if API is unreachable or offline.
 */
export async function fetchMarketMap(
  network: CheckerNetwork,
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const baseUrl = getBaseApiUrl(network);
  const map = getStaticMarketMap(network);

  try {
    const res = await fetch(`${baseUrl}/orderBookDetails?_t=${Date.now()}`, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) return map;

    const data = (await res.json()) as any;
    if (data && Array.isArray(data.order_book_details)) {
      for (const m of data.order_book_details) {
        if (m.market_id !== undefined && m.symbol) {
          map.set(Number(m.market_id), String(m.symbol).toUpperCase());
        }
      }
    }
  } catch {
    // Non-critical: falls back to static dictionary
  }

  return map;
}

/**
 * Resolves an account identifier (numeric index or 0x... L1 Address) to a numeric account index.
 */
export async function resolveAccountIndex(
  network: CheckerNetwork,
  input: string,
  authToken?: string,
  signal?: AbortSignal,
): Promise<{ accountIndex: number; l1Address?: string }> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Please enter an Account Index or L1 Wallet Address.");
  }

  // Pure numeric index
  if (/^\d+$/.test(trimmed)) {
    const index = parseInt(trimmed, 10);
    return { accountIndex: index };
  }

  // Hex address 0x...
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    const baseUrl = getBaseApiUrl(network);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (authToken && authToken.trim()) {
      headers["Authorization"] = authToken.trim();
    }

    const res = await fetch(`${baseUrl}/account?by=l1_address&value=${trimmed}&_t=${Date.now()}`, {
      headers,
      signal,
    });

    if (!res.ok) {
      throw new Error(`Failed to resolve wallet address: HTTP ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    if (data.code === 200 && Array.isArray(data.accounts) && data.accounts.length > 0) {
      const acc = data.accounts[0];
      return { accountIndex: Number(acc.index), l1Address: trimmed };
    }

    if (Array.isArray(data.sub_accounts) && data.sub_accounts.length > 0) {
      const acc = data.sub_accounts[0];
      return { accountIndex: Number(acc.index), l1Address: trimmed };
    }

    throw new Error(
      `No Lighter account found for address ${trimmed} on ${getNetworkDisplayName(network)}.`,
    );
  }

  throw new Error("Invalid account format. Enter a numeric ID (e.g. 12345) or 0x address.");
}

/**
 * Safely parses exchange fees to USD amount.
 * Handles quote base units (USDC 6 decimals: > 1000 => raw / 1e6),
 * basis points (<= 1000 => (raw / 10000) * usdValue),
 * and standard floating-point USD fees.
 */
export function parseFeeUsd(rawFee: number | undefined | null, usdValue = 0): number {
  if (rawFee === undefined || rawFee === null || isNaN(rawFee) || rawFee <= 0) {
    return 0;
  }
  // Floating point values are already denominated in USD
  if (!Number.isInteger(rawFee)) {
    return rawFee;
  }
  // In Lighter zk-rollup, atomic quote token units have 6 decimals (1 USDC = 1,000,000 units)
  if (rawFee > 1000) {
    return rawFee / 1_000_000;
  }
  // If integer <= 1000, it represents basis points (e.g. 5 bps = 0.05%)
  return (rawFee / 10000) * usdValue;
}

/**
 * Normalizes an account query (single number, array, or Set) into a Set of numbers.
 */
function toAccountSet(query?: AccountQuery | null): Set<number> {
  const set = new Set<number>();
  if (query == null) return set;
  if (query instanceof Set) {
    for (const v of query) {
      const n = Number(v);
      if (!isNaN(n)) set.add(n);
    }
    return set;
  }
  if (Array.isArray(query)) {
    for (const v of query) {
      const n = Number(v);
      if (!isNaN(n)) set.add(n);
    }
    return set;
  }
  const n = Number(query);
  if (!isNaN(n)) set.add(n);
  return set;
}

/**
 * Detects user account index(es) from raw trades.
 * Analyzes ask_account_pnl/bid_account_pnl (which Lighter API provides only for the queried account),
 * client ID presence, and trade frequency while filtering out system pools.
 */
export function detectUserAccounts(trades: LighterTrade[]): number[] {
  if (!trades || trades.length === 0) return [];

  const appearanceCounts = new Map<number, number>();
  const pnlCounts = new Map<number, number>();
  const clientOrderCounts = new Map<number, number>();

  for (const t of trades) {
    const askAcc = Number(t.ask_account_id);
    const bidAcc = Number(t.bid_account_id);

    // Track appearances for valid user accounts (filtering out system pools > 100B)
    if (!isNaN(askAcc) && askAcc > 0 && askAcc < 100_000_000_000) {
      appearanceCounts.set(askAcc, (appearanceCounts.get(askAcc) || 0) + 1);
    }
    if (!isNaN(bidAcc) && bidAcc > 0 && bidAcc < 100_000_000_000) {
      appearanceCounts.set(bidAcc, (appearanceCounts.get(bidAcc) || 0) + 1);
    }

    // PnL analysis: check for non-zero or single-sided PnL
    const hasAskPnl =
      t.ask_account_pnl !== undefined && t.ask_account_pnl !== null && t.ask_account_pnl !== "";
    const hasBidPnl =
      t.bid_account_pnl !== undefined && t.bid_account_pnl !== null && t.bid_account_pnl !== "";

    const askPnlVal = hasAskPnl ? parseFloat(t.ask_account_pnl!) : 0;
    const bidPnlVal = hasBidPnl ? parseFloat(t.bid_account_pnl!) : 0;

    if (hasAskPnl && (!hasBidPnl || (askPnlVal !== 0 && bidPnlVal === 0))) {
      if (!isNaN(askAcc) && askAcc > 0 && askAcc < 100_000_000_000) {
        pnlCounts.set(askAcc, (pnlCounts.get(askAcc) || 0) + 1);
      }
    }
    if (hasBidPnl && (!hasAskPnl || (bidPnlVal !== 0 && askPnlVal === 0))) {
      if (!isNaN(bidAcc) && bidAcc > 0 && bidAcc < 100_000_000_000) {
        pnlCounts.set(bidAcc, (pnlCounts.get(bidAcc) || 0) + 1);
      }
    }

    // Client ID presence (only queried account sends client ID)
    if (t.ask_client_id || t.ask_client_id_str || t.ask_order_version !== undefined) {
      if (!isNaN(askAcc) && askAcc > 0 && askAcc < 100_000_000_000) {
        clientOrderCounts.set(askAcc, (clientOrderCounts.get(askAcc) || 0) + 1);
      }
    }
    if (t.bid_client_id || t.bid_client_id_str || t.bid_order_version !== undefined) {
      if (!isNaN(bidAcc) && bidAcc > 0 && bidAcc < 100_000_000_000) {
        clientOrderCounts.set(bidAcc, (clientOrderCounts.get(bidAcc) || 0) + 1);
      }
    }
  }

  // Score candidate accounts
  const candidates: Array<{ acc: number; score: number; freq: number }> = [];

  for (const [acc, count] of appearanceCounts.entries()) {
    const freq = count / trades.length;
    const pnl = pnlCounts.get(acc) || 0;
    const clientOrders = clientOrderCounts.get(acc) || 0;

    // Reject transient counterparty accounts with low frequency (< 15% of trades) and no real PnL/client IDs
    if (trades.length >= 10 && freq < 0.15 && pnl === 0 && clientOrders === 0) {
      continue;
    }

    const score = count * 10 + pnl * 100 + clientOrders * 50;
    candidates.push({ acc, score, freq });
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return [];

  const top = candidates[0];
  // Include secondary accounts only if they represent a significant portion of trades (multi-account stitched file)
  const detected = candidates
    .filter((c) => c.score >= top.score * 0.35 && (c.freq >= 0.2 || c.score > 500))
    .map((c) => c.acc);

  return detected.length > 0 ? detected : [top.acc];
}

interface TradeSortKey {
  ts: number;
  micro: number;
  id: number;
}

const tradeSortKeyMap = new WeakMap<LighterTrade, TradeSortKey>();

function getTradeSortKey(t: LighterTrade): TradeSortKey {
  let key = tradeSortKeyMap.get(t);
  if (!key) {
    key = {
      ts: normalizeTimestampMs(t.timestamp),
      micro: t.transaction_time ?? 0,
      id: Number(t.trade_id_str || t.trade_id) || 0,
    };
    tradeSortKeyMap.set(t, key);
  }
  return key;
}

/**
 * Sorts trades chronologically descending (most recent first) with microsecond and trade_id tie-breakers.
 */
export function sortTradesChronologicalDesc(trades: LighterTrade[]): LighterTrade[] {
  if (trades.length <= 1) return trades;

  // Fast path: verify if already sorted descending in O(N)
  let isSorted = true;
  for (let i = 1; i < trades.length; i++) {
    const prevKey = getTradeSortKey(trades[i - 1]);
    const currKey = getTradeSortKey(trades[i]);

    if (prevKey.ts < currKey.ts) {
      isSorted = false;
      break;
    }
    if (prevKey.ts === currKey.ts) {
      if (prevKey.micro < currKey.micro) {
        isSorted = false;
        break;
      }
      if (prevKey.micro === currKey.micro && prevKey.id < currKey.id) {
        isSorted = false;
        break;
      }
    }
  }

  if (isSorted) return trades;

  // oxlint-disable-next-line unicorn/no-array-sort
  return trades.sort((a, b) => {
    const aKey = getTradeSortKey(a);
    const bKey = getTradeSortKey(b);
    if (aKey.ts !== bKey.ts) return bKey.ts - aKey.ts;
    if (aKey.micro !== bKey.micro) return bKey.micro - aKey.micro;
    return bKey.id - aKey.id;
  });
}

/**
 * Sorts parsed trade views chronologically descending (most recent first).
 */
export function sortParsedTradesChronologicalDesc(trades: ParsedTradeView[]): ParsedTradeView[] {
  if (trades.length <= 1) return trades;

  // Fast path: verify if already sorted descending in O(N)
  let isSorted = true;
  for (let i = 1; i < trades.length; i++) {
    const prev = trades[i - 1];
    const curr = trades[i];
    if (prev.timestampMs < curr.timestampMs) {
      isSorted = false;
      break;
    }
    if (prev.timestampMs === curr.timestampMs) {
      const prevMicro = prev.raw?.transaction_time ?? 0;
      const currMicro = curr.raw?.transaction_time ?? 0;
      if (prevMicro < currMicro) {
        isSorted = false;
        break;
      }
      if (prevMicro === currMicro) {
        const prevId = prev.tradeIdNum ?? (Number(prev.tradeId) || 0);
        const currId = curr.tradeIdNum ?? (Number(curr.tradeId) || 0);
        if (prevId < currId) {
          isSorted = false;
          break;
        }
      }
    }
  }

  if (isSorted) return trades;

  // oxlint-disable-next-line unicorn/no-array-sort
  return trades.sort((a, b) => {
    if (b.timestampMs !== a.timestampMs) return b.timestampMs - a.timestampMs;

    const aMicro = a.raw?.transaction_time ?? 0;
    const bMicro = b.raw?.transaction_time ?? 0;
    if (aMicro !== bMicro) return bMicro - aMicro;

    const aId = a.tradeIdNum ?? (Number(a.tradeId) || 0);
    const bId = b.tradeIdNum ?? (Number(b.tradeId) || 0);
    return bId - aId;
  });
}

/**
 * Stitches multiple trade batches/files together:
 * - Deduplicates trades by trade_id
 * - Aggregates all detected user accounts
 * - Sorts chronologically descending
 */
export function stitchTradeBatches(
  batches: Array<
    | ImportedTradesResult
    | {
        trades: LighterTrade[];
        accountIndex?: number | null;
        accountIndices?: number[];
        network?: CheckerNetwork | null;
        l1Address?: string;
        fileName?: string;
      }
  >,
): StitchedTradesResult {
  const seenTradeKeys = new Set<string>();
  const mergedTrades: LighterTrade[] = [];
  const accountSet = new Set<number>();
  let detectedNetwork: CheckerNetwork | null = null;
  let l1Address: string | undefined = undefined;
  let totalRawTradesCount = 0;
  let duplicateTradesCount = 0;
  const fileNames: string[] = [];

  for (const batch of batches) {
    if (batch.fileName) {
      fileNames.push(batch.fileName);
    }
    if (!detectedNetwork && batch.network) {
      detectedNetwork = batch.network;
    }
    if (!l1Address && batch.l1Address) {
      l1Address = batch.l1Address;
    }
    if (batch.accountIndex != null && !isNaN(batch.accountIndex)) {
      accountSet.add(batch.accountIndex);
    }
    if (batch.accountIndices) {
      for (const acc of batch.accountIndices) {
        if (acc != null && !isNaN(acc)) accountSet.add(acc);
      }
    }

    for (const t of batch.trades) {
      totalRawTradesCount++;
      const key =
        t.trade_id_str ||
        (t.trade_id != null ? String(t.trade_id) : "") ||
        `${t.block_height}_${t.transaction_time}_${t.market_id}_${t.size}`;

      if (seenTradeKeys.has(key)) {
        duplicateTradesCount++;
        continue;
      }
      seenTradeKeys.add(key);
      mergedTrades.push(t);
    }
  }

  // If no account was detected in metadata, detect from merged trades
  if (accountSet.size === 0 && mergedTrades.length > 0) {
    const detected = detectUserAccounts(mergedTrades);
    for (const acc of detected) {
      accountSet.add(acc);
    }
  }

  // Sort chronologically descending (newest first)
  sortTradesChronologicalDesc(mergedTrades);

  const accountIndices = Array.from(accountSet);
  const primaryAccountIndex = accountIndices.length > 0 ? accountIndices[0] : null;

  return {
    trades: mergedTrades,
    accountIndices,
    primaryAccountIndex,
    network: detectedNetwork,
    l1Address,
    totalRawTradesCount,
    duplicateTradesCount,
    fileCount: batches.length,
    fileNames,
  };
}

/**
 * Parses a raw LighterTrade into a view representation.
 * Supports single account or multiple user accounts in a stitched dataset.
 */
export function parseTradeForView(
  trade: LighterTrade,
  queriedAccounts: AccountQuery,
  marketMap?: Map<number, string>,
): ParsedTradeView {
  const userAccounts = toAccountSet(queriedAccounts);

  const bidId = Number(trade.bid_account_id);
  const askId = Number(trade.ask_account_id);

  const isUserBid = userAccounts.has(bidId);
  const isUserAsk = userAccounts.has(askId);

  let side: "BUY" | "SELL" = "BUY";
  let role: "MAKER" | "TAKER" = "TAKER";
  let userAccountId: number | undefined = undefined;
  let realizedPnl = 0;

  if (isUserBid && !isUserAsk) {
    side = "BUY";
    role = !trade.is_maker_ask ? "MAKER" : "TAKER";
    userAccountId = bidId;
    if (trade.bid_account_pnl) realizedPnl = parseFloat(trade.bid_account_pnl) || 0;
  } else if (isUserAsk && !isUserBid) {
    side = "SELL";
    role = trade.is_maker_ask ? "MAKER" : "TAKER";
    userAccountId = askId;
    if (trade.ask_account_pnl) realizedPnl = parseFloat(trade.ask_account_pnl) || 0;
  } else if (isUserBid && isUserAsk) {
    // Self-trade between user's own accounts
    side = "BUY";
    role = "MAKER";
    userAccountId = bidId;
    const pnl1 = trade.bid_account_pnl ? parseFloat(trade.bid_account_pnl) || 0 : 0;
    const pnl2 = trade.ask_account_pnl ? parseFloat(trade.ask_account_pnl) || 0 : 0;
    realizedPnl = pnl1 + pnl2;
  } else {
    // Fallback: check PnL indicators
    if (
      trade.bid_account_pnl !== undefined &&
      trade.bid_account_pnl !== null &&
      trade.bid_account_pnl !== ""
    ) {
      side = "BUY";
      role = !trade.is_maker_ask ? "MAKER" : "TAKER";
      userAccountId = bidId;
      realizedPnl = parseFloat(trade.bid_account_pnl) || 0;
    } else if (
      trade.ask_account_pnl !== undefined &&
      trade.ask_account_pnl !== null &&
      trade.ask_account_pnl !== ""
    ) {
      side = "SELL";
      role = trade.is_maker_ask ? "MAKER" : "TAKER";
      userAccountId = askId;
      realizedPnl = parseFloat(trade.ask_account_pnl) || 0;
    } else {
      // Default: bid is user
      side = "BUY";
      role = !trade.is_maker_ask ? "MAKER" : "TAKER";
      userAccountId = bidId;
    }
  }

  const rawFee = role === "MAKER" ? trade.maker_fee : trade.taker_fee;
  const usdValue = parseFloat(trade.usd_amount) || 0;
  const feeUsd = parseFeeUsd(rawFee, usdValue);

  const symbol = marketMap?.get(Number(trade.market_id)) || `#${trade.market_id}`;
  const timestampMs = normalizeTimestampMs(trade.timestamp);
  const timeFormatted = timestampMs ? formatTimestampUtc(timestampMs) : "--";

  const txHash = trade.tx_hash || "";
  const isZeroHash = !txHash || /^0x?0+$/.test(txHash) || txHash === "0";
  const txHashShort = isZeroHash
    ? "--"
    : txHash.length > 14
      ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}`
      : txHash;

  const tradeId = trade.trade_id_str || String(trade.trade_id);
  const tradeIdNum = Number(trade.trade_id_str || trade.trade_id) || 0;
  const searchIndex = `${symbol} ${side} ${role} ${tradeId} ${txHash}`.toLowerCase();

  return {
    raw: trade,
    tradeId,
    tradeIdNum,
    userAccountId,
    timeFormatted,
    timestampMs,
    marketSymbol: symbol,
    marketId: Number(trade.market_id),
    marketKind: trade.market_kind || "perps",
    type: trade.type || "trade",
    side,
    role,
    price: parseFloat(trade.price) || 0,
    size: parseFloat(trade.size) || 0,
    usdValue,
    realizedPnl,
    feeUsd,
    txHash,
    txHashShort,
    searchIndex,
  };
}

/**
 * Calculates aggregate summary metrics from fetched trades.
 * Supports single account index or multiple user accounts in a stitched dataset.
 */
export function calculateTradeMetrics(
  trades: LighterTrade[],
  queriedAccounts: AccountQuery,
): CheckerSummaryMetrics {
  const userAccounts = toAccountSet(queriedAccounts);
  let totalVolumeUsd = 0;
  let totalRealizedPnl = 0;
  let totalFeesUsd = 0;
  let makerTradesCount = 0;
  let takerTradesCount = 0;
  let buyTradesCount = 0;
  let sellTradesCount = 0;
  let firstTradeTime: number | null = null;
  let lastTradeTime: number | null = null;
  const marketSet = new Set<number>();

  for (const t of trades) {
    const bidId = Number(t.bid_account_id);
    const askId = Number(t.ask_account_id);
    const isUserBid = userAccounts.has(bidId);
    const isUserAsk = userAccounts.has(askId);

    let isBuy = true;
    let isMaker = false;
    let tradePnl = 0;

    if (isUserBid && !isUserAsk) {
      isBuy = true;
      isMaker = !t.is_maker_ask;
      if (t.bid_account_pnl) tradePnl = parseFloat(t.bid_account_pnl) || 0;
    } else if (isUserAsk && !isUserBid) {
      isBuy = false;
      isMaker = t.is_maker_ask;
      if (t.ask_account_pnl) tradePnl = parseFloat(t.ask_account_pnl) || 0;
    } else if (isUserBid && isUserAsk) {
      isBuy = true;
      isMaker = true;
      const pnl1 = t.bid_account_pnl ? parseFloat(t.bid_account_pnl) || 0 : 0;
      const pnl2 = t.ask_account_pnl ? parseFloat(t.ask_account_pnl) || 0 : 0;
      tradePnl = pnl1 + pnl2;
    } else {
      // Fallback by PnL indicators
      if (
        t.bid_account_pnl !== undefined &&
        t.bid_account_pnl !== null &&
        t.bid_account_pnl !== ""
      ) {
        isBuy = true;
        isMaker = !t.is_maker_ask;
        tradePnl = parseFloat(t.bid_account_pnl) || 0;
      } else if (
        t.ask_account_pnl !== undefined &&
        t.ask_account_pnl !== null &&
        t.ask_account_pnl !== ""
      ) {
        isBuy = false;
        isMaker = t.is_maker_ask;
        tradePnl = parseFloat(t.ask_account_pnl) || 0;
      } else {
        isBuy = true;
        isMaker = !t.is_maker_ask;
      }
    }

    if (isBuy) buyTradesCount++;
    else sellTradesCount++;

    if (isMaker) makerTradesCount++;
    else takerTradesCount++;

    totalRealizedPnl += tradePnl;

    const usd = parseFloat(t.usd_amount) || 0;
    totalVolumeUsd += usd;

    const rawFee = isMaker ? t.maker_fee : t.taker_fee;
    totalFeesUsd += parseFeeUsd(rawFee, usd);

    marketSet.add(Number(t.market_id));

    const ts = normalizeTimestampMs(t.timestamp);
    if (ts > 0) {
      if (firstTradeTime === null || ts < firstTradeTime) firstTradeTime = ts;
      if (lastTradeTime === null || ts > lastTradeTime) lastTradeTime = ts;
    }
  }

  return {
    totalTrades: trades.length,
    totalVolumeUsd,
    totalRealizedPnl,
    totalFeesUsd,
    makerTradesCount,
    takerTradesCount,
    buyTradesCount,
    sellTradesCount,
    firstTradeTime,
    lastTradeTime,
    uniqueMarketsCount: marketSet.size,
    accountIndices: Array.from(userAccounts),
  };
}

function padZero(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Formats a timestamp into YYYY-MM-DD HH:MM:SS UTC.
 */
export function formatTimestampUtc(ms: number): string {
  if (!ms || isNaN(ms)) return "--";
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${padZero(d.getUTCMonth() + 1)}-${padZero(d.getUTCDate())} ${padZero(d.getUTCHours())}:${padZero(d.getUTCMinutes())}:${padZero(d.getUTCSeconds())}`;
}

/**
 * Prepares the complete JSON export payload.
 */
export function prepareExportPayload(
  trades: LighterTrade[],
  network: CheckerNetwork,
  accountIndex: number | number[],
  l1Address?: string,
  truncated?: boolean,
  rowCap?: number,
): ExportPayload {
  const accountIndices = Array.isArray(accountIndex) ? accountIndex : [accountIndex];
  const primaryAccountIndex = accountIndices[0] ?? 0;
  const metrics = calculateTradeMetrics(trades, accountIndices);
  return {
    version: "1.0",
    exported_at: new Date().toISOString(),
    exported_at_unix: Date.now(),
    network,
    network_name: getNetworkDisplayName(network),
    account_index: primaryAccountIndex,
    ...(accountIndices.length > 1 ? { account_indices: accountIndices } : {}),
    ...(l1Address ? { l1_address: l1Address } : {}),
    total_trades: trades.length,
    ...(truncated ? { truncated: true } : {}),
    ...(rowCap ? { row_cap: rowCap } : {}),
    summary: {
      total_volume_usd: Number(metrics.totalVolumeUsd.toFixed(2)),
      total_realized_pnl_usd: Number(metrics.totalRealizedPnl.toFixed(4)),
      total_fees_usd: Number(metrics.totalFeesUsd.toFixed(4)),
      buy_trades_count: metrics.buyTradesCount,
      sell_trades_count: metrics.sellTradesCount,
      maker_trades_count: metrics.makerTradesCount,
      taker_trades_count: metrics.takerTradesCount,
      first_trade_time_utc: metrics.firstTradeTime
        ? formatTimestampUtc(metrics.firstTradeTime)
        : null,
      last_trade_time_utc: metrics.lastTradeTime ? formatTimestampUtc(metrics.lastTradeTime) : null,
    },
    trades,
  };
}

/**
 * Triggers a file download of an object as pretty-printed JSON.
 */
export function downloadJsonFile(data: unknown, filename: string): void {
  const isLarge =
    data && typeof data === "object" && "trades" in data && Array.isArray((data as any).trades)
      ? (data as any).trades.length > 5000
      : false;
  const jsonStr = isLarge ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Triggers a file download of text content (e.g. CSV).
 */
export function downloadTextFile(
  content: string,
  filename: string,
  mimeType = "text/csv;charset=utf-8",
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Validates and parses an uploaded JSON file into structured trade history.
 * Supports both custom export payloads and raw Lighter API responses ({ code: 200, next_cursor, trades: [...] }).
 */
export function parseImportedTradesJson(rawText: string, fileName?: string): ImportedTradesResult {
  let parsed: any;
  const cleanText = rawText.trim().replace(/^\uFEFF/, "");
  try {
    parsed = JSON.parse(cleanText);
  } catch (err: any) {
    throw new Error(`Invalid JSON syntax: ${err.message}`, { cause: err });
  }

  let trades: LighterTrade[] = [];
  let accountIndex: number | null = null;
  let accountIndices: number[] = [];
  let network: CheckerNetwork | null = null;
  let l1Address: string | undefined = undefined;
  let exportedAt: string | undefined = undefined;
  let isTruncated: boolean | undefined = undefined;
  let rowCap: number | undefined = undefined;
  let nextCursor: string | undefined = undefined;

  if (Array.isArray(parsed)) {
    trades = parsed;
  } else if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.trades)) {
      trades = parsed.trades;
    } else if (Array.isArray(parsed.data)) {
      trades = parsed.data;
    } else {
      throw new Error("Uploaded JSON file does not contain a 'trades' array or trade list.");
    }

    if (parsed.next_cursor) {
      nextCursor = String(parsed.next_cursor);
    }
    if (parsed.account_index !== undefined) {
      accountIndex = Number(parsed.account_index);
    }
    if (parsed.network === "rh" || parsed.network === "mainnet") {
      network = parsed.network;
    }
    if (parsed.l1_address) {
      l1Address = String(parsed.l1_address);
    }
    if (parsed.exported_at) {
      exportedAt = String(parsed.exported_at);
    }
    if (parsed.truncated) {
      isTruncated = true;
    }
    if (parsed.row_cap) {
      rowCap = Number(parsed.row_cap);
    }
  }

  if (trades.length === 0) {
    throw new Error("No trades found in the imported JSON file.");
  }

  // Detect network from fileName if not specified in JSON
  if (!network && fileName) {
    const fn = fileName.toLowerCase();
    if (fn.includes("rh") || fn.includes("robinhood")) {
      network = "rh";
    } else if (fn.includes("mainnet") || fn.includes("core")) {
      network = "mainnet";
    }
  }

  // If still unknown, attempt to infer network from market_ids
  if (!network && trades.length > 0) {
    const marketIds = new Set(trades.map((t) => Number(t.market_id)));
    // Mainnet has distinct high IDs: e.g. 108, 109, 110, 111, 112, 113, 114, 115, 120, 128
    const hasMainnetSpecificMarkets = Array.from(marketIds).some((id) => id >= 80 && id <= 250);
    if (hasMainnetSpecificMarkets) {
      network = "mainnet";
    }
  }

  // Account detection: If explicitly provided in metadata (our bookmarklet or custom export), use it!
  if (Array.isArray(parsed?.account_indices) && parsed.account_indices.length > 0) {
    accountIndices = parsed.account_indices
      .map(Number)
      .filter((n: number) => !isNaN(n) && n > 0 && n < 100_000_000_000);
    if (accountIndex === null && accountIndices.length > 0) {
      accountIndex = accountIndices[0];
    }
  } else if (accountIndex !== null && !isNaN(accountIndex) && accountIndex > 0) {
    // Single account explicitly provided in JSON metadata (our bookmarklet export)
    accountIndices = [accountIndex];
  } else {
    // Zero-trust raw API response without metadata: detect user account(s)
    accountIndices = detectUserAccounts(trades);
    accountIndex = accountIndices.length > 0 ? accountIndices[0] : null;
  }

  // Always ensure trades are sorted chronologically descending (newest first)
  sortTradesChronologicalDesc(trades);

  return {
    trades,
    accountIndex,
    accountIndices,
    network,
    l1Address,
    exportedAt,
    isTruncated,
    rowCap,
    fileName,
    nextCursor,
  };
}
