import { CONFIG } from "../config";
import { AlertTier, LighterPosition, PositionRiskAnalysis } from "../types";

export function analyzePositionRisk(pos: LighterPosition): PositionRiskAnalysis | null {
  const size = Math.abs(parseFloat(pos.position || "0"));
  const posValue = Math.abs(parseFloat(pos.position_value || "0"));
  const liqPrice = parseFloat(pos.liquidation_price || "0");
  const entryPrice = parseFloat(pos.avg_entry_price || "0");
  const unrealizedPnl = parseFloat(pos.unrealized_pnl || "0");

  // Если позиция нулевая или закрыта — активной сделки нет
  if (size === 0) return null;

  const markPrice = posValue > 0 && size > 0 ? posValue / size : 0;
  let distancePercent: number | null = null;
  let tier: AlertTier = "SAFE";

  if (liqPrice > 0 && markPrice > 0) {
    distancePercent = (Math.abs(markPrice - liqPrice) / markPrice) * 100;

    if (distancePercent <= CONFIG.TIERS.CRITICAL_2.maxDistance) {
      tier = "CRITICAL_2";
    } else if (distancePercent <= CONFIG.TIERS.DANGER_5.maxDistance) {
      tier = "DANGER_5";
    } else if (distancePercent <= CONFIG.TIERS.WARN_10.maxDistance) {
      tier = "WARN_10";
    }
  }

  return {
    marketId: pos.market_id,
    symbol: pos.symbol,
    isLong: pos.sign === 1,
    size,
    posValue,
    entryPrice,
    markPrice,
    liqPrice,
    unrealizedPnl,
    distancePercent,
    tier,
  };
}

export function formatSmartPrice(price: number): string {
  if (price >= 100) {
    return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (price >= 1) {
    return price.toFixed(4);
  }
  return price.toFixed(6);
}
