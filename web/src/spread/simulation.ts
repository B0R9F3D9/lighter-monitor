import type { OrderBookLevel, SimFillResult } from "./types";

export function simulateFillBase(
  levels: OrderBookLevel[],
  targetBaseQty: number,
  isAsk: boolean,
): SimFillResult {
  if (!levels || levels.length === 0 || targetBaseQty <= 0) {
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
  const bestPrice = levels[0].price;
  let remainingBase = targetBaseQty;
  let totalCostUsd = 0;
  let filledBase = 0;
  let levelsSwept = 0;
  let totalAvailableUsd = 0;
  let totalAvailableBase = 0;

  const len = levels.length;
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

  return {
    isComplete,
    avgPrice,
    bestPrice,
    slippageBps,
    levelsSwept,
    totalCostUsd,
    filledBase,
    totalAvailableUsd,
    totalAvailableBase,
  };
}
