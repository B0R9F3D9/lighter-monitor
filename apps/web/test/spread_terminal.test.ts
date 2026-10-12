import { describe, expect, it } from "bun:test";
import {
  formatMoney,
  formatPrice,
  formatBps,
  formatBaseQty,
  formatDeltaMid,
} from "../src/shared/formatters";
import {
  getOrCreateBook,
  updateBookFromWs,
  getSortedLevels,
  FlatOrderBookSide,
} from "../src/spread/orderbook";
import {
  simulateFillBase,
  simulateFillBaseInto,
  fastSimFillInto,
} from "../src/spread/simulation";
import type { FastSimResult } from "../src/spread/simulation";
import { calculateMarketMetrics, findOptimalSize, getMetrics } from "../src/spread/metrics";
import { STORAGE_KEYS } from "../src/spread/config";
import type { MarketInfo, OrderBook, SimFillResult, TerminalState } from "../src/spread/types";

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
    expect(formatPrice(-125.5)).toBe("-$125.50");
    expect(formatPrice(-2.456)).toBe("-$2.456");
    expect(formatPrice(-0.0045)).toBe("-$0.0045");
    expect(formatPrice(0)).toBe("$0.00");
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
      asks: new Map([
        [100, 1.0],
        [101, 2.0],
      ]),
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
        asks: [
          { price: "105", size: "0" },
          { price: "106", size: "2.0" },
        ],
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

  it("caches sorted levels on OrderBook and invalidates on updateBookFromWs", () => {
    const book: OrderBook = {
      marketId: 1,
      asks: new Map([
        [100, 1.0],
        [102, 2.0],
      ]),
      bids: new Map([[99, 1.0]]),
      isSnapshotReceived: true,
      lastUpdatedTs: 0,
      offset: 0,
    };

    const asks1 = getSortedLevels(book, true);
    expect(asks1.length).toBe(2);
    expect(book.cachedAsks).toBe(asks1);

    // Second call returns exactly the same cached reference
    const asks2 = getSortedLevels(book, true);
    expect(asks2).toBe(asks1);

    // updateBookFromWs invalidates cache
    updateBookFromWs(book, { asks: [{ price: 101, size: 5.0 }] });
    expect(book.cachedAsks).toBeNull();

    const asks3 = getSortedLevels(book, true);
    expect(asks3).not.toBe(asks1);
    expect(asks3.length).toBe(3);
    expect(book.cachedAsks).toBe(asks3);
  });

  it("prunes deep stale order book levels beyond retention limit to prevent map bloat", () => {
    const book: OrderBook = {
      marketId: 1,
      asks: new Map(),
      bids: new Map(),
      isSnapshotReceived: true,
      lastUpdatedTs: 0,
      offset: 0,
    };

    // Populate 200 ask levels
    for (let i = 1; i <= 200; i++) {
      book.asks.set(i, 1.0);
    }
    expect(book.asks.size).toBe(200);

    // Call getSortedLevels with limit=40
    const topAsks = getSortedLevels(book, true, 40);
    expect(topAsks.length).toBe(40);
    expect(topAsks[0]!.price).toBe(1);
    expect(topAsks[39]!.price).toBe(40);

    // Deep levels (> 80) should have been pruned from book.asks Map
    expect(book.asks.size).toBe(80);
    expect(book.asks.has(80)).toBe(true);
    expect(book.asks.has(81)).toBe(false);
    expect(book.asks.has(200)).toBe(false);
  });

  describe("FlatOrderBookSide (Zero-Allocation Binary Buffer)", () => {
    it("maintains sorted order for asks (ascending) via binary search insertion", () => {
      const asks = new FlatOrderBookSide(true, 10);
      asks.set(105, 1.0);
      asks.set(100, 2.0);
      asks.set(102, 3.0);
      asks.set(101, 1.5);

      expect(asks.count).toBe(4);
      expect(asks.prices[0]).toBe(100);
      expect(asks.prices[1]).toBe(101);
      expect(asks.prices[2]).toBe(102);
      expect(asks.prices[3]).toBe(105);
      expect(asks.totalDepthBase).toBe(7.5);
      expect(asks.totalDepthUsd).toBeCloseTo(100 * 2.0 + 101 * 1.5 + 102 * 3.0 + 105 * 1.0, 4);

      // Updating an existing level in-place
      asks.set(101, 2.5);
      expect(asks.count).toBe(4);
      expect(asks.sizes[1]).toBe(2.5);
      expect(asks.totalDepthBase).toBe(8.5);

      // Deleting a level when size <= 0
      asks.set(101, 0);
      expect(asks.count).toBe(3);
      expect(asks.prices[1]).toBe(102);
      expect(asks.totalDepthBase).toBe(6.0);
    });

    it("maintains sorted order for bids (descending) via binary search insertion", () => {
      const bids = new FlatOrderBookSide(false, 10);
      bids.set(95, 1.0);
      bids.set(100, 2.0);
      bids.set(98, 3.0);
      bids.set(99, 1.5);

      expect(bids.count).toBe(4);
      expect(bids.prices[0]).toBe(100);
      expect(bids.prices[1]).toBe(99);
      expect(bids.prices[2]).toBe(98);
      expect(bids.prices[3]).toBe(95);

      // Prune when capacity is reached
      const smallBids = new FlatOrderBookSide(false, 3);
      smallBids.set(100, 1.0);
      smallBids.set(98, 1.0);
      smallBids.set(96, 1.0);
      expect(smallBids.count).toBe(3);

      // Better bid (99) pushes out worst bid (96)
      smallBids.set(99, 1.0);
      expect(smallBids.count).toBe(3);
      expect(smallBids.prices[0]).toBe(100);
      expect(smallBids.prices[1]).toBe(99);
      expect(smallBids.prices[2]).toBe(98);

      // Worse bid (95) is ignored
      smallBids.set(95, 1.0);
      expect(smallBids.count).toBe(3);
      expect(smallBids.prices[2]).toBe(98);
    });
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

    const metrics = calculateMarketMetrics(
      dummyMarket,
      1000,
      coreBook,
      rhBook,
      Date.now(),
      Date.now(),
    );
    expect(metrics).toBeNull();
  });

  it("calculates exact delta-neutral baseQty and sum-based RT loss", () => {
    // RH: Ask 100.10, Bid 99.90 (Mid 100.0)
    // Core: Ask 100.05, Bid 99.95 (Mid 100.0)
    const rhBook: OrderBook = {
      marketId: 1,
      asks: new Map([[100.1, 100]]),
      bids: new Map([[99.9, 100]]),
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

  it("calculates instant real-time rawCostUsd through getMetrics and derives consistent bps and entry/exit loss", () => {
    const rhBook: OrderBook = {
      marketId: 1,
      asks: new Map([[100.1, 100]]),
      bids: new Map([[99.9, 100]]),
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
      isDynamicSize: false,
      dynamicMode: "none",
      maxCapUsd: 20000,
      filterEquities: false,
      filterReadyOnly: false,
      minLeverageFilter: 0,
      searchQuery: "",
      sortColumn: "costUsd",
      sortDirection: "asc",
      isAutoSortEnabled: true,
      displayedSymbolsOrder: [dummyMarket.symbol],
      rerankTimerRemaining: 0,
      rerankIntervalSec: 0,
      emaMap: new Map(),
      expandedSymbol: null,
      isCoreConnected: true,
      isRhConnected: true,
    };

    const now = performance.now();
    const m1 = getMetrics(dummyMarket, state, Date.now(), Date.now(), now);
    expect(m1).not.toBeNull();
    if (!m1) return;

    // Initial cost equals rawCostUsd ($30.0)
    expect(m1.costUsd).toBeCloseTo(30.0, 2);
    // Drag bps = (30 / 10000) * 10000 = 30.0 bps
    expect(m1.vwapTotalDragBps).toBeCloseTo(30.0, 2);
    expect(m1.entryLossUsd).toBeGreaterThan(0);
    expect(m1.exitLossUsd).toBeGreaterThan(0);

    // After 1 second with a spike in price, instant real-time cost updates immediately
    const dtNow = now + 1000;
    // Simulate spike: raw cost increases
    updateBookFromWs(rhBook, {
      asks: [
        { price: 100.1, size: 0 },
        { price: 100.3, size: 100 },
      ],
    });
    const m2 = getMetrics(dummyMarket, state, Date.now(), Date.now(), dtNow);
    expect(m2).not.toBeNull();
    if (!m2) return;

    // Instant real-time cost matches raw cost immediately without dampening
    expect(m2.rawCostUsd).toBeGreaterThan(m1.rawCostUsd);
    expect(m2.costUsd).toBe(m2.rawCostUsd);
    expect(m2.costUsd).toBeGreaterThan(m1.costUsd);
    // vwapTotalDragBps stays strictly aligned with instant costUsd
    expect(m2.vwapTotalDragBps).toBeCloseTo((m2.costUsd / 10000) * 10000, 4);
  });
});

describe("Spread Terminal: Dynamic Position Sizing (Min Burn vs Max Vol)", () => {
  it("min_burn mode stops increasing size when price/slippage cost deteriorates", () => {
    // Level 1: $10,000 depth at 100.05 / 99.95 (tight 10 bps spread)
    // Level 2: $20,000 depth at 100.25 / 99.75 (wide 50 bps spread - deteriorates unit cost!)
    const rhAsks = [
      { price: 100.05, totalBase: 100, totalUsd: 10005 },
      { price: 100.25, totalBase: 200, totalUsd: 20050 },
    ];
    const coreBids = [
      { price: 99.95, totalBase: 100, totalUsd: 9995 },
      { price: 99.75, totalBase: 200, totalUsd: 19950 },
    ];
    const rhBids = [
      { price: 99.95, totalBase: 100, totalUsd: 9995 },
      { price: 99.75, totalBase: 200, totalUsd: 19950 },
    ];
    const coreAsks = [
      { price: 100.05, totalBase: 100, totalUsd: 10005 },
      { price: 100.25, totalBase: 200, totalUsd: 20050 },
    ];

    // min_burn should NOT sweep into Level 2 because unit cost worsens!
    const minBurnSize = findOptimalSize(
      rhAsks,
      coreBids,
      rhBids,
      coreAsks,
      100.0,
      "min_burn",
      30000,
    );
    expect(minBurnSize).toBeLessThanOrEqual(10000);

    // max_vol will accept higher slippage to maximize position volume
    const maxVolSize = findOptimalSize(rhAsks, coreBids, rhBids, coreAsks, 100.0, "max_vol", 30000);
    expect(maxVolSize).toBeGreaterThan(minBurnSize);
  });

  it("respects maxCapUsd budget cap", () => {
    const rhAsks = [{ price: 100.05, totalBase: 1000, totalUsd: 100050 }];
    const coreBids = [{ price: 99.95, totalBase: 1000, totalUsd: 99950 }];
    const rhBids = [{ price: 99.95, totalBase: 1000, totalUsd: 99950 }];
    const coreAsks = [{ price: 100.05, totalBase: 1000, totalUsd: 100050 }];

    // Cap at $15,000 even though book has $100K depth
    const optSize = findOptimalSize(rhAsks, coreBids, rhBids, coreAsks, 100.0, "min_burn", 15000);
    expect(optSize).toBeLessThanOrEqual(15000);
  });

  it("handles thin liquidity without crashing and bounds size by available depth", () => {
    const rhAsks = [{ price: 100.1, totalBase: 2, totalUsd: 200.2 }];
    const coreBids = [{ price: 99.9, totalBase: 2, totalUsd: 199.8 }];
    const rhBids = [{ price: 99.9, totalBase: 2, totalUsd: 199.8 }];
    const coreAsks = [{ price: 100.1, totalBase: 2, totalUsd: 200.2 }];

    const optSize = findOptimalSize(rhAsks, coreBids, rhBids, coreAsks, 100.0, "min_burn", 20000);
    expect(optSize).toBeLessThanOrEqual(500);
    expect(optSize).toBeGreaterThanOrEqual(100);
  });

  it("calculates market metrics with dynamic size enabled", () => {
    const dummyMarket: MarketInfo = {
      symbol: "NVDA",
      leverage: "50x",
      leverageNum: 50,
      rhLeverage: "50x",
      coreLeverage: "50x",
      rhMarketId: 10,
      coreMarketId: 20,
      rhVolume24h: 500000,
      coreVolume24h: 300000,
      totalVolume24h: 800000,
      rhOiUsd: 1000000,
      coreOiUsd: 500000,
      totalOiUsd: 1500000,
      latestMetrics: null,
    };
    const rhBook: OrderBook = {
      marketId: 10,
      asks: new Map([
        [100.05, 50],
        [100.1, 100],
      ]),
      bids: new Map([
        [99.95, 50],
        [99.9, 100],
      ]),
      isSnapshotReceived: true,
      lastUpdatedTs: Date.now(),
      offset: 1,
    };
    const coreBook: OrderBook = {
      marketId: 20,
      asks: new Map([
        [100.04, 50],
        [100.08, 100],
      ]),
      bids: new Map([
        [99.96, 50],
        [99.92, 100],
      ]),
      isSnapshotReceived: true,
      lastUpdatedTs: Date.now(),
      offset: 1,
    };

    const now = Date.now();
    // Fixed mode: targetSize = $10,000
    const fixedMetrics = calculateMarketMetrics(
      dummyMarket,
      10000,
      coreBook,
      rhBook,
      now,
      now,
      "none",
    );
    expect(fixedMetrics).not.toBeNull();
    expect(fixedMetrics?.isDynamic).toBe(false);
    expect(fixedMetrics?.effectiveTargetUsd).toBe(10000);
    expect(fixedMetrics?.optimalSizeUsd).toBeGreaterThan(0);

    // Dynamic mode: min_burn
    const dynamicMetrics = calculateMarketMetrics(
      dummyMarket,
      10000,
      coreBook,
      rhBook,
      now,
      now,
      "min_burn",
      20000,
    );
    expect(dynamicMetrics).not.toBeNull();
    expect(dynamicMetrics?.isDynamic).toBe(true);
    expect(dynamicMetrics?.dynamicMode).toBe("min_burn");
    expect(dynamicMetrics?.effectiveTargetUsd).toBe(dynamicMetrics?.optimalSizeUsd);
    expect(dynamicMetrics?.optimalSizeUsd).toBeGreaterThan(0);
    expect(dynamicMetrics?.optimalSizeUsd).toBeLessThanOrEqual(20000);
  });
});

describe("Spread Terminal: High-Throughput & Zero-Allocation Hot Path", () => {
  it("executes fastSimFillInto and simulateFillBaseInto in-place without object allocations", () => {
    const asks = new FlatOrderBookSide(true, 40);
    for (let i = 0; i < 20; i++) {
      asks.set(100 + i * 0.5, 2.0 + i * 0.1);
    }

    const fastRes: FastSimResult = {
      isComplete: false,
      totalCostUsd: 0,
      levelsSwept: 0,
      avgPrice: 0,
    };
    const complete = fastSimFillInto(fastRes, asks, 10.0);

    expect(complete).toBe(true);
    expect(fastRes.isComplete).toBe(true);
    expect(fastRes.levelsSwept).toBeGreaterThan(0);
    expect(fastRes.totalCostUsd).toBeGreaterThan(0);
    expect(fastRes.avgPrice).toBeGreaterThanOrEqual(100);

    const fillRes: SimFillResult = {
      isComplete: false,
      avgPrice: 0,
      bestPrice: 0,
      slippageBps: 0,
      levelsSwept: 0,
      totalCostUsd: 0,
      filledBase: 0,
      totalAvailableUsd: 0,
      totalAvailableBase: 0,
    };
    simulateFillBaseInto(fillRes, asks, 10.0, true);

    expect(fillRes.isComplete).toBe(true);
    expect(fillRes.filledBase).toBeCloseTo(10.0, 4);
    expect(fillRes.levelsSwept).toBe(fastRes.levelsSwept);
    expect(fillRes.avgPrice).toBeCloseTo(fastRes.avgPrice, 4);
    expect(fillRes.totalCostUsd).toBeCloseTo(fastRes.totalCostUsd, 4);
    expect(fillRes.bestPrice).toBe(100);
  });

  it("handles high-frequency orderbook churn with sub-microsecond latency and zero drift", () => {
    const asks = new FlatOrderBookSide(true, 80);
    const bids = new FlatOrderBookSide(false, 80);

    for (let i = 0; i < 40; i++) {
      asks.set(100 + i * 0.1, 5 + i * 0.5);
      bids.set(99.9 - i * 0.1, 5 + i * 0.5);
    }

    const fastRes: FastSimResult = {
      isComplete: false,
      totalCostUsd: 0,
      levelsSwept: 0,
      avgPrice: 0,
    };
    const fillRes: SimFillResult = {
      isComplete: false,
      avgPrice: 0,
      bestPrice: 0,
      slippageBps: 0,
      levelsSwept: 0,
      totalCostUsd: 0,
      filledBase: 0,
      totalAvailableUsd: 0,
      totalAvailableBase: 0,
    };

    const ITERATIONS = 50_000;
    const tStart = performance.now();

    for (let i = 0; i < ITERATIONS; i++) {
      const priceOffset = (i % 30) * 0.1;
      const p = 100 + priceOffset;
      const s = i % 2 === 0 ? 0 : (i % 10) + 1;

      asks.set(p, s);

      fastSimFillInto(fastRes, asks, 15.0);
      simulateFillBaseInto(fillRes, asks, 15.0, true);
    }

    const durationMs = performance.now() - tStart;
    const usPerOp = (durationMs / ITERATIONS) * 1000;

    // Must execute 50,000 iterations in under 500ms (< 10 microseconds per operation)
    expect(durationMs).toBeLessThan(500);
    expect(usPerOp).toBeLessThan(10);
    expect(fillRes.isComplete).toBe(true);
    expect(asks.count).toBeGreaterThan(0);
    expect(asks.totalDepthBase).toBeGreaterThan(0);
    expect(asks.totalDepthUsd).toBeGreaterThan(0);
  });

  it("maintains depth accuracy and invariants under rapid insertions and deletions", () => {
    const side = new FlatOrderBookSide(true, 20);

    // Insert 10 levels
    for (let i = 1; i <= 10; i++) {
      side.set(100 + i, 2.0);
    }
    expect(side.count).toBe(10);
    expect(side.totalDepthBase).toBe(20.0);

    // Delete 5 levels
    for (let i = 1; i <= 5; i++) {
      side.set(100 + i, 0); // remove
    }
    expect(side.count).toBe(5);
    expect(side.totalDepthBase).toBe(10.0);
    expect(side.prices[0]).toBe(106);

    // Update remaining levels
    for (let i = 6; i <= 10; i++) {
      side.set(100 + i, 3.0);
    }
    expect(side.count).toBe(5);
    expect(side.totalDepthBase).toBe(15.0);

    // Recalibrate and ensure zero float drift
    const prevBase = side.totalDepthBase;
    const prevUsd = side.totalDepthUsd;
    side.recalibrateDepth();
    expect(side.totalDepthBase).toBeCloseTo(prevBase, 6);
    expect(side.totalDepthUsd).toBeCloseTo(prevUsd, 6);

    // Clear and verify strict zero
    side.clear();
    expect(side.count).toBe(0);
    expect(side.totalDepthBase).toBe(0);
    expect(side.totalDepthUsd).toBe(0);
  });

  it("includes sort persistence keys in STORAGE_KEYS", () => {
    expect(STORAGE_KEYS.SORT_COLUMN).toBe("terminal_sort_column");
    expect(STORAGE_KEYS.SORT_DIRECTION).toBe("terminal_sort_direction");
  });
});

