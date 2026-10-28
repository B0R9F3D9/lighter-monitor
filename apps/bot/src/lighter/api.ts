import { CONFIG } from "../config";
import {
  LighterAccount,
  LighterNetwork,
  MarketPriceSnapshot,
  SpreadDirection,
  SpreadUnit,
  SpreadAlertOrderBookLeg,
  TopOrderBook,
  LIGHTER_NETWORKS,
  SPREAD_DIRECTIONS,
} from "../types";
import { MEMORY_PRICES } from "../cache/memory";

export interface FetchAccountResult {
  account: LighterAccount | null;
  status: "OK" | "NOT_FOUND" | "RATE_LIMIT" | "ERROR";
  statusCode?: number;
  message?: string;
}

const BASE_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export async function fetchLighterAccountWithStatus(
  network: LighterNetwork,
  accountIndex: number,
  interactive: boolean = false,
  authToken?: string,
): Promise<FetchAccountResult> {
  const baseUrl = CONFIG.NETWORKS[network]?.baseUrl || CONFIG.NETWORKS.rh.baseUrl;
  // В интерактивных запросах пользователя ретраи отключены для мгновенного ответа
  const maxRetries = interactive ? 0 : 1;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const headers =
        authToken && authToken.trim()
          ? { ...BASE_HEADERS, Authorization: authToken.trim() }
          : BASE_HEADERS;

      const fetchOptions: RequestInit & { cf?: any } = {
        headers,
        signal: AbortSignal.timeout(CONFIG.FETCH_TIMEOUT_MS || 5000),
        cf: { cacheTtl: 0, cacheEverything: false },
      };

      // Прямой запрос без _t для сохранения Keep-Alive TLS сессии и сокетов
      let res = await fetch(`${baseUrl}/account?by=index&value=${accountIndex}`, fetchOptions);

      // Защита от невалидного или протухшего токена авторизации:
      // если биржа вернула 401 с токеном, пробуем резервный публичный запрос без него
      if (res.status === 401 && authToken) {
        console.warn(
          `[${network}] #${accountIndex} got 401 with Authorization token. Retrying without auth token...`,
        );
        res = await fetch(`${baseUrl}/account?by=index&value=${accountIndex}`, {
          ...fetchOptions,
          headers: BASE_HEADERS,
        });
      }

      if (res.status === 429) {
        if (attempt < maxRetries) {
          const retryHeader = res.headers.get("Retry-After");
          const retryAfterSec = retryHeader ? parseInt(retryHeader, 10) : 0;
          const delay = Math.min(
            retryAfterSec > 0
              ? retryAfterSec * 1000
              : (attempt + 1) * 350 + Math.floor(Math.random() * 150),
            1000,
          );
          console.warn(
            `[${network}] #${accountIndex} got 429, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        return {
          account: null,
          status: "RATE_LIMIT",
          statusCode: 429,
          message: "Too Many Requests",
        };
      }

      if (!res.ok) {
        if (res.status === 404) {
          return { account: null, status: "NOT_FOUND", statusCode: 404, message: "Not found" };
        }
        const errText = await res.text().catch(() => "");
        console.error(
          `[Lighter API Error] [${network}] #${accountIndex} HTTP ${res.status}: ${errText}`,
        );
        return { account: null, status: "ERROR", statusCode: res.status, message: errText };
      }

      const data = (await res.json()) as any;
      if (data.code === 200 && data.accounts && data.accounts.length > 0) {
        return { account: data.accounts[0] as LighterAccount, status: "OK", statusCode: 200 };
      }

      if (
        data.code === 29404 ||
        (data.message && data.message.includes("not found")) ||
        (data.accounts && data.accounts.length === 0)
      ) {
        return { account: null, status: "NOT_FOUND", statusCode: 200, message: "Not found" };
      }

      console.error(
        `[Lighter API Error] [${network}] #${accountIndex} code=${data.code}: ${data.message}`,
      );
      return { account: null, status: "ERROR", statusCode: data.code, message: data.message };
    } catch (err: any) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      console.error(`[Lighter API Exception] [${network}] #${accountIndex}:`, err);
      return { account: null, status: "ERROR", message: err?.message || String(err) };
    }
  }

  return { account: null, status: "ERROR", message: "Max retries exceeded" };
}

export async function fetchLighterAccount(
  network: LighterNetwork,
  accountIndex: number,
  interactive?: boolean,
  authToken?: string,
): Promise<LighterAccount | null>;
export async function fetchLighterAccount(
  accountIndex: number,
  interactive?: boolean,
  authToken?: string,
): Promise<LighterAccount | null>;
export async function fetchLighterAccount(
  networkOrIndex: LighterNetwork | number,
  maybeIndexOrInteractive?: number | boolean,
  maybeInteractiveOrToken?: boolean | string,
  maybeToken?: string,
): Promise<LighterAccount | null> {
  let network: LighterNetwork = LIGHTER_NETWORKS.RH;
  let index: number;
  let interactive = false;
  let authToken: string | undefined;

  if (typeof networkOrIndex === "number") {
    index = networkOrIndex;
    network = LIGHTER_NETWORKS.RH;
    interactive = typeof maybeIndexOrInteractive === "boolean" ? maybeIndexOrInteractive : false;
    authToken = typeof maybeInteractiveOrToken === "string" ? maybeInteractiveOrToken : undefined;
  } else {
    network = networkOrIndex;
    index = maybeIndexOrInteractive as number;
    interactive = typeof maybeInteractiveOrToken === "boolean" ? maybeInteractiveOrToken : false;
    authToken = maybeToken;
  }

  const result = await fetchLighterAccountWithStatus(network, index, interactive, authToken);
  return result.account;
}

export async function fetchInChunks<T, R>(
  items: T[],
  chunkSize: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  const len = items.length;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.allSettled(chunk.map(fn));
    for (let j = 0; j < chunkResults.length; j++) {
      results.push(chunkResults[j]!);
    }
  }
  return results;
}

interface NormalizedSymbol {
  upper: string;
  clean: string;
  hasSeparator: boolean;
  baseSym: string;
  isPerp: boolean;
}

const SYMBOL_NORM_CACHE = new Map<string, NormalizedSymbol>();

function normalizeMarketSymbolFast(rawSymbol: string): NormalizedSymbol {
  let cached = SYMBOL_NORM_CACHE.get(rawSymbol);
  if (cached !== undefined) return cached;

  const upper = String(rawSymbol).toUpperCase();
  const dash = upper.indexOf("-");
  const slash = upper.indexOf("/");
  const under = upper.indexOf("_");
  const sep = dash !== -1 ? dash : slash !== -1 ? slash : under;
  const hasSeparator = sep !== -1;
  const baseSym = hasSeparator ? upper.slice(0, sep) : upper;
  const isPerp = upper.endsWith("PERP");

  cached = {
    upper,
    clean: baseSym,
    hasSeparator,
    baseSym,
    isPerp,
  };
  SYMBOL_NORM_CACHE.set(rawSymbol, cached);
  return cached;
}

export async function fetchExchangeStats(
  network: LighterNetwork,
  activeSymbolsOrToken?: Set<string> | string,
  maybeToken?: string,
): Promise<Map<string, MarketPriceSnapshot>> {
  let activeSymbols: Set<string> | undefined;
  let authToken: string | undefined;

  if (typeof activeSymbolsOrToken === "string") {
    authToken = activeSymbolsOrToken;
  } else {
    if (activeSymbolsOrToken instanceof Set) {
      activeSymbols = activeSymbolsOrToken;
    }
    authToken = maybeToken;
  }

  const baseUrl = CONFIG.NETWORKS[network]?.baseUrl || CONFIG.NETWORKS.rh.baseUrl;
  const map = new Map<string, MarketPriceSnapshot>();

  try {
    const headers =
      authToken && authToken.trim()
        ? { ...BASE_HEADERS, Authorization: authToken.trim() }
        : BASE_HEADERS;

    const fetchOptions: RequestInit & { cf?: any } = {
      headers,
      signal: AbortSignal.timeout(CONFIG.FETCH_TIMEOUT_MS || 5000),
      cf: { cacheTtl: 0, cacheEverything: false },
    };

    let res = await fetch(`${baseUrl}/exchangeStats`, fetchOptions);

    if (res.status === 401 && authToken) {
      console.warn(
        `[${network}] exchangeStats got 401 with Authorization token. Retrying without auth token...`,
      );
      res = await fetch(`${baseUrl}/exchangeStats`, {
        ...fetchOptions,
        headers: BASE_HEADERS,
      });
    }

    if (!res.ok) return map;
    const data = (await res.json()) as any;

    if (data.code === 200 && Array.isArray(data.order_book_stats)) {
      const stats = data.order_book_stats;
      const count = stats.length;
      for (let i = 0; i < count; i++) {
        const item = stats[i];
        if (!item || !item.symbol || !item.last_trade_price) continue;
        const norm = normalizeMarketSymbolFast(item.symbol);

        // Predicate Filtering: if activeSymbols is provided, skip tickers not in activeSymbols!
        if (activeSymbols && !activeSymbols.has(norm.upper) && !activeSymbols.has(norm.clean)) {
          continue;
        }

        const price = parseFloat(item.last_trade_price);
        const snapshot: MarketPriceSnapshot = {
          symbol: norm.upper,
          price,
          dailyChange: item.daily_price_change ? parseFloat(item.daily_price_change) : 0,
        };
        map.set(norm.upper, snapshot);
        MEMORY_PRICES.set(`${network}:${norm.upper}`, price);
        MEMORY_PRICES.set(norm.upper, price);

        if (norm.hasSeparator) {
          if (!map.has(norm.baseSym) || norm.isPerp) {
            map.set(norm.baseSym, snapshot);
            MEMORY_PRICES.set(`${network}:${norm.baseSym}`, price);
            MEMORY_PRICES.set(norm.baseSym, price);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error fetching exchangeStats for ${network}:`, err);
  }

  return map;
}

export async function fetchTargetedMarketPrices(
  network: LighterNetwork,
  activeSymbols: Set<string>,
  authToken?: string,
): Promise<Map<string, number>> {
  const snapshots = await fetchExchangeStats(network, activeSymbols, authToken);
  const result = new Map<string, number>();
  for (const [sym, snap] of snapshots) {
    if (snap.price > 0) {
      result.set(sym, snap.price);
    }
  }
  return result;
}

export function findMarketPrice(
  map: Map<string, MarketPriceSnapshot>,
  symbol: string,
): MarketPriceSnapshot | undefined {
  // 1. Direct hit (fastest path: ~95% of queries for already normalized uppercase symbols)
  let direct = map.get(symbol);
  if (direct) return direct;

  const sym = symbol.toUpperCase();
  if (sym !== symbol) {
    direct = map.get(sym);
    if (direct) return direct;
  }

  // 2. Common suffixes without regex
  const perp = map.get(sym + "-PERP");
  if (perp) return perp;

  const usdg = map.get(sym + "/USDG");
  if (usdg) return usdg;

  // 3. Fast separator strip (e.g. "ETH-PERP" -> "ETH")
  const dash = sym.indexOf("-");
  const slash = sym.indexOf("/");
  const under = sym.indexOf("_");
  const sep = dash !== -1 ? dash : slash !== -1 ? slash : under;
  if (sep !== -1) {
    return map.get(sym.slice(0, sep));
  }

  return undefined;
}

export const KNOWN_MARKET_IDS: Record<LighterNetwork, Record<string, number>> = {
  rh: {
    ETH: 0,
    BTC: 1,
    HYPE: 2,
    SOL: 3,
    ZEC: 4,
    LIT: 5,
    XRP: 6,
    NEAR: 7,
    VVV: 8,
    SUI: 9,
    AAPL: 10,
    AMZN: 11,
    GOOGL: 12,
    META: 13,
    MSFT: 14,
    NVDA: 15,
    TSLA: 16,
    ORCL: 17,
    SPCX: 18,
    BABA: 19,
    BE: 20,
    USAR: 21,
    USO: 22,
    COIN: 23,
    CRCL: 24,
    QQQ: 25,
    SPY: 26,
    SGOV: 27,
    SLV: 28,
    AMD: 29,
    INTC: 30,
    MU: 31,
    SNDK: 32,
    CRWV: 33,
    PLTR: 34,
    SOXL: 35,
    CASHCAT: 36,
    SKHY: 37,
    ANTHROPIC: 38,
    ANSEM: 39,
    XAU: 40,
    XAG: 41,
    OPENAI: 42,
    SHEIN: 43,
    PONS: 44,
    AI: 45,
    TSM: 46,
    ASTS: 47,
    CLSK: 48,
    IREN: 49,
    LUNR: 50,
    QBTS: 51,
    RGTI: 52,
    SMCI: 53,
    SOFI: 54,
    WULF: 55,
    AMC: 56,
    USELESS: 57,
    UNI: 4095,
    LINK: 4096,
    AAVE: 4097,
    XMR: 4098,
    TRX: 4099,
  },
  mainnet: {
    ETH: 0,
    BTC: 1,
    SOL: 2,
    XAU: 92,
    COIN: 109,
    NVDA: 110,
    AMZN: 111,
    TSLA: 112,
    AAPL: 113,
    MSFT: 114,
    META: 115,
    GOOGL: 116,
    SPY: 128,
    QQQ: 129,
    PLTR: 137,
    AMD: 138,
  },
};

const MEMORY_MARKET_IDS = new Map<string, number>();

export async function getMarketId(
  network: LighterNetwork,
  symbol: string,
  authToken?: string,
): Promise<number | undefined> {
  const norm = normalizeMarketSymbolFast(symbol);
  const clean = norm.clean.toUpperCase();

  const known = KNOWN_MARKET_IDS[network]?.[clean];
  if (known !== undefined) return known;

  const cacheKey = `${network}:${clean}`;
  const cached = MEMORY_MARKET_IDS.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const baseUrl = CONFIG.NETWORKS[network]?.baseUrl || CONFIG.NETWORKS.rh.baseUrl;
    const headers =
      authToken && authToken.trim()
        ? { ...BASE_HEADERS, Authorization: authToken.trim() }
        : BASE_HEADERS;
    const res = await fetch(`${baseUrl}/orderBookDetails`, {
      headers,
      signal: AbortSignal.timeout(CONFIG.FETCH_TIMEOUT_MS || 5000),
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data.code === 200 && Array.isArray(data.order_book_details)) {
        for (const item of data.order_book_details) {
          if (item && item.symbol && item.market_id !== undefined) {
            const itemNorm = normalizeMarketSymbolFast(item.symbol);
            MEMORY_MARKET_IDS.set(
              `${network}:${itemNorm.clean.toUpperCase()}`,
              Number(item.market_id),
            );
            MEMORY_MARKET_IDS.set(`${network}:${itemNorm.upper}`, Number(item.market_id));
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Lighter API] Failed to fetch orderBookDetails for ${network}:`, err);
  }

  return MEMORY_MARKET_IDS.get(cacheKey);
}

export async function fetchTopOrderBook(
  network: LighterNetwork,
  marketId: number,
  authToken?: string,
): Promise<TopOrderBook | null> {
  const baseUrl = CONFIG.NETWORKS[network]?.baseUrl || CONFIG.NETWORKS.rh.baseUrl;
  try {
    const headers =
      authToken && authToken.trim()
        ? { ...BASE_HEADERS, Authorization: authToken.trim() }
        : BASE_HEADERS;

    const res = await fetch(`${baseUrl}/orderBookOrders?market_id=${marketId}&limit=1`, {
      headers,
      signal: AbortSignal.timeout(3000),
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (data.code !== 200) return null;

    const askItem = data.asks && data.asks.length > 0 ? data.asks[0] : null;
    const bidItem = data.bids && data.bids.length > 0 ? data.bids[0] : null;

    const bestAsk = askItem ? parseFloat(askItem.price || "0") : 0;
    const bestAskSize = askItem
      ? parseFloat(askItem.remaining_base_amount || askItem.initial_base_amount || "0")
      : 0;
    const bestBid = bidItem ? parseFloat(bidItem.price || "0") : 0;
    const bestBidSize = bidItem
      ? parseFloat(bidItem.remaining_base_amount || bidItem.initial_base_amount || "0")
      : 0;

    return { bestBid, bestBidSize, bestAsk, bestAskSize };
  } catch (err) {
    console.warn(`[Lighter API] Failed to fetch top orderBook for ${network} #${marketId}:`, err);
    return null;
  }
}

export interface ExecutableSpreadResult {
  isValid: boolean;
  reason?: string;
  orderBook?: SpreadAlertOrderBookLeg;
}

export async function verifyExecutableSpread(
  symbol: string,
  direction: SpreadDirection,
  targetDelta: number,
  unit: SpreadUnit,
  authTokenRh?: string,
  authTokenCore?: string,
): Promise<ExecutableSpreadResult> {
  const [rhMarketId, coreMarketId] = await Promise.all([
    getMarketId(LIGHTER_NETWORKS.RH, symbol, authTokenRh),
    getMarketId(LIGHTER_NETWORKS.MAINNET, symbol, authTokenCore),
  ]);

  if (rhMarketId === undefined || coreMarketId === undefined) {
    // If market IDs cannot be resolved, allow alert to proceed gracefully with prices
    return { isValid: true };
  }

  const [rhBook, coreBook] = await Promise.all([
    fetchTopOrderBook(LIGHTER_NETWORKS.RH, rhMarketId, authTokenRh),
    fetchTopOrderBook(LIGHTER_NETWORKS.MAINNET, coreMarketId, authTokenCore),
  ]);

  if (
    !rhBook ||
    !coreBook ||
    rhBook.bestAsk <= 0 ||
    rhBook.bestBid <= 0 ||
    coreBook.bestAsk <= 0 ||
    coreBook.bestBid <= 0
  ) {
    // If orderbooks unavailable or empty, allow alert through with fallback
    return { isValid: true };
  }

  if (direction === SPREAD_DIRECTIONS.RH_CHEAPER) {
    // Arbitrage: Buy RH Ask, Sell Core Bid
    const rhPrice = rhBook.bestAsk;
    const rhSize = rhBook.bestAskSize;
    const corePrice = coreBook.bestBid;
    const coreSize = coreBook.bestBidSize;

    const execDiffUsd = corePrice - rhPrice;
    const execDiffBps = corePrice > 0 ? (execDiffUsd / corePrice) * 10000 : 0;

    const execBasisSigned = rhPrice - corePrice;
    const execBasisBps = corePrice > 0 ? (execBasisSigned / corePrice) * 10000 : 0;

    // Filter phantom wicks: If orderbook spread collapsed (RH Ask > Core Bid)
    if (execDiffUsd <= 0 || execDiffBps < 0) {
      return {
        isValid: false,
        reason: `Orderbook spread collapsed: RH Ask ($${rhPrice}) >= Core Bid ($${corePrice})`,
      };
    }

    return {
      isValid: true,
      orderBook: {
        rhPrice,
        rhSize,
        rhType: "Ask",
        corePrice,
        coreSize,
        coreType: "Bid",
        execBps: execBasisBps,
        execUsd: execBasisSigned,
      },
    };
  } else {
    // Arbitrage: Sell RH Bid, Buy Core Ask
    const rhPrice = rhBook.bestBid;
    const rhSize = rhBook.bestBidSize;
    const corePrice = coreBook.bestAsk;
    const coreSize = coreBook.bestAskSize;

    const execDiffUsd = rhPrice - corePrice;
    const execDiffBps = corePrice > 0 ? (execDiffUsd / corePrice) * 10000 : 0;

    const execBasisSigned = rhPrice - corePrice;
    const execBasisBps = corePrice > 0 ? (execBasisSigned / corePrice) * 10000 : 0;

    // Filter phantom wicks: If orderbook spread collapsed (RH Bid < Core Ask)
    if (execDiffUsd <= 0 || execDiffBps < 0) {
      return {
        isValid: false,
        reason: `Orderbook spread collapsed: RH Bid ($${rhPrice}) <= Core Ask ($${corePrice})`,
      };
    }

    return {
      isValid: true,
      orderBook: {
        rhPrice,
        rhSize,
        rhType: "Bid",
        corePrice,
        coreSize,
        coreType: "Ask",
        execBps: execBasisBps,
        execUsd: execBasisSigned,
      },
    };
  }
}
