import type {
  DynamicSizeMode,
  MarketInfo,
  MarketMetrics,
  OrderBook,
  OrderBookLevel,
  SimFillResult,
  TerminalState,
} from "./types";
import { CONFIG } from "./config";
import { ASC_COMP, FlatOrderBookSide } from "./orderbook";
import type { FastSimResult } from "./simulation";
import { fastSimFillInto, simulateFillBaseInto } from "./simulation";

function formatOptSize(sz: number): number {
  if (sz >= 10000) {
    return Math.round(sz / 1000) * 1000;
  } else if (sz >= 3000) {
    return Math.round(sz / 500) * 500;
  }
  return Math.round(sz / 100) * 100;
}

const BASE_SIZE_GRID: readonly number[] = [
  1000, 2000, 2500, 3000, 4000, 5000, 6000, 7500, 10000, 12500, 15000, 20000, 25000, 35000, 50000,
  75000, 100000,
];

// Pre-allocated reusable structures for zero-allocation simulation during optimization
const staticSimEntryRh: FastSimResult = {
  isComplete: false,
  totalCostUsd: 0,
  levelsSwept: 0,
  avgPrice: 0,
};
const staticSimEntryCore: FastSimResult = {
  isComplete: false,
  totalCostUsd: 0,
  levelsSwept: 0,
  avgPrice: 0,
};
const staticSimExitRh: FastSimResult = {
  isComplete: false,
  totalCostUsd: 0,
  levelsSwept: 0,
  avgPrice: 0,
};
const staticSimExitCore: FastSimResult = {
  isComplete: false,
  totalCostUsd: 0,
  levelsSwept: 0,
  avgPrice: 0,
};
const scratchCandidates: number[] = [];

function getSideDepth(side: OrderBookLevel[] | FlatOrderBookSide): number {
  if ("totalDepthUsd" in side) return side.totalDepthUsd;
  let d = 0;
  for (let i = 0; i < side.length; i++) d += side[i]!.totalUsd;
  return d;
}

function getBestPrice(side: OrderBookLevel[] | FlatOrderBookSide): number {
  if ("prices" in side) return side.count > 0 ? side.prices[0]! : 0;
  return side[0]?.price || 0;
}

function getL1DepthUsd(side: OrderBookLevel[] | FlatOrderBookSide): number {
  if ("totalUsds" in side) return side.count > 0 ? side.totalUsds[0]! : 0;
  return side[0]?.totalUsd || 0;
}

function getSideCount(side: OrderBookLevel[] | FlatOrderBookSide): number {
  if ("count" in side) return side.count;
  return side ? side.length : 0;
}

export function findOptimalSize(
  rhAsks: OrderBookLevel[] | FlatOrderBookSide,
  coreBids: OrderBookLevel[] | FlatOrderBookSide,
  rhBids: OrderBookLevel[] | FlatOrderBookSide,
  coreAsks: OrderBookLevel[] | FlatOrderBookSide,
  midPrice: number,
  mode: DynamicSizeMode = "min_burn",
  maxCapUsd: number = 50000,
): number {
  if (
    midPrice <= 0 ||
    getSideCount(rhAsks) === 0 ||
    getSideCount(coreBids) === 0 ||
    getSideCount(rhBids) === 0 ||
    getSideCount(coreAsks) === 0
  ) {
    return 10000;
  }

  const d0 = getSideDepth(rhAsks);
  const d1 = getSideDepth(coreBids);
  const d2 = getSideDepth(rhBids);
  const d3 = getSideDepth(coreAsks);

  let maxAvail = d0 < d1 ? d0 : d1;
  if (d2 < maxAvail) maxAvail = d2;
  if (d3 < maxAvail) maxAvail = d3;

  const upperLimit = Math.min(maxAvail, maxCapUsd > 0 ? maxCapUsd : 50000);
  if (upperLimit < 500) return Math.max(100, Math.floor(upperLimit));

  const rhBestAsk = getBestPrice(rhAsks);
  const coreBestBid = getBestPrice(coreBids);
  const rhBestBid = getBestPrice(rhBids);
  const coreBestAsk = getBestPrice(coreAsks);

  const rawEntryDragBps = ((rhBestAsk - coreBestBid) / midPrice) * 10000;
  const rawExitDragBps = ((coreBestAsk - rhBestBid) / midPrice) * 10000;
  const rawSpreadBps = (rawEntryDragBps + rawExitDragBps) / 2;

  const l1Depth = Math.floor(
    Math.min(
      getL1DepthUsd(rhAsks),
      getL1DepthUsd(coreBids),
      getL1DepthUsd(rhBids),
      getL1DepthUsd(coreAsks),
    ),
  );

  scratchCandidates.length = 0;
  for (let i = 0; i < BASE_SIZE_GRID.length; i++) {
    const s = BASE_SIZE_GRID[i]!;
    if (s >= 500 && s <= upperLimit) {
      scratchCandidates.push(s);
    }
  }
  if (l1Depth >= 500 && l1Depth <= upperLimit && !scratchCandidates.includes(l1Depth)) {
    scratchCandidates.push(l1Depth);
  }
  if (maxCapUsd >= 500 && maxCapUsd <= upperLimit && !scratchCandidates.includes(maxCapUsd)) {
    scratchCandidates.push(maxCapUsd);
  }
  scratchCandidates.sort(ASC_COMP);

  if (scratchCandidates.length === 0) return Math.min(10000, Math.floor(upperLimit));

  let hasCompletedSim = false;
  let bestSize = scratchCandidates[0]!;
  let bestArbSize = 0;
  let basePtCost = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < scratchCandidates.length; i++) {
    const s = scratchCandidates[i]!;
    const q = s / midPrice;

    if (!fastSimFillInto(staticSimEntryRh, rhAsks, q)) break;
    if (!fastSimFillInto(staticSimEntryCore, coreBids, q)) break;
    if (!fastSimFillInto(staticSimExitRh, rhBids, q)) break;
    if (!fastSimFillInto(staticSimExitCore, coreAsks, q)) break;

    hasCompletedSim = true;

    const entryLossUsd = staticSimEntryRh.totalCostUsd - staticSimEntryCore.totalCostUsd;
    const exitLossUsd = staticSimExitCore.totalCostUsd - staticSimExitRh.totalCostUsd;
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
      staticSimEntryRh.levelsSwept,
      staticSimEntryCore.levelsSwept,
      staticSimExitRh.levelsSwept,
      staticSimExitCore.levelsSwept,
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
      } else if (slippageBps > 10.0 && maxSwept > 6) {
        // High slippage and deteriorating score: break early to save cycles
        break;
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

function createEmptyLeg(): SimFillResult {
  return {
    isComplete: false,
    avgPrice: 0,
    bestPrice: 0,
    slippageBps: 0,
    levelsSwept: 0,
    totalCostUsd: 0,
    filledBase: 0,
    totalAvailableUsd: 0,
    totalAvailableBase: 0,
  };
}

function createEmptyMetrics(symbol: string): MarketMetrics {
  return {
    symbol,
    leverage: "",
    leverageNum: 0,
    rhLeverage: "",
    coreLeverage: "",
    midPrice: 0,
    rhMid: 0,
    coreMid: 0,
    deltaMidUsd: 0,
    deltaMidBps: 0,
    baseQty: 0,
    allFilled: false,
    isStale: false,
    totalVolume24h: 0,
    rhVolume24h: 0,
    totalOiUsd: 0,
    rawSpreadBps: 0,
    slippageBps: 0,
    entryDragBps: 0,
    exitDragBps: 0,
    entryLossUsd: 0,
    exitLossUsd: 0,
    vwapTotalDragBps: 0,
    costUsd: 999999,
    rawCostUsd: 999999,
    pointCostUsd: 999999,
    pointsEarned: 0,
    maxLevelsSwept: 0,
    minDepthUsd: 0,
    optimalSizeUsd: 0,
    effectiveTargetUsd: 0,
    isDynamic: false,
    dynamicMode: "none",
    status: "LOW LIQ",
    legs: {
      entryRh: createEmptyLeg(),
      entryCore: createEmptyLeg(),
      exitRh: createEmptyLeg(),
      exitCore: createEmptyLeg(),
      rhBestAsk: 0,
      coreBestBid: 0,
      rhBestBid: 0,
      coreBestAsk: 0,
      rhMid: 0,
      coreMid: 0,
    },
  };
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
  target?: MarketMetrics | null,
): MarketMetrics | null {
  if (!rhBook?.isSnapshotReceived || !coreBook?.isSnapshotReceived) return null;

  const rhAsks: FlatOrderBookSide =
    "prices" in rhBook.asks
      ? (rhBook.asks as FlatOrderBookSide)
      : ((rhBook.asks = new FlatOrderBookSide(
          true,
          (rhBook.asks as unknown as Map<number, number>).entries(),
        )) as FlatOrderBookSide);
  const rhBids: FlatOrderBookSide =
    "prices" in rhBook.bids
      ? (rhBook.bids as FlatOrderBookSide)
      : ((rhBook.bids = new FlatOrderBookSide(
          false,
          (rhBook.bids as unknown as Map<number, number>).entries(),
        )) as FlatOrderBookSide);
  const coreAsks: FlatOrderBookSide =
    "prices" in coreBook.asks
      ? (coreBook.asks as FlatOrderBookSide)
      : ((coreBook.asks = new FlatOrderBookSide(
          true,
          (coreBook.asks as unknown as Map<number, number>).entries(),
        )) as FlatOrderBookSide);
  const coreBids: FlatOrderBookSide =
    "prices" in coreBook.bids
      ? (coreBook.bids as FlatOrderBookSide)
      : ((coreBook.bids = new FlatOrderBookSide(
          false,
          (coreBook.bids as unknown as Map<number, number>).entries(),
        )) as FlatOrderBookSide);

  if (rhAsks.count === 0 || rhBids.count === 0 || coreAsks.count === 0 || coreBids.count === 0) {
    return null;
  }

  const now = Date.now();
  const isStale =
    (lastCoreMsgAt > 0 && now - lastCoreMsgAt > CONFIG.SOCKET_SILENCE_TIMEOUT_MS) ||
    (lastRhMsgAt > 0 && now - lastRhMsgAt > CONFIG.SOCKET_SILENCE_TIMEOUT_MS);

  const rhBestAsk = getBestPrice(rhAsks);
  const rhBestBid = getBestPrice(rhBids);
  const coreBestAsk = getBestPrice(coreAsks);
  const coreBestBid = getBestPrice(coreBids);

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

  // Mutate target in place or instantiate once
  const res = target ?? createEmptyMetrics(m.symbol);

  // 4-Leg VWAP fills directly into pre-allocated legs!
  simulateFillBaseInto(res.legs.entryRh, rhAsks, baseQty, true);
  simulateFillBaseInto(res.legs.entryCore, coreBids, baseQty, false);
  simulateFillBaseInto(res.legs.exitRh, rhBids, baseQty, false);
  simulateFillBaseInto(res.legs.exitCore, coreAsks, baseQty, true);

  const simEntryRh = res.legs.entryRh;
  const simEntryCore = res.legs.entryCore;
  const simExitRh = res.legs.exitRh;
  const simExitCore = res.legs.exitCore;

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

  res.symbol = m.symbol;
  res.leverage = m.leverage;
  res.leverageNum = m.leverageNum;
  res.rhLeverage = m.rhLeverage;
  res.coreLeverage = m.coreLeverage;
  res.midPrice = midPrice;
  res.rhMid = rhMid;
  res.coreMid = coreMid;
  res.deltaMidUsd = deltaMidUsd;
  res.deltaMidBps = deltaMidBps;
  res.baseQty = baseQty;
  res.allFilled = allFilled;
  res.isStale = isStale;
  res.totalVolume24h = m.totalVolume24h;
  res.rhVolume24h = m.rhVolume24h;
  res.totalOiUsd = m.totalOiUsd;
  res.rawSpreadBps = rawSpreadBps;
  res.slippageBps = slippageBps;
  res.entryDragBps = vwapEntryDragBps;
  res.exitDragBps = vwapExitDragBps;
  res.entryLossUsd = entryLossUsd;
  res.exitLossUsd = exitLossUsd;
  res.vwapTotalDragBps = vwapTotalDragBps;
  res.costUsd = effectiveCostUsd;
  res.rawCostUsd = costUsd;
  res.pointCostUsd = effectivePointCostUsd;
  res.pointsEarned = pointsEarned;
  res.maxLevelsSwept = maxLevelsSwept;
  res.minDepthUsd = minDepthUsd;
  res.optimalSizeUsd = optimalSizeUsd;
  res.effectiveTargetUsd = effectiveTargetUsd;
  res.isDynamic = isDynamic;
  res.dynamicMode = dynamicMode;
  res.status = status;

  res.legs.rhBestAsk = rhBestAsk;
  res.legs.coreBestBid = coreBestBid;
  res.legs.rhBestBid = rhBestBid;
  res.legs.coreBestAsk = coreBestAsk;
  res.legs.rhMid = rhMid;
  res.legs.coreMid = coreMid;

  return res;
}

export function getMetrics(
  m: MarketInfo,
  state: TerminalState,
  lastCoreMsgAt: number,
  lastRhMsgAt: number,
  nowTime: number = performance.now(),
  target?: MarketMetrics | null,
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
    target,
  );

  if (!r) {
    m.latestMetrics = null;
    return null;
  }

  if (r.allFilled && !r.isStale && isFinite(r.rawCostUsd) && !isNaN(r.rawCostUsd)) {
    r.costUsd = r.rawCostUsd;
    r.pointCostUsd = r.pointsEarned > 0 ? r.rawCostUsd / r.pointsEarned : 0;
    r.vwapTotalDragBps =
      r.effectiveTargetUsd > 0 ? (r.rawCostUsd / r.effectiveTargetUsd) * 10000 : 0;
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
