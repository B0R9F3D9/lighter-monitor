import { CONFIG, fetchMarketPairs } from "../shared";
import { alignCandlesToBasisPoints, calculateQuantStats, calculateRollingBands } from "./math";
import type {
  AnalyticsMarketPair,
  BasisPoint,
  QuantStats,
  RawCandle,
  TimeframeConfig,
  TimeframeId,
} from "./types";

export { fetchMarketPairs };

export const TIMEFRAMES: Record<TimeframeId, TimeframeConfig> = {
  "1h": { id: "1h", label: "1H", resolution: "1m", countBack: 60, durationSec: 3600 },
  "4h": { id: "4h", label: "4H", resolution: "1m", countBack: 240, durationSec: 14400 },
  "12h": { id: "12h", label: "12H", resolution: "5m", countBack: 144, durationSec: 43200 },
  "24h": { id: "24h", label: "24H", resolution: "5m", countBack: 288, durationSec: 86400 },
  "3d": { id: "3d", label: "3D", resolution: "15m", countBack: 288, durationSec: 259200 },
  "7d": { id: "7d", label: "7D", resolution: "1h", countBack: 168, durationSec: 604800 },
  "30d": { id: "30d", label: "ALL", resolution: "4h", countBack: 180, durationSec: 2592000 },
};

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
