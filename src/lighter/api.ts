import { CONFIG } from "../config";
import { LighterAccount, LighterNetwork, MarketPriceSnapshot } from "../types";

export interface FetchAccountResult {
  account: LighterAccount | null;
  status: "OK" | "NOT_FOUND" | "RATE_LIMIT" | "ERROR";
  statusCode?: number;
  message?: string;
}

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
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      };
      if (authToken && authToken.trim()) {
        headers["Authorization"] = authToken.trim();
      }

      const res = await fetch(`${baseUrl}/account?by=index&value=${accountIndex}`, {
        headers,
        signal: AbortSignal.timeout(CONFIG.FETCH_TIMEOUT_MS || 3000),
      });

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

      return { account: null, status: "ERROR", statusCode: data.code, message: data.message };
    } catch (err: any) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
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
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.allSettled(chunk.map((item) => fn(item)));
    results.push(...chunkResults);
    // Небольшая пауза между чанками для предотвращения 429 всплесков
    if (i + chunkSize < items.length) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return results;
}

export async function fetchExchangeStats(
  network: LighterNetwork,
  authToken?: string,
): Promise<Map<string, MarketPriceSnapshot>> {
  const baseUrl = CONFIG.NETWORKS[network]?.baseUrl || CONFIG.NETWORKS.rh.baseUrl;
  const map = new Map<string, MarketPriceSnapshot>();

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
    if (authToken && authToken.trim()) {
      headers["Authorization"] = authToken.trim();
    }

    const res = await fetch(`${baseUrl}/exchangeStats`, {
      headers,
    });

    if (!res.ok) return map;
    const data = (await res.json()) as any;

    if (data.code === 200 && Array.isArray(data.order_book_stats)) {
      for (const item of data.order_book_stats) {
        if (item.symbol && item.last_trade_price) {
          const sym = String(item.symbol).toUpperCase();
          const snapshot: MarketPriceSnapshot = {
            symbol: sym,
            price: parseFloat(item.last_trade_price),
            dailyChange: parseFloat(item.daily_price_change || "0"),
          };
          map.set(sym, snapshot);

          const baseSym = sym.replace(/[-/_].*$/, "");
          const isPerp = sym.includes("PERP") || !sym.includes("/");
          if (!map.has(baseSym) || isPerp) {
            map.set(baseSym, snapshot);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error fetching exchangeStats for ${network}:`, err);
  }

  return map;
}

export function findMarketPrice(
  map: Map<string, MarketPriceSnapshot>,
  symbol: string,
): MarketPriceSnapshot | undefined {
  const sym = symbol.toUpperCase();
  const direct = map.get(sym);
  if (direct) return direct;

  // Быстрый поиск суффиксов без регулярных выражений
  const perp = map.get(`${sym}-PERP`);
  if (perp) return perp;

  const usdg = map.get(`${sym}/USDG`);
  if (usdg) return usdg;

  // Быстрое отсечение суффиксов без RegExp (например, "ETH-PERP", "GOOGL/USDG", "BTC_USDC")
  const dashIdx = sym.indexOf("-");
  const slashIdx = sym.indexOf("/");
  const underIdx = sym.indexOf("_");
  let sepIdx = -1;
  if (dashIdx !== -1) sepIdx = dashIdx;
  else if (slashIdx !== -1) sepIdx = slashIdx;
  else if (underIdx !== -1) sepIdx = underIdx;

  if (sepIdx !== -1) {
    const base = sym.substring(0, sepIdx);
    const baseMatch = map.get(base);
    if (baseMatch) return baseMatch;
  }

  return undefined;
}
