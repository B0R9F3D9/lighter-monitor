import { CONFIG } from "../config";
import { LighterAccount, LighterNetwork, MarketPriceSnapshot } from "../types";
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
  let network: LighterNetwork = "rh";
  let index: number;
  let interactive = false;
  let authToken: string | undefined;

  if (typeof networkOrIndex === "number") {
    index = networkOrIndex;
    network = "rh";
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
        const sym = String(item.symbol).toUpperCase();

        const dash = sym.indexOf("-");
        const slash = sym.indexOf("/");
        const under = sym.indexOf("_");
        const sep = dash !== -1 ? dash : slash !== -1 ? slash : under;
        const cleanSym = sep !== -1 ? sym.slice(0, sep) : sym;

        // Predicate Filtering: if activeSymbols is provided, skip tickers not in activeSymbols!
        if (activeSymbols && !activeSymbols.has(sym) && !activeSymbols.has(cleanSym)) {
          continue;
        }

        const price = parseFloat(item.last_trade_price);
        const snapshot: MarketPriceSnapshot = {
          symbol: sym,
          price,
          dailyChange: item.daily_price_change ? parseFloat(item.daily_price_change) : 0,
        };
        map.set(sym, snapshot);
        MEMORY_PRICES.set(sym, price);

        if (sep !== -1) {
          const baseSym = sym.slice(0, sep);
          if (!map.has(baseSym) || sym.endsWith("PERP")) {
            map.set(baseSym, snapshot);
            MEMORY_PRICES.set(baseSym, price);
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
