import { describe, expect, it } from "bun:test";
import { getStaticMarketMap, parseFeeUsd, parseTradeForView } from "../web/src/checker/api";
import {
  formatCompactDuration,
  formatCompactK,
  formatCompactUsd,
  formatDisplayFileName,
  formatTimestampLocal,
  renderDailySummary,
  updateIndividualAccountMetrics,
} from "../web/src/checker/dom";
import {
  aggregateTradesByOrder,
  calculateAccountAverageOi,
  calculateAccountDailyStats,
  calculateHedgeMetrics,
  calculateSelectedHedgeMetrics,
  computeRangeSelection,
  exportHedgeReportToCsv,
  matchHedgeTrades,
} from "../web/src/checker/hedge";
import {
  createPresetDateFilter,
  findPresetById,
  isTradeInDateRange,
} from "../web/src/checker/date_filter";
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

function createMockIndividualElements() {
  return {
    accountBadge: { textContent: "", className: "" } as HTMLElement,
    tradesCount: { textContent: "" } as HTMLElement,
    volume: { textContent: "" } as HTMLElement,
    realizedPnl: { textContent: "", className: "" } as HTMLElement,
    fees: { textContent: "" } as HTMLElement,
    unhedgedCount: { textContent: "", className: "" } as HTMLElement,
    avgOi: { textContent: "", className: "", title: "" } as HTMLElement,
    dailySummary: { innerHTML: "" } as HTMLElement,
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

    // Lighter API fee rates: scaled by 1,000,000 (1e6)
    // 120 = 1.2 bps (0.012%) -> on $1,000 volume: $0.12 fee
    expect(parseFeeUsd(120, 1000)).toBeCloseTo(0.12, 6);
    // 500 = 5 bps (0.05%) -> on $1,000 volume: $0.50 fee
    expect(parseFeeUsd(500, 1000)).toBeCloseTo(0.5, 6);
    // 28 = 0.28 bps (0.0028%) -> on $10,000 volume: $0.28 fee
    expect(parseFeeUsd(28, 10000)).toBeCloseTo(0.28, 6);
    // 10000 = 100 bps (1%) -> on $1,000 volume: $10.00 fee
    expect(parseFeeUsd(10000, 1000)).toBeCloseTo(10.0, 6);

    // If usdValue is 0 or omitted, rate returns 0
    expect(parseFeeUsd(120, 0)).toBe(0);
    expect(parseFeeUsd(120)).toBe(0);
  });

  it("calculates exact fees and hedge metrics for real Premium Account trades (maker_fee=120)", () => {
    // NVDA BUY on RH: size 10, price 242.20, usd 2422.00, maker_fee 120 (1.2 bps)
    const rhTrade = parseTradeForView(
      {
        trade_id: 1358456054,
        market_id: 15,
        price: "242.20",
        size: "10.0000",
        usd_amount: "2422.00",
        bid_account_id: 31704,
        ask_account_id: 6468,
        is_maker_ask: false, // user bid is maker
        timestamp: 1791299950111,
        maker_fee: 120,
        taker_fee: 0,
      } as any,
      31704,
      new Map([[15, "NVDA"]]),
    );

    // Expected fee: (120 / 1e6) * 2422.00 = 0.29064 USD (~0.29 USD, NOT 29.06 USD!)
    expect(rhTrade.feeUsd).toBeCloseTo(0.29064, 5);

    // NVDA SELL on Core: size 10, price 241.95, usd 2419.50, maker_fee 0 (0 bps)
    const coreTrade = parseTradeForView(
      {
        trade_id: 33483838306,
        market_id: 110,
        price: "241.95",
        size: "10.0000",
        usd_amount: "2419.50",
        ask_account_id: 749329,
        bid_account_id: 12345,
        is_maker_ask: true, // user ask is maker
        timestamp: 1791299952000,
        maker_fee: 0,
        taker_fee: 0,
      } as any,
      749329,
      new Map([[110, "NVDA"]]),
    );

    expect(coreTrade.feeUsd).toBe(0);

    const match = matchHedgeTrades([rhTrade], [coreTrade], 31704, 749329, 600, true);
    expect(match.pairs).toHaveLength(1);
    const p = match.pairs[0];
    expect(p.rhFeeUsd).toBeCloseTo(0.29064, 5);
    expect(p.coreFeeUsd).toBe(0);
    expect(p.totalFeesUsd).toBeCloseTo(0.29064, 5);

    // Price PnL: sell (241.95) - buy (242.20) = -0.25 * 10 = -2.50 USD
    expect(p.pricePnlUsd).toBeCloseTo(-2.5, 4);

    // Net PnL: -2.50 - 0.29064 = -2.79064 USD (NOT -31.56 USD!)
    expect(p.netPnlUsd).toBeCloseTo(-2.79064, 4);

    // Hedge PnL (bps): notional = 10 * 242.075 = 2420.75 USD
    // pnlBps: (-2.79064 / 2420.75) * 10000 = -11.53 bps (NOT -130.36 bps!)
    expect(p.pnlBps).toBeCloseTo(-11.53, 1);
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

  describe("Date Filtering & Robinhood Promo Weeks Integration", () => {
    it("filters matched hedge pairs by Robinhood Campaign week preset and recomputes summary metrics", () => {
      // Week 1: 2026-08-10 00:00:00 UTC to 2026-08-20 00:00:00 UTC
      const week1Timestamp = Date.UTC(2026, 7, 15, 12, 0, 0); // Aug 15, 2026
      // Week 2: 2026-08-20 00:00:00 UTC to 2026-08-27 00:00:00 UTC
      const week2Timestamp = Date.UTC(2026, 7, 22, 14, 0, 0); // Aug 22, 2026
      // Week 8: 2026-10-01 00:00:00 UTC to 2026-10-08 00:00:00 UTC
      const week8Timestamp = Date.UTC(2026, 9, 3, 10, 0, 0); // Oct 3, 2026

      const rhTrade1 = mockTrade({
        tradeId: "rh-w1",
        side: "BUY",
        price: 200,
        size: 10,
        feeUsd: 1,
        timestampMs: week1Timestamp,
        marketSymbol: "ETH",
      });
      const coreTrade1 = mockTrade({
        tradeId: "core-w1",
        side: "SELL",
        price: 201,
        size: 10,
        feeUsd: 1,
        timestampMs: week1Timestamp + 500,
        marketSymbol: "ETH",
      });

      const rhTrade2 = mockTrade({
        tradeId: "rh-w2",
        side: "SELL",
        price: 300,
        size: 5,
        feeUsd: 1.5,
        timestampMs: week2Timestamp,
        marketSymbol: "BTC",
      });
      const coreTrade2 = mockTrade({
        tradeId: "core-w2",
        side: "BUY",
        price: 298,
        size: 5,
        feeUsd: 1.5,
        timestampMs: week2Timestamp + 300,
        marketSymbol: "BTC",
      });

      const rhTrade8 = mockTrade({
        tradeId: "rh-w8",
        side: "BUY",
        price: 150,
        size: 20,
        feeUsd: 2,
        timestampMs: week8Timestamp,
        marketSymbol: "SOL",
      });
      const coreTrade8 = mockTrade({
        tradeId: "core-w8",
        side: "SELL",
        price: 150.5,
        size: 20,
        feeUsd: 2,
        timestampMs: week8Timestamp + 1000,
        marketSymbol: "SOL",
      });

      // Match all 3 pairs globally
      const matched = matchHedgeTrades(
        [rhTrade1, rhTrade2, rhTrade8],
        [coreTrade1, coreTrade2, coreTrade8],
        31704,
        749329,
      );

      expect(matched.pairs).toHaveLength(3);
      expect(matched.unhedged).toHaveLength(0);

      // Total All-Time metrics
      const allMetrics = matched.metrics;
      expect(allMetrics.totalPairs).toBe(3);
      // Volume: 10*200.5 + 5*299 + 20*150.25 = 2005 + 1495 + 3005 = 6505
      expect(allMetrics.totalHedgedVolumeUsd).toBe(6505);

      // Now filter by Week 1 preset
      const week1Preset = findPresetById("week-1");
      expect(week1Preset).toBeDefined();
      const week1Filter = createPresetDateFilter(week1Preset!);

      const w1Pairs = matched.pairs.filter((p) => isTradeInDateRange(p.rhTimestampMs, week1Filter));
      const w1Unhedged = matched.unhedged.filter((u) =>
        isTradeInDateRange(u.timestampMs, week1Filter),
      );

      expect(w1Pairs).toHaveLength(1);
      expect(w1Pairs[0].rhTradeId).toBe("rh-w1");

      const w1Metrics = calculateHedgeMetrics(w1Pairs, w1Unhedged, 31704, 749329, 1, 1);
      expect(w1Metrics.totalPairs).toBe(1);
      expect(w1Metrics.totalHedgedVolumeUsd).toBe(2005);
      // Sell 201 - Buy 200 = +1 * 10 = +10 price PnL - 2 fees = +8 net PnL
      expect(w1Metrics.totalNetPnlUsd).toBe(8);

      // Now filter by Week 8 (the active week as of Oct 2026)
      const week8Preset = findPresetById("week-8");
      expect(week8Preset).toBeDefined();
      const week8Filter = createPresetDateFilter(week8Preset!);

      const w8Pairs = matched.pairs.filter((p) => isTradeInDateRange(p.rhTimestampMs, week8Filter));
      expect(w8Pairs).toHaveLength(1);
      expect(w8Pairs[0].rhTradeId).toBe("rh-w8");

      const w8Metrics = calculateHedgeMetrics(w8Pairs, [], 31704, 749329, 1, 1);
      expect(w8Metrics.totalPairs).toBe(1);
      expect(w8Metrics.totalHedgedVolumeUsd).toBe(3005);
    });

    it("respects exact Friday 00:00:00.000 UTC snapshot boundary across week transitions", () => {
      // Snapshot 1 boundary: Friday, Aug 21, 2026 00:00:00.000 UTC
      const boundaryMs = Date.UTC(2026, 7, 21, 0, 0, 0);
      const justBeforeBoundary = boundaryMs - 1; // 23:59:59.999 UTC Aug 20 -> Week 1
      const exactlyAtBoundary = boundaryMs; // 00:00:00.000 UTC Aug 21 -> Week 2

      const week1Filter = createPresetDateFilter(findPresetById("week-1")!);
      const week2Filter = createPresetDateFilter(findPresetById("week-2")!);

      expect(isTradeInDateRange(justBeforeBoundary, week1Filter)).toBe(true);
      expect(isTradeInDateRange(justBeforeBoundary, week2Filter)).toBe(false);

      expect(isTradeInDateRange(exactlyAtBoundary, week1Filter)).toBe(false);
      expect(isTradeInDateRange(exactlyAtBoundary, week2Filter)).toBe(true);
    });

    it("prevents cross-boundary trades from producing false unhedged records when matched globally", () => {
      // RH fills 2 seconds before snapshot; Core hedge executes 2 seconds after snapshot
      const rhTimestamp = Date.UTC(2026, 7, 21, 0, 0, 0) - 2000; // Aug 20, 23:59:58 UTC (Week 1)
      const coreTimestamp = Date.UTC(2026, 7, 21, 0, 0, 0) + 2000; // Aug 21, 00:00:02 UTC (Week 2)

      const rhTrade = mockTrade({
        tradeId: "rh-cross",
        side: "BUY",
        price: 100,
        size: 1,
        timestampMs: rhTimestamp,
      });
      const coreTrade = mockTrade({
        tradeId: "core-cross",
        side: "SELL",
        price: 100,
        size: 1,
        timestampMs: coreTimestamp,
      });

      // Global match successfully pairs them together
      const result = matchHedgeTrades([rhTrade], [coreTrade], 31704, 749329, 600);
      expect(result.pairs).toHaveLength(1);
      expect(result.unhedged).toHaveLength(0);

      // Filtering by Week 1 (RH leg timestamp) captures the matched pair
      const week1Filter = createPresetDateFilter(findPresetById("week-1")!);
      const w1Pairs = result.pairs.filter((p) => isTradeInDateRange(p.rhTimestampMs, week1Filter));
      expect(w1Pairs).toHaveLength(1);

      // Filtering by Week 2 shows 0 pairs for that week and NO false unhedged records
      const week2Filter = createPresetDateFilter(findPresetById("week-2")!);
      const w2Pairs = result.pairs.filter((p) => isTradeInDateRange(p.rhTimestampMs, week2Filter));
      expect(w2Pairs).toHaveLength(0);
      const w2Unhedged = result.unhedged.filter((u) =>
        isTradeInDateRange(u.timestampMs, week2Filter),
      );
      expect(w2Unhedged).toHaveLength(0);
    });
  });

  describe("Individual Account Metrics Cards (RH & CORE)", () => {
    it("resets elements to placeholders when metrics is null or 0 trades", () => {
      const els = createMockIndividualElements();
      updateIndividualAccountMetrics(null, els);

      expect(els.accountBadge.textContent).toBe("--");
      expect(els.tradesCount.textContent).toBe("0");
      expect(els.volume.textContent).toBe("$0.00");
      expect(els.realizedPnl.textContent).toBe("$0.00");
      expect(els.fees.textContent).toBe("$0.00");
      expect(els.unhedgedCount.textContent).toBe("0");
      expect(els.avgOi.textContent).toBe("$0.00");
    });

    it("renders formatted metrics accurately for a populated account", () => {
      const els = createMockIndividualElements();
      updateIndividualAccountMetrics(
        {
          accountIndex: 31704,
          network: "RH",
          tradesCount: 42,
          totalVolumeUsd: 125000.5,
          realizedPnlUsd: 145.2,
          totalFeesUsd: 8.45,
          unhedgedCount: 3,
          avgOiUsd: 12500.0,
        },
        els,
      );

      expect(els.accountBadge.textContent).toBe("#31704");
      expect(els.accountBadge.className).toContain("text-terminal-emerald");
      expect(els.tradesCount.textContent).toBe("42");
      expect(els.volume.textContent).toBe("$125.0K");
      expect(els.realizedPnl.textContent).toBe("+$145.20");
      expect(els.realizedPnl.className).toContain("text-terminal-emerald");
      expect(els.fees.textContent).toBe("$8.45");
      expect(els.unhedgedCount.textContent).toBe("3");
      expect(els.unhedgedCount.className).toContain("text-terminal-coral");
      expect(els.avgOi.textContent).toBe("$12.5K");
      expect(els.avgOi.className).toContain("text-white");
    });

    it("handles multiple accounts and negative PnL gracefully", () => {
      const els = createMockIndividualElements();
      updateIndividualAccountMetrics(
        {
          accountIndex: 749329,
          accountIndices: [749329, 749330],
          network: "CORE",
          tradesCount: 15,
          totalVolumeUsd: 54000.0,
          realizedPnlUsd: -34.5,
          totalFeesUsd: 2.1,
          unhedgedCount: 0,
          avgOiUsd: 0,
        },
        els,
      );

      expect(els.accountBadge.textContent).toBe("#749329, #749330");
      expect(els.accountBadge.className).toContain("text-terminal-accent");
      expect(els.tradesCount.textContent).toBe("15");
      expect(els.realizedPnl.textContent).toBe("-$34.50");
      expect(els.realizedPnl.className).toContain("text-terminal-coral");
      expect(els.fees.textContent).toBe("$2.10");
      expect(els.unhedgedCount.textContent).toBe("0");
      expect(els.unhedgedCount.className).toContain("text-terminal-muted");
      expect(els.avgOi.textContent).toBe("$0.00");
    });
  });

  describe("Time-Weighted Average Open Interest (calculateAccountAverageOi)", () => {
    it("returns 0 when no trades are provided", () => {
      const res = calculateAccountAverageOi([], null);
      expect(res.avgOiUsd).toBe(0);
      expect(res.currentOpenOiUsd).toBe(0);
      expect(res.periodDurationMs).toBe(0);
    });

    it("calculates exact time-weighted average for a 1-to-1 open and close within period", () => {
      // Open 10 ETH at $2,000 ($20,000 OI) at t=1000
      // Close 10 ETH at $2,000 ($0 OI) at t=3000 (held for 2000 ms)
      // Range: [0, 4000] (duration 4000 ms).
      // Expected: ($20,000 * 2000) / 4000 = $10,000
      const t1 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 10,
        price: 2000,
        timestampMs: 1000,
      });
      const t2 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "SELL",
        size: 10,
        price: 2000,
        timestampMs: 3000,
      });

      const filter = {
        startTimestampMs: 0,
        endTimestampMs: 4000,
        presetId: "custom",
      };

      const res = calculateAccountAverageOi([t1, t2], filter, 5000);
      expect(res.avgOiUsd).toBe(10000);
      expect(res.currentOpenOiUsd).toBe(0);
      expect(res.holdingDurationMs).toBe(2000);
      expect(res.periodDurationMs).toBe(4000);
    });

    it("accurately handles scale-in (partial open) with VWAP entry price", () => {
      // t=0: BUY 5 ETH at $2,000 -> pos=5, entry=2000, OI=$10,000
      // t=1000: BUY 5 ETH at $3,000 -> pos=10, entry=(5*2000 + 5*3000)/10 = 2500, OI=$25,000
      // t=3000: SELL 10 ETH at $3,000 -> pos=0, OI=$0
      // Filter [0, 3000]:
      // [0, 1000] (1000 ms): 10,000 -> 10,000,000
      // [1000, 3000] (2000 ms): 25,000 -> 50,000,000
      // Total integral = 60,000,000 / 3000 = $20,000
      const t1 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 5,
        price: 2000,
        timestampMs: 0,
      });
      const t2 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 5,
        price: 3000,
        timestampMs: 1000,
      });
      const t3 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "SELL",
        size: 10,
        price: 3000,
        timestampMs: 3000,
      });

      const filter = {
        startTimestampMs: 0,
        endTimestampMs: 3000,
        presetId: "custom",
      };

      const res = calculateAccountAverageOi([t1, t2, t3], filter, 4000);
      expect(res.avgOiUsd).toBe(20000);
      expect(res.currentOpenOiUsd).toBe(0);
    });

    it("accurately handles scale-out (partial close) preserving entry price", () => {
      // t=0: BUY 10 ETH at $2,000 -> pos=10, entry=2000, OI=$20,000
      // t=2000: SELL 4 ETH at $2,200 (partial close) -> pos=6, entry=2000, OI=$12,000
      // t=4000: SELL 6 ETH at $2,400 (full close) -> pos=0, OI=$0
      // Filter [0, 4000]:
      // [0, 2000] (2000 ms): 20,000 -> 40,000,000
      // [2000, 4000] (2000 ms): 12,000 -> 24,000,000
      // Total integral = 64,000,000 / 4000 = $16,000
      const t1 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 10,
        price: 2000,
        timestampMs: 0,
      });
      const t2 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "SELL",
        size: 4,
        price: 2200,
        timestampMs: 2000,
      });
      const t3 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "SELL",
        size: 6,
        price: 2400,
        timestampMs: 4000,
      });

      const filter = {
        startTimestampMs: 0,
        endTimestampMs: 4000,
        presetId: "custom",
      };

      const res = calculateAccountAverageOi([t1, t2, t3], filter, 5000);
      expect(res.avgOiUsd).toBe(16000);
      expect(res.currentOpenOiUsd).toBe(0);
    });

    it("handles position carried over across date filter boundary", () => {
      // Position opened BEFORE filter start:
      // t=1000: BUY 10 ETH at $2,000 ($20,000 OI)
      // Filter: [2000, 6000] (duration 4000 ms)
      // t=3000: SELL 10 ETH at $2,100 ($0 OI) (1000 ms after filter start)
      // In [2000, 6000]:
      // [2000, 3000] (1000 ms): 20,000 -> 20,000,000
      // [3000, 6000] (3000 ms): 0
      // Average OI = 20,000,000 / 4000 = $5,000
      const t1 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 10,
        price: 2000,
        timestampMs: 1000,
      });
      const t2 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "SELL",
        size: 10,
        price: 2100,
        timestampMs: 3000,
      });

      const filter = {
        startTimestampMs: 2000,
        endTimestampMs: 6000,
        presetId: "custom",
      };

      const res = calculateAccountAverageOi([t1, t2], filter, 7000);
      expect(res.avgOiUsd).toBe(5000);
      expect(res.holdingDurationMs).toBe(1000);
    });

    it("handles position flipping from Long to Short", () => {
      // t=0: BUY 10 ETH at $2,000 -> pos=+10, entry=2000, OI=$20,000
      // t=1000: SELL 15 ETH at $3,000 -> flips to pos=-5 (SHORT), entry=3000, OI=$15,000
      // t=2000: BUY 5 ETH at $2,800 -> pos=0, OI=$0
      // Filter [0, 2000]:
      // [0, 1000] (1000 ms): 20,000 -> 20,000,000
      // [1000, 2000] (1000 ms): 15,000 -> 15,000,000
      // Total integral = 35,000,000 / 2000 = $17,500
      const t1 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 10,
        price: 2000,
        timestampMs: 0,
      });
      const t2 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "SELL",
        size: 15,
        price: 3000,
        timestampMs: 1000,
      });
      const t3 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 5,
        price: 2800,
        timestampMs: 2000,
      });

      const filter = {
        startTimestampMs: 0,
        endTimestampMs: 2000,
        presetId: "custom",
      };

      const res = calculateAccountAverageOi([t1, t2, t3], filter, 3000);
      expect(res.avgOiUsd).toBe(17500);
      expect(res.currentOpenOiUsd).toBe(0);
    });

    it("tracks multiple markets concurrently without cross-contamination", () => {
      // Market 0 (ETH): BUY 10 ETH at $2,000 at t=0, close at t=2000. OI = $20k for [0, 2000].
      // Market 1 (BTC): BUY 1 BTC at $50,000 at t=1000, close at t=3000. OI = $50k for [1000, 3000].
      // Filter [0, 4000]:
      // ETH integral: 20,000 * 2000 = 40,000,000
      // BTC integral: 50,000 * 2000 = 100,000,000
      // Total integral = 140,000,000 / 4000 = $35,000
      const eth1 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 10,
        price: 2000,
        timestampMs: 0,
      });
      const eth2 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "SELL",
        size: 10,
        price: 2000,
        timestampMs: 2000,
      });
      const btc1 = mockTrade({
        marketSymbol: "BTC",
        marketId: 1,
        side: "BUY",
        size: 1,
        price: 50000,
        timestampMs: 1000,
      });
      const btc2 = mockTrade({
        marketSymbol: "BTC",
        marketId: 1,
        side: "SELL",
        size: 1,
        price: 50000,
        timestampMs: 3000,
      });

      const filter = {
        startTimestampMs: 0,
        endTimestampMs: 4000,
        presetId: "custom",
      };

      const res = calculateAccountAverageOi([eth1, btc1, eth2, btc2], filter, 5000);
      expect(res.avgOiUsd).toBe(35000);
    });

    it("handles All Time mode when position remains open into nowMs", () => {
      // BUY 10 ETH at $2,000 at t=1000. Never closed!
      // nowMs = 3000.
      // All Time duration: [1000, 3000] = 2000 ms.
      // Average OI = $20,000
      const t1 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 10,
        price: 2000,
        timestampMs: 1000,
      });

      const res = calculateAccountAverageOi([t1], null, 3000);
      expect(res.avgOiUsd).toBe(20000);
      expect(res.currentOpenOiUsd).toBe(20000);
      expect(res.periodDurationMs).toBe(2000);
    });

    it("calculates accurate average OI for a real completed Robinhood Campaign week", () => {
      // Week 1: 2026-08-10 00:00 UTC to 2026-08-21 00:00 UTC (11 days = 950,400,000 ms)
      const w1Start = Date.parse("2026-08-10T00:00:00.000Z");
      const w1End = Date.parse("2026-08-21T00:00:00.000Z");
      const msPerDay = 86400000;

      // User opens $50,000 position on day 2 (Aug 12)
      // Closes on day 7.5 (Aug 17.5) -> held for 5.5 days (half of 11-day campaign week 1)
      const t1 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 25,
        price: 2000,
        timestampMs: w1Start + 2 * msPerDay,
      });
      const t2 = mockTrade({
        marketSymbol: "ETH",
        marketId: 0,
        side: "SELL",
        size: 25,
        price: 2050,
        timestampMs: w1Start + 7.5 * msPerDay,
      });

      const filter = {
        startTimestampMs: w1Start,
        endTimestampMs: w1End,
        presetId: "week-1",
      };

      // nowMs in October (week is completed)
      const res = calculateAccountAverageOi(
        [t1, t2],
        filter,
        Date.parse("2026-10-09T00:00:00.000Z"),
      );
      // 50,000 * 5.5 days / 11 days = $25,000
      expect(res.avgOiUsd).toBe(25000);
      expect(res.currentOpenOiUsd).toBe(0);
      expect(res.periodDurationMs).toBe(11 * msPerDay);
    });
  });

  describe("Account Daily Summary Breakdown (calculateAccountDailyStats)", () => {
    const msPerDay = 86400000;

    it("returns 7-day scheduled breakdown for Robinhood promo week with no trades", () => {
      // Promo Week 2: Friday Aug 21, 2026 to Friday Aug 28, 2026
      const w2Start = Date.parse("2026-08-21T00:00:00.000Z");
      const w2End = Date.parse("2026-08-28T00:00:00.000Z");
      const filter = {
        startTimestampMs: w2Start,
        endTimestampMs: w2End,
        presetId: "week-2",
      };

      const stats = calculateAccountDailyStats([], filter);
      expect(stats.length).toBe(7);

      expect(stats[0].dayOfWeek).toBe("Fri");
      expect(stats[0].shortDate).toBe("21/08");
      expect(stats[0].dateFormatted).toBe("2026-08-21");
      expect(stats[0].tradesCount).toBe(0);
      expect(stats[0].totalVolumeUsd).toBe(0);
      expect(stats[0].avgHoldingDurationMs).toBe(0);

      expect(stats[1].dayOfWeek).toBe("Sat");
      expect(stats[1].shortDate).toBe("22/08");
      expect(stats[2].dayOfWeek).toBe("Sun");
      expect(stats[3].dayOfWeek).toBe("Mon");
      expect(stats[4].dayOfWeek).toBe("Tue");
      expect(stats[5].dayOfWeek).toBe("Wed");
      expect(stats[6].dayOfWeek).toBe("Thu");
      expect(stats[6].dateFormatted).toBe("2026-08-27");
    });

    it("calculates accurate trade count, volume, and average holding time for intraday trades", () => {
      // Monday Aug 24:
      // t1 at 10:00: BUY 10 ETH at $2,000 (vol $20,000)
      // t2 at 10:15: SELL 10 ETH at $2,010 (vol $20,100) -> held 15m (900,000 ms)
      const dayStart = Date.parse("2026-08-24T00:00:00.000Z");
      const t1 = mockTrade({
        tradeId: "t1",
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 10,
        price: 2000,
        usdValue: 20000,
        timestampMs: dayStart + 10 * 3600 * 1000,
      });
      const t2 = mockTrade({
        tradeId: "t2",
        marketSymbol: "ETH",
        marketId: 0,
        side: "SELL",
        size: 10,
        price: 2010,
        usdValue: 20100,
        timestampMs: dayStart + 10.25 * 3600 * 1000,
      });

      const filter = {
        startTimestampMs: dayStart,
        endTimestampMs: dayStart + msPerDay,
        presetId: "custom",
      };

      const stats = calculateAccountDailyStats([t1, t2], filter);
      expect(stats.length).toBe(1);
      const day = stats[0];

      expect(day.dayOfWeek).toBe("Mon");
      expect(day.shortDate).toBe("24/08");
      expect(day.dateFormatted).toBe("2026-08-24");
      expect(day.tradesCount).toBe(2);
      expect(day.totalVolumeUsd).toBe(40100);
      expect(day.avgHoldingDurationMs).toBe(15 * 60 * 1000); // 15 minutes
    });

    it("calculates accurate holding time for position carried overnight across UTC midnight", () => {
      // Trade entered Monday Aug 24 at 23:00 UTC
      // Trade exited Tuesday Aug 25 at 01:00 UTC (held for 2 hours)
      const monStart = Date.parse("2026-08-24T00:00:00.000Z");
      const t1 = mockTrade({
        tradeId: "t1",
        marketSymbol: "ETH",
        marketId: 0,
        side: "BUY",
        size: 5,
        price: 2000,
        usdValue: 10000,
        timestampMs: monStart + 23 * 3600 * 1000,
      });
      const t2 = mockTrade({
        tradeId: "t2",
        marketSymbol: "ETH",
        marketId: 0,
        side: "SELL",
        size: 5,
        price: 2000,
        usdValue: 10000,
        timestampMs: monStart + 25 * 3600 * 1000, // Tue 01:00 UTC
      });

      const filter = {
        startTimestampMs: monStart,
        endTimestampMs: monStart + 2 * msPerDay,
        presetId: "custom",
      };

      const stats = calculateAccountDailyStats([t1, t2], filter);
      expect(stats.length).toBe(2);

      const mon = stats[0];
      const tue = stats[1];

      expect(mon.dayOfWeek).toBe("Mon");
      expect(mon.shortDate).toBe("24/08");
      expect(mon.tradesCount).toBe(1);
      expect(mon.avgHoldingDurationMs).toBe(1 * 3600 * 1000); // 1 hour on Mon (23:00 to 24:00)

      expect(tue.dayOfWeek).toBe("Tue");
      expect(tue.shortDate).toBe("25/08");
      expect(tue.tradesCount).toBe(1);
      expect(tue.avgHoldingDurationMs).toBe(1 * 3600 * 1000); // 1 hour on Tue (00:00 to 01:00)
    });

    it("accurately handles scale-in and position holding time within day", () => {
      // 10:00: BUY 10 ETH
      // 10:10: BUY 10 ETH
      // 10:20: SELL 20 ETH -> position open from 10:00 to 10:20 (20 minutes active in day)
      const dayStart = Date.parse("2026-08-24T00:00:00.000Z");
      const t1 = mockTrade({
        tradeId: "t1",
        marketSymbol: "ETH",
        side: "BUY",
        size: 10,
        price: 2000,
        usdValue: 20000,
        timestampMs: dayStart + 10 * 3600 * 1000,
      });
      const t2 = mockTrade({
        tradeId: "t2",
        marketSymbol: "ETH",
        side: "BUY",
        size: 10,
        price: 2000,
        usdValue: 20000,
        timestampMs: dayStart + 10 * 3600 * 1000 + 10 * 60 * 1000,
      });
      const t3 = mockTrade({
        tradeId: "t3",
        marketSymbol: "ETH",
        side: "SELL",
        size: 20,
        price: 2000,
        usdValue: 40000,
        timestampMs: dayStart + 10 * 3600 * 1000 + 20 * 60 * 1000,
      });

      const filter = {
        startTimestampMs: dayStart,
        endTimestampMs: dayStart + msPerDay,
        presetId: "custom",
      };

      const stats = calculateAccountDailyStats([t1, t2, t3], filter);
      expect(stats.length).toBe(1);
      expect(stats[0].tradesCount).toBe(3);
      expect(stats[0].shortDate).toBe("24/08");
      expect(stats[0].totalVolumeUsd).toBe(80000);
      expect(stats[0].avgHoldingDurationMs).toBe(20 * 60 * 1000); // 20 min active position in day
    });

    it("reports 24h holding time for days with 0 trades when a position was open throughout", () => {
      const monStart = Date.parse("2026-08-24T00:00:00.000Z"); // Mon 00:00 UTC
      // Position opened Monday 10:00 UTC, closed Wednesday 14:00 UTC
      // Tuesday has 0 trades, but position was open for the full 24 hours!
      const tOpen = mockTrade({
        tradeId: "open-1",
        marketSymbol: "ETH",
        side: "BUY",
        size: 5,
        price: 2000,
        usdValue: 10000,
        timestampMs: monStart + 10 * 3600 * 1000, // Mon 10:00 UTC
      });
      const tClose = mockTrade({
        tradeId: "close-1",
        marketSymbol: "ETH",
        side: "SELL",
        size: 5,
        price: 2000,
        usdValue: 10000,
        timestampMs: monStart + 2 * msPerDay + 14 * 3600 * 1000, // Wed 14:00 UTC
      });

      const filter = {
        startTimestampMs: monStart,
        endTimestampMs: monStart + 3 * msPerDay,
        presetId: "custom",
      };

      const stats = calculateAccountDailyStats([tOpen, tClose], filter);
      expect(stats.length).toBe(3);

      const [mon, tue, wed] = stats;
      // Monday: 10:00 to 24:00 = 14 hours
      expect(mon.tradesCount).toBe(1);
      expect(mon.avgHoldingDurationMs).toBe(14 * 3600 * 1000);
      expect(formatCompactDuration(mon.avgHoldingDurationMs)).toBe("14h");

      // Tuesday: 0 trades, held entire 24h of the day
      expect(tue.tradesCount).toBe(0);
      expect(tue.totalVolumeUsd).toBe(0);
      expect(tue.avgHoldingDurationMs).toBe(24 * 3600 * 1000);
      expect(formatCompactDuration(tue.avgHoldingDurationMs)).toBe("24h");

      // Wednesday: 00:00 to 14:00 = 14 hours
      expect(wed.tradesCount).toBe(1);
      expect(wed.avgHoldingDurationMs).toBe(14 * 3600 * 1000);
      expect(formatCompactDuration(wed.avgHoldingDurationMs)).toBe("14h");
    });
  });

  describe("Compact Formatters (formatCompactDuration & formatCompactUsd)", () => {
    it("formats durations concisely without emojis", () => {
      expect(formatCompactDuration(0)).toBe("—");
      expect(formatCompactDuration(500)).toBe("<1s");
      expect(formatCompactDuration(35000)).toBe("35s");
      expect(formatCompactDuration(2 * 60 * 1000 + 15 * 1000)).toBe("2m 15s");
      expect(formatCompactDuration(25 * 60 * 1000)).toBe("25m");
      expect(formatCompactDuration(1.5 * 3600 * 1000)).toBe("1h 30m");
      expect(formatCompactDuration(14 * 3600 * 1000)).toBe("14h");
      expect(formatCompactDuration(24 * 3600 * 1000)).toBe("24h");
      expect(formatCompactDuration(26 * 3600 * 1000)).toBe("24h");
    });

    it("formats usd volumes compactly", () => {
      expect(formatCompactUsd(0)).toBe("$0");
      expect(formatCompactUsd(450)).toBe("$450");
      expect(formatCompactUsd(12500)).toBe("$12.5k");
      expect(formatCompactUsd(120000)).toBe("$120k");
      expect(formatCompactUsd(1250000)).toBe("$1.3M");
    });

    it("formats notional sizes in K/M compactly without extra cents (formatCompactK)", () => {
      expect(formatCompactK(0)).toBe("0K");
      expect(formatCompactK(undefined)).toBe("0K");
      expect(formatCompactK(null)).toBe("0K");
      expect(formatCompactK(25)).toBe("<0.1K");
      expect(formatCompactK(100)).toBe("0.1K");
      expect(formatCompactK(500)).toBe("0.5K");
      expect(formatCompactK(1000)).toBe("1K");
      expect(formatCompactK(1500)).toBe("1.5K");
      expect(formatCompactK(25400)).toBe("25.4K");
      expect(formatCompactK(100000)).toBe("100K");
      expect(formatCompactK(1250000)).toBe("1.3M");
      expect(formatCompactK(2000000)).toBe("2M");
    });

    it("formats timestamp into local browser date-time (formatTimestampLocal)", () => {
      expect(formatTimestampLocal(0)).toBe("--");
      expect(formatTimestampLocal(NaN)).toBe("--");
      expect(formatTimestampLocal(null)).toBe("--");
      const ts = 1727863200000;
      const res = formatTimestampLocal(ts);
      expect(res).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      const d = new Date(ts);
      expect(res).toContain(d.getFullYear().toString());
    });
  });

  describe("DOM Daily Summary Column Rendering (renderDailySummary)", () => {
    it("renders compact columns with day headers, date next to day, avg hold, and volume without emojis", () => {
      const container = { innerHTML: "" } as HTMLElement;
      const stats = [
        {
          dateFormatted: "2026-08-21",
          dayOfWeek: "Fri",
          shortDate: "21/08",
          timestampMs: 1000,
          tradesCount: 12,
          totalVolumeUsd: 45000,
          avgHoldingDurationMs: 4.5 * 60 * 1000, // 4m 30s
          realizedPnlUsd: 15.5,
          totalFeesUsd: 1.2,
        },
        {
          dateFormatted: "2026-08-22",
          dayOfWeek: "Sat",
          shortDate: "22/08",
          timestampMs: 2000,
          tradesCount: 0,
          totalVolumeUsd: 0,
          avgHoldingDurationMs: 0,
          realizedPnlUsd: 0,
          totalFeesUsd: 0,
        },
      ];

      renderDailySummary(container, stats, "RH");
      expect(container.innerHTML).toContain("FRI");
      expect(container.innerHTML).toContain("(21/08)");
      expect(container.innerHTML).toContain("SAT");
      expect(container.innerHTML).toContain("(22/08)");
      expect(container.innerHTML).not.toContain("trd");
      expect(container.innerHTML).not.toContain("Trades:");
      expect(container.innerHTML).toContain("4m 30s");
      expect(container.innerHTML).toContain("$45.0k");
      // Check that emojis are NOT present
      expect(container.innerHTML).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    });

    it("integrates seamlessly into updateIndividualAccountMetrics", () => {
      const els = createMockIndividualElements();
      const stats = [
        {
          dateFormatted: "2026-08-21",
          dayOfWeek: "Fri",
          shortDate: "21/08",
          timestampMs: 1000,
          tradesCount: 5,
          totalVolumeUsd: 10000,
          avgHoldingDurationMs: 60000,
          realizedPnlUsd: 0,
          totalFeesUsd: 0,
        },
      ];

      updateIndividualAccountMetrics(
        {
          accountIndex: 1,
          network: "CORE",
          tradesCount: 5,
          totalVolumeUsd: 10000,
          realizedPnlUsd: 0,
          totalFeesUsd: 0,
          unhedgedCount: 0,
          dailyStats: stats,
        },
        els,
      );

      expect(els.dailySummary.innerHTML).toContain("FRI");
      expect(els.dailySummary.innerHTML).toContain("(21/08)");
      expect(els.dailySummary.innerHTML).not.toContain("trd");
      expect(els.dailySummary.innerHTML).not.toContain("Trades:");
      expect(els.dailySummary.innerHTML).toContain("1m");
      expect(els.dailySummary.innerHTML).toContain("text-terminal-accent");
    });
  });
});
