import type {
  BasisPoint,
  HourlyBucketStats,
  QuantStats,
  RawCandle,
  SignalVerdict,
} from "./types";

/**
 * Aligns candlestick arrays from Robinhood and Core by timestamp
 * and calculates price difference (Basis) for each aligned interval.
 */
export function alignCandlesToBasisPoints(
  rhCandles: RawCandle[],
  coreCandles: RawCandle[],
): BasisPoint[] {
  if (!rhCandles.length || !coreCandles.length) return [];

  // Index core candles by millisecond timestamp
  const coreMap = new Map<number, RawCandle>();
  for (const c of coreCandles) {
    coreMap.set(c.t, c);
  }

  const results: BasisPoint[] = [];

  for (const rh of rhCandles) {
    let core = coreMap.get(rh.t);

    // Fallback: If not exact, find the closest core candle within a reasonable tolerance (e.g. 5 minutes)
    if (!core) {
      let closestDiff = Infinity;
      for (const [t, c] of coreMap) {
        const diff = Math.abs(t - rh.t);
        if (diff < closestDiff && diff <= 300_000) {
          closestDiff = diff;
          core = c;
        }
      }
    }

    if (!core) continue;

    const rhPrice = rh.c;
    const corePrice = core.c;
    const basisUsd = rhPrice - corePrice;
    const midPrice = (rhPrice + corePrice) / 2;
    const basisBps = midPrice > 0 ? (basisUsd / midPrice) * 10000 : 0;

    results.push({
      timeSec: Math.floor(rh.t / 1000),
      timestampMs: rh.t,
      rhPrice,
      corePrice,
      basisUsd,
      basisBps,
      midPrice,
      rhVolume: rh.v,
      coreVolume: core.v,
    });
  }

  // Ensure chronological order
  results.sort((a, b) => a.timeSec - b.timeSec);
  return results;
}

/**
 * Evaluates entry recommendation based on standard Z-Score.
 */
export function evaluateSignalVerdict(zScore: number): SignalVerdict {
  if (zScore <= 0) return "EXCELLENT ENTRY";
  if (zScore <= 1.0) return "FAIR";
  if (zScore <= 2.0) return "CAUTION";
  return "OVERHEATED";
}

/**
 * Computes mean, median, standard deviation, Bollinger bands, Z-Score,
 * percentile rank, and actionable signal verdict.
 */
export function calculateQuantStats(points: BasisPoint[]): QuantStats | null {
  if (!points.length) return null;

  const count = points.length;
  const valuesUsd = points.map((p) => p.basisUsd);
  const valuesBps = points.map((p) => p.basisBps);

  const sumUsd = valuesUsd.reduce((acc, v) => acc + v, 0);
  const sumBps = valuesBps.reduce((acc, v) => acc + v, 0);
  const meanBasisUsd = sumUsd / count;
  const meanBasisBps = sumBps / count;

  // Standard Deviation
  const varianceUsd = valuesUsd.reduce((acc, v) => acc + Math.pow(v - meanBasisUsd, 2), 0) / count;
  const varianceBps = valuesBps.reduce((acc, v) => acc + Math.pow(v - meanBasisBps, 2), 0) / count;
  const stdDevUsd = Math.sqrt(varianceUsd);
  const stdDevBps = Math.sqrt(varianceBps);

  // Median
  const sortedUsd = valuesUsd.toSorted((a, b) => a - b);
  const midIndex = Math.floor(count / 2);
  const medianBasisUsd =
    count % 2 === 0 ? (sortedUsd[midIndex - 1] + sortedUsd[midIndex]) / 2 : sortedUsd[midIndex];

  // Latest point
  const latest = points[points.length - 1];
  const currentBasisUsd = latest.basisUsd;
  const currentBasisBps = latest.basisBps;

  // Z-Score
  const zScore = stdDevUsd > 0.00001 ? (currentBasisUsd - meanBasisUsd) / stdDevUsd : 0;

  // Percentile rank (0 to 100)
  const countBelow = sortedUsd.filter((v) => v < currentBasisUsd).length;
  const percentile = (countBelow / count) * 100;

  // Bollinger Bands (2σ)
  const upperBandUsd = meanBasisUsd + 2 * stdDevUsd;
  const lowerBandUsd = meanBasisUsd - 2 * stdDevUsd;

  const minBasisUsd = sortedUsd[0];
  const maxBasisUsd = sortedUsd[count - 1];
  const signal = evaluateSignalVerdict(zScore);

  return {
    count,
    currentBasisUsd,
    currentBasisBps,
    meanBasisUsd,
    meanBasisBps,
    medianBasisUsd,
    stdDevUsd,
    stdDevBps,
    upperBandUsd,
    lowerBandUsd,
    zScore,
    percentile,
    minBasisUsd,
    maxBasisUsd,
    signal,
  };
}

/**
 * Calculates rolling Simple Moving Average and Bollinger Bands for a series.
 */
export function calculateRollingBands(
  points: BasisPoint[],
  period = 20,
): Array<{
  timeSec: number;
  sma: number;
  upper: number;
  lower: number;
}> {
  const result: Array<{ timeSec: number; sma: number; upper: number; lower: number }> = [];

  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - period + 1);
    const windowSlice = points.slice(start, i + 1);
    const windowValues = windowSlice.map((p) => p.basisUsd);

    const sum = windowValues.reduce((a, b) => a + b, 0);
    const sma = sum / windowValues.length;

    const variance =
      windowValues.reduce((acc, v) => acc + Math.pow(v - sma, 2), 0) / windowValues.length;
    const stdDev = Math.sqrt(variance);

    result.push({
      timeSec: points[i].timeSec,
      sma,
      upper: sma + 2 * stdDev,
      lower: sma - 2 * stdDev,
    });
  }

  return result;
}

/**
 * Aggregates basis metrics into 24 hour-of-the-day buckets (00:00 to 23:00)
 * adjusting for the user's timezone offset in hours.
 */
export function calculateHourlyBuckets(
  points: BasisPoint[],
  timezoneOffsetHours = 2, // Default: Warsaw / Europe (UTC+2)
): HourlyBucketStats[] {
  const buckets: Array<{
    hour: number;
    valuesUsd: number[];
    valuesBps: number[];
  }> = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    valuesUsd: [],
    valuesBps: [],
  }));

  for (const p of points) {
    const date = new Date(p.timestampMs);
    // Shift UTC hour by timezone offset
    let h = (date.getUTCHours() + timezoneOffsetHours) % 24;
    if (h < 0) h += 24;

    buckets[h].valuesUsd.push(p.basisUsd);
    buckets[h].valuesBps.push(p.basisBps);
  }

  const result: HourlyBucketStats[] = [];
  let minAvgUsd = Infinity;
  let maxAvgUsd = -Infinity;

  for (let h = 0; h < 24; h++) {
    const b = buckets[h];
    const count = b.valuesUsd.length;
    const padHour = String(h).padStart(2, "0");
    const label = `${padHour}:00`;

    if (count === 0) {
      result.push({
        hour: h,
        label,
        avgBasisUsd: 0,
        avgBasisBps: 0,
        minBasisUsd: 0,
        maxBasisUsd: 0,
        sampleCount: 0,
        scoreNormalized: 0.5,
      });
      continue;
    }

    const sumUsd = b.valuesUsd.reduce((acc, v) => acc + v, 0);
    const sumBps = b.valuesBps.reduce((acc, v) => acc + v, 0);
    const avgBasisUsd = sumUsd / count;
    const avgBasisBps = sumBps / count;
    const minBasisUsd = Math.min(...b.valuesUsd);
    const maxBasisUsd = Math.max(...b.valuesUsd);

    if (avgBasisUsd < minAvgUsd) minAvgUsd = avgBasisUsd;
    if (avgBasisUsd > maxAvgUsd) maxAvgUsd = avgBasisUsd;

    result.push({
      hour: h,
      label,
      avgBasisUsd,
      avgBasisBps,
      minBasisUsd,
      maxBasisUsd,
      sampleCount: count,
      scoreNormalized: 0, // normalized below
    });
  }

  // Normalize scores from 0 (cheapest/green) to 1 (most expensive/red)
  const range = maxAvgUsd - minAvgUsd;
  for (const r of result) {
    if (r.sampleCount > 0 && range > 0.0001) {
      r.scoreNormalized = Math.max(0, Math.min(1, (r.avgBasisUsd - minAvgUsd) / range));
    } else {
      r.scoreNormalized = 0.5;
    }
  }

  return result;
}

/**
 * Chooses the best candle resolution and step based on visible time span in seconds.
 */
export function chooseOptimalResolution(spanSec: number): { resolution: string; stepSec: number } {
  if (spanSec <= 3 * 3600) {
    return { resolution: "1m", stepSec: 60 };
  } else if (spanSec <= 26 * 3600) {
    return { resolution: "5m", stepSec: 300 };
  } else if (spanSec <= 4 * 86400) {
    return { resolution: "15m", stepSec: 900 };
  } else if (spanSec <= 16 * 86400) {
    return { resolution: "1h", stepSec: 3600 };
  } else {
    return { resolution: "4h", stepSec: 14400 };
  }
}

/**
 * Extrapolates visible time range from logical range indexes and loaded time points.
 */
export function extrapolateTimeRange(
  logicalRange: { from: number; to: number } | null,
  points: Array<{ timeSec: number }>,
  nowSec: number = Math.floor(Date.now() / 1000),
): { fromSec: number; toSec: number } | null {
  if (!logicalRange || points.length === 0) return null;

  const N = points.length;
  const tFirst = points[0].timeSec;
  const tLast = points[N - 1].timeSec;
  const dt = N > 1 ? Math.max(1, (tLast - tFirst) / (N - 1)) : 60;

  let fromSec: number;
  if (logicalRange.from < 0) {
    fromSec = Math.floor(tFirst + logicalRange.from * dt);
  } else if (logicalRange.from >= N) {
    fromSec = Math.floor(tLast + (logicalRange.from - (N - 1)) * dt);
  } else {
    const idx = Math.min(N - 1, Math.max(0, Math.floor(logicalRange.from)));
    fromSec = points[idx].timeSec;
  }

  let toSec: number;
  if (logicalRange.to > N - 1) {
    toSec = Math.ceil(tLast + (logicalRange.to - (N - 1)) * dt);
  } else if (logicalRange.to < 0) {
    toSec = Math.ceil(tFirst + logicalRange.to * dt);
  } else {
    const idx = Math.min(N - 1, Math.max(0, Math.ceil(logicalRange.to)));
    toSec = points[idx].timeSec;
  }

  toSec = Math.min(toSec, nowSec);
  fromSec = Math.min(fromSec, toSec - 60);
  fromSec = Math.max(fromSec, nowSec - 90 * 86400);

  if (toSec <= fromSec) return null;

  return { fromSec, toSec };
}

/**
 * Returns an iconic badge symbol for recognized market tickers.
 */
export function getTokenIcon(symbol: string): string {
  const sym = symbol.toUpperCase();
  if (sym === "AAPL") return "";
  if (sym === "BTC") return "₿";
  if (sym === "ETH") return "Ξ";
  if (sym === "SOL") return "◎";
  if (sym === "XAU") return "Au";
  if (sym === "XAG") return "Ag";
  if (sym === "GOOGL" || sym === "GOOG") return "G";
  if (sym === "NVDA") return "NV";
  if (sym === "MSFT") return "MS";
  if (sym === "TSLA") return "T";
  if (sym === "AMZN") return "AM";
  if (sym === "META") return "M";
  if (sym === "COIN") return "C";
  if (sym === "SPY") return "SP";
  if (sym === "QQQ") return "Q";
  return sym.slice(0, 2);
}

/**
 * Formats market prices (Mark / Index / Last) without dollar sign, matching Lighter exchange format.
 */
export function formatMarketPrice(p: number | undefined | null): string {
  if (p === undefined || p === null || isNaN(p) || p <= 0) return "--";
  if (p >= 1000) {
    return p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  }
  if (p >= 1) {
    return p.toFixed(2);
  }
  return p.toFixed(4);
}

/**
 * Verified official Lighter token logos hosted on Lighter's official asset CDN.
 */
export const OFFICIAL_TOKEN_LOGOS: Record<string, string> = {
  AAPL: "https://assets.lighter.xyz/fe/token/aapl.png",
  AI: "https://assets.lighter.xyz/fe/token/ai.png",
  AMD: "https://assets.lighter.xyz/fe/token/amd.png",
  AMZN: "https://assets.lighter.xyz/fe/token/amzn.png",
  ANSEM: "https://assets.lighter.xyz/fe/token/ansem.png",
  ANTHROPIC: "https://assets.lighter.xyz/fe/token/anthropic.png",
  BABA: "https://assets.lighter.xyz/fe/token/baba.png",
  BE: "https://assets.lighter.xyz/fe/token/be.png",
  BTC: "https://assets.lighter.xyz/fe/token/btc.png",
  CASHCAT: "https://assets.lighter.xyz/fe/token/cashcat.png",
  COIN: "https://assets.lighter.xyz/fe/token/coinbase.png",
  CRCL: "https://assets.lighter.xyz/fe/token/crcl.png",
  CRWV: "https://assets.lighter.xyz/fe/token/crwv.png",
  ETH: "https://assets.lighter.xyz/fe/token/eth.png",
  GOOGL: "https://assets.lighter.xyz/fe/token/googl.png",
  HYPE: "https://assets.lighter.xyz/fe/token/hype.png",
  INTC: "https://assets.lighter.xyz/fe/token/intc.png",
  LIT: "https://assets.lighter.xyz/fe/token/lit.png",
  META: "https://assets.lighter.xyz/fe/token/meta.png",
  MSFT: "https://assets.lighter.xyz/fe/token/msft.png",
  MU: "https://assets.lighter.xyz/fe/token/mu.png",
  NEAR: "https://assets.lighter.xyz/fe/token/near.png",
  NVDA: "https://assets.lighter.xyz/fe/token/nvda.png",
  OPENAI: "https://assets.lighter.xyz/fe/token/openai.png",
  ORCL: "https://assets.lighter.xyz/fe/token/orcl.png",
  PLTR: "https://assets.lighter.xyz/fe/token/pltr.png",
  PONS: "https://assets.lighter.xyz/fe/token/pons.png",
  QQQ: "https://assets.lighter.xyz/fe/token/qqq.png",
  SHEIN: "https://assets.lighter.xyz/fe/token/shein.png",
  SKHY: "https://assets.lighter.xyz/fe/token/skhynix.png",
  SNDK: "https://assets.lighter.xyz/fe/token/sndk.png",
  SOL: "https://assets.lighter.xyz/fe/token/sol.png",
  SOXL: "https://assets.lighter.xyz/fe/token/soxl.png",
  SPCX: "https://assets.lighter.xyz/fe/token/spcx.png",
  SPY: "https://assets.lighter.xyz/fe/token/spy.png",
  SUI: "https://assets.lighter.xyz/fe/token/sui.png",
  TSLA: "https://assets.lighter.xyz/fe/token/tsla.png",
  TSM: "https://assets.lighter.xyz/fe/token/tsm.png",
  VVV: "https://assets.lighter.xyz/fe/token/vvv.png",
  XAG: "https://assets.lighter.xyz/fe/token/xag.png",
  XAU: "https://assets.lighter.xyz/fe/token/xau.png",
  XRP: "https://assets.lighter.xyz/fe/token/xrp.png",
  ZEC: "https://assets.lighter.xyz/fe/token/zcash.png",
};

const dynamicTokenLogos = new Map<string, string>();

/**
 * Registers dynamically fetched token logos from Lighter tokenlist API.
 */
export function registerTokenLogos(
  tokens: Array<{ symbol: string; logo?: string; logo_extension?: string }>,
): void {
  for (const t of tokens) {
    if (!t.symbol || !t.logo) continue;
    const ext = t.logo_extension || "png";
    const url = `https://assets.lighter.xyz/fe/token/${t.logo}.${ext}`;
    dynamicTokenLogos.set(t.symbol.toUpperCase(), url);
  }
}

/**
 * Resolves the primary logo image URL for a given market symbol from Lighter's official CDN.
 */
export function getTokenImageUrl(symbol: string): string {
  const sym = symbol.toUpperCase();
  if (dynamicTokenLogos.has(sym)) {
    return dynamicTokenLogos.get(sym)!;
  }
  if (OFFICIAL_TOKEN_LOGOS[sym]) {
    return OFFICIAL_TOKEN_LOGOS[sym];
  }
  return `https://assets.lighter.xyz/fe/token/${sym.toLowerCase()}.png`;
}
