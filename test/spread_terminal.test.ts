import { describe, expect, it } from "bun:test";
import { formatMoney, formatPrice, formatBps, formatBaseQty, formatDeltaMid } from "../web/src/formatters";
import { getOrCreateBook, updateBookFromWs, getSortedLevels } from "../web/src/orderbook";
import { simulateFillBase } from "../web/src/simulation";
import { calculateMarketMetrics, getMetrics } from "../web/src/metrics";
import type { MarketInfo, OrderBook, TerminalState } from "../web/src/types";

describe("Spread Terminal: Formatters", () => {
  it("formats positive, zero, and negative money correctly", () => {
    expect(formatMoney(10.5)).toBe("$10.50");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(-3.2)).toBe("-$3.20");
    expect(formatMoney(-0.05)).toBe("-$0.05");
    expect(formatMoney(1500)).toBe("$1.5K");
    expect(formatMoney(2500000)).toBe("$2.50M");
    expect(formatMoney(null)).toBe("$0.00");
    expect(formatMoney(NaN)).toBe("$0.00");
  });

  it("formats prices dynamically based on magnitude", () => {
    expect(formatPrice(0.0045)).toBe("$0.0045");
    expect(formatPrice(2.456)).toBe("$2.456");
    expect(formatPrice(125.5)).toBe("$125.50");
    expect(formatPrice(null)).toBe("$0.00");
  });

  it("formats basis points with and without sign", () => {
    expect(formatBps(5.25)).toBe("5.25 bps");
    expect(formatBps(5.25, true)).toBe("+5.25 bps");
    expect(formatBps(-3.1, true)).toBe("-3.10 bps");
    expect(formatBps(0)).toBe("0.00 bps");
  });

  it("formats base qty cleanly", () => {
    expect(formatBaseQty(150.25)).toBe("150.3");
    expect(formatBaseQty(4.567)).toBe("4.57");
    expect(formatBaseQty(0.0234)).toBe("0.0234");
    expect(formatBaseQty(0)).toBe("0.0");
  });

  it("formats delta mid correctly", () => {
    expect(formatDeltaMid(0.05, 5)).toBe("Δ: +$0.050");
    expect(formatDeltaMid(-1.25, -12)).toBe("Δ: -$1.25");
    expect(formatDeltaMid(null, null)).toBe("Δ: $0.00");
  });
});

describe("Spread Terminal: Order Book Management", () => {
  it("creates and retrieves order books idempotently", () => {
    const map = new Map<number, OrderBook>();
    const b1 = getOrCreateBook(map, 101);
    expect(b1.marketId).toBe(101);
    expect(b1.asks.size).toBe(0);
    expect(b1.bids.size).toBe(0);

    const b2 = getOrCreateBook(map, 101);
    expect(b1).toBe(b2);
  });

  it("applies snapshots and updates correctly, clearing deleted levels", () => {
    const book: OrderBook = {
      marketId: 1,
      asks: new Map([[100, 1.0], [101, 2.0]]),
      bids: new Map([[99, 1.0]]),
      isSnapshotReceived: true,
      lastUpdatedTs: 0,
      offset: 0,
    };

    // Snapshot clears old levels
    updateBookFromWs(
      book,
      {
        asks: [{ price: "105", size: "3.5" }],
        bids: [{ price: "98", size: "4.0" }],
      },
      true,
      12345,
    );

    expect(book.asks.has(100)).toBe(false);
    expect(book.asks.get(105)).toBe(3.5);
    expect(book.bids.get(98)).toBe(4.0);
    expect(book.offset).toBe(12345);

    // Delta update removes level when size <= 0
    updateBookFromWs(
      book,
      {
        asks: [{ price: "105", size: "0" }, { price: "106", size: "2.0" }],
      },
      false,
    );

    expect(book.asks.has(105)).toBe(false);
    expect(book.asks.get(106)).toBe(2.0);
  });

  it("sorts levels and caps to top 40 levels", () => {
    const map = new Map<number, number>();
    for (let i = 1; i <= 60; i++) {
      map.set(i, 1.0);
    }

    const asks = getSortedLevels(map, true);
    expect(asks.length).toBe(40);
    expect(asks[0]!.price).toBe(1);
    expect(asks[39]!.price).toBe(40);

    const bids = getSortedLevels(map, false);
    expect(bids.length).toBe(40);
    expect(bids[0]!.price).toBe(60);
    expect(bids[39]!.price).toBe(21);
  });
});

describe("Spread Terminal: VWAP Simulation", () => {
  it("simulates fill across multiple levels with accurate volume-weighted price and slippage", () => {
    const asks = [
      { price: 100, totalBase: 2.0, totalUsd: 200 },
      { price: 102, totalBase: 3.0, totalUsd: 306 },
      { price: 105, totalBase: 5.0, totalUsd: 525 },
    ];

    // Target: 4.0 units
    // Takes 2.0 @ 100 ($200) + 2.0 @ 102 ($204) = $404 for 4.0 units -> avgPrice = 101.0
    const sim = simulateFillBase(asks, 4.0, true);
    expect(sim.isComplete).toBe(true);
    expect(sim.avgPrice).toBe(101.0);
    expect(sim.totalCostUsd).toBe(404.0);
    expect(sim.levelsSwept).toBe(2);
    // slippage = ((101 - 100) / 100) * 10000 = 100 bps
    expect(sim.slippageBps).toBeCloseTo(100.0, 2);
  });

  it("handles relative tolerance (0.05%) to avoid false LOW LIQ on floating point leftovers", () => {
    const asks = [{ price: 100, totalBase: 1.999999, totalUsd: 199.9999 }];
    // Target: 2.0 -> remainingBase is 0.000001, which is <= tolerance
    const sim = simulateFillBase(asks, 2.0, true);
    expect(sim.isComplete).toBe(true);
  });

  it("marks isComplete as false when depth is insufficient", () => {
    const asks = [{ price: 100, totalBase: 1.0, totalUsd: 100 }];
    const sim = simulateFillBase(asks, 10.0, true);
    expect(sim.isComplete).toBe(false);
    expect(sim.totalAvailableBase).toBe(1.0);
  });
});

describe("Spread Terminal: Metrics & RT Loss Calculation", () => {
  const dummyMarket: MarketInfo = {
    symbol: "TEST",
    leverage: "20x",
    leverageNum: 20,
    rhLeverage: "20x",
    coreLeverage: "20x",
    rhMarketId: 1,
    coreMarketId: 2,
    rhVolume24h: 100000,
    coreVolume24h: 100000,
    totalVolume24h: 200000,
    rhOiUsd: 50000,
    coreOiUsd: 50000,
    totalOiUsd: 100000,
    latestMetrics: null,
  };

  it("rejects crossed books immediately", () => {
    const rhBook: OrderBook = {
      marketId: 1,
      asks: new Map([[100, 10]]),
      bids: new Map([[105, 10]]), // Crossed: bid > ask
      isSnapshotReceived: true,
      lastUpdatedTs: Date.now(),
      offset: 1,
    };
    const coreBook: OrderBook = {
      marketId: 2,
      asks: new Map([[101, 10]]),
      bids: new Map([[99, 10]]),
      isSnapshotReceived: true,
      lastUpdatedTs: Date.now(),
      offset: 1,
    };

    const metrics = calculateMarketMetrics(dummyMarket, 1000, coreBook, rhBook, Date.now(), Date.now());
    expect(metrics).toBeNull();
  });

  it("calculates exact delta-neutral baseQty and sum-based RT loss", () => {
    // RH: Ask 100.10, Bid 99.90 (Mid 100.0)
    // Core: Ask 100.05, Bid 99.95 (Mid 100.0)
    const rhBook: OrderBook = {
      marketId: 1,
      asks: new Map([[100.10, 100]]),
      bids: new Map([[99.90, 100]]),
      isSnapshotReceived: true,
      lastUpdatedTs: Date.now(),
      offset: 1,
    };
    const coreBook: OrderBook = {
      marketId: 2,
      asks: new Map([[100.05, 100]]),
      bids: new Map([[99.95, 100]]),
      isSnapshotReceived: true,
      lastUpdatedTs: Date.now(),
      offset: 1,
    };

    const now = Date.now();
    const metrics = calculateMarketMetrics(dummyMarket, 10000, coreBook, rhBook, now, now);
    expect(metrics).not.toBeNull();
    if (!metrics) return;

    expect(metrics.midPrice).toBe(100.0);
    // Base quantity: $10,000 / $100 = 100 base units
    expect(metrics.baseQty).toBe(100.0);

    // Entry: Buy RH at 100.10 ($10,010), Sell Core at 99.95 ($9,995) -> Loss = $15.00
    expect(metrics.entryLossUsd).toBeCloseTo(15.0, 2);

    // Exit: Buy Core at 100.05 ($10,005), Sell RH at 99.90 ($9,990) -> Loss = $15.00
    expect(metrics.exitLossUsd).toBeCloseTo(15.0, 2);

    // Real round-trip loss: $15 + $15 = $30.00
    expect(metrics.rawCostUsd).toBeCloseTo(30.0, 2);
    expect(metrics.costUsd).toBeCloseTo(30.0, 2);
    expect(metrics.status).toBe("READY");
  });

  it("smooths rawCostUsd through getMetrics and derives consistent bps and point cost", () => {
    const rhBook: OrderBook = {
      marketId: 1,
      asks: new Map([[100.10, 100]]),
      bids: new Map([[99.90, 100]]),
      isSnapshotReceived: true,
      lastUpdatedTs: Date.now(),
      offset: 1,
    };
    const coreBook: OrderBook = {
      marketId: 2,
      asks: new Map([[100.05, 100]]),
      bids: new Map([[99.95, 100]]),
      isSnapshotReceived: true,
      lastUpdatedTs: Date.now(),
      offset: 1,
    };

    const state: TerminalState = {
      markets: new Map([[dummyMarket.symbol, dummyMarket]]),
      coreBooks: new Map([[coreBook.marketId, coreBook]]),
      rhBooks: new Map([[rhBook.marketId, rhBook]]),
      targetSizeUsd: 10000,
      filterEquities: false,
      filterReadyOnly: false,
      minLeverageFilter: 0,
      searchQuery: "",
      sortColumn: "costUsd",
      sortDirection: "asc",
      isAutoSortEnabled: true,
      displayedSymbolsOrder: [dummyMarket.symbol],
      rerankTimerRemaining: 5,
      emaMap: new Map(),
      expandedSymbol: null,
      isCoreConnected: true,
      isRhConnected: true,
    };

    const now = performance.now();
    const m1 = getMetrics(dummyMarket, state, Date.now(), Date.now(), now);
    expect(m1).not.toBeNull();
    if (!m1) return;

    // Initial EMA cost equals rawCostUsd ($30.0)
    expect(m1.costUsd).toBeCloseTo(30.0, 2);
    // Drag bps = (30 / 10000) * 10000 = 30.0 bps
    expect(m1.vwapTotalDragBps).toBeCloseTo(30.0, 2);
    expect(m1.pointCostUsd).toBeGreaterThan(0);

    // After 1 second with a spike in price, EMA dampens the move
    const dtNow = now + 1000;
    // Simulate spike: raw cost increases
    rhBook.asks.delete(100.10);
    rhBook.asks.set(100.30, 100);
    const m2 = getMetrics(dummyMarket, state, Date.now(), Date.now(), dtNow);
    expect(m2).not.toBeNull();
    if (!m2) return;

    // Raw cost increased, but smoothed costUsd moved gradually
    expect(m2.rawCostUsd).toBeGreaterThan(m1.rawCostUsd);
    expect(m2.costUsd).toBeGreaterThan(m1.costUsd);
    expect(m2.costUsd).toBeLessThan(m2.rawCostUsd); // Dampened!
    // vwapTotalDragBps stays strictly aligned with smoothed costUsd
    expect(m2.vwapTotalDragBps).toBeCloseTo((m2.costUsd / 10000) * 10000, 4);
  });
});
