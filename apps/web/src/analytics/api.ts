import { CONFIG, registerTokens, isEquitySymbol, getHedgeSideConfig } from "../shared";
import { alignCandlesToBasisPoints, calculateQuantStats, calculateRollingBands } from "./math";
import type {
  AnalyticsMarketPair,
  BasisPoint,
  MarketVenueStats,
  QuantStats,
  RawCandle,
  TimeframeConfig,
  TimeframeId,
} from "./types";

export const TIMEFRAMES: Record<TimeframeId, TimeframeConfig> = {
  "1h": { id: "1h", label: "1H", resolution: "1m", countBack: 60, durationSec: 3600 },
  "4h": { id: "4h", label: "4H", resolution: "1m", countBack: 240, durationSec: 14400 },
  "12h": { id: "12h", label: "12H", resolution: "5m", countBack: 144, durationSec: 43200 },
  "24h": { id: "24h", label: "24H", resolution: "5m", countBack: 288, durationSec: 86400 },
  "3d": { id: "3d", label: "3D", resolution: "15m", countBack: 288, durationSec: 259200 },
  "7d": { id: "7d", label: "7D", resolution: "1h", countBack: 168, durationSec: 604800 },
  "30d": { id: "30d", label: "ALL", resolution: "4h", countBack: 180, durationSec: 2592000 },
};

export async function fetchMarketPairs(): Promise<AnalyticsMarketPair[]> {
  const [coreRes, rhRes, tokenlistRes] = await Promise.all([
    fetch(`${CONFIG.CORE_API_URL}/orderBookDetails`, { headers: { Accept: "application/json" } }),
    fetch(`${CONFIG.RH_API_URL}/orderBookDetails`, { headers: { Accept: "application/json" } }),
    fetch(`${CONFIG.RH_API_URL}/tokenlist`, { headers: { Accept: "application/json" } }).catch(
      () => null,
    ),
  ]);

  if (!coreRes.ok || !rhRes.ok) {
    throw new Error("Failed to fetch orderBookDetails from Lighter APIs");
  }

  const [coreJson, rhJson] = await Promise.all([coreRes.json(), rhRes.json()]);

  if (tokenlistRes?.ok) {
    try {
      const tokJson = await tokenlistRes.json();
      if (Array.isArray(tokJson.tokens)) {
        registerTokens(tokJson.tokens);
      }
    } catch {}
  }

  const coreMap = new Map<string, any>();
  for (const m of coreJson.order_book_details || []) {
    if (m.status === "active" && !m.is_frozen && m.market_id !== undefined && m.market_id >= 0) {
      coreMap.set(m.symbol, m);
    }
  }

  const pairs: AnalyticsMarketPair[] = [];

  for (const rm of rhJson.order_book_details || []) {
    if (rm.status !== "active" || rm.is_frozen || rm.market_id === undefined || rm.market_id < 0) {
      continue;
    }
    const cm = coreMap.get(rm.symbol);
    if (!cm) continue; // Only tokens present on BOTH venues

    const rhMargin = rm.min_initial_margin_fraction || 500;
    const coreMargin = cm.min_initial_margin_fraction || 500;
    const rhLev = Math.round(10000 / rhMargin);
    const coreLev = Math.round(10000 / coreMargin);
    const minLev = Math.min(rhLev, coreLev);

    const rhQuoteVol = parseFloat(rm.daily_quote_token_volume) || 0;
    const coreQuoteVol = parseFloat(cm.daily_quote_token_volume) || 0;

    const rhMark = parseFloat(rm.mark_price) || 0;
    const coreMark = parseFloat(cm.mark_price) || 0;

    const rhIndex = parseFloat(rm.index_price) || 0;
    const coreIndex = parseFloat(cm.index_price) || 0;

    const rhPriceChange = parseFloat(rm.daily_price_change) || 0;
    const corePriceChange = parseFloat(cm.daily_price_change) || 0;

    const rhOiBase = parseFloat(rm.open_interest) || 0;
    const coreOiBase = parseFloat(cm.open_interest) || 0;
    const rhOiUsd = rhOiBase * rhMark;
    const coreOiUsd = coreOiBase * coreMark;

    let rhFunding1h = 0;
    if (rhIndex > 0 && rhMark > 0) {
      rhFunding1h = ((rhMark - rhIndex) / (rhIndex * 24)) * 100;
      if (rm.base_interest_rate) {
        rhFunding1h += (parseFloat(rm.base_interest_rate) || 0) / 8;
      }
    } else if (rm.base_interest_rate) {
      rhFunding1h = (parseFloat(rm.base_interest_rate) || 0) / 8;
    }

    let coreFunding1h = 0;
    if (coreIndex > 0 && coreMark > 0) {
      coreFunding1h = ((coreMark - coreIndex) / (coreIndex * 24)) * 100;
      if (cm.base_interest_rate) {
        coreFunding1h += (parseFloat(cm.base_interest_rate) || 0) / 8;
      }
    } else if (cm.base_interest_rate) {
      coreFunding1h = (parseFloat(cm.base_interest_rate) || 0) / 8;
    }

    const rhStats: MarketVenueStats = {
      markPrice: rhMark,
      indexPrice: rhIndex,
      dailyPriceChange: rhPriceChange,
      dailyVolumeUsd: rhQuoteVol,
      openInterestUsd: rhOiUsd,
      fundingRate1h: rhFunding1h,
      leverage: `${rhLev}x`,
    };

    const coreStats: MarketVenueStats = {
      markPrice: coreMark,
      indexPrice: coreIndex,
      dailyPriceChange: corePriceChange,
      dailyVolumeUsd: coreQuoteVol,
      openInterestUsd: coreOiUsd,
      fundingRate1h: coreFunding1h,
      leverage: `${coreLev}x`,
    };

    pairs.push({
      symbol: rm.symbol,
      rhMarketId: rm.market_id,
      coreMarketId: cm.market_id,
      leverage: `${minLev}x`,
      leverageNum: minLev,
      isEquity: isEquitySymbol(rm.symbol),
      hedgeSideConfig: getHedgeSideConfig(rm.symbol),
      rh: rhStats,
      core: coreStats,
      // Default: Robinhood (RH) stats
      totalVolume24h: rhQuoteVol,
      markPrice: rhMark > 0 ? rhMark : coreMark,
      indexPrice: rhIndex > 0 ? rhIndex : coreIndex,
      dailyPriceChange: rhPriceChange,
      dailyVolumeUsd: rhQuoteVol,
      openInterestUsd: rhOiUsd,
      fundingRate1h: rhFunding1h,
    });
  }

  // Sort: Equities first, then by 24h volume descending
  pairs.sort((a, b) => {
    if (a.isEquity !== b.isEquity) return a.isEquity ? -1 : 1;
    return b.totalVolume24h - a.totalVolume24h;
  });

  return pairs;
}

export async function fetchRawCandles(
  baseUrl: string,
  marketId: number,
  resolution: string,
  startSec: number,
  endSec: number,
  countBack: number,
): Promise<RawCandle[]> {
  const url = `${baseUrl}/candles?market_id=${marketId}&resolution=${resolution}&start_timestamp=${startSec}&end_timestamp=${endSec}&count_back=${countBack}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Candles HTTP ${res.status} from ${baseUrl}`);
  }

  const json = await res.json();
  return (json.c || json.candlesticks || []) as RawCandle[];
}

export async function fetchHistoricalBasis(
  pair: AnalyticsMarketPair,
  tf: TimeframeConfig,
): Promise<{
  points: BasisPoint[];
  stats: QuantStats | null;
  bands: Array<{ timeSec: number; sma: number; upper: number; lower: number }>;
}> {
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - tf.durationSec;

  const [rhCandles, coreCandles] = await Promise.all([
    fetchRawCandles(
      CONFIG.RH_API_URL,
      pair.rhMarketId,
      tf.resolution,
      startSec,
      nowSec,
      tf.countBack,
    ),
    fetchRawCandles(
      CONFIG.CORE_API_URL,
      pair.coreMarketId,
      tf.resolution,
      startSec,
      nowSec,
      tf.countBack,
    ),
  ]);

  const points = alignCandlesToBasisPoints(rhCandles, coreCandles);
  const stats = calculateQuantStats(points, pair.hedgeSideConfig.isRhLong);
  const bands = calculateRollingBands(points, 20);

  return { points, stats, bands };
}
