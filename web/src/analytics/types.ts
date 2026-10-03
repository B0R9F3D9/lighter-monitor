export type TimeframeId = "1h" | "4h" | "12h" | "24h" | "3d" | "7d" | "30d";

export interface TimeframeConfig {
  id: TimeframeId;
  label: string;
  resolution: string; // "1m" | "5m" | "15m" | "1h" | "4h"
  countBack: number;
  durationSec: number;
}

export interface RawCandle {
  t: number; // millisecond timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // base volume
  V: number; // quote volume
}

export interface BasisPoint {
  timeSec: number; // Unix timestamp in seconds for lightweight-charts
  timestampMs: number;
  rhPrice: number;
  corePrice: number;
  basisUsd: number; // rhPrice - corePrice
  basisBps: number; // (basisUsd / midPrice) * 10000
  midPrice: number;
  rhVolume: number;
  coreVolume: number;
}

export type SignalVerdict = "EXCELLENT ENTRY" | "FAIR" | "CAUTION" | "OVERHEATED";

export interface QuantStats {
  count: number;
  currentBasisUsd: number;
  currentBasisBps: number;
  meanBasisUsd: number;
  meanBasisBps: number;
  medianBasisUsd: number;
  stdDevUsd: number;
  stdDevBps: number;
  upperBandUsd: number; // Mean + 2σ
  lowerBandUsd: number; // Mean - 2σ
  zScore: number;
  percentile: number; // 0 to 100
  minBasisUsd: number;
  maxBasisUsd: number;
  signal: SignalVerdict;
}

export interface HourlyBucketStats {
  hour: number; // 0 to 23
  label: string; // e.g. "00:00", "14:00"
  avgBasisUsd: number;
  avgBasisBps: number;
  minBasisUsd: number;
  maxBasisUsd: number;
  sampleCount: number;
  scoreNormalized: number; // 0 (cheapest) to 1 (most expensive)
}

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

export interface LiveSpreadTick {
  symbol: string;
  timestampMs: number;
  rhAsk: number;
  rhBid: number;
  coreAsk: number;
  coreBid: number;
  rhMid: number;
  coreMid: number;
  basisMidUsd: number;
  entryDragUsd: number; // rhAsk - coreBid
  exitDragUsd: number; // coreAsk - rhBid
  entryDragBps: number;
  exitDragBps: number;
}

export interface DateFilterConfig {
  isActive: boolean;
  fromDate: string; // "YYYY-MM-DD"
  toDate: string; // "YYYY-MM-DD"
  daysOfWeek: Set<number>; // 0 = Sun, 1 = Mon, ..., 6 = Sat
  presetLabel?: string;
  activePresetId?: string;
  resolution?: string;
}
