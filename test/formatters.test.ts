import { describe, expect, it } from "bun:test";
import { formatPositionsReport } from "../src/bot/formatters";
import { PositionRiskAnalysis } from "../src/types";

describe("formatPositionsReport", () => {
  it("should format empty positions correctly with network badge", () => {
    const text = formatPositionsReport('rh', 31704, "Основной", 100.5, []);
    expect(text).toContain("#31704 (Основной)");
    expect(text).toContain("[RH]");
    expect(text).toContain("$100.50");
    expect(text).toContain("Нет открытых позиций");
  });

  it("should format active positions with status badges and without mId", () => {
    const pos: PositionRiskAnalysis = {
      marketId: 40,
      symbol: "XAU",
      isLong: true,
      size: 3.1,
      posValue: 13229.064,
      entryPrice: 4282.65,
      markPrice: 4267.44,
      liqPrice: 4168.39,
      unrealizedPnl: -47.16,
      distancePercent: 0.8,
      tier: "CRITICAL_2"
    };

    const text = formatPositionsReport('mainnet', 749329, null, 51.32, [pos], 1.5);
    expect(text).toContain("#749329");
    expect(text).toContain("[Mainnet]");
    expect(text).toContain("🟢 LONG <b>XAU</b> • <b>3.1</b>");
    expect(text).not.toContain("mId");
    expect(text).toContain("Вход: $4,282.65 ➔ Марк: $4,267.44");
    expect(text).toContain("<b>0.80%</b> 🚨 [КРИТИЧНО]");
    expect(text).toContain("📉 -$47.16");
  });
});

