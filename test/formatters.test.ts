import { describe, expect, it } from "bun:test";
import { formatPositionsReport, formatLiquidationAlert, formatPositionWipedAlert } from "../src/bot/formatters";
import { PositionRiskAnalysis } from "../src/types";

describe("formatPositionsReport", () => {
  it("should format empty positions correctly", () => {
    const text = formatPositionsReport(31704, "Основной", "0x0000000000000000000000000000000000000001", 100.5, []);
    expect(text).toContain("#31704 (Основной)");
    expect(text).toContain("0x0000...0001");
    expect(text).toContain("$100.50");
    expect(text).toContain("Нет открытых позиций");
  });

  it("should format active positions with status badges", () => {
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

    const text = formatPositionsReport(31704, null, "0x0000000000000000000000000000000000000001", 51.32, [pos], 1.5);
    expect(text).toContain("#31704");
    expect(text).toContain("<b>XAU</b> [LONG]");
    expect(text).toContain("Размер: 3.1");
    expect(text).toContain("<b>0.80%</b> [КРИТИЧНО]");
  });
});

describe("formatLiquidationAlert", () => {
  it("should format liquidation alert with account name and details", () => {
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
      distancePercent: 2.32,
      tier: "CRITICAL_2"
    };

    const alert = formatLiquidationAlert(31704, "Мейн", pos);
    expect(alert).toContain("КРИТИЧЕСКИЙ РИСК ЛИКВИДАЦИИ");
    expect(alert).toContain("#31704 (Мейн)");
    expect(alert).toContain("2.32%");
    expect(alert).toContain("4,267.44");
    expect(alert).toContain("4,168.39");
  });
});

describe("formatPositionWipedAlert", () => {
  it("should format wiped alert for closed/liquidated position", () => {
    const alert = formatPositionWipedAlert(31704, "Мейн", "XAU");
    expect(alert).toContain("ПОЗИЦИЯ ЗАКРЫТА ИЛИ ЛИКВИДИРОВАНА");
    expect(alert).toContain("#31704 (Мейн)");
    expect(alert).toContain("XAU");
  });
});
