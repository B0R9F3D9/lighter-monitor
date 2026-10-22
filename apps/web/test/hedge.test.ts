import { describe, expect, it } from "bun:test";
import {
  getStaticMarketMap,
  parseFeeUsd,
  parseTradeForView,
  stitchTradeBatches,
} from "../src/checker/api";
import {
  formatCompactDuration,
  formatCompactK,
  formatCompactUsd,
  formatDisplayFileName,
  formatTimestampLocal,
  renderDailySummary,
  renderMarketSummaryCards,
  updateHedgeExecutiveMetrics,
  updateHedgeSelectionMetrics,
  updateIndividualAccountMetrics,
  updateWeeklyPointsCard,
  renderWeeklyPointsTable,
  renderWeeklyPointsMultiGrid,
  type WeeklyPointsElements,
  type WeeklyPointsMultiElements,
} from "../src/checker/dom";
import {
  aggregateTradesByOrder,
  calculateAccountAverageOi,
  calculateAccountDailyStats,
  calculateHedgeMetrics,
  calculateMarketHoldingDuration,
  calculateMarketSummaryStats,
  calculateSelectedHedgeMetrics,
  calculateWeekActivityStats,
  calculateWeeklyPointsAnalysis,
  calculateWeeklyPointsTotalStats,
  computeRangeSelection,
  exportHedgeReportToCsv,
  getParticipatingWeeksStats,
  matchHedgeTrades,
  sortMarketSummaryStats,
  sortWeeklyPointsStats,
  type WeekActivityStats,
} from "../src/checker/hedge";
import {
  createPresetDateFilter,
  findPresetById,
  getRobinhoodPromoWeeks,
  isTradeInDateRange,
} from "../src/checker/date_filter";
import type {
  HedgePair,
  LighterTrade,
  MarketSummaryStat,
  ParsedTradeView,
  WeeklyPointsSortColumn,
  WithdrawalRecord,
} from "../src/checker/types";

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
    fees: { textContent: "", className: "" } as HTMLElement,
    funding: { textContent: "", className: "", title: "" } as HTMLElement,
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
  rhFundingUsd = 0,
  coreFundingUsd = 0,
) => ({
  id,
  marketSymbol: "AAPL",
  matchedSize: 50,
  rhTradeId: `rh-${id}`,
  rhSide: "BUY" as const,
  rhPrice: 200,
  rhSize: 50,
  rhFeeUsd: totalFeesUsd / 2,
  rhFundingUsd,
  rhTimestampMs: 1000,
  rhTimeFormatted: "10:00:00",
  rhTxHash: "0x1",
  rhRole: "TAKER" as const,
  coreTradeId: `core-${id}`,
  coreSide: "SELL" as const,
  corePrice: 200,
  coreSize: 50,
  coreFeeUsd: totalFeesUsd / 2,
  coreFundingUsd,
  coreTimestampMs: 1000,
  coreTimeFormatted: "10:00:00",
  coreTxHash: "0x2",
  coreRole: "MAKER" as const,
  buyPrice: 200,
  sellPrice: 200,
  priceDelta: pricePnlUsd / 50,
  pricePnlUsd,
  totalFeesUsd,
  totalFundingUsd: rhFundingUsd + coreFundingUsd,
  netPnlUsd: pricePnlUsd + (rhFundingUsd + coreFundingUsd) - totalFeesUsd,
  notionalUsd,
  pnlBps: ((pricePnlUsd + (rhFundingUsd + coreFundingUsd) - totalFeesUsd) / notionalUsd) * 10000,
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
      expect(els.fees.className).toContain("text-terminal-muted");
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
      expect(els.fees.className).toContain("text-terminal-coral");
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
      expect(els.fees.className).toContain("text-terminal-coral");
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

    it("correctly uses fundingHistory to restore pre-existing position carried into week", () => {
      // User entered week with 100 contracts long NVDA ($200 price = $20,000 OI)
      // Week starts at t0 = 0
      // First trade in week is at t = 2000 (SELL 100 NVDA to close long)
      // Without funding history, checker would think user opened a short of -100 from t=2000 to t=10000.
      // With funding history, checker knows user held 100 long from t=0 to t=2000!
      const tClose = mockTrade({
        tradeId: "tClose",
        marketSymbol: "NVDA",
        marketId: 15,
        size: 100,
        price: 200,
        side: "SELL",
        timestampMs: 2000,
      });

      const fundingHistory = [
        {
          timestamp: 0, // t=0s -> 0ms
          market_id: 15,
          funding_id: 1,
          change: "-0.20",
          rate: "0.00001",
          position_size: "100.0000",
          position_side: "long" as const,
          discount: "0.000000",
        },
      ];

      const filter = {
        startTimestampMs: 0,
        endTimestampMs: 10000,
        presetId: "week-9",
      };

      const res = calculateAccountAverageOi([tClose], filter, 10000, fundingHistory);

      // Held $20,000 OI from t=0 to t=2000 (2000ms), flat ($0) from t=2000 to t=10000 (8000ms)
      // Integral = 20,000 * 2000 = 40,000,000
      // avgOiUsd = 40,000,000 / 10,000 = $4,000
      expect(res.avgOiUsd).toBe(4000);
      expect(res.currentOpenOiUsd).toBe(0);
    });

    it("calculates accurate OI for market held throughout week with 0 trades from fundingHistory", () => {
      // 0 trades in file, but funding history shows 50 SOL held throughout period
      const fundingHistory = [
        {
          timestamp: 0,
          market_id: 20,
          funding_id: 101,
          change: "-0.10",
          rate: "0.00001", // mark price = 0.10 / (50 * 0.00001) = 200
          position_size: "50.0000",
          position_side: "long" as const,
          discount: "0.000000",
        },
        {
          timestamp: 5, // 5000ms
          market_id: 20,
          funding_id: 102,
          change: "-0.10",
          rate: "0.00001",
          position_size: "50.0000",
          position_side: "long" as const,
          discount: "0.000000",
        },
      ];

      const filter = {
        startTimestampMs: 0,
        endTimestampMs: 10000,
        presetId: "week-9",
      };

      const res = calculateAccountAverageOi([], filter, 10000, fundingHistory);
      // 50 * 200 = 10,000 OI held throughout
      expect(res.avgOiUsd).toBe(10000);
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

  describe("Funding Integration in Hedge Checker", () => {
    it("pro-rates funding across 1-to-1 and partial matches in matchHedgeTrades", () => {
      // RH BUY 10 AAPL with -$2.00 funding
      const rhTrade = mockTrade({
        tradeId: "rh-1",
        side: "BUY",
        size: 10,
        price: 200,
        fundingUsd: -2.0,
        timestampMs: 1000,
      });

      // Core SELL 6 AAPL with +$0.60 funding
      const coreTrade1 = mockTrade({
        tradeId: "core-1",
        side: "SELL",
        size: 6,
        price: 200,
        fundingUsd: 0.6,
        timestampMs: 1050,
      });

      // Core SELL 4 AAPL with +$0.40 funding
      const coreTrade2 = mockTrade({
        tradeId: "core-2",
        side: "SELL",
        size: 4,
        price: 200,
        fundingUsd: 0.4,
        timestampMs: 1100,
      });

      const result = matchHedgeTrades([rhTrade], [coreTrade1, coreTrade2], 10, 20);

      expect(result.pairs).toHaveLength(2);
      expect(result.unhedged).toHaveLength(0);

      // Pair matched with core-1 (size 6):
      // RH share: 6/10 of -2.00 = -1.20 USD
      // Core share: full 0.60 USD
      const p1 = result.pairs.find((p) => p.coreTradeId === "core-1");
      expect(p1).toBeDefined();
      expect(p1!.rhFundingUsd).toBeCloseTo(-1.2, 4);
      expect(p1!.coreFundingUsd).toBeCloseTo(0.6, 4);
      expect(p1!.totalFundingUsd).toBeCloseTo(-0.6, 4);

      // Pair matched with core-2 (size 4):
      // RH share: 4/10 of -2.00 = -0.80 USD
      // Core share: full 0.40 USD
      const p2 = result.pairs.find((p) => p.coreTradeId === "core-2");
      expect(p2).toBeDefined();
      expect(p2!.rhFundingUsd).toBeCloseTo(-0.8, 4);
      expect(p2!.coreFundingUsd).toBeCloseTo(0.4, 4);
      expect(p2!.totalFundingUsd).toBeCloseTo(-0.4, 4);

      // Aggregate summary metrics
      expect(result.metrics.rhTotalFundingUsd).toBeCloseTo(-2.0, 4);
      expect(result.metrics.coreTotalFundingUsd).toBeCloseTo(1.0, 4);
      expect(result.metrics.totalFundingUsd).toBeCloseTo(-1.0, 4);
      expect(result.metrics.totalNetPnlUsd).toBeCloseTo(-2.5, 4); // 0 slippage + -1.0 funding - 1.5 fees
    });

    it("assigns remaining pro-rated funding to unhedged trades", () => {
      // RH BUY 10 AAPL with -$5.00 funding
      const rhTrade = mockTrade({
        tradeId: "rh-1",
        side: "BUY",
        size: 10,
        price: 200,
        fundingUsd: -5.0,
      });

      // Core SELL only 4 AAPL with +$1.00 funding
      const coreTrade = mockTrade({
        tradeId: "core-1",
        side: "SELL",
        size: 4,
        price: 200,
        fundingUsd: 1.0,
      });

      const result = matchHedgeTrades([rhTrade], [coreTrade], 10, 20);

      expect(result.pairs).toHaveLength(1);
      expect(result.unhedged).toHaveLength(1);

      // Matched pair: size 4 => 4/10 * -5.0 = -2.0 USD RH funding
      expect(result.pairs[0].matchedSize).toBe(4);
      expect(result.pairs[0].rhFundingUsd).toBeCloseTo(-2.0, 4);
      expect(result.pairs[0].coreFundingUsd).toBeCloseTo(1.0, 4);
      expect(result.pairs[0].totalFundingUsd).toBeCloseTo(-1.0, 4);

      // Unhedged leg: remaining size 6 => 6/10 * -5.0 = -3.0 USD RH funding
      const unhedged = result.unhedged[0];
      expect(unhedged.unhedgedSize).toBe(6);
      expect(unhedged.fundingUsd).toBeCloseTo(-3.0, 4);

      // Overall metrics sum both pair and unhedged funding
      expect(result.metrics.rhTotalFundingUsd).toBeCloseTo(-5.0, 4);
      expect(result.metrics.coreTotalFundingUsd).toBeCloseTo(1.0, 4);
      expect(result.metrics.totalFundingUsd).toBeCloseTo(-4.0, 4);
    });

    it("aggregates totalFundingUsd in calculateSelectedHedgeMetrics", () => {
      const p1 = makeMockHedgePair("p1", 1000, 10, 1, -0.5, 0.2);
      const p2 = makeMockHedgePair("p2", 2000, 20, 2, -1.0, 0.3);

      const unhedged = {
        tradeId: "u1",
        network: "RH" as const,
        timeFormatted: "12:00:00",
        timestampMs: 12000,
        marketSymbol: "AAPL",
        side: "BUY" as const,
        role: "TAKER" as const,
        originalSize: 5,
        unhedgedSize: 5,
        price: 200,
        usdValue: 1000,
        feeUsd: 0.5,
        fundingUsd: -0.25,
        txHash: "0x123",
      };

      const metrics = calculateSelectedHedgeMetrics([p1, p2], [unhedged]);

      // p1 totalFunding: -0.3
      // p2 totalFunding: -0.7
      // unhedged totalFunding: -0.25
      expect(metrics.totalFundingUsd).toBeCloseTo(-1.25, 4);
      expect(metrics.totalNetPnlUsd).toBeCloseTo(30 - 1.25 - 3.5, 4);
      expect(metrics.selectedCount).toBe(3);
    });

    it("exports RH Funding USD, Core Funding USD, and Total Funding USD to CSV", () => {
      const p = makeMockHedgePair("p1", 2000, 5, 1, -1.5, 0.5);
      const u = {
        tradeId: "u1",
        network: "CORE" as const,
        timeFormatted: "12:00:00",
        timestampMs: 12000,
        marketSymbol: "AAPL",
        side: "SELL" as const,
        role: "MAKER" as const,
        originalSize: 5,
        unhedgedSize: 5,
        price: 200,
        usdValue: 1000,
        feeUsd: 0.1,
        fundingUsd: 0.75,
        txHash: "0xcore",
      };

      const csv = exportHedgeReportToCsv([p], [u]);
      const lines = csv.split("\n");

      // Verify header columns
      expect(lines[0]).toContain("RH Funding USD");
      expect(lines[0]).toContain("Core Funding USD");
      expect(lines[0]).toContain("Total Funding USD");

      // Verify pair row
      const pairLine = lines.find((l) => l.startsWith("p1,"));
      expect(pairLine).toBeDefined();
      expect(pairLine).toContain("-1.5000,0.5000,-1.0000");

      // Verify unhedged row (Core unhedged leg => RH funding is --, Core funding is 0.7500, Total is 0.7500)
      const unhedgedLine = lines.find((l) => l.startsWith("unhedged-CORE-u1,"));
      expect(unhedgedLine).toBeDefined();
      expect(unhedgedLine).toContain("--,0.7500,0.7500");
    });

    it("formats individual account funding correctly with signs, classes, and titles in DOM", () => {
      const els = createMockIndividualElements();

      // Case 1: Positive funding (received income)
      updateIndividualAccountMetrics(
        {
          accountIndex: 31704,
          network: "RH",
          tradesCount: 10,
          totalVolumeUsd: 50000,
          realizedPnlUsd: 10,
          totalFeesUsd: 2,
          totalFundingUsd: 4.56,
          unhedgedCount: 0,
        },
        els,
      );

      expect(els.funding.textContent).toBe("+$4.56");
      expect(els.funding.className).toContain("text-terminal-emerald");
      expect(els.funding.title).toContain("RH Net funding received: +$4.56");

      // Case 2: Negative funding (paid expense)
      updateIndividualAccountMetrics(
        {
          accountIndex: 749329,
          network: "CORE",
          tradesCount: 10,
          totalVolumeUsd: 50000,
          realizedPnlUsd: -5,
          totalFeesUsd: 2,
          totalFundingUsd: -12.34,
          unhedgedCount: 0,
        },
        els,
      );

      expect(els.funding.textContent).toBe("-$12.34");
      expect(els.funding.className).toContain("text-terminal-coral");
      expect(els.funding.title).toContain("CORE Net funding paid: -$12.34");

      // Case 3: Zero funding
      updateIndividualAccountMetrics(
        {
          accountIndex: 749329,
          network: "CORE",
          tradesCount: 10,
          totalVolumeUsd: 50000,
          realizedPnlUsd: 0,
          totalFeesUsd: 0,
          totalFundingUsd: 0,
          unhedgedCount: 0,
        },
        els,
      );

      expect(els.funding.textContent).toBe("$0.00");
      expect(els.funding.className).toContain("text-terminal-muted");
      expect(els.funding.title).toContain("CORE No funding paid/received");
    });

    it("formats hedge executive and selection funding metrics correctly in DOM", () => {
      // Executive Lead Strip
      const execFundingEl = { textContent: "", className: "", title: "" } as HTMLElement;
      updateHedgeExecutiveMetrics(
        {
          rhAccountIndex: null,
          coreAccountIndex: null,
          rhTotalTrades: 5,
          coreTotalTrades: 5,
          totalPairs: 5,
          totalHedgedVolumeUsd: 10000,
          totalNetPnlUsd: 25,
          totalPricePnlUsd: 30,
          totalFeesUsd: 5,
          totalFundingUsd: -1.75,
          rhTotalFundingUsd: -2.5,
          coreTotalFundingUsd: 0.75,
          avgPnlBps: 25,
          bestPairPnlUsd: 10,
          worstPairPnlUsd: -2,
          totalUnhedgedTrades: 0,
          unhedgedVolumeUsd: 0,
          unhedgedRhCount: 0,
          unhedgedCoreCount: 0,
          firstTradeTime: 1000,
          lastTradeTime: 2000,
        },
        {
          pairsCount: null,
          netPnl: null,
          pnlBps: null,
          hedgedVolume: null,
          slippage: null,
          fees: null,
          funding: execFundingEl,
          unhedgedCount: null,
        },
      );

      expect(execFundingEl.textContent).toBe("-$1.75");
      expect(execFundingEl.className).toContain("text-terminal-coral");
      expect(execFundingEl.title).toBe("Net Funding: -$1.75 (RH: -$2.50 / Core: +$0.75)");

      // Selection Floating Card
      const selFundingEl = { textContent: "", className: "", title: "" } as HTMLElement;
      updateHedgeSelectionMetrics(
        {
          selectedCount: 2,
          pairsCount: 2,
          unhedgedCount: 0,
          totalVolumeUsd: 4000,
          totalNetPnlUsd: 10,
          totalPricePnlUsd: 12,
          totalFeesUsd: 2,
          totalFundingUsd: 3.2,
          avgPnlBps: 25,
          totalMatchedSize: 20,
          weightedPriceDelta: 0.1,
          weightedPriceDeltaBps: 5,
          weightedBuyPrice: 200,
          weightedSellPrice: 200.1,
          isSingleMarket: true,
          marketSymbol: "AAPL",
        },
        {
          selectionCard: null,
          countBadge: null,
          pairsCount: null,
          volume: null,
          netPnl: null,
          pnlBps: null,
          weightedDelta: null,
          weightedDeltaBps: null,
          slippage: null,
          fees: null,
          funding: selFundingEl,
          unhedgedCount: null,
        },
      );

      expect(selFundingEl.textContent).toBe("+$3.20");
      expect(selFundingEl.className).toContain("text-terminal-emerald");
      expect(selFundingEl.title).toBe("Selected Net Funding: +$3.20");
    });

    it("displays strictly Robinhood (RH) AVG OI in lead banner instead of sum of both accounts", () => {
      const avgOiEl = { textContent: "", className: "", title: "" } as HTMLElement;
      updateHedgeExecutiveMetrics(
        {
          rhAccountIndex: null,
          coreAccountIndex: null,
          rhTotalTrades: 5,
          coreTotalTrades: 5,
          totalPairs: 5,
          totalHedgedVolumeUsd: 10000,
          totalNetPnlUsd: 25,
          totalPricePnlUsd: 30,
          totalFeesUsd: 5,
          totalFundingUsd: 0,
          rhTotalFundingUsd: 0,
          coreTotalFundingUsd: 0,
          avgPnlBps: 25,
          bestPairPnlUsd: 10,
          worstPairPnlUsd: -2,
          totalUnhedgedTrades: 0,
          unhedgedVolumeUsd: 0,
          unhedgedRhCount: 0,
          unhedgedCoreCount: 0,
          firstTradeTime: 1000,
          lastTradeTime: 2000,
          rhAvgOiUsd: 16000,
          coreAvgOiUsd: 15000,
          totalAvgOiUsd: 16000,
        },
        {
          pairsCount: null,
          netPnl: null,
          pnlBps: null,
          hedgedVolume: null,
          slippage: null,
          fees: null,
          funding: null,
          unhedgedCount: null,
          avgOi: avgOiEl,
        },
      );

      // Should display $16.0K (RH only), NOT $31.0K (sum of RH and Core)
      expect(avgOiEl.textContent).toBe("$16.0K");
      expect(avgOiEl.title).toBe("RH Avg OI: $16.0K (Core: $15.0K)");
    });
  });

  describe("Token & Market Summary Breakdown (by Token / Market)", () => {
    it("calculateMarketHoldingDuration returns 0 when no trades provided", () => {
      expect(calculateMarketHoldingDuration([])).toBe(0);
    });

    it("calculateMarketHoldingDuration calculates exact holding time for a simple 1-to-1 open and close", () => {
      const openTime = 1727863200000;
      const closeTime = openTime + 30 * 60 * 1000; // 30 minutes later
      const trades: ParsedTradeView[] = [
        mockTrade({ tradeId: "1", side: "BUY", size: 1.5, timestampMs: openTime }),
        mockTrade({ tradeId: "2", side: "SELL", size: 1.5, timestampMs: closeTime }),
      ];

      const durationMs = calculateMarketHoldingDuration(trades);
      expect(durationMs).toBe(30 * 60 * 1000);
    });

    it("calculateMarketHoldingDuration calculates size-weighted holding time when scaling out", () => {
      const t0 = 1727863200000;
      const t1 = t0 + 20 * 60 * 1000; // +20 min (sell 1.0)
      const t2 = t0 + 50 * 60 * 1000; // +50 min (sell 1.0)
      const trades: ParsedTradeView[] = [
        mockTrade({ tradeId: "1", side: "BUY", size: 2.0, timestampMs: t0 }),
        mockTrade({ tradeId: "2", side: "SELL", size: 1.0, timestampMs: t1 }),
        mockTrade({ tradeId: "3", side: "SELL", size: 1.0, timestampMs: t2 }),
      ];

      // 1.0 held for 20m, 1.0 held for 50m -> weighted avg = (1*20 + 1*50) / 2 = 35m
      const durationMs = calculateMarketHoldingDuration(trades);
      expect(durationMs).toBe(35 * 60 * 1000);
    });

    it("calculateMarketHoldingDuration isolates subaccounts correctly", () => {
      const t0 = 1727863200000;
      const t1 = t0 + 10 * 60 * 1000;
      const t2 = t0 + 40 * 60 * 1000;
      const trades: ParsedTradeView[] = [
        mockTrade({ tradeId: "1", userAccountId: 10, side: "BUY", size: 1.0, timestampMs: t0 }),
        mockTrade({ tradeId: "2", userAccountId: 20, side: "BUY", size: 1.0, timestampMs: t0 }),
        mockTrade({ tradeId: "3", userAccountId: 10, side: "SELL", size: 1.0, timestampMs: t1 }), // acc 10 held 10m
        mockTrade({ tradeId: "4", userAccountId: 20, side: "SELL", size: 1.0, timestampMs: t2 }), // acc 20 held 40m
      ];

      // Total weighted: 1*10m + 1*40m = 50m / 2 = 25m
      const durationMs = calculateMarketHoldingDuration(trades);
      expect(durationMs).toBe(25 * 60 * 1000);
    });

    it("calculateMarketSummaryStats groups volume, transactions, avg size, and holding duration by token", () => {
      const t0 = 1727863200000;
      const t1 = t0 + 15 * 60 * 1000;

      const rhTrades: ParsedTradeView[] = [
        mockTrade({
          tradeId: "rh-1",
          marketId: 1,
          marketSymbol: "ETH",
          side: "BUY",
          size: 2.0,
          price: 3000,
          usdValue: 6000,
          timestampMs: t0,
        }),
        mockTrade({
          tradeId: "rh-2",
          marketId: 1,
          marketSymbol: "ETH",
          side: "SELL",
          size: 2.0,
          price: 3010,
          usdValue: 6020,
          timestampMs: t1,
        }),
        mockTrade({
          tradeId: "rh-3",
          marketId: 2,
          marketSymbol: "BTC",
          side: "BUY",
          size: 0.1,
          price: 60000,
          usdValue: 6000,
          timestampMs: t0,
        }),
      ];

      const coreTrades: ParsedTradeView[] = [
        mockTrade({
          tradeId: "core-1",
          marketId: 1,
          marketSymbol: "ETH",
          side: "SELL",
          size: 2.0,
          price: 3000,
          usdValue: 6000,
          timestampMs: t0 + 50,
        }),
        mockTrade({
          tradeId: "core-2",
          marketId: 1,
          marketSymbol: "ETH",
          side: "BUY",
          size: 2.0,
          price: 3008,
          usdValue: 6016,
          timestampMs: t1 + 50,
        }),
        mockTrade({
          tradeId: "core-3",
          marketId: 2,
          marketSymbol: "BTC",
          side: "SELL",
          size: 0.1,
          price: 60000,
          usdValue: 6000,
          timestampMs: t0 + 50,
        }),
      ];

      const matchRes = matchHedgeTrades(rhTrades, coreTrades);
      expect(matchRes.pairs.length).toBe(3);

      const stats = calculateMarketSummaryStats(
        matchRes.pairs,
        matchRes.unhedged,
        rhTrades,
        coreTrades,
      );

      expect(stats.length).toBe(2);

      // ETH has 2 pairs (RH volume: $6000 + $6020 = $12020), BTC has 1 pair (RH volume: $6000)
      // Sorted by volume descending: ETH first, then BTC
      const ethStat = stats.find((s) => s.marketSymbol === "ETH")!;
      expect(ethStat).toBeDefined();
      expect(ethStat.pairsCount).toBe(2);
      expect(ethStat.transactionsCount).toBe(2);
      expect(ethStat.volumeUsd).toBeCloseTo(12020, 0);
      expect(ethStat.avgVolumeSizeUsd).toBeCloseTo(6010, 0);
      expect(ethStat.avgHoldingDurationMs).toBe(15 * 60 * 1000);

      const btcStat = stats.find((s) => s.marketSymbol === "BTC")!;
      expect(btcStat).toBeDefined();
      expect(btcStat.pairsCount).toBe(1);
      expect(btcStat.transactionsCount).toBe(1);
      expect(btcStat.volumeUsd).toBeCloseTo(6000, 0);
      expect(btcStat.avgVolumeSizeUsd).toBeCloseTo(6000, 0);
    });

    it("calculateMarketSummaryStats correctly includes unhedged trades in volume and tx counts", () => {
      const t0 = 1727863200000;
      const rhTrades: ParsedTradeView[] = [
        mockTrade({
          tradeId: "rh-1",
          marketId: 3,
          marketSymbol: "SOL",
          side: "BUY",
          size: 10,
          price: 150,
          usdValue: 1500,
          timestampMs: t0,
        }),
      ];

      // No core trades -> SOL is unhedged
      const matchRes = matchHedgeTrades(rhTrades, []);
      expect(matchRes.unhedged.length).toBe(1);

      const stats = calculateMarketSummaryStats(matchRes.pairs, matchRes.unhedged, rhTrades, []);

      expect(stats.length).toBe(1);
      const solStat = stats[0];
      expect(solStat.marketSymbol).toBe("SOL");
      expect(solStat.pairsCount).toBe(0);
      expect(solStat.unhedgedCount).toBe(1);
      expect(solStat.transactionsCount).toBe(1);
      expect(solStat.volumeUsd).toBe(1500);
      expect(solStat.avgVolumeSizeUsd).toBe(1500);
    });

    it("renderMarketSummaryCards displays empty state when no stats provided", () => {
      const container = { innerHTML: "", querySelectorAll: () => [] } as unknown as HTMLElement;
      renderMarketSummaryCards(container, []);
      expect(container.innerHTML).toContain("No token activity for selected period");
    });

    it("renderMarketSummaryCards renders styled token cards with volume, tx count, avg hold and avg size", () => {
      const container = { innerHTML: "", querySelectorAll: () => [] } as unknown as HTMLElement;
      const stats: MarketSummaryStat[] = [
        {
          marketSymbol: "ETH",
          volumeUsd: 145000,
          transactionsCount: 18,
          avgVolumeSizeUsd: 8055.56,
          avgHoldingDurationMs: 14 * 60 * 1000 + 22 * 1000,
          pairsCount: 18,
          unhedgedCount: 0,
        },
      ];

      renderMarketSummaryCards(container, stats);

      const html = container.innerHTML;
      expect(html).toContain("ETH");
      expect(html).toContain("18 txs");
      expect(html).toContain("$145.0K");
      expect(html).toContain("Avg Hold");
      expect(html).toContain("14m");
      expect(html).toContain("Avg Size");
      expect(html).toContain("$8.1k");
    });

    it("renderMarketSummaryCards renders total row with Σ, sums, spacer row, and handles total row click", () => {
      let totalClickHandler: (() => void) | null = null;
      const fakeTotalRow = {
        addEventListener: (event: string, handler: () => void) => {
          if (event === "click") totalClickHandler = handler;
        },
      };

      let renderedHtml = "";
      const container = {
        get innerHTML() {
          return renderedHtml;
        },
        set innerHTML(val: string) {
          renderedHtml = val;
        },
        querySelectorAll: () => [],
        querySelector: (sel: string) => {
          if (sel === "tr[data-market-total]") return fakeTotalRow;
          return null;
        },
      } as unknown as HTMLElement;

      const stats: MarketSummaryStat[] = [
        {
          marketSymbol: "NVDA",
          volumeUsd: 100000,
          transactionsCount: 10,
          avgVolumeSizeUsd: 10000,
          avgHoldingDurationMs: 60000,
          pairsCount: 10,
          unhedgedCount: 0,
          realizedPnlUsd: -150,
        },
        {
          marketSymbol: "AAPL",
          volumeUsd: 50000,
          transactionsCount: 5,
          avgVolumeSizeUsd: 10000,
          avgHoldingDurationMs: 30000,
          pairsCount: 5,
          unhedgedCount: 0,
          realizedPnlUsd: 50,
        },
      ];

      let clickedToken = "initial";
      renderMarketSummaryCards(container, stats, "NVDA", (sym) => {
        clickedToken = sym;
      });

      expect(renderedHtml).toContain("<tfoot");
      expect(renderedHtml).toContain('data-market-total="true"');
      expect(renderedHtml).toContain("Total (2)");
      expect(renderedHtml).toContain("Σ");
      expect(renderedHtml).toContain("$150.0K"); // 100k + 50k
      expect(renderedHtml).toContain("15 txs"); // 10 + 5
      expect(renderedHtml).toContain("spacer-row");
      expect(renderedHtml).toContain("-$100.00"); // -150 + 50

      // Click total row
      expect(totalClickHandler).not.toBeNull();
      totalClickHandler!();
      expect(clickedToken).toBe(""); // resets filter
    });

    it("renderMarketSummaryCards handles click callback and activeMarketFilter highlighting", () => {
      let clickHandler: (() => void) | null = null;
      const fakeCard = {
        getAttribute: (attr: string) => (attr === "data-market" ? "ETH" : null),
        addEventListener: (event: string, handler: () => void) => {
          if (event === "click") clickHandler = handler;
        },
      };

      const container = {
        innerHTML: "",
        querySelectorAll: () => [fakeCard],
      } as unknown as HTMLElement;

      const stats: MarketSummaryStat[] = [
        {
          marketSymbol: "ETH",
          volumeUsd: 50000,
          transactionsCount: 5,
          avgVolumeSizeUsd: 10000,
          avgHoldingDurationMs: 60000,
          pairsCount: 5,
          unhedgedCount: 0,
        },
      ];

      let clickedToken = "";
      renderMarketSummaryCards(container, stats, "ETH", (sym) => {
        clickedToken = sym;
      });

      // Active row selection style applied (matching trades table)
      expect(container.innerHTML).toContain("bg-white/10");
      // Avg Hold text color uses text-terminal-secondary (gray), not cyan/blue accent
      expect(container.innerHTML).not.toContain("text-terminal-accent font-semibold");

      // Verify click callback works
      expect(clickHandler).not.toBeNull();
      clickHandler!();
      expect(clickedToken).toBe("ETH");
    });

    it("sortMarketSummaryStats sorts correctly by multiple columns and directions", () => {
      const stats: MarketSummaryStat[] = [
        {
          marketSymbol: "SOL",
          volumeUsd: 15000,
          transactionsCount: 20,
          avgVolumeSizeUsd: 750,
          avgHoldingDurationMs: 30000,
          pairsCount: 20,
          unhedgedCount: 0,
          realizedPnlUsd: 100,
        },
        {
          marketSymbol: "ETH",
          volumeUsd: 50000,
          transactionsCount: 5,
          avgVolumeSizeUsd: 10000,
          avgHoldingDurationMs: 120000,
          pairsCount: 5,
          unhedgedCount: 0,
          realizedPnlUsd: -50,
        },
        {
          marketSymbol: "BTC",
          volumeUsd: 30000,
          transactionsCount: 10,
          avgVolumeSizeUsd: 3000,
          avgHoldingDurationMs: 60000,
          pairsCount: 10,
          unhedgedCount: 0,
          realizedPnlUsd: 25,
        },
      ];

      // Default: volumeUsd descending
      const byVolDesc = sortMarketSummaryStats([...stats], "volumeUsd", "desc");
      expect(byVolDesc.map((s) => s.marketSymbol)).toEqual(["ETH", "BTC", "SOL"]);

      // volumeUsd ascending
      const byVolAsc = sortMarketSummaryStats([...stats], "volumeUsd", "asc");
      expect(byVolAsc.map((s) => s.marketSymbol)).toEqual(["SOL", "BTC", "ETH"]);

      // transactionsCount descending
      const byTxsDesc = sortMarketSummaryStats([...stats], "transactionsCount", "desc");
      expect(byTxsDesc.map((s) => s.marketSymbol)).toEqual(["SOL", "BTC", "ETH"]);

      // marketSymbol ascending (alphabetical)
      const bySymAsc = sortMarketSummaryStats([...stats], "marketSymbol", "asc");
      expect(bySymAsc.map((s) => s.marketSymbol)).toEqual(["BTC", "ETH", "SOL"]);

      // avgHoldingDurationMs descending
      const byHoldDesc = sortMarketSummaryStats([...stats], "avgHoldingDurationMs", "desc");
      expect(byHoldDesc.map((s) => s.marketSymbol)).toEqual(["ETH", "BTC", "SOL"]);

      // realizedPnlUsd descending
      const byPnlDesc = sortMarketSummaryStats([...stats], "realizedPnlUsd", "desc");
      expect(byPnlDesc.map((s) => s.marketSymbol)).toEqual(["SOL", "BTC", "ETH"]);
    });

    it("renderMarketSummaryCards displays sort indicators ▲ and ▼ and triggers onSortClick", () => {
      let headerClickHandler: (() => void) | null = null;
      const fakeHeader = {
        getAttribute: (attr: string) => (attr === "data-sort" ? "volumeUsd" : null),
        addEventListener: (event: string, handler: () => void) => {
          if (event === "click") headerClickHandler = handler;
        },
      };

      const container = {
        innerHTML: "",
        querySelectorAll: (selector: string) => (selector === "th[data-sort]" ? [fakeHeader] : []),
      } as unknown as HTMLElement;

      const stats: MarketSummaryStat[] = [
        {
          marketSymbol: "ETH",
          volumeUsd: 50000,
          transactionsCount: 5,
          avgVolumeSizeUsd: 10000,
          avgHoldingDurationMs: 60000,
          pairsCount: 5,
          unhedgedCount: 0,
        },
      ];

      let sortedColumn = "";
      renderMarketSummaryCards(container, stats, null, undefined, "volumeUsd", "desc", (col) => {
        sortedColumn = col;
      });

      // Contains descending indicator ▼ on active volumeUsd column
      expect(container.innerHTML).toContain("▼");
      expect(container.innerHTML).toContain('data-sort="volumeUsd"');

      // Test click callback
      expect(headerClickHandler).not.toBeNull();
      headerClickHandler!();
      expect(sortedColumn).toBe("volumeUsd");

      // Now test ascending indicator ▲
      renderMarketSummaryCards(container, stats, null, undefined, "volumeUsd", "asc");
      expect(container.innerHTML).toContain("▲");
    });

    it("calculateSelectedHedgeMetrics and updateHedgeSelectionMetrics display correct HUD when market rows are selected", () => {
      const ethPair1: HedgePair = {
        id: "hedge-1",
        marketSymbol: "ETH",
        matchedSize: 2,
        rhTradeId: "1",
        rhSide: "BUY",
        rhPrice: 3000,
        rhSize: 2,
        rhFeeUsd: 1.5,
        rhTimestampMs: 1000,
        rhTimeFormatted: "12:00:00",
        rhTxHash: "0x1",
        rhRole: "TAKER",
        coreTradeId: "2",
        coreSide: "SELL",
        corePrice: 3010,
        coreSize: 2,
        coreFeeUsd: 1.5,
        coreTimestampMs: 1001,
        coreTimeFormatted: "12:00:01",
        coreTxHash: "0x2",
        coreRole: "MAKER",
        buyPrice: 3000,
        sellPrice: 3010,
        priceDelta: 10,
        pricePnlUsd: 20,
        totalFeesUsd: 3,
        netPnlUsd: 17,
        notionalUsd: 6010,
        pnlBps: 28.28,
        timeDeltaSec: 1,
        status: "HEDGED",
      };

      const btcPair: HedgePair = {
        ...ethPair1,
        id: "hedge-2",
        marketSymbol: "BTC",
        matchedSize: 0.1,
        rhPrice: 60000,
        corePrice: 60100,
        buyPrice: 60000,
        sellPrice: 60100,
        priceDelta: 100,
        pricePnlUsd: 10,
        notionalUsd: 6005,
      };

      const allPairs = [ethPair1, btcPair];

      // Simulate selecting ETH market: only ethPair1 is selected
      const selectedEthPairs = allPairs.filter((p) => p.marketSymbol.toUpperCase() === "ETH");
      expect(selectedEthPairs.length).toBe(1);

      const metrics = calculateSelectedHedgeMetrics(selectedEthPairs, []);
      expect(metrics.selectedCount).toBe(1);
      expect(metrics.pairsCount).toBe(1);
      expect(metrics.isSingleMarket).toBe(true);
      expect(metrics.marketSymbol).toBe("ETH");
      expect(metrics.totalNetPnlUsd).toBe(17);

      const elements = {
        selectionCard: { classList: { remove: () => {}, add: () => {} } },
        countBadge: { textContent: "" },
        pairsCount: { textContent: "" },
        volume: { textContent: "" },
        netPnl: { textContent: "", className: "", title: "" },
        pnlBps: { textContent: "", className: "" },
        weightedDelta: { textContent: "", className: "", title: "" },
        weightedDeltaBps: { textContent: "", className: "" },
        slippage: { textContent: "" },
        fees: { textContent: "" },
        unhedgedCount: { textContent: "" },
      } as any;

      updateHedgeSelectionMetrics(metrics, elements);
      expect(elements.countBadge.textContent).toBe("1 row");
      expect(elements.weightedDelta.title).toContain("(ETH)");
      expect(elements.netPnl.textContent).toContain("$17.00");
    });
  });

  describe("Withdrawals Integration in Hedge Checker", () => {
    it("stitchTradeBatches parses and preserves withdrawal structures", () => {
      const mockWithdrawals = [
        {
          id: "tx-1",
          amount: "500.00",
          amountUsd: 500,
          timestamp: 1720001000,
          timestampMs: 1720001000000,
          status: "completed",
          type: "fast",
          l1_tx_hash: "0xabc123",
          asset_id: 1,
          symbol: "USDG",
          fee: "1.50",
        },
        {
          id: "tx-2",
          amount: "250.00",
          amountUsd: 250,
          timestamp: 1720002000,
          timestampMs: 1720002000000,
          status: "pending",
          type: "secure",
          asset_id: 1,
        },
      ];

      const batch = {
        trades: [],
        accountIndex: 12345,
        network: "rh" as const,
        withdrawals: mockWithdrawals,
      };

      const stitched = stitchTradeBatches([batch]);
      expect(stitched.hasWithdrawals).toBe(true);
      expect(stitched.withdrawals?.length).toBe(2);
      expect(stitched.withdrawals![0].amountUsd).toBe(250);
      expect(stitched.withdrawals![1].amountUsd).toBe(500);
      expect(stitched.withdrawals![1].symbol).toBe("USDG");
      expect(stitched.withdrawals![1].status).toBe("completed");
      expect(stitched.withdrawals![1].type).toBe("fast");
    });

    it("stitchTradeBatches deduplicates withdrawals across multiple batches", () => {
      const batch1 = {
        trades: [
          {
            trade_id: 1,
            trade_id_str: "1",
            market_id: 1,
            size: 1,
            price: 100,
            usd_amount: 100,
            timestamp: 1720000000,
            side: "BUY" as const,
          } as unknown as LighterTrade,
        ],
        accountIndex: 123,
        accountIndices: [123],
        network: "rh" as const,
        withdrawals: [
          {
            id: "w-1",
            amount: "100",
            amountUsd: 100,
            timestamp: 1720000000,
            timestampMs: 1720000000000,
            status: "completed",
            type: "fast",
            asset_id: 1,
            symbol: "USDG",
          },
        ],
      };

      const batch2 = {
        trades: [
          {
            trade_id: 2,
            trade_id_str: "2",
            market_id: 1,
            size: 1,
            price: 100,
            usd_amount: 100,
            timestamp: 1720000100,
            side: "BUY" as const,
          } as unknown as LighterTrade,
        ],
        accountIndex: 123,
        accountIndices: [123],
        network: "rh" as const,
        withdrawals: [
          {
            id: "w-1", // duplicate
            amount: "100",
            amountUsd: 100,
            timestamp: 1720000000,
            timestampMs: 1720000000000,
            status: "completed",
            type: "fast",
            asset_id: 1,
            symbol: "USDG",
          },
          {
            id: "w-2",
            amount: "200",
            amountUsd: 200,
            timestamp: 1720005000,
            timestampMs: 1720005000000,
            status: "completed",
            type: "secure",
            asset_id: 1,
            symbol: "USDG",
          },
        ],
      };

      const stitched = stitchTradeBatches([batch1, batch2]);
      expect(stitched.hasWithdrawals).toBe(true);
      expect(stitched.withdrawals?.length).toBe(2);
      // Chronological descending: w-2 (1720005000000) should be first, w-1 second
      expect(stitched.withdrawals![0].id).toBe("w-2");
      expect(stitched.withdrawals![1].id).toBe("w-1");
    });

    it("calculateHedgeMetrics subtracts valid withdrawal fees from totalNetPnlUsd and ignores failed/refunded", () => {
      const pair: HedgePair = {
        id: "hedge-1",
        marketSymbol: "ETH",
        matchedSize: 1,
        rhTradeId: "rh-1",
        rhSide: "BUY",
        rhPrice: 3000,
        rhSize: 1,
        rhFeeUsd: 1.5,
        rhTimestampMs: 1000,
        rhTimeFormatted: "10:00:00",
        rhTxHash: "0x1",
        rhRole: "TAKER",
        coreTradeId: "core-1",
        coreSide: "SELL",
        corePrice: 3010,
        coreSize: 1,
        coreFeeUsd: 1.5,
        coreTimestampMs: 1000,
        coreTimeFormatted: "10:00:00",
        coreTxHash: "0x2",
        coreRole: "MAKER",
        buyPrice: 3000,
        sellPrice: 3010,
        priceDelta: 10,
        pricePnlUsd: 10, // +$10 slippage
        totalFeesUsd: 3, // -$3 fees
        netPnlUsd: 7, // without withdrawals: $7
        notionalUsd: 3005,
        pnlBps: 23.29,
        timeDeltaSec: 0,
        status: "HEDGED",
      };

      const rhWithdrawals: WithdrawalRecord[] = [
        {
          id: "rh-w-1",
          amount: "50",
          amountUsd: 50,
          fee: "1.5",
          feeUsd: 1.5,
          timestamp: 1000,
          timestampMs: 1000000,
          status: "completed",
          type: "fast",
          asset_id: 1,
        },
        {
          id: "rh-w-2",
          amount: "100",
          amountUsd: 100,
          fee: "2.0",
          feeUsd: 2.0,
          timestamp: 2000,
          timestampMs: 2000000,
          status: "failed", // Should be ignored
          type: "fast",
          asset_id: 1,
        },
      ];

      const coreWithdrawals: WithdrawalRecord[] = [
        {
          id: "core-w-1",
          amount: "20",
          amountUsd: 20,
          fee: "0.5",
          feeUsd: 0.5,
          timestamp: 3000,
          timestampMs: 3000000,
          status: "completed",
          type: "secure",
          asset_id: 3,
        },
        {
          id: "core-w-2",
          amount: "30",
          amountUsd: 30,
          fee: "1.0",
          feeUsd: 1.0,
          timestamp: 4000,
          timestampMs: 4000000,
          status: "refunded", // Should be ignored
          type: "secure",
          asset_id: 3,
        },
      ];

      const metrics = calculateHedgeMetrics([pair], [], 100, 200, 1, 1, [100], [200], {
        rhWithdrawals,
        coreWithdrawals,
      });

      expect(metrics.rhTotalWithdrawalsUsd).toBe(50);
      expect(metrics.coreTotalWithdrawalsUsd).toBe(20);
      expect(metrics.totalWithdrawalsUsd).toBe(70);
      expect(metrics.rhTotalWithdrawalFeesUsd).toBe(1.5);
      expect(metrics.coreTotalWithdrawalFeesUsd).toBe(0.5);
      expect(metrics.totalWithdrawalFeesUsd).toBe(2.0);
      expect(metrics.withdrawalsCount).toBe(2);
      // Net PnL = Price PnL ($10) + Funding ($0) - Fees ($3) - Withdrawal Fees ($2) = $5
      expect(metrics.totalNetPnlUsd).toBe(5);
    });

    it("updateHedgeExecutiveMetrics updates withdrawals with separate RH and Core counts", () => {
      const elements = {
        accountsBadge: { innerHTML: "", textContent: "" },
        pairsCount: { textContent: "" },
        hedgedVolume: { textContent: "" },
        netPnl: { textContent: "", className: "", title: "" },
        slippage: { textContent: "" },
        fees: { textContent: "" },
        funding: { textContent: "", className: "", title: "" },
        withdrawals: { textContent: "", className: "", title: "" },
        unhedgedCount: { textContent: "" },
        avgOi: { textContent: "", className: "", title: "" },
      } as any;

      const mockMetrics = {
        totalPairs: 1,
        totalHedgedVolumeUsd: 1000,
        totalNetPnlUsd: 2,
        totalPricePnlUsd: 10,
        totalFeesUsd: 5,
        totalFundingUsd: null,
        hasAnyFunding: false,
        totalWithdrawalsUsd: 70,
        totalWithdrawalFeesUsd: 3,
        rhTotalWithdrawalFeesUsd: 2,
        coreTotalWithdrawalFeesUsd: 1,
        withdrawalsCount: 3,
        rhWithdrawalsCount: 2,
        coreWithdrawalsCount: 1,
        totalUnhedgedTrades: 0,
        unhedgedVolumeUsd: 0,
        unhedgedFeesUsd: 0,
        unhedgedRealizedPnlUsd: 0,
        totalVolumeUsd: 1000,
        overallNetPnlUsd: 2,
        overallPnlBps: 20,
        winCount: 1,
        lossCount: 0,
        winRatePercent: 100,
        bestPairPnlUsd: 2,
        worstPairPnlUsd: 2,
        avgHoldDurationSec: 0,
        firstTradeTime: 1000,
        lastTradeTime: 2000,
        rhTradesCount: 1,
        coreTradesCount: 1,
      } as any;

      updateHedgeExecutiveMetrics(mockMetrics, elements);
      expect(elements.withdrawals.textContent).toBe("RH: 2 / Core: 1");
      expect(elements.withdrawals.title).toContain(
        "Withdrawals: RH: 2, Core: 1 · Total Fee: $3.00",
      );
      expect(elements.netPnl.title).toContain("- Withdraw Fees: $3.00");
    });

    it("updateIndividualAccountMetrics updates withdrawals with count", () => {
      const elements = {
        accountBadge: { textContent: "", className: "" },
        tradesCount: { textContent: "" },
        volume: { textContent: "" },
        realizedPnl: { textContent: "", className: "" },
        fees: { textContent: "" },
        funding: { textContent: "", className: "", title: "" },
        withdrawals: { textContent: "", className: "", title: "" },
        unhedgedCount: { textContent: "", className: "" },
        avgOi: { textContent: "", className: "", title: "" },
        dailySummary: { innerHTML: "" },
      } as any;

      const mockMetrics = {
        accountIndex: 31704,
        network: "RH" as const,
        tradesCount: 10,
        totalVolumeUsd: 5000,
        realizedPnlUsd: 120,
        totalFeesUsd: 15,
        totalFundingUsd: null,
        totalWithdrawalsUsd: 50,
        totalWithdrawalFeesUsd: 1.5,
        withdrawalsCount: 2,
        unhedgedCount: 0,
      } as any;

      updateIndividualAccountMetrics(mockMetrics, elements);
      expect(elements.withdrawals.textContent).toBe("2");
      expect(elements.withdrawals.title).toBe("RH Withdrawals: 2 (Fee: $1.50)");
    });
  });

  describe("Weekly Points Analysis", () => {
    const baseMetrics = {
      rhVolumeUsd: 100000,
      rhAvgOiUsd: 5000,
      totalNetPnlUsd: -50,
      totalFeesUsd: 35,
    };

    it("returns nulls when points is null, undefined, 0, or negative", () => {
      expect(calculateWeeklyPointsAnalysis(baseMetrics, null)).toEqual({
        volPerPoint: null,
        oiPerPoint: null,
        costPerPoint: null,
        isProfitable: false,
        feesPerPoint: null,
        ratePer1kVol: null,
      });

      expect(calculateWeeklyPointsAnalysis(baseMetrics, undefined).volPerPoint).toBeNull();
      expect(calculateWeeklyPointsAnalysis(baseMetrics, 0).volPerPoint).toBeNull();
      expect(calculateWeeklyPointsAnalysis(baseMetrics, -100).volPerPoint).toBeNull();
      expect(calculateWeeklyPointsAnalysis(baseMetrics, NaN).volPerPoint).toBeNull();
    });

    it("calculates exact unit metrics for user-entered points", () => {
      const res = calculateWeeklyPointsAnalysis(baseMetrics, 1000);
      expect(res.volPerPoint).toBe(100); // $100k / 1k = $100
      expect(res.oiPerPoint).toBe(5); // $5k / 1k = $5
      expect(res.costPerPoint).toBe(0.05); // $50 / 1k = $0.05
      expect(res.isProfitable).toBe(false);
      expect(res.feesPerPoint).toBe(0.035); // $35 / 1k = $0.035
      expect(res.ratePer1kVol).toBe(10); // (1000 / 100000) * 1000 = 10 pts / $1k
    });

    it("flags positive net PnL as profitable", () => {
      const profitMetrics = {
        ...baseMetrics,
        totalNetPnlUsd: 25,
      };
      const res = calculateWeeklyPointsAnalysis(profitMetrics, 500);
      expect(res.isProfitable).toBe(true);
      expect(res.costPerPoint).toBe(0.05); // $25 / 500 = $0.05
    });

    it("handles zero volume and zero OI gracefully", () => {
      const zeroMetrics = {
        rhVolumeUsd: 0,
        rhAvgOiUsd: 0,
        totalNetPnlUsd: 0,
        totalFeesUsd: 0,
      };
      const res = calculateWeeklyPointsAnalysis(zeroMetrics, 100);
      expect(res.volPerPoint).toBe(0);
      expect(res.oiPerPoint).toBe(0);
      expect(res.costPerPoint).toBe(0);
      expect(res.feesPerPoint).toBe(0);
      expect(res.ratePer1kVol).toBeNull();
    });

    it("updates DOM elements via updateWeeklyPointsCard properly", () => {
      const classList = {
        classes: new Set<string>(["hidden"]),
        add(c: string) {
          this.classes.add(c);
        },
        remove(c: string) {
          this.classes.delete(c);
        },
        contains(c: string) {
          return this.classes.has(c);
        },
      };

      const elements: WeeklyPointsElements = {
        container: { classList } as any,
        title: { textContent: "" } as HTMLElement,
        inputPoints: { value: "" } as HTMLInputElement,
        volPerPoint: { textContent: "", title: "" } as HTMLElement,
        oiPerPoint: { textContent: "", title: "" } as HTMLElement,
        costPerPoint: { textContent: "", className: "", title: "" } as HTMLElement,
        feesPerPoint: { textContent: "", title: "" } as HTMLElement,
        ratePer1k: { textContent: "", title: "" } as HTMLElement,
      };

      // 1. Should hide when weekNumber is null or 0
      updateWeeklyPointsCard(null, baseMetrics, 1000, elements);
      expect(classList.contains("hidden")).toBe(true);

      updateWeeklyPointsCard(0, baseMetrics, 1000, elements);
      expect(classList.contains("hidden")).toBe(true);

      // 2. Should show when weekNumber is valid, but show placeholders when no points entered
      updateWeeklyPointsCard(3, baseMetrics, null, elements);
      expect(classList.contains("hidden")).toBe(false);
      expect(elements.title?.textContent).toBe("Week 3:");
      expect(elements.volPerPoint?.textContent).toBe("--");
      expect(elements.costPerPoint?.textContent).toBe("--");
      expect(elements.costPerPoint?.className).toContain("text-terminal-muted");

      // 3. Should calculate and populate values when points entered (loss case)
      updateWeeklyPointsCard(3, baseMetrics, 1000, elements);
      expect(elements.volPerPoint?.textContent).toBe("$100.00");
      expect(elements.oiPerPoint?.textContent).toBe("$5.00");
      expect(elements.costPerPoint?.textContent).toBe("$0.0500");
      expect(elements.costPerPoint?.className).toContain("text-white");
      expect(elements.feesPerPoint?.textContent).toBe("$0.0350");
      expect(elements.ratePer1k?.textContent).toBe("10.0");

      // 4. Should populate profit case with + and emerald color
      const profitMetrics = { ...baseMetrics, totalNetPnlUsd: 12.5 };
      updateWeeklyPointsCard(3, profitMetrics, 1000, elements);
      expect(elements.costPerPoint?.textContent).toBe("+$0.0125");
      expect(elements.costPerPoint?.className).toContain("text-terminal-emerald");

      // 5. Should handle tiny micro point prices with high precision
      const microMetrics = { ...baseMetrics, totalNetPnlUsd: -0.05 };
      updateWeeklyPointsCard(3, microMetrics, 1000, elements);
      expect(elements.costPerPoint?.textContent).toBe("$0.000050");
    });

    it("getParticipatingWeeksStats detects only promo weeks with user trade activity", () => {
      const promoWeeks = getRobinhoodPromoWeeks();
      const w1 = promoWeeks[0];
      const w2 = promoWeeks[1];

      const tradeW1: ParsedTradeView = {
        tradeId: "t1",
        userAccountId: 100,
        marketSymbol: "ETH",
        side: "BUY",
        price: 2500,
        size: 2,
        usdValue: 5000,
        fee: 5,
        timestampMs: w1.startTimestampMs! + 1000,
        timeFormatted: "",
        txHash: "0x1",
        isMaker: true,
      } as any;

      const tradeW2: ParsedTradeView = {
        tradeId: "t2",
        userAccountId: 100,
        marketSymbol: "ETH",
        side: "SELL",
        price: 2600,
        size: 2,
        usdValue: 5200,
        fee: 5,
        timestampMs: w2.startTimestampMs! + 5000,
        timeFormatted: "",
        txHash: "0x2",
        isMaker: false,
      } as any;

      const params = {
        allHedgePairs: [],
        allUnhedgedTrades: [],
        rhParsedTrades: [tradeW1, tradeW2],
        coreParsedTrades: [],
        rhAccountIndex: 100,
        coreAccountIndex: null,
        nowMs: w2.endTimestampMs! + 10000,
        pointsByWeek: {
          1: 1000,
          2: 2000,
        },
      };

      const participating = getParticipatingWeeksStats(params);
      expect(participating.length).toBe(2);
      expect(participating[0].weekNumber).toBe(1);
      expect(participating[0].rhVolumeUsd).toBe(5000);
      expect(participating[0].points).toBe(1000);
      expect(participating[0].analysis.volPerPoint).toBe(5);

      expect(participating[1].weekNumber).toBe(2);
      expect(participating[1].rhVolumeUsd).toBe(5200);
      expect(participating[1].points).toBe(2000);
      expect(participating[1].analysis.volPerPoint).toBe(2.6);
    });

    it("getParticipatingWeeksStats returns empty array when no trades match promo weeks", () => {
      const outsideTrade: ParsedTradeView = {
        tradeId: "t-old",
        userAccountId: 100,
        marketSymbol: "ETH",
        side: "BUY",
        price: 2500,
        size: 1,
        usdValue: 2500,
        fee: 2.5,
        timestampMs: Date.parse("2025-01-01T00:00:00Z"),
        timeFormatted: "",
        txHash: "0xold",
        isMaker: true,
      } as any;

      const participating = getParticipatingWeeksStats({
        allHedgePairs: [],
        allUnhedgedTrades: [],
        rhParsedTrades: [outsideTrade],
        coreParsedTrades: [],
        rhAccountIndex: 100,
        coreAccountIndex: null,
      });

      expect(participating.length).toBe(0);
    });

    it("renderWeeklyPointsTable renders table rows, handles events, and reuses DOM", () => {
      const containerClassList = new Set<string>(["hidden"]);
      const container = {
        classList: {
          add: (c: string) => containerClassList.add(c),
          remove: (c: string) => containerClassList.delete(c),
          contains: (c: string) => containerClassList.has(c),
        },
      } as any;

      const count = { textContent: "" } as HTMLElement;

      const rowClickListeners: Record<number, (e: any) => void> = {};
      const inputListeners: Record<number, (e: any) => void> = {};
      let renderedHtml = "";

      const makeRowMock = (weekNum: number) => {
        const classNames = new Set<string>(["hover:bg-terminal-surfaceHover/80"]);
        const inputObj = {
          value: "",
          addEventListener: (event: string, handler: any) => {
            if (event === "input") inputListeners[weekNum] = handler;
          },
        };
        const metricEl = { textContent: "", className: "", parentElement: { title: "" } };

        return {
          dataset: { week: String(weekNum) },
          get className() {
            return Array.from(classNames).join(" ");
          },
          classList: {
            add: (...classes: string[]) => classes.forEach((c) => classNames.add(c)),
            remove: (...classes: string[]) => classes.forEach((c) => classNames.delete(c)),
            contains: (c: string) => classNames.has(c),
          },
          addEventListener: (event: string, handler: any) => {
            if (event === "click") rowClickListeners[weekNum] = handler;
          },
          querySelector: (sel: string) => {
            if (sel === "input") return inputObj;
            return metricEl;
          },
        };
      };

      let existingMockRows: any[] = [];
      const attrs = new Map<string, string>();

      const tableContainer = {
        get innerHTML() {
          return renderedHtml;
        },
        set innerHTML(val: string) {
          renderedHtml = val;
          existingMockRows = [makeRowMock(1), makeRowMock(2)];
        },
        getAttribute: (name: string) => attrs.get(name) ?? null,
        setAttribute: (name: string, val: string) => attrs.set(name, val),
        querySelectorAll: (selector: string) => {
          if (selector === "tr[data-week]") {
            return existingMockRows;
          }
          return [];
        },
      } as any;

      const elements: WeeklyPointsMultiElements = {
        container,
        count,
        grid: tableContainer,
      };

      const promoWeeks = getRobinhoodPromoWeeks();
      const statsList: WeekActivityStats[] = [
        {
          weekNumber: 1,
          presetId: "week-1",
          label: "Week 1",
          shortLabel: "W1",
          dateRangeFormatted: "Aug 10 – Aug 21",
          startTimestampMs: promoWeeks[0].startTimestampMs!,
          endTimestampMs: promoWeeks[0].endTimestampMs!,
          tradesCount: 10,
          rhVolumeUsd: 100000,
          rhAvgOiUsd: 5000,
          totalNetPnlUsd: -50,
          totalFeesUsd: 35,
          points: 1000,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 100000, rhAvgOiUsd: 5000, totalNetPnlUsd: -50, totalFeesUsd: 35 },
            1000,
          ),
        },
        {
          weekNumber: 2,
          presetId: "week-2",
          label: "Week 2",
          shortLabel: "W2",
          dateRangeFormatted: "Aug 21 – Aug 28",
          startTimestampMs: promoWeeks[1].startTimestampMs!,
          endTimestampMs: promoWeeks[1].endTimestampMs!,
          tradesCount: 15,
          rhVolumeUsd: 200000,
          rhAvgOiUsd: 10000,
          totalNetPnlUsd: 100,
          totalFeesUsd: 50,
          points: null,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 200000, rhAvgOiUsd: 10000, totalNetPnlUsd: 100, totalFeesUsd: 50 },
            null,
          ),
        },
      ];

      let selectedWeek: number | null = null;
      let changedWeek: number | null = null;
      let changedVal: string | null = null;

      // 1. Initial render using renderWeeklyPointsTable directly
      renderWeeklyPointsTable(
        tableContainer,
        statsList,
        1,
        (w, v) => {
          changedWeek = w;
          changedVal = v;
        },
        (w) => {
          selectedWeek = w;
        },
      );

      expect(renderedHtml).toContain("<table");
      expect(renderedHtml).toContain("Week 1");
      expect(renderedHtml).toContain("Week 2");
      expect(renderedHtml).toContain("Vol / Point");
      expect(renderedHtml).toContain("Avg OI / Point");
      expect(renderedHtml).toContain("Point Price");
      expect(renderedHtml).toContain("$100.00"); // Vol / Pt for W1
      expect(renderedHtml).not.toContain("Fees:");
      expect(renderedHtml).not.toContain("Rate:");
      // Input width reduced to w-20
      expect(renderedHtml).toContain("w-20");
      expect(renderedHtml).not.toContain("w-24");
      // Price for cost/loss should be text-white, NOT text-terminal-coral
      expect(renderedHtml).toContain("text-white tabular-nums");
      expect(renderedHtml).not.toContain("text-terminal-coral");

      // Test row click triggering onSelectWeek
      rowClickListeners[2]?.({ target: { tagName: "TD" } });
      expect(Number(selectedWeek)).toBe(2);

      // Test input event triggering onPointsChange
      existingMockRows[1].querySelector("input").value = "3500";
      inputListeners[2]?.({ stopPropagation: () => {} });
      expect(Number(changedWeek)).toBe(2);
      expect(String(changedVal)).toBe("3500");

      // 2. Test DOM reuse when updating statsList
      const row0Before = existingMockRows[0];
      const updatedStatsList = [...statsList];
      updatedStatsList[0] = {
        ...updatedStatsList[0],
        points: 2000,
        analysis: calculateWeeklyPointsAnalysis(
          { rhVolumeUsd: 100000, rhAvgOiUsd: 5000, totalNetPnlUsd: -50, totalFeesUsd: 35 },
          2000,
        ),
      };

      renderWeeklyPointsTable(
        tableContainer,
        updatedStatsList,
        2,
        () => {},
        () => {},
      );

      expect(existingMockRows[0]).toBe(row0Before); // Reused same DOM element!
      expect(existingMockRows[1].classList.contains("bg-white/10")).toBe(true);

      // 3. Test compatibility helper renderWeeklyPointsMultiGrid
      renderWeeklyPointsMultiGrid(
        elements,
        statsList,
        null,
        () => {},
        () => {},
      );
      expect(container.classList.contains("hidden")).toBe(false);
      expect(count.textContent).toBe("(2 weeks active)");

      // 4. Test single week rendering always uses table
      const singleWeekStats: WeekActivityStats[] = [statsList[0]];
      let singleHtml = "";
      const singleContainer = {
        get innerHTML() {
          return singleHtml;
        },
        set innerHTML(val: string) {
          singleHtml = val;
        },
        querySelectorAll: () => [],
        getAttribute: () => null,
        setAttribute: () => {},
      } as any;
      renderWeeklyPointsTable(
        singleContainer,
        singleWeekStats,
        1,
        () => {},
        () => {},
      );
      expect(singleHtml).toContain("<table");
      expect(singleHtml).toContain("Week 1");
      expect(singleHtml).not.toContain("Week 2");
    });

    it("sortWeeklyPointsStats sorts properly by columns and handles null points", () => {
      const promoWeeks = getRobinhoodPromoWeeks();
      const statsList: WeekActivityStats[] = [
        {
          weekNumber: 3,
          presetId: "week-3",
          label: "Week 3",
          shortLabel: "W3",
          dateRangeFormatted: "Aug 28 – Sep 04",
          startTimestampMs: promoWeeks[2].startTimestampMs!,
          endTimestampMs: promoWeeks[2].endTimestampMs!,
          tradesCount: 10,
          rhVolumeUsd: 300000,
          rhAvgOiUsd: 15000,
          totalNetPnlUsd: -150,
          totalFeesUsd: 50,
          points: 1000,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 300000, rhAvgOiUsd: 15000, totalNetPnlUsd: -150, totalFeesUsd: 50 },
            1000,
          ), // vol: 300, oi: 15, cost: 0.15
        },
        {
          weekNumber: 1,
          presetId: "week-1",
          label: "Week 1",
          shortLabel: "W1",
          dateRangeFormatted: "Aug 10 – Aug 21",
          startTimestampMs: promoWeeks[0].startTimestampMs!,
          endTimestampMs: promoWeeks[0].endTimestampMs!,
          tradesCount: 10,
          rhVolumeUsd: 100000,
          rhAvgOiUsd: 5000,
          totalNetPnlUsd: -50,
          totalFeesUsd: 35,
          points: 1000,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 100000, rhAvgOiUsd: 5000, totalNetPnlUsd: -50, totalFeesUsd: 35 },
            1000,
          ), // vol: 100, oi: 5, cost: 0.05
        },
        {
          weekNumber: 2,
          presetId: "week-2",
          label: "Week 2",
          shortLabel: "W2",
          dateRangeFormatted: "Aug 21 – Aug 28",
          startTimestampMs: promoWeeks[1].startTimestampMs!,
          endTimestampMs: promoWeeks[1].endTimestampMs!,
          tradesCount: 15,
          rhVolumeUsd: 200000,
          rhAvgOiUsd: 10000,
          totalNetPnlUsd: 100,
          totalFeesUsd: 50,
          points: null,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 200000, rhAvgOiUsd: 10000, totalNetPnlUsd: 100, totalFeesUsd: 50 },
            null,
          ), // null points
        },
      ];

      // Sort by weekNumber asc (default)
      const byWeekAsc = sortWeeklyPointsStats([...statsList], "weekNumber", "asc");
      expect(byWeekAsc.map((s) => s.weekNumber)).toEqual([1, 2, 3]);

      // Sort by weekNumber desc
      const byWeekDesc = sortWeeklyPointsStats([...statsList], "weekNumber", "desc");
      expect(byWeekDesc.map((s) => s.weekNumber)).toEqual([3, 2, 1]);

      // Sort by volPerPoint desc (300, 100, then null)
      const byVolDesc = sortWeeklyPointsStats([...statsList], "volPerPoint", "desc");
      expect(byVolDesc.map((s) => s.weekNumber)).toEqual([3, 1, 2]);

      // Sort by volPerPoint asc (100, 300, then null at bottom)
      const byVolAsc = sortWeeklyPointsStats([...statsList], "volPerPoint", "asc");
      expect(byVolAsc.map((s) => s.weekNumber)).toEqual([1, 3, 2]);

      // Sort by costPerPoint desc (0.15, 0.05, then null)
      const byCostDesc = sortWeeklyPointsStats([...statsList], "costPerPoint", "desc");
      expect(byCostDesc.map((s) => s.weekNumber)).toEqual([3, 1, 2]);

      // Sort by costPerPoint asc (0.05, 0.15, then null at bottom)
      const byCostAsc = sortWeeklyPointsStats([...statsList], "costPerPoint", "asc");
      expect(byCostAsc.map((s) => s.weekNumber)).toEqual([1, 3, 2]);
    });

    it("renderWeeklyPointsTable renders sort indicators and handles header click", () => {
      const promoWeeks = getRobinhoodPromoWeeks();
      const statsList: WeekActivityStats[] = [
        {
          weekNumber: 1,
          presetId: "week-1",
          label: "Week 1",
          shortLabel: "W1",
          dateRangeFormatted: "Aug 10 – Aug 21",
          startTimestampMs: promoWeeks[0].startTimestampMs!,
          endTimestampMs: promoWeeks[0].endTimestampMs!,
          tradesCount: 10,
          rhVolumeUsd: 100000,
          rhAvgOiUsd: 5000,
          totalNetPnlUsd: -50,
          totalFeesUsd: 35,
          points: 1000,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 100000, rhAvgOiUsd: 5000, totalNetPnlUsd: -50, totalFeesUsd: 35 },
            1000,
          ),
        },
      ];

      let sortColClicked: WeeklyPointsSortColumn | null = null;
      let html = "";
      const headerListeners: Record<string, () => void> = {};

      const fakeContainer = {
        get innerHTML() {
          return html;
        },
        set innerHTML(val: string) {
          html = val;
        },
        getAttribute: () => null,
        setAttribute: () => {},
        querySelectorAll: (sel: string) => {
          if (sel === "th[data-sort]") {
            const cols: WeeklyPointsSortColumn[] = [
              "weekNumber",
              "dateRange",
              "points",
              "volPerPoint",
              "oiPerPoint",
              "costPerPoint",
            ];
            return cols.map((col) => ({
              getAttribute: (attr: string) => (attr === "data-sort" ? col : null),
              addEventListener: (ev: string, handler: any) => {
                if (ev === "click") headerListeners[col] = handler;
              },
            }));
          }
          return [];
        },
      } as any;

      renderWeeklyPointsTable(
        fakeContainer,
        statsList,
        null,
        () => {},
        () => {},
        "volPerPoint",
        "desc",
        (col) => {
          sortColClicked = col;
        },
      );

      // Verify that sort indicator ▼ is present
      expect(html).toContain("▼");
      expect(html).toContain('data-sort="volPerPoint"');

      // Click on costPerPoint header
      headerListeners["costPerPoint"]?.();
      expect(sortColClicked as string | null).toBe("costPerPoint");
    });

    it("calculateWeekActivityStats returns null if no trades occurred in week", () => {
      const promoWeeks = getRobinhoodPromoWeeks();
      const w1 = promoWeeks[0];
      const stats = calculateWeekActivityStats(w1, {
        allHedgePairs: [],
        allUnhedgedTrades: [],
        rhParsedTrades: [],
        coreParsedTrades: [],
        rhAccountIndex: null,
        coreAccountIndex: null,
      });
      expect(stats).toBeNull();
    });

    it("calculateWeeklyPointsTotalStats calculates aggregate metrics across all active weeks", () => {
      expect(calculateWeeklyPointsTotalStats([])).toBeNull();

      const promoWeeks = getRobinhoodPromoWeeks();
      const statsList: WeekActivityStats[] = [
        {
          weekNumber: 1,
          presetId: "week-1",
          label: "Week 1",
          shortLabel: "W1",
          dateRangeFormatted: "Aug 10 – Aug 21",
          startTimestampMs: promoWeeks[0].startTimestampMs!,
          endTimestampMs: promoWeeks[0].endTimestampMs!,
          tradesCount: 10,
          rhVolumeUsd: 100000,
          rhAvgOiUsd: 5000,
          totalNetPnlUsd: -50,
          totalFeesUsd: 35,
          points: 1000,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 100000, rhAvgOiUsd: 5000, totalNetPnlUsd: -50, totalFeesUsd: 35 },
            1000,
          ),
        },
        {
          weekNumber: 2,
          presetId: "week-2",
          label: "Week 2",
          shortLabel: "W2",
          dateRangeFormatted: "Aug 21 – Aug 28",
          startTimestampMs: promoWeeks[1].startTimestampMs!,
          endTimestampMs: promoWeeks[1].endTimestampMs!,
          tradesCount: 20,
          rhVolumeUsd: 200000,
          rhAvgOiUsd: 10000,
          totalNetPnlUsd: -100,
          totalFeesUsd: 65,
          points: 2000,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 200000, rhAvgOiUsd: 10000, totalNetPnlUsd: -100, totalFeesUsd: 65 },
            2000,
          ),
        },
      ];

      const totals = calculateWeeklyPointsTotalStats(statsList);
      expect(totals).not.toBeNull();
      expect(totals!.tradesCount).toBe(30);
      expect(totals!.rhVolumeUsd).toBe(300000);
      expect(totals!.rhAvgOiUsd).toBe(15000);
      expect(totals!.totalNetPnlUsd).toBe(-150);
      expect(totals!.totalFeesUsd).toBe(100);
      expect(totals!.points).toBe(3000);
      expect(totals!.dateRangeFormatted).toContain("Aug 10");
      expect(totals!.dateRangeFormatted).toContain("Aug 28");

      // Per-point aggregate analysis:
      // Vol / Point: $300k / 3k pts = $100
      expect(totals!.analysis.volPerPoint).toBe(100);
      // Avg OI / Point: $15k / 3k pts = $5
      expect(totals!.analysis.oiPerPoint).toBe(5);
      // Point Price: $150 loss / 3k pts = $0.05
      expect(totals!.analysis.costPerPoint).toBe(0.05);
      expect(totals!.analysis.isProfitable).toBe(false);
      // Rate: 3k pts / 300k vol * 1000 = 10 pts / $1k
      expect(totals!.analysis.ratePer1kVol).toBe(10);
    });

    it("calculateWeeklyPointsTotalStats handles null points gracefully and flags profit", () => {
      const promoWeeks = getRobinhoodPromoWeeks();
      const statsList: WeekActivityStats[] = [
        {
          weekNumber: 1,
          presetId: "week-1",
          label: "Week 1",
          shortLabel: "W1",
          dateRangeFormatted: "Aug 10 – Aug 21",
          startTimestampMs: promoWeeks[0].startTimestampMs!,
          endTimestampMs: promoWeeks[0].endTimestampMs!,
          tradesCount: 5,
          rhVolumeUsd: 50000,
          rhAvgOiUsd: 2000,
          totalNetPnlUsd: 100, // profit
          totalFeesUsd: 10,
          points: null,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 50000, rhAvgOiUsd: 2000, totalNetPnlUsd: 100, totalFeesUsd: 10 },
            null,
          ),
        },
      ];

      const noPointsTotal = calculateWeeklyPointsTotalStats(statsList);
      expect(noPointsTotal!.points).toBeNull();
      expect(noPointsTotal!.analysis.volPerPoint).toBeNull();
      expect(noPointsTotal!.analysis.costPerPoint).toBeNull();

      // Now with profit points
      statsList[0].points = 500;
      const profitTotal = calculateWeeklyPointsTotalStats(statsList);
      expect(profitTotal!.points).toBe(500);
      expect(profitTotal!.analysis.isProfitable).toBe(true);
      expect(profitTotal!.analysis.costPerPoint).toBe(0.2); // $100 / 500 = $0.20
    });

    it("renderWeeklyPointsTable renders total row in tfoot and handles total row click", () => {
      const promoWeeks = getRobinhoodPromoWeeks();
      const statsList: WeekActivityStats[] = [
        {
          weekNumber: 1,
          presetId: "week-1",
          label: "Week 1",
          shortLabel: "W1",
          dateRangeFormatted: "Aug 10 – Aug 21",
          startTimestampMs: promoWeeks[0].startTimestampMs!,
          endTimestampMs: promoWeeks[0].endTimestampMs!,
          tradesCount: 10,
          rhVolumeUsd: 100000,
          rhAvgOiUsd: 5000,
          totalNetPnlUsd: -50,
          totalFeesUsd: 35,
          points: 1000,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 100000, rhAvgOiUsd: 5000, totalNetPnlUsd: -50, totalFeesUsd: 35 },
            1000,
          ),
        },
        {
          weekNumber: 2,
          presetId: "week-2",
          label: "Week 2",
          shortLabel: "W2",
          dateRangeFormatted: "Aug 21 – Aug 28",
          startTimestampMs: promoWeeks[1].startTimestampMs!,
          endTimestampMs: promoWeeks[1].endTimestampMs!,
          tradesCount: 20,
          rhVolumeUsd: 200000,
          rhAvgOiUsd: 10000,
          totalNetPnlUsd: -100,
          totalFeesUsd: 65,
          points: 2000,
          analysis: calculateWeeklyPointsAnalysis(
            { rhVolumeUsd: 200000, rhAvgOiUsd: 10000, totalNetPnlUsd: -100, totalFeesUsd: 65 },
            2000,
          ),
        },
      ];

      let selectedWeekNum: number | null = null;
      let totalRowClickHandler: (() => void) | null = null;
      let renderedHtml = "";

      const fakeContainer = {
        get innerHTML() {
          return renderedHtml;
        },
        set innerHTML(val: string) {
          renderedHtml = val;
        },
        getAttribute: () => null,
        setAttribute: () => {},
        querySelectorAll: () => [],
        querySelector: (sel: string) => {
          if (sel === "tr[data-total-row]") {
            return {
              addEventListener: (ev: string, handler: any) => {
                if (ev === "click") totalRowClickHandler = handler;
              },
            };
          }
          return null;
        },
      } as any;

      renderWeeklyPointsTable(
        fakeContainer,
        statsList,
        1,
        () => {},
        (wNum) => {
          selectedWeekNum = wNum;
        },
      );

      // Verify Total row in tfoot
      expect(renderedHtml).toContain("<tfoot");
      expect(renderedHtml).toContain('data-total-row="true"');
      expect(renderedHtml).toContain("Total");
      expect(renderedHtml).toContain("Σ");
      expect(renderedHtml).toContain("val-total-points");
      expect(renderedHtml).toContain("3,000"); // 1000 + 2000 points
      expect(renderedHtml).toContain("$100.00"); // $300k / 3k pts = $100

      // Click on total row
      expect(totalRowClickHandler).not.toBeNull();
      totalRowClickHandler!();
      expect(Number(selectedWeekNum)).toBe(0); // Selects 0 (resets to all weeks)
    });
  });
});
