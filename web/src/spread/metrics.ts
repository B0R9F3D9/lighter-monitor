import type { MarketInfo, MarketMetrics, OrderBook, TerminalState } from "./types";
import { CONFIG } from "./config";
import { getSortedLevels } from "./orderbook";
import { simulateFillBase } from "./simulation";

export function calculateMarketMetrics(
  m: MarketInfo,
  targetUsd: number,
  coreBook: OrderBook | undefined,
  rhBook: OrderBook | undefined,
  lastCoreMsgAt: number,
  lastRhMsgAt: number,
): MarketMetrics | null {
  if (!rhBook?.isSnapshotReceived || !coreBook?.isSnapshotReceived) return null;
  if (
    rhBook.asks.size === 0 ||
    rhBook.bids.size === 0 ||
    coreBook.asks.size === 0 ||
    coreBook.bids.size === 0
  ) {
    return null;
  }

  const now = Date.now();
  const isStale =
    (lastCoreMsgAt > 0 && now - lastCoreMsgAt > CONFIG.SOCKET_SILENCE_TIMEOUT_MS) ||
    (lastRhMsgAt > 0 && now - lastRhMsgAt > CONFIG.SOCKET_SILENCE_TIMEOUT_MS);

  const rhAsks = getSortedLevels(rhBook.asks, true);
  const rhBids = getSortedLevels(rhBook.bids, false);
  const coreAsks = getSortedLevels(coreBook.asks, true);
  const coreBids = getSortedLevels(coreBook.bids, false);

  if (
    rhAsks.length === 0 ||
    rhBids.length === 0 ||
    coreAsks.length === 0 ||
    coreBids.length === 0
  ) {
    return null;
  }

  const rhBestAsk = rhAsks[0]!.price;
  const rhBestBid = rhBids[0]!.price;
  const coreBestAsk = coreAsks[0]!.price;
  const coreBestBid = coreBids[0]!.price;

  // Crossed book check (reject corrupted book ticks)
  if (rhBestBid >= rhBestAsk || coreBestBid >= coreBestAsk) {
    return null;
  }

  const rhMid = (rhBestAsk + rhBestBid) / 2;
  const coreMid = (coreBestAsk + coreBestBid) / 2;
  const midPrice = (rhMid + coreMid) / 2;
  if (midPrice <= 0) return null;

  // Inter-exchange basis (RH vs Core)
  const deltaMidUsd = rhMid - coreMid;
  const deltaMidBps = (deltaMidUsd / midPrice) * 10000;

  // Base Asset Quantity for target size (Strict Delta-Neutral)
  const baseQty = targetUsd / midPrice;

  // 4-Leg VWAP fills by EXACT baseQty
  const simEntryRh = simulateFillBase(rhAsks, baseQty, true);
  const simEntryCore = simulateFillBase(coreBids, baseQty, false);
  const simExitRh = simulateFillBase(rhBids, baseQty, false);
  const simExitCore = simulateFillBase(coreAsks, baseQty, true);

  // Theoretical top-of-book spread
  const rawEntryDragBps = ((rhBestAsk - coreBestBid) / midPrice) * 10000;
  const rawExitDragBps = ((coreBestAsk - rhBestBid) / midPrice) * 10000;
  const rawSpreadBps = (rawEntryDragBps + rawExitDragBps) / 2;

  // Real VWAP drag in bps
  const vwapEntryDragBps = ((simEntryRh.avgPrice - simEntryCore.avgPrice) / midPrice) * 10000;
  const vwapExitDragBps = ((simExitCore.avgPrice - simExitRh.avgPrice) / midPrice) * 10000;
  const rawVwapDragBps = (vwapEntryDragBps + vwapExitDragBps) / 2;
  const slippageBps = rawVwapDragBps - rawSpreadBps;

  if (isNaN(rawVwapDragBps) || !isFinite(rawVwapDragBps)) return null;

  // Instant Entry Drag ($) vs Exit Drag ($)
  const entryLossUsd = simEntryRh.totalCostUsd - simEntryCore.totalCostUsd;
  const exitLossUsd = simExitCore.totalCostUsd - simExitRh.totalCostUsd;

  // Real Round-Trip Dollar Loss: Sum of Entry Loss + Exit Loss
  const costUsd = entryLossUsd + exitLossUsd;
  const vwapTotalDragBps = rawVwapDragBps;

  // Point cost calculation:
  const rhRoundTripVol = targetUsd * 2;
  const pointsEarned = (rhRoundTripVol / 1000000) * 52 * 5.0;
  const pointCostUsd = pointsEarned > 0 ? costUsd / pointsEarned : 0;

  const maxLevelsSwept = Math.max(
    simEntryRh.levelsSwept,
    simEntryCore.levelsSwept,
    simExitRh.levelsSwept,
    simExitCore.levelsSwept,
  );

  const minDepthUsd = Math.min(
    simEntryRh.totalAvailableUsd,
    simEntryCore.totalAvailableUsd,
    simExitRh.totalAvailableUsd,
    simExitCore.totalAvailableUsd,
  );

  const allFilled =
    simEntryRh.isComplete &&
    simEntryCore.isComplete &&
    simExitRh.isComplete &&
    simExitCore.isComplete;

  let status: "READY" | "SLIPPAGE" | "LOW LIQ" | "STALE" = "READY";
  if (isStale) {
    status = "STALE";
  } else if (!allFilled) {
    status = "LOW LIQ";
  } else if (maxLevelsSwept > 6 || slippageBps > 8.0) {
    status = "SLIPPAGE";
  }

  const effectiveCostUsd = allFilled && !isStale ? costUsd : 999999;
  const effectivePointCostUsd = allFilled && !isStale ? pointCostUsd : 999999;

  return {
    symbol: m.symbol,
    leverage: m.leverage,
    leverageNum: m.leverageNum,
    rhLeverage: m.rhLeverage,
    coreLeverage: m.coreLeverage,
    midPrice,
    rhMid,
    coreMid,
    deltaMidUsd,
    deltaMidBps,
    baseQty,
    allFilled,
    isStale,
    totalVolume24h: m.totalVolume24h,
    rhVolume24h: m.rhVolume24h,
    totalOiUsd: m.totalOiUsd,
    rawSpreadBps,
    slippageBps,
    entryDragBps: vwapEntryDragBps,
    exitDragBps: vwapExitDragBps,
    entryLossUsd,
    exitLossUsd,
    vwapTotalDragBps,
    costUsd: effectiveCostUsd,
    rawCostUsd: costUsd,
    pointCostUsd: effectivePointCostUsd,
    pointsEarned,
    maxLevelsSwept,
    minDepthUsd,
    status,
    legs: {
      entryRh: simEntryRh,
      entryCore: simEntryCore,
      exitRh: simExitRh,
      exitCore: simExitCore,
      rhBestAsk,
      coreBestBid,
      rhBestBid,
      coreBestAsk,
      rhMid,
      coreMid,
    },
  };
}

export function getMetrics(
  m: MarketInfo,
  state: TerminalState,
  lastCoreMsgAt: number,
  lastRhMsgAt: number,
  nowTime: number = performance.now(),
): MarketMetrics | null {
  const r = calculateMarketMetrics(
    m,
    state.targetSizeUsd,
    state.coreBooks.get(m.coreMarketId),
    state.rhBooks.get(m.rhMarketId),
    lastCoreMsgAt,
    lastRhMsgAt,
  );

  if (!r) {
    m.latestMetrics = null;
    return null;
  }

  if (r.allFilled && !r.isStale && isFinite(r.rawCostUsd) && !isNaN(r.rawCostUsd)) {
    let e = state.emaMap.get(m.symbol);
    if (!e || !isFinite(e.cost) || isNaN(e.cost)) {
      e = { cost: r.rawCostUsd, lastTs: nowTime };
      state.emaMap.set(m.symbol, e);
    } else {
      const dt = Math.max(0, nowTime - (e.lastTs || nowTime));
      const tau = CONFIG.EMA_TAU_MS;
      const a = 1 - Math.exp(-dt / tau);
      e.cost = a * r.rawCostUsd + (1 - a) * e.cost;
      e.lastTs = nowTime;
    }
    r.costUsd = e.cost;
    r.pointCostUsd = r.pointsEarned > 0 ? e.cost / r.pointsEarned : 0;
    r.vwapTotalDragBps = state.targetSizeUsd > 0 ? (e.cost / state.targetSizeUsd) * 10000 : 0;
  } else {
    r.costUsd = 999999;
    r.pointCostUsd = 999999;
    r.vwapTotalDragBps = state.targetSizeUsd > 0 ? (r.rawCostUsd / state.targetSizeUsd) * 10000 : 0;
  }

  r.computedAt = nowTime;
  m.latestMetrics = r;
  return r;
}
