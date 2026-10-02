import { describe, expect, it } from "bun:test";
import { exportHedgeReportToCsv, matchHedgeTrades } from "../web/src/checker/hedge";
import type { ParsedTradeView } from "../web/src/checker/types";

function mockTrade(overrides: Partial<ParsedTradeView>): ParsedTradeView {
  return {
    raw: {} as any,
    tradeId: "1",
    timeFormatted: "2024-10-02 10:00:00",
    timestampMs: 1727863200000,
    marketSymbol: "AAPL",
    marketId: 1,
    marketKind: "perps",
    type: "trade",
    side: "BUY",
    role: "TAKER",
    price: 220.0,
    size: 10.0,
    usdValue: 2200.0,
    realizedPnl: 0,
    feeUsd: 0.5,
    txHash: "0x123",
    txHashShort: "0x123",
    ...overrides,
  };
}

describe("Hedge Matching Engine", () => {
  it("matches 1-to-1 exact opposite trades across RH and Core", () => {
    const rhTrade = mockTrade({
      tradeId: "rh-101",
      side: "BUY",
      price: 220.0,
      size: 10.0,
      feeUsd: 0.5,
      timestampMs: 1000000,
      marketSymbol: "AAPL",
    });

    const coreTrade = mockTrade({
      tradeId: "core-201",
      side: "SELL",
      price: 219.8,
      size: 10.0,
      feeUsd: 0.3,
      timestampMs: 1000500, // +0.5s later
      marketSymbol: "AAPL",
    });

    const result = matchHedgeTrades([rhTrade], [coreTrade], 31704, 749329);

    expect(result.pairs).toHaveLength(1);
    expect(result.unhedged).toHaveLength(0);

    const pair = result.pairs[0];
    expect(pair.marketSymbol).toBe("AAPL");
    expect(pair.matchedSize).toBe(10.0);
    expect(pair.rhSide).toBe("BUY");
    expect(pair.coreSide).toBe("SELL");
    expect(pair.buyPrice).toBe(220.0);
    expect(pair.sellPrice).toBe(219.8);
    expect(pair.priceDelta).toBeCloseTo(-0.2, 5); // 219.8 - 220.0 = -0.2
    expect(pair.priceLossUsd).toBeCloseTo(-2.0, 5); // -0.2 * 10 = -2.0
    expect(pair.totalFeesUsd).toBeCloseTo(0.8, 5); // 0.5 + 0.3
    expect(pair.netLossUsd).toBeCloseTo(-2.8, 5); // -2.0 - 0.8 = -2.8
    expect(pair.timeDeltaSec).toBeCloseTo(0.5, 2);
    expect(pair.status).toBe("HEDGED");

    // Metrics verification
    expect(result.metrics.totalPairs).toBe(1);
    expect(result.metrics.totalNetLossUsd).toBeCloseTo(-2.8, 5);
    expect(result.metrics.totalPriceLossUsd).toBeCloseTo(-2.0, 5);
    expect(result.metrics.totalFeesUsd).toBeCloseTo(0.8, 5);
    expect(result.metrics.totalUnhedgedTrades).toBe(0);
  });

  it("handles RH SELL matched against Core BUY correctly", () => {
    const rhTrade = mockTrade({
      tradeId: "rh-102",
      side: "SELL",
      price: 220.5,
      size: 5.0,
      feeUsd: 0,
      timestampMs: 1000000,
      marketSymbol: "AAPL",
    });

    const coreTrade = mockTrade({
      tradeId: "core-202",
      side: "BUY",
      price: 220.6,
      size: 5.0,
      feeUsd: 0,
      timestampMs: 1000200,
      marketSymbol: "AAPL",
    });

    const result = matchHedgeTrades([rhTrade], [coreTrade], 31704, 749329);

    expect(result.pairs).toHaveLength(1);
    const pair = result.pairs[0];
    expect(pair.buyPrice).toBe(220.6); // Core bought
    expect(pair.sellPrice).toBe(220.5); // RH sold
    expect(pair.priceLossUsd).toBeCloseTo(-0.5, 5); // (220.5 - 220.6) * 5 = -0.5
    expect(pair.netLossUsd).toBeCloseTo(-0.5, 5);
  });

  it("handles partial fills (one RH trade matched with multiple Core trades)", () => {
    const rhTrade = mockTrade({
      tradeId: "rh-103",
      side: "BUY",
      price: 200.0,
      size: 10.0,
      feeUsd: 1.0,
      timestampMs: 1000000,
      marketSymbol: "ETH",
    });

    const core1 = mockTrade({
      tradeId: "core-301",
      side: "SELL",
      price: 199.9,
      size: 6.0,
      feeUsd: 0.6,
      timestampMs: 1000100,
      marketSymbol: "ETH",
    });

    const core2 = mockTrade({
      tradeId: "core-302",
      side: "SELL",
      price: 199.8,
      size: 4.0,
      feeUsd: 0.4,
      timestampMs: 1000200,
      marketSymbol: "ETH",
    });

    const result = matchHedgeTrades([rhTrade], [core1, core2], 31704, 749329);

    expect(result.pairs).toHaveLength(2);
    expect(result.unhedged).toHaveLength(0);

    // First partial fill
    expect(result.pairs[1].matchedSize).toBe(6.0); // Earlier timestamp
    expect(result.pairs[1].status).toBe("PARTIAL");

    // Second partial fill
    expect(result.pairs[0].matchedSize).toBe(4.0);
    expect(result.pairs[0].status).toBe("PARTIAL");

    // Total hedged volume
    const totalMatchedSize = result.pairs.reduce((acc, p) => acc + p.matchedSize, 0);
    expect(totalMatchedSize).toBe(10.0);
  });

  it("detects unhedged trades when sides or markets do not match", () => {
    // Both BUY (not opposite!)
    const rhTrade = mockTrade({
      tradeId: "rh-104",
      side: "BUY",
      size: 10.0,
      marketSymbol: "AAPL",
    });

    const coreTrade = mockTrade({
      tradeId: "core-401",
      side: "BUY",
      size: 10.0,
      marketSymbol: "AAPL",
    });

    const result = matchHedgeTrades([rhTrade], [coreTrade], 31704, 749329);

    expect(result.pairs).toHaveLength(0);
    expect(result.unhedged).toHaveLength(2);
    expect(result.metrics.unhedgedRhCount).toBe(1);
    expect(result.metrics.unhedgedCoreCount).toBe(1);
  });

  it("generates valid CSV export string", () => {
    const rhTrade = mockTrade({ tradeId: "rh-1", side: "BUY", price: 100, size: 2 });
    const coreTrade = mockTrade({ tradeId: "core-1", side: "SELL", price: 99.9, size: 2 });

    const result = matchHedgeTrades([rhTrade], [coreTrade], 1, 2);
    const csv = exportHedgeReportToCsv(result.pairs, result.unhedged);

    expect(csv).toContain("Pair ID");
    expect(csv).toContain("AAPL");
    expect(csv).toContain("BUY");
    expect(csv).toContain("SELL");
    expect(csv).toContain("HEDGED");
  });
});
