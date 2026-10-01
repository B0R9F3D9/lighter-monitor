import type {
  DynamicSizeMode,
  MarketInfo,
  MarketMetrics,
  OrderBook,
  OrderBookLevel,
  TerminalState,
} from "./types";
import { CONFIG } from "./config";
import { ASC_COMP, getSortedLevels } from "./orderbook";
import { fastSimFill, simulateFillBase } from "./simulation";

function formatOptSize(sz: number): number {
  if (sz >= 10000) {
    return Math.round(sz / 1000) * 1000;
  } else if (sz >= 3000) {
    return Math.round(sz / 500) * 500;
  }
  return Math.round(sz / 100) * 100;
}

const BASE_SIZE_GRID: readonly number[] = [
  1000, 2000, 3000, 4000, 5000, 6000, 7500, 10000, 12500, 15000, 20000, 25000, 35000, 50000, 75000,
  100000,
];

export function findOptimalSize(
  rhAsks: OrderBookLevel[],
  coreBids: OrderBookLevel[],
  rhBids: OrderBookLevel[],
  coreAsks: OrderBookLevel[],
  midPrice: number,
  mode: DynamicSizeMode = "min_burn",
  maxCapUsd: number = 50000,
): number {
  if (
    midPrice <= 0 ||
    !rhAsks?.length ||
    !coreBids?.length ||
    !rhBids?.length ||
    !coreAsks?.length
  ) {
    return 10000;
  }

  let d0 = 0;
  for (let i = 0; i < rhAsks.length; i++) d0 += rhAsks[i]!.totalUsd;
  let d1 = 0;
  for (let i = 0; i < coreBids.length; i++) d1 += coreBids[i]!.totalUsd;
  let d2 = 0;
  for (let i = 0; i < rhBids.length; i++) d2 += rhBids[i]!.totalUsd;
  let d3 = 0;
  for (let i = 0; i < coreAsks.length; i++) d3 += coreAsks[i]!.totalUsd;

  let maxAvail = d0 < d1 ? d0 : d1;
  if (d2 < maxAvail) maxAvail = d2;
  if (d3 < maxAvail) maxAvail = d3;

  const upperLimit = Math.min(maxAvail, maxCapUsd > 0 ? maxCapUsd : 50000);
  if (upperLimit < 500) return Math.max(100, Math.floor(upperLimit));

  const rhBestAsk = rhAsks[0]?.price || 0;
  const coreBestBid = coreBids[0]?.price || 0;
  const rhBestBid = rhBids[0]?.price || 0;
  const coreBestAsk = coreAsks[0]?.price || 0;

  const rawEntryDragBps = ((rhBestAsk - coreBestBid) / midPrice) * 10000;
  const rawExitDragBps = ((coreBestAsk - rhBestBid) / midPrice) * 10000;
  const rawSpreadBps = (rawEntryDragBps + rawExitDragBps) / 2;

  const l1Depth = Math.floor(
    Math.min(
      rhAsks[0]?.totalUsd || 0,
      coreBids[0]?.totalUsd || 0,
      rhBids[0]?.totalUsd || 0,
      coreAsks[0]?.totalUsd || 0,
    ),
  );

  const candidates: number[] = [];
  for (let i = 0; i < BASE_SIZE_GRID.length; i++) {
    const s = BASE_SIZE_GRID[i]!;
    if (s >= 500 && s <= upperLimit) {
      candidates.push(s);
    }
  }
  if (l1Depth >= 500 && l1Depth <= upperLimit && !candidates.includes(l1Depth)) {
    candidates.push(l1Depth);
  }
  if (maxCapUsd >= 500 && maxCapUsd <= upperLimit && !candidates.includes(maxCapUsd)) {
    candidates.push(maxCapUsd);
  }
  candidates.sort(ASC_COMP);

  if (candidates.length === 0) return Math.min(10000, Math.floor(upperLimit));

  let hasCompletedSim = false;
  let bestSize = candidates[0]!;
  let bestArbSize = 0;
  let basePtCost = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i]!;
    const q = s / midPrice;

    const simEntryRh = fastSimFill(rhAsks, q);
    if (!simEntryRh.isComplete) break;
    const simEntryCore = fastSimFill(coreBids, q);
    if (!simEntryCore.isComplete) break;
    const simExitRh = fastSimFill(rhBids, q);
    if (!simExitRh.isComplete) break;
    const simExitCore = fastSimFill(coreAsks, q);
    if (!simExitCore.isComplete) break;

    hasCompletedSim = true;

    const entryLossUsd = simEntryRh.totalCostUsd - simEntryCore.totalCostUsd;
    const exitLossUsd = simExitCore.totalCostUsd - simExitRh.totalCostUsd;
    const costUsd = entryLossUsd + exitLossUsd;

    if (costUsd <= 0) {
      bestArbSize = s;
    } else if (bestArbSize > 0) {
      // Cost turned positive; larger sizes will only have higher costs
      break;
    }

    const vwapDragBps = (costUsd / s) * 10000;
    const slippageBps = Math.max(0, vwapDragBps - rawSpreadBps);
    const pointsEarned = ((s * 2) / 1000000) * 52 * 5.0;
    const pointCostUsd = pointsEarned > 0 ? costUsd / pointsEarned : 0;
    const maxSwept = Math.max(
      simEntryRh.levelsSwept,
      simEntryCore.levelsSwept,
      simExitRh.levelsSwept,
      simExitCore.levelsSwept,
    );

    if (mode === "max_vol") {
      let score = 0;
      if (slippageBps <= 3.5 && maxSwept <= 4) {
        score = s / Math.max(0.3, pointCostUsd);
      } else if (slippageBps <= 6.0 && maxSwept <= 6) {
        score = (s / Math.max(0.3, pointCostUsd)) * 0.4;
      } else {
        score = (s / Math.max(0.3, pointCostUsd)) * 0.05;
      }
      if (score > bestScore) {
        bestScore = score;
        bestSize = s;
      }
    } else {
      // ALGORITHM 1: Min Burn (Strict minimum unit cost $/pt & bps, stops immediately on price degradation)
      if (basePtCost < 0) {
        basePtCost = pointCostUsd;
        bestSize = s;
      } else {
        const costInflation = basePtCost > 0 ? (pointCostUsd - basePtCost) / basePtCost : 0;
        // Stop increasing size if slippage exceeds 0.8 bps or point cost inflates by > 5% or > 3 levels swept
        if (slippageBps > 0.8 || costInflation > 0.05 || maxSwept > 3) {
          break;
        }
        bestSize = s;
      }
    }
  }

  if (!hasCompletedSim) {
    return Math.min(10000, Math.floor(upperLimit));
  }

  if (bestArbSize > 0) {
    return formatOptSize(bestArbSize);
  }

  return formatOptSize(bestSize);
}

export function calculateMarketMetrics(
  m: MarketInfo,
  targetUsd: number,
  coreBook: OrderBook | undefined,
  rhBook: OrderBook | undefined,
  lastCoreMsgAt: number,
  lastRhMsgAt: number,
  dynamicMode: DynamicSizeMode = "none",
  maxCapUsd: number = 50000,
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

  const rhAsks = getSortedLevels(rhBook, true);
  const rhBids = getSortedLevels(rhBook, false);
  const coreAsks = getSortedLevels(coreBook, true);
  const coreBids = getSortedLevels(coreBook, false);

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

  const isDynamic = dynamicMode !== "none";
  const optimalSizeUsd = isDynamic
    ? findOptimalSize(rhAsks, coreBids, rhBids, coreAsks, midPrice, dynamicMode, maxCapUsd)
    : targetUsd;
  const effectiveTargetUsd = optimalSizeUsd;

  // Inter-exchange basis (RH vs Core)
  const deltaMidUsd = rhMid - coreMid;
  const deltaMidBps = (deltaMidUsd / midPrice) * 10000;

  // Base Asset Quantity for target size (Strict Delta-Neutral)
  const baseQty = effectiveTargetUsd / midPrice;

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
  const rhRoundTripVol = effectiveTargetUsd * 2;
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
    optimalSizeUsd,
    effectiveTargetUsd,
    isDynamic,
    dynamicMode,
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
  const mode = state.dynamicMode || (state.isDynamicSize ? "min_burn" : "none");
  const r = calculateMarketMetrics(
    m,
    state.targetSizeUsd,
    state.coreBooks.get(m.coreMarketId),
    state.rhBooks.get(m.rhMarketId),
    lastCoreMsgAt,
    lastRhMsgAt,
    mode,
    state.maxCapUsd || state.targetSizeUsd || 50000,
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
    r.vwapTotalDragBps = r.effectiveTargetUsd > 0 ? (e.cost / r.effectiveTargetUsd) * 10000 : 0;
  } else {
    r.costUsd = 999999;
    r.pointCostUsd = 999999;
    r.vwapTotalDragBps =
      r.effectiveTargetUsd > 0 ? (r.rawCostUsd / r.effectiveTargetUsd) * 10000 : 0;
  }

  r.computedAt = nowTime;
  m.latestMetrics = r;
  return r;
}
