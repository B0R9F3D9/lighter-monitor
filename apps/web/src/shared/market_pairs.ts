import { CONFIG } from "./config";
import {
  registerTokens,
  isEquitySymbol,
  getHedgeSideConfig,
  compareMarketCategoryPriority,
  type HedgeSideConfig,
} from "./tokens";

export type AnalyticsVenue = "rh" | "core";

export interface MarketVenueStats {
  markPrice: number;
  indexPrice: number;
  dailyPriceChange: number;
  dailyVolumeUsd: number;
  openInterestUsd: number;
  fundingRate1h: number;
  leverage: string;
}

export interface AnalyticsMarketPair {
  symbol: string;
  rhMarketId: number;
  coreMarketId: number;
  leverage: string;
  leverageNum: number;
  isEquity: boolean;
  hedgeSideConfig: HedgeSideConfig;
  rh: MarketVenueStats;
  core: MarketVenueStats;
  totalVolume24h: number;
  markPrice: number;
  indexPrice: number;
  dailyPriceChange: number;
  dailyVolumeUsd: number;
  openInterestUsd: number;
  fundingRate1h: number;
}

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
      totalVolume24h: rhQuoteVol,
      markPrice: rhMark > 0 ? rhMark : coreMark,
      indexPrice: rhIndex > 0 ? rhIndex : coreIndex,
      dailyPriceChange: rhPriceChange,
      dailyVolumeUsd: rhQuoteVol,
      openInterestUsd: rhOiUsd,
      fundingRate1h: rhFunding1h,
    });
  }

  // Sort by official program categories (Pre-IPOs & Equities -> Commodities/ETFs -> Crypto)
  pairs.sort((a, b) => {
    const prioDiff = compareMarketCategoryPriority(a.symbol, b.symbol);
    if (prioDiff !== 0) return prioDiff;
    return b.dailyVolumeUsd - a.dailyVolumeUsd;
  });

  return pairs;
}
