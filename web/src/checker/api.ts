import { CONFIG } from "../spread/config";
import type {
  CheckerNetwork,
  CheckerSummaryMetrics,
  ExportPayload,
  FetchProgress,
  FetchTradesOptions,
  LighterTrade,
  ParsedTradeView,
  TradesApiResponse,
} from "./types";

export function getBaseApiUrl(network: CheckerNetwork): string {
  return network === "rh" ? CONFIG.RH_API_URL : CONFIG.CORE_API_URL;
}

export function getNetworkDisplayName(network: CheckerNetwork): string {
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

/**
 * Fetches market definitions from orderBookDetails to map market_id -> Symbol.
 */
export async function fetchMarketMap(
  network: CheckerNetwork,
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const baseUrl = getBaseApiUrl(network);
  const map = new Map<number, string>();

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
    // Non-critical: table will fall back to #market_id
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
 * Fetches a single page of trades from /api/v1/trades
 */
export async function fetchTradesPage(
  options: FetchTradesOptions,
  signal?: AbortSignal,
): Promise<TradesApiResponse> {
  const baseUrl = getBaseApiUrl(options.network);
  const url = new URL(`${baseUrl}/trades`);

  url.searchParams.set("account_index", String(options.accountIndex));
  url.searchParams.set("sort_by", options.sortBy || "timestamp");
  url.searchParams.set("sort_dir", options.sortDir || "desc");
  url.searchParams.set("limit", String(options.limit || 100));

  if (options.cursor) {
    url.searchParams.set("cursor", options.cursor);
  }
  if (options.marketType && options.marketType !== "all") {
    url.searchParams.set("market_type", options.marketType);
  }
  if (options.marketId !== undefined && options.marketId !== 255) {
    url.searchParams.set("market_id", String(options.marketId));
  }

  const trimmedAuth = options.authToken?.trim();
  if (trimmedAuth) {
    url.searchParams.set("auth", trimmedAuth);
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (trimmedAuth) {
    headers["Authorization"] = trimmedAuth;
  }

  const res = await fetch(url.toString(), { headers, signal });
  const rawText = await res.text();

  let data: TradesApiResponse;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Server returned non-JSON response (HTTP ${res.status}): ${rawText.slice(0, 120)}`,
    );
  }

  if (!res.ok || (data.code !== 200 && data.code !== undefined && data.code !== 0)) {
    // Specific informative messages for common lighter codes
    if (data.code === 20001 || data.message?.includes("auth")) {
      throw new Error(
        `[Auth Required] ${data.message || "Authorization token is missing or invalid for Robinhood Chain. Please provide an Auth Token above."}`,
      );
    }
    throw new Error(data.message || `API Error (code ${data.code || res.status})`);
  }

  return data;
}

/**
 * Fetches all trade history with pagination and progress reporting.
 */
export async function fetchAllTrades(
  options: FetchTradesOptions,
  onProgress?: (progress: FetchProgress) => void,
  signal?: AbortSignal,
): Promise<LighterTrade[]> {
  const allTrades: LighterTrade[] = [];
  const seenTradeIds = new Set<string>();
  let cursor: string | undefined = undefined;
  let page = 0;
  let totalBytes = 0;
  const startTime = Date.now();

  while (true) {
    if (signal?.aborted) break;
    page++;
    const res = await fetchTradesPage({ ...options, cursor }, signal);
    const trades = res.trades || [];

    if (trades.length === 0) {
      break;
    }

    let newTradesInPage = 0;
    for (const t of trades) {
      const idKey = t.trade_id_str || String(t.trade_id);
      if (!seenTradeIds.has(idKey)) {
        seenTradeIds.add(idKey);
        allTrades.push(t);
        newTradesInPage++;
      }
    }

    const payloadApproxSize = JSON.stringify(trades).length;
    totalBytes += payloadApproxSize;

    const latestTs = trades.length > 0 ? normalizeTimestampMs(trades[0].timestamp) : undefined;

    if (onProgress) {
      onProgress({
        page,
        tradesCount: allTrades.length,
        latestTimestamp: latestTs,
        cursor: res.next_cursor,
        bytesReceived: totalBytes,
        elapsedMs: Date.now() - startTime,
      });
    }

    // Termination conditions
    if (!res.next_cursor || res.next_cursor.trim() === "" || newTradesInPage === 0) {
      break;
    }

    if (res.next_cursor === cursor) {
      // Loop protection if cursor didn't advance
      break;
    }

    cursor = res.next_cursor;

    // Small delay between chunks to respect rate limits
    await new Promise((r) => setTimeout(r, 100));
  }

  return allTrades;
}

/**
 * Parses a raw LighterTrade into a view representation.
 */
export function parseTradeForView(
  trade: LighterTrade,
  queriedAccountIndex: number,
  marketMap: Map<number, string>,
): ParsedTradeView {
  const isBid = Number(trade.bid_account_id) === queriedAccountIndex;
  const side: "BUY" | "SELL" = isBid ? "BUY" : "SELL";

  // Role: Maker vs Taker
  // trade.is_maker_ask indicates whether the ASK side was the maker order.
  let role: "MAKER" | "TAKER" = "TAKER";
  if (isBid) {
    // User is buyer (bid). If ask is NOT maker, then bid is maker.
    role = !trade.is_maker_ask ? "MAKER" : "TAKER";
  } else {
    // User is seller (ask). If ask IS maker, then user is maker.
    role = trade.is_maker_ask ? "MAKER" : "TAKER";
  }

  // Realized PnL: attributed to user side
  let realizedPnl = 0;
  if (isBid && trade.bid_account_pnl) {
    realizedPnl = parseFloat(trade.bid_account_pnl) || 0;
  } else if (!isBid && trade.ask_account_pnl) {
    realizedPnl = parseFloat(trade.ask_account_pnl) || 0;
  }

  const rawFee = role === "MAKER" ? trade.maker_fee : trade.taker_fee;
  const feeUsd = typeof rawFee === "number" ? rawFee / 10000 : 0;

  const symbol = marketMap.get(Number(trade.market_id)) || `#${trade.market_id}`;
  const timestampMs = normalizeTimestampMs(trade.timestamp);
  const timeFormatted = timestampMs ? formatTimestampUtc(timestampMs) : "--";

  const txHash = trade.tx_hash || "";
  const isZeroHash = !txHash || /^0x?0+$/.test(txHash) || txHash === "0";
  const txHashShort = isZeroHash
    ? "--"
    : txHash.length > 14
      ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}`
      : txHash;

  return {
    raw: trade,
    tradeId: trade.trade_id_str || String(trade.trade_id),
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
    usdValue: parseFloat(trade.usd_amount) || 0,
    realizedPnl,
    feeUsd,
    txHash,
    txHashShort,
  };
}

/**
 * Calculates aggregate summary metrics from fetched trades.
 */
export function calculateTradeMetrics(
  trades: LighterTrade[],
  queriedAccountIndex: number,
): CheckerSummaryMetrics {
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
    const isBid = Number(t.bid_account_id) === queriedAccountIndex;
    if (isBid) buyTradesCount++;
    else sellTradesCount++;

    const isMaker = isBid ? !t.is_maker_ask : t.is_maker_ask;
    if (isMaker) makerTradesCount++;
    else takerTradesCount++;

    const pnlStr = isBid ? t.bid_account_pnl : t.ask_account_pnl;
    if (pnlStr) {
      totalRealizedPnl += parseFloat(pnlStr) || 0;
    }

    const usd = parseFloat(t.usd_amount) || 0;
    totalVolumeUsd += usd;

    const rawFee = isMaker ? t.maker_fee : t.taker_fee;
    if (typeof rawFee === "number") {
      totalFeesUsd += rawFee / 10000;
    }

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
  accountIndex: number,
  l1Address?: string,
  truncated?: boolean,
  rowCap?: number,
): ExportPayload {
  const metrics = calculateTradeMetrics(trades, accountIndex);
  return {
    version: "1.0",
    exported_at: new Date().toISOString(),
    exported_at_unix: Date.now(),
    network,
    network_name: getNetworkDisplayName(network),
    account_index: accountIndex,
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
  const jsonStr = JSON.stringify(data, null, 2);
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

export interface ImportedTradesResult {
  trades: LighterTrade[];
  accountIndex: number | null;
  network: CheckerNetwork | null;
  l1Address?: string;
  exportedAt?: string;
  isTruncated?: boolean;
  rowCap?: number;
}

/**
 * Validates and parses an uploaded JSON file into structured trade history.
 */
export function parseImportedTradesJson(rawText: string): ImportedTradesResult {
  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: any) {
    throw new Error(`Invalid JSON syntax: ${err.message}`, { cause: err });
  }

  let trades: LighterTrade[] = [];
  let accountIndex: number | null = null;
  let network: CheckerNetwork | null = null;
  let l1Address: string | undefined = undefined;
  let exportedAt: string | undefined = undefined;
  let isTruncated: boolean | undefined = undefined;
  let rowCap: number | undefined = undefined;

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

  // If accountIndex wasn't specified in root, attempt to detect from most frequent account id in trades
  if (accountIndex === null && trades.length > 0) {
    const countMap = new Map<number, number>();
    for (const t of trades.slice(0, 50)) {
      if (t.bid_account_id)
        countMap.set(t.bid_account_id, (countMap.get(t.bid_account_id) || 0) + 1);
      if (t.ask_account_id)
        countMap.set(t.ask_account_id, (countMap.get(t.ask_account_id) || 0) + 1);
    }
    let topAcc: number | null = null;
    let topCount = 0;
    for (const [acc, count] of countMap.entries()) {
      if (count > topCount) {
        topCount = count;
        topAcc = acc;
      }
    }
    accountIndex = topAcc;
  }

  return {
    trades,
    accountIndex,
    network,
    l1Address,
    exportedAt,
    isTruncated,
    rowCap,
  };
}
