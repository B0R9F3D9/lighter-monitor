import { describe, expect, it } from "bun:test";
import {
  alignCandlesToBasisPoints,
  calculateQuantStats,
  calculateRollingBands,
  calculateHourlyBuckets,
  evaluateSignalVerdict,
  chooseOptimalResolution,
  extrapolateTimeRange,
  formatMarketPrice,
  getTokenIcon,
  getTokenImageUrl,
} from "../web/src/analytics/math";
import type { RawCandle } from "../web/src/analytics/types";

describe("Analytics Math Engine", () => {
  it("aligns RH and Core candles correctly and computes basis", () => {
    const rhCandles: RawCandle[] = [
      { t: 1000000, o: 100, h: 101, l: 99, c: 100.5, v: 10, V: 1000 },
      { t: 1060000, o: 100.5, h: 102, l: 100, c: 101.2, v: 15, V: 1500 },
    ];
    const coreCandles: RawCandle[] = [
      { t: 1000000, o: 100, h: 101, l: 99, c: 100.0, v: 12, V: 1200 },
      { t: 1060000, o: 100, h: 102, l: 100, c: 101.0, v: 18, V: 1800 },
    ];

    const points = alignCandlesToBasisPoints(rhCandles, coreCandles);
    expect(points.length).toBe(2);

    expect(points[0].basisUsd).toBeCloseTo(0.5, 4);
    expect(points[0].midPrice).toBeCloseTo(100.25, 4);
    expect(points[0].basisBps).toBeCloseTo((0.5 / 100.25) * 10000, 2);

    expect(points[1].basisUsd).toBeCloseTo(0.2, 4);
    expect(points[1].midPrice).toBeCloseTo(101.1, 4);
  });

  it("calculates quant stats, Z-Score, and percentiles correctly", () => {
    const rhCandles: RawCandle[] = [];
    const coreCandles: RawCandle[] = [];

    // Create 100 data points with known basis
    // Basis starts at 0.10 and goes up to 1.09
    for (let i = 0; i < 100; i++) {
      const t = 1700000000000 + i * 60000;
      const corePrice = 100;
      const basis = 0.1 + i * 0.01;
      rhCandles.push({ t, o: 100, h: 102, l: 98, c: corePrice + basis, v: 1, V: 100 });
      coreCandles.push({ t, o: 100, h: 102, l: 98, c: corePrice, v: 1, V: 100 });
    }

    const points = alignCandlesToBasisPoints(rhCandles, coreCandles);
    const stats = calculateQuantStats(points);
    expect(stats).not.toBeNull();
    if (!stats) return;

    expect(stats.count).toBe(100);
    expect(stats.minBasisUsd).toBeCloseTo(0.1, 2);
    expect(stats.maxBasisUsd).toBeCloseTo(1.09, 2);
    // Mean of 0.10, 0.11, ..., 1.09 is ~0.595
    expect(stats.meanBasisUsd).toBeCloseTo(0.595, 2);
    expect(stats.medianBasisUsd).toBeCloseTo(0.595, 2);
    expect(stats.stdDevUsd).toBeGreaterThan(0.2);

    // Latest point is 1.09 (maximum)
    expect(stats.currentBasisUsd).toBeCloseTo(1.09, 2);
    expect(stats.percentile).toBe(99); // 99 items below 100th
    expect(stats.zScore).toBeGreaterThan(1.5);
    expect(stats.signal).toBe("CAUTION"); // or OVERHEATED depending on z-score
  });

  it("evaluates signal verdicts across tiers properly", () => {
    expect(evaluateSignalVerdict(-0.5)).toBe("EXCELLENT ENTRY");
    expect(evaluateSignalVerdict(0)).toBe("EXCELLENT ENTRY");
    expect(evaluateSignalVerdict(0.5)).toBe("FAIR");
    expect(evaluateSignalVerdict(1.0)).toBe("FAIR");
    expect(evaluateSignalVerdict(1.5)).toBe("CAUTION");
    expect(evaluateSignalVerdict(2.0)).toBe("CAUTION");
    expect(evaluateSignalVerdict(2.5)).toBe("OVERHEATED");
  });

  it("calculates rolling Bollinger Bands", () => {
    const rhCandles: RawCandle[] = [];
    const coreCandles: RawCandle[] = [];
    for (let i = 0; i < 30; i++) {
      const t = 1700000000000 + i * 60000;
      rhCandles.push({ t, o: 100, h: 102, l: 98, c: 100.5, v: 1, V: 100 });
      coreCandles.push({ t, o: 100, h: 102, l: 98, c: 100.0, v: 1, V: 100 });
    }
    const points = alignCandlesToBasisPoints(rhCandles, coreCandles);
    const bands = calculateRollingBands(points, 20);
    expect(bands.length).toBe(30);
    expect(bands[29].sma).toBeCloseTo(0.5, 4);
    // Since all basis values are 0.5, stdDev is 0
    expect(bands[29].upper).toBeCloseTo(0.5, 4);
    expect(bands[29].lower).toBeCloseTo(0.5, 4);
  });

  it("groups basis points into 24-hour buckets and normalizes scores", () => {
    const rhCandles: RawCandle[] = [];
    const coreCandles: RawCandle[] = [];

    // Hour 10 UTC (which with offset 2 is hour 12): low spread (0.05)
    // Hour 14 UTC (which with offset 2 is hour 16): high spread (0.50)
    const tHour10 = Date.UTC(2026, 9, 1, 10, 0, 0);
    const tHour14 = Date.UTC(2026, 9, 1, 14, 0, 0);

    rhCandles.push({ t: tHour10, o: 100, h: 100, l: 100, c: 100.05, v: 1, V: 100 });
    coreCandles.push({ t: tHour10, o: 100, h: 100, l: 100, c: 100.0, v: 1, V: 100 });

    rhCandles.push({ t: tHour14, o: 100, h: 100, l: 100, c: 100.5, v: 1, V: 100 });
    coreCandles.push({ t: tHour14, o: 100, h: 100, l: 100, c: 100.0, v: 1, V: 100 });

    const points = alignCandlesToBasisPoints(rhCandles, coreCandles);
    const buckets = calculateHourlyBuckets(points, 2);

    expect(buckets.length).toBe(24);
    // Hour 12 should have sampleCount = 1, avgBasisUsd = 0.05, scoreNormalized = 0 (cheapest)
    expect(buckets[12].sampleCount).toBe(1);
    expect(buckets[12].avgBasisUsd).toBeCloseTo(0.05, 4);
    expect(buckets[12].scoreNormalized).toBeCloseTo(0, 2);

    // Hour 16 should have sampleCount = 1, avgBasisUsd = 0.50, scoreNormalized = 1 (most expensive)
    expect(buckets[16].sampleCount).toBe(1);
    expect(buckets[16].avgBasisUsd).toBeCloseTo(0.5, 4);
    expect(buckets[16].scoreNormalized).toBeCloseTo(1, 2);
  });

  it("selects optimal candle resolutions based on visible time span", () => {
    // <= 3 hours -> 1m
    expect(chooseOptimalResolution(3600).resolution).toBe("1m");
    expect(chooseOptimalResolution(3 * 3600).resolution).toBe("1m");

    // <= 26 hours -> 5m
    expect(chooseOptimalResolution(12 * 3600).resolution).toBe("5m");
    expect(chooseOptimalResolution(24 * 3600).resolution).toBe("5m");
    expect(chooseOptimalResolution(26 * 3600).resolution).toBe("5m");

    // <= 4 days -> 15m
    expect(chooseOptimalResolution(3 * 86400).resolution).toBe("15m");
    expect(chooseOptimalResolution(4 * 86400).resolution).toBe("15m");

    // <= 16 days -> 1h
    expect(chooseOptimalResolution(7 * 86400).resolution).toBe("1h");
    expect(chooseOptimalResolution(14 * 86400).resolution).toBe("1h");

    // > 16 days -> 4h
    expect(chooseOptimalResolution(30 * 86400).resolution).toBe("4h");
    expect(chooseOptimalResolution(60 * 86400).resolution).toBe("4h");
  });

  it("extrapolates time range when zooming or panning beyond existent bars", () => {
    const points = [{ timeSec: 1000 }, { timeSec: 1060 }, { timeSec: 1120 }, { timeSec: 1180 }];
    const nowSec = 5000;

    // Inside range: [0, 3]
    const inside = extrapolateTimeRange({ from: 1, to: 2 }, points, nowSec);
    expect(inside).toEqual({ fromSec: 1060, toSec: 1120 });

    // Panned left into the past: from = -2, to = 2
    // dt = (1180 - 1000) / 3 = 60
    // fromSec = 1000 + (-2 * 60) = 880
    // toSec = points[2].timeSec = 1120
    const pannedLeft = extrapolateTimeRange({ from: -2, to: 2 }, points, nowSec);
    expect(pannedLeft).toEqual({ fromSec: 880, toSec: 1120 });

    // Zoomed out past both edges: from = -10, to = 13
    // fromSec = 1000 + (-10 * 60) = 400
    // toSec = 1180 + (13 - 3) * 60 = 1780
    const zoomedOut = extrapolateTimeRange({ from: -10, to: 13 }, points, nowSec);
    expect(zoomedOut).toEqual({ fromSec: 400, toSec: 1780 });

    // Clamps to nowSec when to is in the future
    const future = extrapolateTimeRange({ from: 0, to: 1000 }, points, 2000);
    expect(future?.toSec).toBe(2000);

    // Empty points or null range returns null
    expect(extrapolateTimeRange(null, points, nowSec)).toBeNull();
    expect(extrapolateTimeRange({ from: 0, to: 1 }, [], nowSec)).toBeNull();
  });

  it("returns iconic badge icons for recognized symbols", () => {
    expect(getTokenIcon("AAPL")).toBe("");
    expect(getTokenIcon("BTC")).toBe("₿");
    expect(getTokenIcon("ETH")).toBe("Ξ");
    expect(getTokenIcon("SOL")).toBe("◎");
    expect(getTokenIcon("NVDA")).toBe("NV");
    expect(getTokenIcon("SPY")).toBe("SP");
    expect(getTokenIcon("UNKNOWN")).toBe("UN");
  });

  it("formats market prices matching Lighter exchange format", () => {
    expect(formatMarketPrice(328.21)).toBe("328.21");
    expect(formatMarketPrice(84388.4)).toBe("84,388.4");
    expect(formatMarketPrice(0.0521)).toBe("0.0521");
    expect(formatMarketPrice(0)).toBe("--");
    expect(formatMarketPrice(null)).toBe("--");
  });

  it("resolves official Lighter CDN image URLs for all shared tokens without 404s", () => {
    const tokens = [
      { sym: "XAU", expected: "https://assets.lighter.xyz/fe/token/xau.png" },
      { sym: "XAG", expected: "https://assets.lighter.xyz/fe/token/xag.png" },
      { sym: "HYPE", expected: "https://assets.lighter.xyz/fe/token/hype.png" },
      { sym: "CRCL", expected: "https://assets.lighter.xyz/fe/token/crcl.png" },
      { sym: "PONS", expected: "https://assets.lighter.xyz/fe/token/pons.png" },
      { sym: "CASHCAT", expected: "https://assets.lighter.xyz/fe/token/cashcat.png" },
      { sym: "ANSEM", expected: "https://assets.lighter.xyz/fe/token/ansem.png" },
      { sym: "OPENAI", expected: "https://assets.lighter.xyz/fe/token/openai.png" },
      { sym: "SHEIN", expected: "https://assets.lighter.xyz/fe/token/shein.png" },
      { sym: "ANTHROPIC", expected: "https://assets.lighter.xyz/fe/token/anthropic.png" },
      { sym: "SKHY", expected: "https://assets.lighter.xyz/fe/token/skhynix.png" },
      { sym: "COIN", expected: "https://assets.lighter.xyz/fe/token/coinbase.png" },
      { sym: "ZEC", expected: "https://assets.lighter.xyz/fe/token/zcash.png" },
      { sym: "AAPL", expected: "https://assets.lighter.xyz/fe/token/aapl.png" },
      { sym: "BTC", expected: "https://assets.lighter.xyz/fe/token/btc.png" },
      { sym: "ETH", expected: "https://assets.lighter.xyz/fe/token/eth.png" },
      { sym: "SOL", expected: "https://assets.lighter.xyz/fe/token/sol.png" },
      { sym: "LIT", expected: "https://assets.lighter.xyz/fe/token/lit.png" },
    ];

    for (const { sym, expected } of tokens) {
      expect(getTokenImageUrl(sym)).toBe(expected);
    }
  });
});
