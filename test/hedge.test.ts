import { describe, expect, it } from "bun:test";
import { getStaticMarketMap, parseFeeUsd } from "../web/src/checker/api";
import { formatDisplayFileName } from "../web/src/checker/dom";
import {
  aggregateTradesByOrder,
  calculateSelectedHedgeMetrics,
  computeRangeSelection,
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

const makeMockHedgePair = (
  id: string,
  notionalUsd: number,
  pricePnlUsd: number,
  totalFeesUsd: number,
) => ({
  id,
  marketSymbol: "AAPL",
  matchedSize: 50,
  rhTradeId: `rh-${id}`,
  rhSide: "BUY" as const,
  rhPrice: 200,
  rhSize: 50,
  rhFeeUsd: totalFeesUsd / 2,
  rhTimestampMs: 1000,
  rhTimeFormatted: "10:00:00",
  rhTxHash: "0x1",
  rhRole: "TAKER" as const,
  coreTradeId: `core-${id}`,
  coreSide: "SELL" as const,
  corePrice: 200,
  coreSize: 50,
  coreFeeUsd: totalFeesUsd / 2,
  coreTimestampMs: 1000,
  coreTimeFormatted: "10:00:00",
  coreTxHash: "0x2",
  coreRole: "MAKER" as const,
  buyPrice: 200,
  sellPrice: 200,
  priceDelta: pricePnlUsd / 50,
  pricePnlUsd,
  totalFeesUsd,
  netPnlUsd: pricePnlUsd - totalFeesUsd,
  notionalUsd,
  pnlBps: ((pricePnlUsd - totalFeesUsd) / notionalUsd) * 10000,
  timeDeltaSec: 0,
  status: "HEDGED" as const,
});

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

  it("calculates accurate summary metrics for user-selected hedge rows", () => {
    // Simulate opening campaign: 3 hedge pairs
    // Pair 1: notional = 10,000, pricePnl = -2.0, fees = 4.0, netPnl = -6.0
    // Pair 2: notional = 10,000, pricePnl = +1.0, fees = 4.0, netPnl = -3.0
    // Pair 3: notional = 10,000, pricePnl = -1.5, fees = 4.0, netPnl = -5.5
    // Simulate closing campaign: 3 hedge pairs
    // Pair 4: notional = 10,000, pricePnl = -0.5, fees = 4.0, netPnl = -4.5
    // Pair 5: notional = 10,000, pricePnl = 0.0, fees = 4.0, netPnl = -4.0
    // Pair 6: notional = 10,000, pricePnl = -2.0, fees = 4.0, netPnl = -6.0

    const pairs = [
      makeMockHedgePair("p1", 10000, -2.0, 4.0),
      makeMockHedgePair("p2", 10000, 1.0, 4.0),
      makeMockHedgePair("p3", 10000, -1.5, 4.0),
      makeMockHedgePair("p4", 10000, -0.5, 4.0),
      makeMockHedgePair("p5", 10000, 0.0, 4.0),
      makeMockHedgePair("p6", 10000, -2.0, 4.0),
    ];

    // Case 1: Empty selection
    const emptyMetrics = calculateSelectedHedgeMetrics([], []);
    expect(emptyMetrics.selectedCount).toBe(0);
    expect(emptyMetrics.totalVolumeUsd).toBe(0);
    expect(emptyMetrics.totalNetPnlUsd).toBe(0);
    expect(emptyMetrics.avgPnlBps).toBe(0);
    expect(emptyMetrics.totalMatchedSize).toBe(0);
    expect(emptyMetrics.weightedPriceDelta).toBe(0);
    expect(emptyMetrics.weightedPriceDeltaBps).toBe(0);
    expect(emptyMetrics.isSingleMarket).toBe(false);

    // Case 2: User selects all 6 hedges from open + close campaign
    const selectedAll = calculateSelectedHedgeMetrics(pairs, []);
    expect(selectedAll.selectedCount).toBe(6);
    expect(selectedAll.pairsCount).toBe(6);
    expect(selectedAll.unhedgedCount).toBe(0);
    expect(selectedAll.totalVolumeUsd).toBe(60000);
    // pricePnl = -2 + 1 - 1.5 - 0.5 + 0 - 2 = -5.0
    expect(selectedAll.totalPricePnlUsd).toBeCloseTo(-5.0, 4);
    // fees = 6 * 4.0 = 24.0
    expect(selectedAll.totalFeesUsd).toBeCloseTo(24.0, 4);
    // netPnl = -5.0 - 24.0 = -29.0
    expect(selectedAll.totalNetPnlUsd).toBeCloseTo(-29.0, 4);
    // bps = (-29.0 / 60000) * 10000 = -4.8333 bps
    expect(selectedAll.avgPnlBps).toBeCloseTo(-4.8333, 4);
    expect(selectedAll.totalMatchedSize).toBe(300);
    expect(selectedAll.weightedPriceDelta).toBeCloseTo(-5.0 / 300, 5);
    expect(selectedAll.weightedPriceDeltaBps).toBeCloseTo((-5.0 / 60000) * 10000, 4);
    expect(selectedAll.isSingleMarket).toBe(true);
    expect(selectedAll.marketSymbol).toBe("AAPL");

    // Case 3: User selects opening 3 trades only
    const selectedOpen = calculateSelectedHedgeMetrics(pairs.slice(0, 3), []);
    expect(selectedOpen.selectedCount).toBe(3);
    expect(selectedOpen.totalVolumeUsd).toBe(30000);
    // pricePnl = -2.5, fees = 12.0, netPnl = -14.5
    expect(selectedOpen.totalNetPnlUsd).toBeCloseTo(-14.5, 4);
    expect(selectedOpen.totalMatchedSize).toBe(150);
    expect(selectedOpen.weightedPriceDelta).toBeCloseTo(-2.5 / 150, 5);
    expect(selectedOpen.weightedPriceDeltaBps).toBeCloseTo((-2.5 / 30000) * 10000, 4);
    expect(selectedOpen.isSingleMarket).toBe(true);
    expect(selectedOpen.marketSymbol).toBe("AAPL");

    // Case 4: Selection with unhedged trade
    const unhedgedItem = {
      id: "unhedged-RH-99",
      tradeId: "99",
      network: "RH" as const,
      marketSymbol: "AAPL",
      side: "BUY" as const,
      role: "TAKER" as const,
      unhedgedSize: 10,
      originalSize: 10,
      price: 200,
      usdValue: 2000,
      feeUsd: 1.5,
      timestampMs: 1000,
      timeFormatted: "10:00:00",
      txHash: "0x3",
    };

    const mixed = calculateSelectedHedgeMetrics([pairs[0]], [unhedgedItem]);
    expect(mixed.selectedCount).toBe(2);
    expect(mixed.pairsCount).toBe(1);
    expect(mixed.unhedgedCount).toBe(1);
    // volume = 10,000 + 2,000 = 12,000
    expect(mixed.totalVolumeUsd).toBe(12000);
    // fees = 4.0 (pair) + 1.5 (unhedged) = 5.5
    expect(mixed.totalFeesUsd).toBeCloseTo(5.5, 4);
    // netPnl = -6.0 (pair net) - 1.5 (unhedged fee) = -7.5
    expect(mixed.totalNetPnlUsd).toBeCloseTo(-7.5, 4);
    expect(mixed.totalMatchedSize).toBe(50);
    expect(mixed.weightedPriceDelta).toBeCloseTo(-2.0 / 50, 5);
  });

  it("calculates accurate weighted price delta for entry and exit hedge campaigns", () => {
    // Campaign: ETH positions
    // User enters position via 3 hedge executions (Long RH, Short Core):
    // Fill 1: size = 2.0 ETH, RH Buy = 2000, Core Sell = 2005 => delta = +5.00, pricePnl = +10.00
    // Fill 2: size = 3.0 ETH, RH Buy = 2000, Core Sell = 2002 => delta = +2.00, pricePnl = +6.00
    // Fill 3: size = 5.0 ETH, RH Buy = 2000, Core Sell = 2001 => delta = +1.00, pricePnl = +5.00
    const entryHedges = [
      {
        id: "entry-1",
        marketSymbol: "ETH",
        matchedSize: 2.0,
        rhTradeId: "rh-e1",
        rhSide: "BUY" as const,
        rhPrice: 2000,
        rhSize: 2.0,
        rhFeeUsd: 1.0,
        rhTimestampMs: 1000,
        rhTimeFormatted: "10:00:00",
        rhTxHash: "0x1",
        rhRole: "TAKER" as const,
        coreTradeId: "core-e1",
        coreSide: "SELL" as const,
        corePrice: 2005,
        coreSize: 2.0,
        coreFeeUsd: 1.0,
        coreTimestampMs: 1000,
        coreTimeFormatted: "10:00:00",
        coreTxHash: "0x2",
        coreRole: "MAKER" as const,
        buyPrice: 2000,
        sellPrice: 2005,
        priceDelta: 5.0,
        pricePnlUsd: 10.0,
        totalFeesUsd: 2.0,
        netPnlUsd: 8.0,
        notionalUsd: 2.0 * 2002.5,
        pnlBps: (8.0 / (2.0 * 2002.5)) * 10000,
        timeDeltaSec: 0,
        status: "HEDGED" as const,
      },
      {
        id: "entry-2",
        marketSymbol: "ETH",
        matchedSize: 3.0,
        rhTradeId: "rh-e2",
        rhSide: "BUY" as const,
        rhPrice: 2000,
        rhSize: 3.0,
        rhFeeUsd: 1.5,
        rhTimestampMs: 1001,
        rhTimeFormatted: "10:00:01",
        rhTxHash: "0x3",
        rhRole: "TAKER" as const,
        coreTradeId: "core-e2",
        coreSide: "SELL" as const,
        corePrice: 2002,
        coreSize: 3.0,
        coreFeeUsd: 1.5,
        coreTimestampMs: 1001,
        coreTimeFormatted: "10:00:01",
        coreTxHash: "0x4",
        coreRole: "MAKER" as const,
        buyPrice: 2000,
        sellPrice: 2002,
        priceDelta: 2.0,
        pricePnlUsd: 6.0,
        totalFeesUsd: 3.0,
        netPnlUsd: 3.0,
        notionalUsd: 3.0 * 2001,
        pnlBps: (3.0 / (3.0 * 2001)) * 10000,
        timeDeltaSec: 0,
        status: "HEDGED" as const,
      },
      {
        id: "entry-3",
        marketSymbol: "ETH",
        matchedSize: 5.0,
        rhTradeId: "rh-e3",
        rhSide: "BUY" as const,
        rhPrice: 2000,
        rhSize: 5.0,
        rhFeeUsd: 2.5,
        rhTimestampMs: 1002,
        rhTimeFormatted: "10:00:02",
        rhTxHash: "0x5",
        rhRole: "TAKER" as const,
        coreTradeId: "core-e3",
        coreSide: "SELL" as const,
        corePrice: 2001,
        coreSize: 5.0,
        coreFeeUsd: 2.5,
        coreTimestampMs: 1002,
        coreTimeFormatted: "10:00:02",
        coreTxHash: "0x6",
        coreRole: "MAKER" as const,
        buyPrice: 2000,
        sellPrice: 2001,
        priceDelta: 1.0,
        pricePnlUsd: 5.0,
        totalFeesUsd: 5.0,
        netPnlUsd: 0.0,
        notionalUsd: 5.0 * 2000.5,
        pnlBps: 0,
        timeDeltaSec: 0,
        status: "HEDGED" as const,
      },
    ];

    const entryMetrics = calculateSelectedHedgeMetrics(entryHedges, []);
    expect(entryMetrics.pairsCount).toBe(3);
    expect(entryMetrics.totalMatchedSize).toBe(10.0);
    // Weighted delta = (2*5 + 3*2 + 5*1) / 10 = (10 + 6 + 5) / 10 = 21 / 10 = +2.10
    expect(entryMetrics.weightedPriceDelta).toBeCloseTo(2.1, 5);
    expect(entryMetrics.weightedBuyPrice).toBeCloseTo(2000.0, 5);
    // Weighted sell price = (2*2005 + 3*2002 + 5*2001) / 10 = (4010 + 6006 + 10005) / 10 = 2002.1
    expect(entryMetrics.weightedSellPrice).toBeCloseTo(2002.1, 5);
    // Difference between sell and buy equals weightedPriceDelta
    expect(entryMetrics.weightedSellPrice - entryMetrics.weightedBuyPrice).toBeCloseTo(2.1, 5);
    expect(entryMetrics.isSingleMarket).toBe(true);
    expect(entryMetrics.marketSymbol).toBe("ETH");

    // User exits position via 2 hedge executions (Short RH, Long Core):
    // Fill 4: size = 4.0 ETH, RH Sell = 2008, Core Buy = 2010 => delta = -2.00, pricePnl = -8.00
    // Fill 5: size = 6.0 ETH, RH Sell = 2009, Core Buy = 2010 => delta = -1.00, pricePnl = -6.00
    const exitHedges = [
      {
        id: "exit-1",
        marketSymbol: "ETH",
        matchedSize: 4.0,
        rhTradeId: "rh-x1",
        rhSide: "SELL" as const,
        rhPrice: 2008,
        rhSize: 4.0,
        rhFeeUsd: 2.0,
        rhTimestampMs: 2000,
        rhTimeFormatted: "10:10:00",
        rhTxHash: "0x7",
        rhRole: "TAKER" as const,
        coreTradeId: "core-x1",
        coreSide: "BUY" as const,
        corePrice: 2010,
        coreSize: 4.0,
        coreFeeUsd: 2.0,
        coreTimestampMs: 2000,
        coreTimeFormatted: "10:10:00",
        coreTxHash: "0x8",
        coreRole: "MAKER" as const,
        buyPrice: 2010,
        sellPrice: 2008,
        priceDelta: -2.0,
        pricePnlUsd: -8.0,
        totalFeesUsd: 4.0,
        netPnlUsd: -12.0,
        notionalUsd: 4.0 * 2009,
        pnlBps: (-12.0 / (4.0 * 2009)) * 10000,
        timeDeltaSec: 0,
        status: "HEDGED" as const,
      },
      {
        id: "exit-2",
        marketSymbol: "ETH",
        matchedSize: 6.0,
        rhTradeId: "rh-x2",
        rhSide: "SELL" as const,
        rhPrice: 2009,
        rhSize: 6.0,
        rhFeeUsd: 3.0,
        rhTimestampMs: 2001,
        rhTimeFormatted: "10:10:01",
        rhTxHash: "0x9",
        rhRole: "TAKER" as const,
        coreTradeId: "core-x2",
        coreSide: "BUY" as const,
        corePrice: 2010,
        coreSize: 6.0,
        coreFeeUsd: 3.0,
        coreTimestampMs: 2001,
        coreTimeFormatted: "10:10:01",
        coreTxHash: "0xa",
        coreRole: "MAKER" as const,
        buyPrice: 2010,
        sellPrice: 2009,
        priceDelta: -1.0,
        pricePnlUsd: -6.0,
        totalFeesUsd: 6.0,
        netPnlUsd: -12.0,
        notionalUsd: 6.0 * 2009.5,
        pnlBps: (-12.0 / (6.0 * 2009.5)) * 10000,
        timeDeltaSec: 0,
        status: "HEDGED" as const,
      },
    ];

    const exitMetrics = calculateSelectedHedgeMetrics(exitHedges, []);
    expect(exitMetrics.pairsCount).toBe(2);
    expect(exitMetrics.totalMatchedSize).toBe(10.0);
    // Weighted delta = (4*(-2) + 6*(-1)) / 10 = (-8 + -6) / 10 = -14 / 10 = -1.40
    expect(exitMetrics.weightedPriceDelta).toBeCloseTo(-1.4, 5);
    expect(exitMetrics.weightedBuyPrice).toBeCloseTo(2010.0, 5);
    // Weighted sell price = (4*2008 + 6*2009) / 10 = (8032 + 12054) / 10 = 2008.6
    expect(exitMetrics.weightedSellPrice).toBeCloseTo(2008.6, 5);
    expect(exitMetrics.weightedSellPrice - exitMetrics.weightedBuyPrice).toBeCloseTo(-1.4, 5);
    expect(exitMetrics.isSingleMarket).toBe(true);
    expect(exitMetrics.marketSymbol).toBe("ETH");
  });

  it("collapses raw API execution fills sharing the same order ID (ask_id / bid_id) even when transaction_time differs", () => {
    // Two fills from raw API with identical ask_id (user SELL order) but different microsecond transaction_time
    const fill1 = mockTrade({
      tradeId: "1255011511",
      side: "SELL",
      price: 236.3,
      size: 10.0,
      usdValue: 2363.0,
      feeUsd: 0.05,
      realizedPnl: 10.0,
      timestampMs: 1790958876823,
      marketId: 15,
      raw: {
        trade_id: 1255011511,
        ask_id: 4503599644828471,
        bid_id: 4785074583384364,
        ask_account_id: 31704,
        bid_account_id: 281474976710551,
        transaction_time: 1790958876888348, // microsecond seq 1
      } as any,
    });

    const fill2 = mockTrade({
      tradeId: "1255011512",
      side: "SELL",
      price: 236.3,
      size: 11.1919,
      usdValue: 2644.64597,
      feeUsd: 0.06,
      realizedPnl: 14.28286,
      timestampMs: 1790958876823,
      marketId: 15,
      raw: {
        trade_id: 1255011512,
        ask_id: 4503599644828471, // identical ask_id!
        bid_id: 4785074583384365,
        ask_account_id: 31704,
        bid_account_id: 281474976710552,
        transaction_time: 1790958876888350, // microsecond seq 2
      } as any,
    });

    const aggregated = aggregateTradesByOrder([fill1, fill2]);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].fillsCount).toBe(2);
    expect(aggregated[0].size).toBeCloseTo(21.1919, 4);
    expect(aggregated[0].usdValue).toBeCloseTo(5007.64597, 4);
    expect(aggregated[0].realizedPnl).toBeCloseTo(24.28286, 4);
    expect(aggregated[0].tradeId).toBe("1255011511..1255011512");
  });

  it("truncates long filenames cleanly while preserving extension and leaving short names untouched", () => {
    expect(formatDisplayFileName("short.json", 22)).toBe("short.json");
    expect(
      formatDisplayFileName("rh-trades-history-account-31704-2026-10-02T18-29-31.json", 22),
    ).toBe("rh-trade...-29-31.json");
    expect(formatDisplayFileName("", 22)).toBe("");
  });

  describe("Shift-Key Range Selection (computeRangeSelection)", () => {
    const visibleIds = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"];

    it("selects a contiguous range forward when anchor and target are clicked with Shift", () => {
      // User clicks p2 without shift (snapshot = {p2})
      const snapshot = new Set(["p2"]);
      const res = computeRangeSelection(visibleIds, "p2", "p6", snapshot, true);

      expect(res.newAnchorId).toBe("p2");
      expect([...res.newSelectedIds].toSorted()).toEqual(["p2", "p3", "p4", "p5", "p6"]);
    });

    it("selects a contiguous range backward when target is above anchor", () => {
      // User clicks p7 without shift, then Shift-clicks p3
      const snapshot = new Set(["p7"]);
      const res = computeRangeSelection(visibleIds, "p7", "p3", snapshot, true);

      expect(res.newAnchorId).toBe("p7");
      expect([...res.newSelectedIds].toSorted()).toEqual(["p3", "p4", "p5", "p6", "p7"]);
    });

    it("smoothly expands and contracts range when user keeps Shift held down", () => {
      // 1. Initial click on p3
      const snapshot = new Set(["p3"]);

      // 2. Shift-click p7 (range p3..p7)
      const res1 = computeRangeSelection(visibleIds, "p3", "p7", snapshot, true);
      expect([...res1.newSelectedIds].toSorted()).toEqual(["p3", "p4", "p5", "p6", "p7"]);

      // 3. User contracts range to p5 while holding Shift (using same base snapshot)
      const res2 = computeRangeSelection(visibleIds, "p3", "p5", snapshot, true);
      expect([...res2.newSelectedIds].toSorted()).toEqual(["p3", "p4", "p5"]);

      // 4. User expands range to p9 while holding Shift (using same base snapshot)
      const res3 = computeRangeSelection(visibleIds, "p3", "p9", snapshot, true);
      expect([...res3.newSelectedIds].toSorted()).toEqual([
        "p3",
        "p4",
        "p5",
        "p6",
        "p7",
        "p8",
        "p9",
      ]);
    });

    it("preserves non-contiguous selections outside the active Shift-range", () => {
      // p1 and p10 were previously selected
      const snapshot = new Set(["p1", "p10"]);

      // User selects p4..p6 with Shift
      const res = computeRangeSelection(visibleIds, "p4", "p6", snapshot, true);
      expect([...res.newSelectedIds].toSorted()).toEqual(["p1", "p10", "p4", "p5", "p6"]);
    });

    it("unselects a range when anchor was an uncheck action", () => {
      // All items p1..p10 are selected
      const snapshot = new Set(visibleIds);

      // User clicks p3 to uncheck (shouldSelect = false), then Shift-clicks p6
      const res = computeRangeSelection(visibleIds, "p3", "p6", snapshot, false);
      expect(res.newAnchorId).toBe("p3");
      // p3, p4, p5, p6 are deleted
      expect([...res.newSelectedIds].toSorted()).toEqual(["p1", "p10", "p2", "p7", "p8", "p9"]);
    });

    it("establishes target as new anchor when no prior anchor exists", () => {
      const snapshot = new Set<string>();
      const res = computeRangeSelection(visibleIds, null, "p4", snapshot, true);
      expect(res.newAnchorId).toBe("p4");
      expect(Array.from(res.newSelectedIds)).toEqual(["p4"]);
    });

    it("re-anchors to target if previous anchor is no longer visible (e.g. filtered out)", () => {
      const snapshot = new Set(["p1"]);
      // Anchor "hidden_row" is not in visibleIds
      const res = computeRangeSelection(visibleIds, "hidden_row", "p5", snapshot, true);
      expect(res.newAnchorId).toBe("p5");
      expect(res.newSelectedIds.has("p5")).toBe(true);
      expect(res.newSelectedIds.has("p1")).toBe(true);
    });

    it("returns unmodified snapshot if target is not in visibleIds", () => {
      const snapshot = new Set(["p1", "p2"]);
      const res = computeRangeSelection(visibleIds, "p1", "unknown_row", snapshot, true);
      expect(Array.from(res.newSelectedIds)).toEqual(["p1", "p2"]);
    });
  });
});
