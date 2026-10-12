import type { FlatOrderBookSide, OrderBookLevel, SimFillResult } from "./types";

export function simulateFillBaseInto(
  out: SimFillResult,
  levels: OrderBookLevel[] | FlatOrderBookSide,
  targetBaseQty: number,
  isAsk: boolean,
): SimFillResult {
  if (!levels || targetBaseQty <= 0) {
    out.isComplete = false;
    out.avgPrice = 0;
    out.bestPrice = 0;
    out.slippageBps = 0;
    out.levelsSwept = 0;
    out.totalCostUsd = 0;
    out.filledBase = 0;
    out.totalAvailableUsd = 0;
    out.totalAvailableBase = 0;
    return out;
  }

  if ("prices" in levels) {
    const count = levels.count;
    if (count === 0) {
      out.isComplete = false;
      out.avgPrice = 0;
      out.bestPrice = 0;
      out.slippageBps = 0;
      out.levelsSwept = 0;
      out.totalCostUsd = 0;
      out.filledBase = 0;
      out.totalAvailableUsd = 0;
      out.totalAvailableBase = 0;
      return out;
    }

    const prices = levels.prices;
    const sizes = levels.sizes;
    const totalUsds = levels.totalUsds;
    const bestPrice = prices[0]!;

    let remainingBase = targetBaseQty;
    let totalCostUsd = 0;
    let filledBase = 0;
    let levelsSwept = 0;

    const totalAvailableBase = levels.totalDepthBase;
    const totalAvailableUsd = levels.totalDepthUsd;

    for (let i = 0; i < count; i++) {
      levelsSwept++;
      const s = sizes[i]!;
      if (remainingBase <= s) {
        totalCostUsd += remainingBase * prices[i]!;
        filledBase += remainingBase;
        remainingBase = 0;
        break;
      }
      totalCostUsd += totalUsds[i]!;
      filledBase += s;
      remainingBase -= s;
    }

    const tolerance = Math.max(1e-5, targetBaseQty * 0.0005);
    const isComplete = remainingBase <= tolerance;
    const avgPrice = filledBase > 0 ? totalCostUsd / filledBase : bestPrice;
    const slippageBps = isAsk
      ? ((avgPrice - bestPrice) / bestPrice) * 10000
      : ((bestPrice - avgPrice) / bestPrice) * 10000;

    out.isComplete = isComplete;
    out.avgPrice = avgPrice;
    out.bestPrice = bestPrice;
    out.slippageBps = slippageBps;
    out.levelsSwept = levelsSwept;
    out.totalCostUsd = totalCostUsd;
    out.filledBase = filledBase;
    out.totalAvailableUsd = totalAvailableUsd;
    out.totalAvailableBase = totalAvailableBase;
    return out;
  }

  const len = levels.length;
  if (len === 0) {
    out.isComplete = false;
    out.avgPrice = 0;
    out.bestPrice = 0;
    out.slippageBps = 0;
    out.levelsSwept = 0;
    out.totalCostUsd = 0;
    out.filledBase = 0;
    out.totalAvailableUsd = 0;
    out.totalAvailableBase = 0;
    return out;
  }

  const bestPrice = levels[0]!.price;
  let remainingBase = targetBaseQty;
  let totalCostUsd = 0;
  let filledBase = 0;
  let levelsSwept = 0;
  let totalAvailableUsd = 0;
  let totalAvailableBase = 0;

  for (let i = 0; i < len; i++) {
    const lvl = levels[i]!;
    totalAvailableBase += lvl.totalBase;
    totalAvailableUsd += lvl.totalUsd;
    if (remainingBase > 0) {
      levelsSwept++;
      const takeBase = remainingBase < lvl.totalBase ? remainingBase : lvl.totalBase;
      totalCostUsd += takeBase * lvl.price;
      filledBase += takeBase;
      remainingBase -= takeBase;
    }
  }

  const tolerance = Math.max(1e-5, targetBaseQty * 0.0005);
  const isComplete = remainingBase <= tolerance;
  const avgPrice = filledBase > 0 ? totalCostUsd / filledBase : bestPrice;
  const slippageBps = isAsk
    ? ((avgPrice - bestPrice) / bestPrice) * 10000
    : ((bestPrice - avgPrice) / bestPrice) * 10000;

  out.isComplete = isComplete;
  out.avgPrice = avgPrice;
  out.bestPrice = bestPrice;
  out.slippageBps = slippageBps;
  out.levelsSwept = levelsSwept;
  out.totalCostUsd = totalCostUsd;
  out.filledBase = filledBase;
  out.totalAvailableUsd = totalAvailableUsd;
  out.totalAvailableBase = totalAvailableBase;
  return out;
}

export function simulateFillBase(
  levels: OrderBookLevel[] | FlatOrderBookSide,
  targetBaseQty: number,
  isAsk: boolean,
): SimFillResult {
  const out: SimFillResult = {
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
  return simulateFillBaseInto(out, levels, targetBaseQty, isAsk);
}

export interface FastSimResult {
  isComplete: boolean;
  totalCostUsd: number;
  levelsSwept: number;
  avgPrice: number;
}

/**
 * Ultra-fast zero-allocation simulation for optimizer:
 * populates pre-allocated result object directly and returns completion status.
 * Supports both OrderBookLevel[] and FlatOrderBookSide (typed Float64Array).
 */
export function fastSimFillInto(
  out: FastSimResult,
  levels: OrderBookLevel[] | FlatOrderBookSide,
  targetBaseQty: number,
): boolean {
  if (!levels || targetBaseQty <= 0) {
    out.isComplete = false;
    out.totalCostUsd = 0;
    out.levelsSwept = 0;
    out.avgPrice = 0;
    return false;
  }

  let remaining = targetBaseQty;
  let totalCost = 0;
  let swept = 0;

  if ("prices" in levels) {
    const count = levels.count;
    if (count === 0) {
      out.isComplete = false;
      out.totalCostUsd = 0;
      out.levelsSwept = 0;
      out.avgPrice = 0;
      return false;
    }

    const prices = levels.prices;
    const sizes = levels.sizes;
    const totalUsds = levels.totalUsds;

    for (let i = 0; i < count; i++) {
      swept++;
      const s = sizes[i]!;
      if (s >= remaining) {
        totalCost += remaining * prices[i]!;
        remaining = 0;
        break;
      } else {
        totalCost += totalUsds[i]!;
        remaining -= s;
      }
    }

    const isComplete = remaining <= Math.max(1e-5, targetBaseQty * 0.0005);
    const filled = targetBaseQty - remaining;
    const avgPrice = filled > 0 ? totalCost / filled : prices[0] || 0;

    out.isComplete = isComplete;
    out.totalCostUsd = totalCost;
    out.levelsSwept = swept;
    out.avgPrice = avgPrice;
    return isComplete;
  }

  const len = levels.length;
  if (len === 0) {
    out.isComplete = false;
    out.totalCostUsd = 0;
    out.levelsSwept = 0;
    out.avgPrice = 0;
    return false;
  }

  for (let i = 0; i < len; i++) {
    const lvl = levels[i]!;
    swept++;
    if (lvl.totalBase >= remaining) {
      totalCost += remaining * lvl.price;
      remaining = 0;
      break;
    } else {
      totalCost += lvl.totalUsd;
      remaining -= lvl.totalBase;
    }
  }

  const isComplete = remaining <= Math.max(1e-5, targetBaseQty * 0.0005);
  const filled = targetBaseQty - remaining;
  const avgPrice = filled > 0 ? totalCost / filled : levels[0]?.price || 0;

  out.isComplete = isComplete;
  out.totalCostUsd = totalCost;
  out.levelsSwept = swept;
  out.avgPrice = avgPrice;
  return isComplete;
}
