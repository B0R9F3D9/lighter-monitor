import { describe, expect, it } from "bun:test";
import { analyzePositionRisk, formatSmartPrice } from "../src/lighter/math";
import { LighterPosition } from "../src/types";

describe("analyzePositionRisk", () => {
  it("should correctly analyze a real XAU position near liquidation", () => {
    const pos: LighterPosition = {
      market_id: 40,
      symbol: "XAU",
      sign: 1,
      position: "3.1000",
      avg_entry_price: "4282.65",
      position_value: "13229.064000",
      unrealized_pnl: "-47.162912",
      realized_pnl: "0.000000",
      liquidation_price: "4168.387237903226",
      allocated_margin: "664.354485",
    };

    const analysis = analyzePositionRisk(pos);
    expect(analysis).not.toBeNull();
    expect(analysis?.marketId).toBe(40);
    expect(analysis?.symbol).toBe("XAU");
    expect(analysis?.isLong).toBe(true);
    expect(analysis?.size).toBe(3.1);

    // Mark price = 13229.064 / 3.1 = 4267.44
    expect(analysis?.markPrice).toBeCloseTo(4267.44, 1);

    // Distance percent = |4267.44 - 4168.387| / 4267.44 * 100 ≈ 2.32%
    expect(analysis?.distancePercent).not.toBeNull();
    expect(analysis!.distancePercent!).toBeCloseTo(2.32, 1);
    expect(analysis?.tier).toBe("WARN_10");
  });

  it("should return null for zero / closed positions", () => {
    const pos: LighterPosition = {
      market_id: 0,
      symbol: "ETH",
      sign: 1,
      position: "0.0000",
      avg_entry_price: "0.00",
      position_value: "-0.000000",
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "0",
      allocated_margin: "0.000000",
    };

    const analysis = analyzePositionRisk(pos);
    expect(analysis).toBeNull();
  });

  it("should return SAFE and null distance when liquidation_price is 0", () => {
    const pos: LighterPosition = {
      market_id: 1,
      symbol: "BTC",
      sign: 1,
      position: "0.5000",
      avg_entry_price: "60000.00",
      position_value: "30000.000000",
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "0",
      allocated_margin: "30000.000000",
    };

    const analysis = analyzePositionRisk(pos);
    expect(analysis).not.toBeNull();
    expect(analysis?.distancePercent).toBeNull();
    expect(analysis?.tier).toBe("SAFE");
  });

  it("should correctly classify CRITICAL_2, DANGER_5 and WARN_10 tiers for high leverage", () => {
    // 0.8% distance -> CRITICAL_2 (< 1.0%)
    const critPos: LighterPosition = {
      market_id: 2,
      symbol: "SOL",
      sign: 1,
      position: "10.0000",
      avg_entry_price: "150.00",
      position_value: "1500.000000", // mark = 150
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "148.80", // |150 - 148.80| / 150 = 0.8%
      allocated_margin: "200.000000",
    };
    expect(analyzePositionRisk(critPos)?.tier).toBe("CRITICAL_2");

    // 1.2% distance -> DANGER_5 (< 1.5%)
    const dangerPos: LighterPosition = {
      market_id: 2,
      symbol: "SOL",
      sign: 1,
      position: "10.0000",
      avg_entry_price: "150.00",
      position_value: "1500.000000",
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "148.20", // |150 - 148.20| / 150 = 1.2%
      allocated_margin: "200.000000",
    };
    expect(analyzePositionRisk(dangerPos)?.tier).toBe("DANGER_5");

    // 2.0% distance -> WARN_10 (< 2.5%)
    const warnPos: LighterPosition = {
      market_id: 2,
      symbol: "SOL",
      sign: 1,
      position: "10.0000",
      avg_entry_price: "150.00",
      position_value: "1500.000000",
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "147.00", // |150 - 147| / 150 = 2.0%
      allocated_margin: "200.000000",
    };
    expect(analyzePositionRisk(warnPos)?.tier).toBe("WARN_10");

    // 4.0% distance -> SAFE (> 2.5%)
    const safePos: LighterPosition = {
      market_id: 2,
      symbol: "SOL",
      sign: 1,
      position: "10.0000",
      avg_entry_price: "150.00",
      position_value: "1500.000000",
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "144.00", // 4% distance
      allocated_margin: "200.000000",
    };
    expect(analyzePositionRisk(safePos)?.tier).toBe("SAFE");
  });
});

describe("formatSmartPrice", () => {
  it("formats large numbers with 2 decimals and commas", () => {
    expect(formatSmartPrice(4267.44)).toBe("4,267.44");
    expect(formatSmartPrice(100000)).toBe("100,000.00");
  });

  it("formats medium numbers with 4 decimals", () => {
    expect(formatSmartPrice(1.23456)).toBe("1.2346");
    expect(formatSmartPrice(15.5)).toBe("15.5000");
  });

  it("formats small numbers (< 1) with 6 decimals, and micro prices with 8 decimals", () => {
    expect(formatSmartPrice(0.001234)).toBe("0.001234");
    expect(formatSmartPrice(0.00001234)).toBe("0.00001234");
  });
});
