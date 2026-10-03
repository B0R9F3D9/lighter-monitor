import type { BasisPoint, HourlyBucketStats, QuantStats, RawCandle, SignalVerdict } from "./types";

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
  timezoneOffsetHours?: number,
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
    let h: number;
    if (typeof timezoneOffsetHours === "number") {
      h = (((date.getUTCHours() + Math.round(timezoneOffsetHours)) % 24) + 24) % 24;
    } else {
      h = date.getHours(); // Always user's local hour in browser
    }

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

export interface DateFilterInterval {
  startSec: number;
  endSec: number;
}

export interface DateFilterIntervalsResult {
  intervals: DateFilterInterval[];
  totalActiveDays: number;
}

/**
 * Computes contiguous intervals of matching days within [fromDateStr, toDateStr]
 * based on selected days of the week, clamped to current timestamp.
 */
export function computeDateFilterIntervals(
  fromDateStr: string,
  toDateStr: string,
  daysOfWeek: Set<number>,
  nowSec: number = Math.floor(Date.now() / 1000),
): DateFilterIntervalsResult {
  if (!fromDateStr || !toDateStr || daysOfWeek.size === 0) {
    return { intervals: [], totalActiveDays: 0 };
  }

  const [startY, startM, startD] = fromDateStr.split("-").map(Number);
  const [endY, endM, endD] = toDateStr.split("-").map(Number);

  const cur = new Date(startY, startM - 1, startD, 0, 0, 0, 0);
  const endDate = new Date(endY, endM - 1, endD, 23, 59, 59, 999);

  if (endDate.getTime() < cur.getTime()) {
    return { intervals: [], totalActiveDays: 0 };
  }

  const intervals: DateFilterInterval[] = [];
  let currentStart: number | null = null;
  let currentEnd: number | null = null;
  let totalActiveDays = 0;

  while (cur.getTime() <= endDate.getTime()) {
    const dayOfWeek = cur.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
    const y = cur.getFullYear();
    const m = cur.getMonth();
    const d = cur.getDate();

    const dayStartSec = Math.floor(new Date(y, m, d, 0, 0, 0, 0).getTime() / 1000);
    const dayEndSec = Math.floor(new Date(y, m, d, 23, 59, 59, 999).getTime() / 1000);

    if (dayStartSec <= nowSec) {
      if (daysOfWeek.has(dayOfWeek)) {
        totalActiveDays++;
        if (currentStart === null) {
          currentStart = dayStartSec;
        }
        currentEnd = Math.min(nowSec, dayEndSec);
      } else {
        if (currentStart !== null && currentEnd !== null) {
          if (currentEnd >= currentStart) {
            intervals.push({ startSec: currentStart, endSec: currentEnd });
          }
          currentStart = null;
          currentEnd = null;
        }
      }
    } else {
      break;
    }

    cur.setDate(cur.getDate() + 1);
  }

  if (currentStart !== null && currentEnd !== null) {
    if (currentEnd >= currentStart) {
      intervals.push({ startSec: currentStart, endSec: currentEnd });
    }
  }

  return { intervals, totalActiveDays };
}

/**
 * Chooses the best candle resolution and step based on the number of matching active days.
 * Enables much finer granularity (e.g. 5m / 15m) when isolating weekends or specific days.
 */
export function chooseDateFilterResolution(totalActiveDays: number): {
  resolution: string;
  stepSec: number;
} {
  if (totalActiveDays <= 2) {
    return { resolution: "5m", stepSec: 300 };
  } else if (totalActiveDays <= 10) {
    return { resolution: "15m", stepSec: 900 };
  } else if (totalActiveDays <= 20) {
    return { resolution: "30m", stepSec: 1800 };
  } else if (totalActiveDays <= 45) {
    return { resolution: "1h", stepSec: 3600 };
  } else {
    return { resolution: "4h", stepSec: 14400 };
  }
}

export interface ApiCandleChunk {
  startSec: number;
  endSec: number;
  countBack: number;
}

/**
 * Splits intervals into chunks that never exceed the exchange API candlestick limit (500 candles per query).
 */
export function splitIntervalsIntoApiChunks(
  intervals: DateFilterInterval[],
  stepSec: number,
  maxCandlesPerChunk: number = 400,
): ApiCandleChunk[] {
  const chunks: ApiCandleChunk[] = [];
  const chunkSpanSec = Math.max(stepSec, maxCandlesPerChunk * stepSec);

  for (const interval of intervals) {
    let curStart = interval.startSec;
    while (curStart < interval.endSec) {
      const curEnd = Math.min(interval.endSec, curStart + chunkSpanSec);
      const span = curEnd - curStart;
      const expectedCount = Math.ceil(span / stepSec);
      const countBack = Math.min(500, Math.max(10, expectedCount + 10));
      chunks.push({
        startSec: curStart,
        endSec: curEnd,
        countBack,
      });
      curStart = curEnd;
    }
  }

  return chunks;
}

/**
 * Deduplicates candlesticks by timestamp and sorts them chronologically.
 */
export function dedupeAndSortCandles(candles: RawCandle[]): RawCandle[] {
  const map = new Map<number, RawCandle>();
  for (const c of candles) {
    map.set(c.t, c);
  }
  return Array.from(map.values()).toSorted((a, b) => a.t - b.t);
}

export {
  formatMarketPrice,
  getTokenIcon,
  getTokenImageUrl,
  OFFICIAL_TOKEN_LOGOS,
  registerTokenLogos,
} from "../shared";
