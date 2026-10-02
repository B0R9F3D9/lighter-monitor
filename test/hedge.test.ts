import { describe, expect, it } from "bun:test";
import { getStaticMarketMap, parseFeeUsd } from "../web/src/checker/api";
import {
  aggregateTradesByOrder,
  exportHedgeReportToCsv,
  matchHedgeTrades,
} from "../web/src/checker/hedge";
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
  it("matches 1-to-1 exact opposite trades across RH and Core with PnL terminology", () => {
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
    expect(pair.pricePnlUsd).toBeCloseTo(-2.0, 5); // -0.2 * 10 = -2.0
    expect(pair.totalFeesUsd).toBeCloseTo(0.8, 5); // 0.5 + 0.3
    expect(pair.netPnlUsd).toBeCloseTo(-2.8, 5); // -2.0 - 0.8 = -2.8
    expect(pair.timeDeltaSec).toBeCloseTo(0.5, 2);
    expect(pair.status).toBe("HEDGED");

    // Metrics verification
    expect(result.metrics.totalPairs).toBe(1);
    expect(result.metrics.totalNetPnlUsd).toBeCloseTo(-2.8, 5);
    expect(result.metrics.totalPricePnlUsd).toBeCloseTo(-2.0, 5);
    expect(result.metrics.totalFeesUsd).toBeCloseTo(0.8, 5);
    expect(result.metrics.totalUnhedgedTrades).toBe(0);
  });

  it("handles RH SELL matched against Core BUY correctly with positive PnL", () => {
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
      price: 220.0, // Core bought lower than RH sold => profit!
      size: 5.0,
      feeUsd: 0,
      timestampMs: 1000200,
      marketSymbol: "AAPL",
    });

    const result = matchHedgeTrades([rhTrade], [coreTrade], 31704, 749329);

    expect(result.pairs).toHaveLength(1);
    const pair = result.pairs[0];
    expect(pair.buyPrice).toBe(220.0); // Core bought
    expect(pair.sellPrice).toBe(220.5); // RH sold
    expect(pair.priceDelta).toBeCloseTo(0.5, 5);
    expect(pair.pricePnlUsd).toBeCloseTo(2.5, 5); // (220.5 - 220.0) * 5 = +2.5
    expect(pair.netPnlUsd).toBeCloseTo(2.5, 5);
    expect(pair.pnlBps).toBeGreaterThan(0); // positive bps for profit
  });

  it("handles sub-millisecond tie-breaker sorting via transaction_time and trade_id", () => {
    // Both trades have the exact same millisecond timestamp 1700000000000
    // but trade 2 occurred later in microseconds than trade 1
    const rhTrade = mockTrade({
      tradeId: "rh-1",
      side: "BUY",
      size: 10,
      timestampMs: 1700000000000,
      raw: { transaction_time: 1700000000000100, trade_id: 100 } as any,
    });

    // Core trades delivered in reverse descending order (common from Lighter API)
    const coreTradeLate = mockTrade({
      tradeId: "core-2",
      side: "SELL",
      size: 5,
      price: 200,
      timestampMs: 1700000000000,
      raw: { transaction_time: 1700000000000500, trade_id: 2 } as any,
    });

    const coreTradeEarly = mockTrade({
      tradeId: "core-1",
      side: "SELL",
      size: 5,
      price: 199,
      timestampMs: 1700000000000,
      raw: { transaction_time: 1700000000000200, trade_id: 1 } as any,
    });

    // Input in reverse order: [coreTradeLate, coreTradeEarly]
    const result = matchHedgeTrades([rhTrade], [coreTradeLate, coreTradeEarly], 1, 2);

    expect(result.pairs).toHaveLength(2);
    // Since pairs are sorted descending at end, pair matched first (coreTradeEarly) should be present
    const matchedCoreIds = result.pairs.map((p) => p.coreTradeId);
    expect(matchedCoreIds).toContain("core-1");
    expect(matchedCoreIds).toContain("core-2");
  });

  it("performs sequential FIFO matching within window instead of greedy capture", () => {
    // RH1 at T=10.0, RH2 at T=10.21
    // Core2 at T=9.5, Core1 at T=10.2
    const rh1 = mockTrade({
      tradeId: "rh-1",
      side: "BUY",
      size: 5,
      timestampMs: 10000,
    });
    const rh2 = mockTrade({
      tradeId: "rh-2",
      side: "BUY",
      size: 5,
      timestampMs: 10210,
    });

    const coreEarlier = mockTrade({
      tradeId: "core-earlier",
      side: "SELL",
      size: 5,
      timestampMs: 9500,
    });
    const coreLater = mockTrade({
      tradeId: "core-later",
      side: "SELL",
      size: 5,
      timestampMs: 10200,
    });

    // In sequential FIFO matching, rh1 should match coreEarlier (oldest available in window),
    // leaving coreLater for rh2!
    const result = matchHedgeTrades([rh1, rh2], [coreEarlier, coreLater], 1, 2);

    expect(result.pairs).toHaveLength(2);
    const pairForRh1 = result.pairs.find((p) => p.rhTradeId === "rh-1");
    const pairForRh2 = result.pairs.find((p) => p.rhTradeId === "rh-2");

    expect(pairForRh1?.coreTradeId).toBe("core-earlier");
    expect(pairForRh2?.coreTradeId).toBe("core-later");
  });

  it("includes unhedged trade fees in totalFeesUsd", () => {
    const rhTrade = mockTrade({
      tradeId: "rh-unhedged",
      side: "BUY",
      size: 10.0,
      feeUsd: 1.25,
      marketSymbol: "AAPL",
    });

    const result = matchHedgeTrades([rhTrade], [], 31704, null);

    expect(result.pairs).toHaveLength(0);
    expect(result.unhedged).toHaveLength(1);
    expect(result.unhedged[0].feeUsd).toBeCloseTo(1.25, 4);
    // Crucial fix: totalFeesUsd must reflect unhedged fees!
    expect(result.metrics.totalFeesUsd).toBeCloseTo(1.25, 4);
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

    const totalMatchedSize = result.pairs.reduce((acc, p) => acc + p.matchedSize, 0);
    expect(totalMatchedSize).toBeCloseTo(10.0, 5);
  });

  it("aligns unhedged columns correctly in CSV export (RH Price vs Core Price)", () => {
    const unhedgedRh = mockTrade({
      tradeId: "rh-only",
      side: "BUY",
      price: 123.45,
      size: 2,
      feeUsd: 0.1,
      timestampMs: 1000000,
    });
    const unhedgedCore = mockTrade({
      tradeId: "core-only",
      side: "SELL",
      price: 456.78,
      size: 3,
      feeUsd: 0.2,
      timestampMs: 5000000, // Far apart so no match occurs
    });

    const result = matchHedgeTrades([unhedgedRh], [unhedgedCore], 1, 2, 60);
    const csv = exportHedgeReportToCsv(result.pairs, result.unhedged);
    const lines = csv.split("\n");

    const rhLine = lines.find((l) => l.includes("unhedged-RH-rh-only"));
    const coreLine = lines.find((l) => l.includes("unhedged-CORE-core-only"));

    expect(rhLine).toBeDefined();
    expect(coreLine).toBeDefined();

    // Col 8: RH Price, Col 9: Core Price
    const rhCols = rhLine!.split(",");
    expect(rhCols[7]).toBe("123.4500"); // RH Price
    expect(rhCols[8]).toBe("--"); // Core Price is --

    const coreCols = coreLine!.split(",");
    expect(coreCols[7]).toBe("--"); // RH Price is --
    expect(coreCols[8]).toBe("456.7800"); // Core Price
  });

  it("provides static fallback market maps for RH and Mainnet", () => {
    const rhMap = getStaticMarketMap("rh");
    expect(rhMap.get(0)).toBe("ETH");
    expect(rhMap.get(10)).toBe("AAPL");
    expect(rhMap.get(15)).toBe("NVDA");
    expect(rhMap.get(23)).toBe("COIN");
    expect(rhMap.get(40)).toBe("XAU");

    const coreMap = getStaticMarketMap("mainnet");
    expect(coreMap.get(0)).toBe("ETH");
    expect(coreMap.get(92)).toBe("XAU");
    expect(coreMap.get(109)).toBe("COIN");
    expect(coreMap.get(110)).toBe("NVDA");
    expect(coreMap.get(113)).toBe("AAPL");
  });

  it("parses fee values accurately with parseFeeUsd", () => {
    // 0 or null
    expect(parseFeeUsd(0)).toBe(0);
    expect(parseFeeUsd(null)).toBe(0);
    expect(parseFeeUsd(undefined)).toBe(0);

    // Float USD fee
    expect(parseFeeUsd(0.25)).toBe(0.25);

    // Atomic quote units (> 1000, 6 decimals USDC)
    expect(parseFeeUsd(500000)).toBeCloseTo(0.5, 6);
    expect(parseFeeUsd(1000000)).toBeCloseTo(1.0, 6);

    // Basis points (<= 1000, e.g. 5 bps on $1000 volume)
    expect(parseFeeUsd(5, 1000)).toBeCloseTo(0.5, 6);
  });

  it("aggregates concurrent orderbook fills with exact VWAP pricing", () => {
    // Simulate RH executing 25 AAPL across 2 liquidity levels at same timestamp
    const fill1 = mockTrade({
      tradeId: "rh-1",
      side: "SELL",
      price: 330.62,
      size: 23.4881,
      usdValue: 23.4881 * 330.62,
      feeUsd: 0.1,
      timestampMs: 1790885512311,
      marketSymbol: "AAPL",
      marketId: 10,
    });
    const fill2 = mockTrade({
      tradeId: "rh-2",
      side: "SELL",
      price: 330.63,
      size: 1.5119,
      usdValue: 1.5119 * 330.63,
      feeUsd: 0.02,
      timestampMs: 1790885512311,
      marketSymbol: "AAPL",
      marketId: 10,
    });

    const aggregated = aggregateTradesByOrder([fill1, fill2]);

    expect(aggregated).toHaveLength(1);
    const agg = aggregated[0];
    expect(agg.size).toBeCloseTo(25.0, 5);
    expect(agg.fillsCount).toBe(2);
    expect(agg.feeUsd).toBeCloseTo(0.12, 4);
    // VWAP price: (23.4881*330.62 + 1.5119*330.63) / 25 = 330.62060476
    const expectedVwap = (23.4881 * 330.62 + 1.5119 * 330.63) / 25.0;
    expect(agg.price).toBeCloseTo(expectedVwap, 5);
    expect(agg.tradeId).toBe("rh-1..rh-2");
  });

  it("resolves multi-fill orders to 100% HEDGED instead of false PARTIAL", () => {
    // RH: 2 fills totaling 25.0 AAPL SELL
    const rhFills = [
      mockTrade({
        tradeId: "rh-1",
        side: "SELL",
        price: 330.62,
        size: 23.4881,
        usdValue: 23.4881 * 330.62,
        timestampMs: 1790885512311,
        marketSymbol: "AAPL",
        marketId: 10,
      }),
      mockTrade({
        tradeId: "rh-2",
        side: "SELL",
        price: 330.63,
        size: 1.5119,
        usdValue: 1.5119 * 330.63,
        timestampMs: 1790885512311,
        marketSymbol: "AAPL",
        marketId: 10,
      }),
    ];

    // Core: 4 fills totaling 25.0 AAPL BUY
    const coreFills = [
      mockTrade({
        tradeId: "core-1",
        side: "BUY",
        price: 330.489,
        size: 0.577,
        usdValue: 0.577 * 330.489,
        timestampMs: 1790885511630,
        marketSymbol: "AAPL",
        marketId: 113,
      }),
      mockTrade({
        tradeId: "core-2",
        side: "BUY",
        price: 330.49,
        size: 4.179,
        usdValue: 4.179 * 330.49,
        timestampMs: 1790885511630,
        marketSymbol: "AAPL",
        marketId: 113,
      }),
      mockTrade({
        tradeId: "core-3",
        side: "BUY",
        price: 330.502,
        size: 18.15,
        usdValue: 18.15 * 330.502,
        timestampMs: 1790885511630,
        marketSymbol: "AAPL",
        marketId: 113,
      }),
      mockTrade({
        tradeId: "core-4",
        side: "BUY",
        price: 330.505,
        size: 2.094,
        usdValue: 2.094 * 330.505,
        timestampMs: 1790885511630,
        marketSymbol: "AAPL",
        marketId: 113,
      }),
    ];

    // When aggregateFills is true (default):
    const resultAgg = matchHedgeTrades(rhFills, coreFills, 31704, 749329, 600, true);
    expect(resultAgg.pairs).toHaveLength(1);
    expect(resultAgg.pairs[0].status).toBe("HEDGED"); // 100% HEDGED!
    expect(resultAgg.pairs[0].matchedSize).toBeCloseTo(25.0, 5);
    expect(resultAgg.pairs[0].rhFillsCount).toBe(2);
    expect(resultAgg.pairs[0].coreFillsCount).toBe(4);
    expect(resultAgg.unhedged).toHaveLength(0);

    // When aggregateFills is false (raw fills mode):
    const resultRaw = matchHedgeTrades(rhFills, coreFills, 31704, 749329, 600, false);
    // Raw mode fragments into multiple partial fills
    expect(resultRaw.pairs.length).toBeGreaterThan(1);
    expect(resultRaw.pairs.some((p) => p.status === "PARTIAL")).toBe(true);
  });
});
