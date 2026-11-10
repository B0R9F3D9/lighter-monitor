import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { CONFIG } from "../src/shared";
import { createEmptyBook, updateBookFromWs, getBookMidPrice } from "../src/shared/orderbook";
import { AnalyticsController } from "../src/analytics/controller";

function createMockElement(tag: string = "div", id: string = "") {
  const listeners: Record<string, Function[]> = {};
  const children: any[] = [];
  const classListSet = new Set<string>();
  let currentClassName = "";

  const el: any = {
    tagName: tag.toUpperCase(),
    id,
    dataset: {},
    get className() {
      return currentClassName;
    },
    set className(val: string) {
      currentClassName = val;
      classListSet.clear();
      val
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classListSet.add(c));
    },
    classList: {
      add: (...classes: string[]) => classes.forEach((c) => classListSet.add(c)),
      remove: (...classes: string[]) => classes.forEach((c) => classListSet.delete(c)),
      contains: (c: string) => classListSet.has(c),
    },
    textContent: "",
    innerHTML: "",
    style: {},
    children,
    appendChild: (child: any) => {
      children.push(child);
      return child;
    },
    addEventListener: (evt: string, fn: Function) => {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    },
    removeEventListener: (evt: string, fn: Function) => {
      if (listeners[evt]) {
        listeners[evt] = listeners[evt].filter((f) => f !== fn);
      }
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}

describe("Analytics 4-Bug Fix Verification Suite", () => {
  const origDoc = (globalThis as any).document;
  const origWin = (globalThis as any).window;
  const origStorage = (globalThis as any).localStorage;
  const origWs = (globalThis as any).WebSocket;
  const origRaf = (globalThis as any).requestAnimationFrame;
  const origCaf = (globalThis as any).cancelAnimationFrame;
  const origFetch = (globalThis as any).fetch;

  let docListeners: Record<string, Function[]> = {};
  let winListeners: Record<string, Function[]> = {};
  let elements: Map<string, any> = new Map();

  function getOrCreateElement(id: string) {
    if (!elements.has(id)) {
      elements.set(id, createMockElement("div", id));
    }
    return elements.get(id);
  }

  beforeEach(() => {
    docListeners = {};
    winListeners = {};
    elements.clear();

    (globalThis as any).document = {
      visibilityState: "visible",
      addEventListener: (evt: string, fn: Function) => {
        if (!docListeners[evt]) docListeners[evt] = [];
        docListeners[evt].push(fn);
      },
      removeEventListener: (evt: string, fn: Function) => {
        if (docListeners[evt]) {
          docListeners[evt] = docListeners[evt].filter((f) => f !== fn);
        }
      },
      getElementById: (id: string) => getOrCreateElement(id),
      querySelectorAll: () => [],
      createElement: (tag: string) => createMockElement(tag),
      body: createMockElement("body"),
      documentElement: {
        style: {
          setProperty: () => {},
        },
      },
      title: "",
    };

    (globalThis as any).window = {
      addEventListener: (evt: string, fn: Function) => {
        if (!winListeners[evt]) winListeners[evt] = [];
        winListeners[evt].push(fn);
      },
      removeEventListener: (evt: string, fn: Function) => {
        if (winListeners[evt]) {
          winListeners[evt] = winListeners[evt].filter((f) => f !== fn);
        }
      },
      dispatchEvent: () => true,
      location: {
        pathname: "/analytics/AAPL",
        search: "",
        hash: "",
      },
      history: {
        pushState: () => {},
        replaceState: () => {},
      },
    };

    (globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 16) as any;
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);

    const storageStore: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => storageStore[k] ?? null,
      setItem: (k: string, v: string) => {
        storageStore[k] = v;
      },
      removeItem: (k: string) => {
        delete storageStore[k];
      },
      clear: () => {
        for (const k of Object.keys(storageStore)) delete storageStore[k];
      },
    };

    class MockWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = MockWs.OPEN;
      send = () => {};
      close = () => {};
      addEventListener = () => {};
      removeEventListener = () => {};
    }
    (globalThis as any).WebSocket = MockWs;
  });

  afterEach(() => {
    (globalThis as any).document = origDoc;
    (globalThis as any).window = origWin;
    (globalThis as any).localStorage = origStorage;
    (globalThis as any).WebSocket = origWs;
    (globalThis as any).requestAnimationFrame = origRaf;
    (globalThis as any).cancelAnimationFrame = origCaf;
    (globalThis as any).fetch = origFetch;
  });

  describe("Bug 1: Delta loss and ghost levels prevention in OrderBook", () => {
    it("drops delta updates when isSnapshotReceived is false", () => {
      const book = createEmptyBook(1);
      expect(book.isSnapshotReceived).toBe(false);

      // Deltas arriving before snapshot
      updateBookFromWs(
        book,
        {
          bids: [{ price: 100, size: 5 }],
          asks: [{ price: 101, size: 5 }],
        },
        false,
        1,
      );

      // Book remains empty and invalid
      expect(book.isSnapshotReceived).toBe(false);
      expect(book.bids.size).toBe(0);
      expect(book.asks.size).toBe(0);
      expect(getBookMidPrice(book)).toBe(0);
    });

    it("drops stale or duplicate deltas when offset <= book.offset", () => {
      const book = createEmptyBook(1);

      // Initial snapshot with sequence offset 100
      updateBookFromWs(
        book,
        {
          bids: [{ price: 100, size: 10 }],
          asks: [{ price: 102, size: 10 }],
        },
        true,
        100,
      );

      expect(book.isSnapshotReceived).toBe(true);
      expect(book.offset).toBe(100);
      expect(getBookMidPrice(book)).toBe(101);

      // Stale delta with offset 99 must be ignored
      updateBookFromWs(
        book,
        {
          bids: [{ price: 100.5, size: 5 }],
        },
        false,
        99,
      );
      expect(book.bids.get(100.5)).toBeUndefined();
      expect(book.offset).toBe(100);

      // Duplicate delta with offset 100 must be ignored
      updateBookFromWs(
        book,
        {
          bids: [{ price: 100.5, size: 5 }],
        },
        false,
        100,
      );
      expect(book.bids.get(100.5)).toBeUndefined();
      expect(book.offset).toBe(100);

      // Valid newer delta with offset 101 must be applied
      updateBookFromWs(
        book,
        {
          bids: [{ price: 100.5, size: 5 }],
        },
        false,
        101,
      );
      expect(book.bids.get(100.5)).toBe(5);
      expect(book.offset).toBe(101);
      expect(getBookMidPrice(book)).toBe(101.25);
    });
  });

  describe("Bug 2: Asymmetric update and false basis spike prevention", () => {
    it("invalidates book snapshot and resets mid prices on socket close callbacks", () => {
      const controller = new AnalyticsController();
      (controller as any).initWs();

      const rhBook = createEmptyBook(1);
      const coreBook = createEmptyBook(2);
      rhBook.isSnapshotReceived = true;
      coreBook.isSnapshotReceived = true;

      (controller as any).rhBook = rhBook;
      (controller as any).coreBook = coreBook;
      (controller as any).lastKnownRhMid = 150;
      (controller as any).lastKnownCoreMid = 150;

      // Simulate RH socket closing
      (controller as any).wsManager.callbacks.onRhClose();
      expect(rhBook.isSnapshotReceived).toBe(false);
      expect(rhBook.offset).toBe(0);
      expect((controller as any).isRhBookDirty).toBe(true);
      expect((controller as any).lastKnownRhMid).toBe(0);

      // Simulate Core socket closing
      (controller as any).wsManager.callbacks.onCoreClose();
      expect(coreBook.isSnapshotReceived).toBe(false);
      expect(coreBook.offset).toBe(0);
      expect((controller as any).isCoreBookDirty).toBe(true);
      expect((controller as any).lastKnownCoreMid).toBe(0);

      controller.destroy();
    });

    it("resets lastKnownMid to 0 when an orderbook update has no bids or asks (mid === 0)", () => {
      const controller = new AnalyticsController();
      (controller as any).initWs();

      const mockPair = {
        symbol: "AAPL",
        rhMarketId: 1,
        coreMarketId: 2,
        markPrice: 100,
        indexPrice: 100,
        dailyPriceChange: 0,
        dailyVolumeUsd: 0,
        openInterestUsd: 0,
        fundingRate1h: 0,
        hedgeSideConfig: { isRhLong: true },
        rh: { markPrice: 100 },
        core: { markPrice: 100 },
      };
      (controller as any).activePair = mockPair;
      (controller as any).pairs = [mockPair];
      (controller as any).activeSymbol = "AAPL";
      (controller as any).activeRhMarketId = 1;
      (controller as any).activeCoreMarketId = 2;

      // 1. Initial snapshot arrives with valid bids and asks
      (controller as any).wsManager.callbacks.onRhBookUpdate(
        1,
        {
          bids: [{ price: 100, size: 5 }],
          asks: [{ price: 102, size: 5 }],
        },
        true,
        1,
      );
      expect((controller as any).lastKnownRhMid).toBe(101);

      (controller as any).wsManager.callbacks.onCoreBookUpdate(
        2,
        {
          bids: [{ price: 200, size: 5 }],
          asks: [{ price: 202, size: 5 }],
        },
        true,
        1,
      );
      expect((controller as any).lastKnownCoreMid).toBe(201);

      // 2. An update clears asks in RH book (mid becomes 0)
      (controller as any).wsManager.callbacks.onRhBookUpdate(
        1,
        {
          asks: [{ price: 102, size: 0 }],
        },
        false,
        2,
      );
      expect(getBookMidPrice((controller as any).rhBook)).toBe(0);
      expect((controller as any).lastKnownRhMid).toBe(0);

      // 3. An update clears bids in Core book (mid becomes 0)
      (controller as any).wsManager.callbacks.onCoreBookUpdate(
        2,
        {
          bids: [{ price: 200, size: 0 }],
        },
        false,
        2,
      );
      expect(getBookMidPrice((controller as any).coreBook)).toBe(0);
      expect((controller as any).lastKnownCoreMid).toBe(0);

      controller.destroy();
    });

    it("loadPairs does not clobber live mid prices if book already has snapshot", async () => {
      const controller = new AnalyticsController();
      const mockOrderBookDetails = [
        {
          symbol: "AAPL",
          market_id: 1,
          status: "active",
          is_frozen: false,
          min_initial_margin_fraction: 500,
          daily_quote_token_volume: "1000",
          mark_price: "100.0",
          index_price: "100.0",
          daily_price_change: "0",
          open_interest: "10",
          base_interest_rate: "0",
        },
      ];

      (globalThis as any).fetch = async (url: string) => {
        if (url.includes("orderBookDetails")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ order_book_details: mockOrderBookDetails }),
          };
        }
        if (url.includes("tokenlist")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ tokens: [] }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      (controller as any).activeSymbol = "AAPL";

      const rhBook = createEmptyBook(1);
      const coreBook = createEmptyBook(1);
      rhBook.isSnapshotReceived = true;
      coreBook.isSnapshotReceived = true;
      (controller as any).rhBook = rhBook;
      (controller as any).coreBook = coreBook;

      (controller as any).lastKnownRhMid = 115; // Live price from WS
      (controller as any).lastKnownCoreMid = 114; // Live price from WS

      try {
        await (controller as any).loadPairs();

        // Must NOT be overwritten by REST markPrice 100
        expect((controller as any).lastKnownRhMid).toBe(115);
        expect((controller as any).lastKnownCoreMid).toBe(114);
      } finally {
        controller.destroy();
      }
    });

    it("flushRealtimeUpdate refuses to calculate basis if one or both books are not snapshot-valid", () => {
      const controller = new AnalyticsController();
      const mockPair = {
        symbol: "AAPL",
        rhMarketId: 1,
        coreMarketId: 2,
        markPrice: 150,
        indexPrice: 150,
        hedgeSideConfig: { isRhLong: true },
        rh: { markPrice: 150 },
        core: { markPrice: 150 },
      };
      (controller as any).activePair = mockPair;
      (controller as any).pairs = [mockPair];
      (controller as any).activeSymbol = "AAPL";

      const rhBook = createEmptyBook(1);
      const coreBook = createEmptyBook(2);

      // Both books not snapshot-received
      (controller as any).rhBook = rhBook;
      (controller as any).coreBook = coreBook;
      (controller as any).lastKnownRhMid = 150;
      (controller as any).lastKnownCoreMid = 160; // 10 dollar difference!

      let realtimeGaugesUpdated = false;
      (controller as any).updateRealtimeQuantGauges = () => {
        realtimeGaugesUpdated = true;
      };

      (controller as any).flushRealtimeUpdate();
      expect(realtimeGaugesUpdated).toBe(false);

      // Only RH is snapshot-received
      rhBook.isSnapshotReceived = true;
      (controller as any).flushRealtimeUpdate();
      expect(realtimeGaugesUpdated).toBe(false);

      // Both are snapshot-received -> now basis update proceeds
      coreBook.isSnapshotReceived = true;
      (controller as any).flushRealtimeUpdate();
      expect(realtimeGaugesUpdated).toBe(true);

      controller.destroy();
    });

    it("loadData updates lastKnownRhMid/CoreMid from historical candles if book has not received live snapshot", async () => {
      const controller = new AnalyticsController();
      const mockPair = {
        symbol: "AAPL",
        rhMarketId: 1,
        coreMarketId: 2,
        markPrice: 100,
        indexPrice: 100,
        dailyPriceChange: 0,
        dailyVolumeUsd: 0,
        openInterestUsd: 0,
        fundingRate1h: 0,
        hedgeSideConfig: { isRhLong: true },
        rh: { markPrice: 100 },
        core: { markPrice: 100 },
      };
      (controller as any).pairs = [mockPair];
      (controller as any).activePair = mockPair;
      (controller as any).activeSymbol = "AAPL";

      const rhBook = createEmptyBook(1);
      const coreBook = createEmptyBook(2);
      rhBook.isSnapshotReceived = false;
      coreBook.isSnapshotReceived = false;

      (controller as any).rhBook = rhBook;
      (controller as any).coreBook = coreBook;
      (controller as any).lastKnownRhMid = 100; // Stale price
      (controller as any).lastKnownCoreMid = 100; // Stale price

      const nowMs = 1_000_000;
      (globalThis as any).fetch = async (url: string) => {
        if (url.includes("candles")) {
          const isRh =
            url.startsWith(CONFIG.RH_API_URL) || url.includes(`market_id=${mockPair.rhMarketId}&`);
          const price = isRh ? 125 : 126;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              c: [
                {
                  t: nowMs,
                  o: price,
                  h: price,
                  l: price,
                  c: price,
                  v: 10,
                  V: 1000,
                },
              ],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      try {
        await (controller as any).loadData();

        // Fresh candle prices should overwrite stale prices
        expect((controller as any).lastKnownRhMid).toBe(125);
        expect((controller as any).lastKnownCoreMid).toBe(126);
      } finally {
        controller.destroy();
      }
    });

    it("flushRealtimeUpdate waits for loadData when activePoints last candle is older than stepSec * 2", () => {
      const controller = new AnalyticsController();
      const mockPair = {
        symbol: "AAPL",
        rhMarketId: 1,
        coreMarketId: 2,
        markPrice: 150,
        indexPrice: 150,
        hedgeSideConfig: { isRhLong: true },
        rh: { markPrice: 150 },
        core: { markPrice: 150 },
      };
      (controller as any).activePair = mockPair;
      (controller as any).pairs = [mockPair];
      (controller as any).activeSymbol = "AAPL";

      const rhBook = createEmptyBook(1);
      const coreBook = createEmptyBook(2);
      rhBook.isSnapshotReceived = true;
      coreBook.isSnapshotReceived = true;
      (controller as any).rhBook = rhBook;
      (controller as any).coreBook = coreBook;
      (controller as any).lastKnownRhMid = 150;
      (controller as any).lastKnownCoreMid = 150;

      const stepSec = 60;
      (controller as any).currentResolutionStepSec = stepSec;
      const nowSec = Math.floor(Date.now() / 1000);
      const currentBarTime = Math.floor(nowSec / stepSec) * stepSec;

      // Candle from 1 hour ago
      const oldCandleTime = currentBarTime - 3600;
      (controller as any).activePoints = [
        {
          timeSec: oldCandleTime,
          timestampMs: oldCandleTime * 1000,
          rhPrice: 140,
          corePrice: 140,
          basisUsd: 0,
          basisBps: 0,
          midPrice: 140,
          rhVolume: 10,
          coreVolume: 10,
        },
      ];

      // Call flushRealtimeUpdate: currentBarTime - oldCandleTime (3600) > stepSec * 2 (120)
      (controller as any).flushRealtimeUpdate();

      // Must not append live point across the 1-hour gap
      expect((controller as any).activePoints.length).toBe(1);
      expect((controller as any).activePoints[0].timeSec).toBe(oldCandleTime);

      // Now set last candle to recent (currentBarTime - 60 <= stepSec * 2)
      (controller as any).activePoints = [
        {
          timeSec: currentBarTime - 60,
          timestampMs: (currentBarTime - 60) * 1000,
          rhPrice: 140,
          corePrice: 140,
          basisUsd: 0,
          basisBps: 0,
          midPrice: 140,
          rhVolume: 10,
          coreVolume: 10,
        },
      ];
      (controller as any).flushRealtimeUpdate();

      // Recent candle gap <= stepSec * 2: live point is appended
      expect((controller as any).activePoints.length).toBe(2);
      expect((controller as any).activePoints[1].timeSec).toBe(currentBarTime);

      controller.destroy();
    });
  });

  describe("Bug 3: VisibilityChange & bfcache Pageshow Handling", () => {
    it("registers and cleans up visibilitychange and pageshow event listeners", () => {
      const controller = new AnalyticsController();
      (controller as any).setupEventListeners();

      expect(docListeners["visibilitychange"]?.length).toBeGreaterThanOrEqual(1);
      expect(winListeners["pageshow"]?.length).toBeGreaterThanOrEqual(1);

      controller.destroy();

      expect(docListeners["visibilitychange"]?.length).toBe(0);
      expect(winListeners["pageshow"]?.length).toBe(0);
    });

    it("triggers checkHealthAndReconnect and invalidates books on return from sleep (>15s)", () => {
      const controller = new AnalyticsController();
      (controller as any).initWs();

      const rhBook = createEmptyBook(1);
      const coreBook = createEmptyBook(2);
      rhBook.isSnapshotReceived = true;
      coreBook.isSnapshotReceived = true;
      (controller as any).rhBook = rhBook;
      (controller as any).coreBook = coreBook;

      let reconnected = false;
      (controller as any).wsManager.checkHealthAndReconnect = () => {
        reconnected = true;
      };

      let loadPairsCalled = false;
      let loadDataCalled = false;
      (controller as any).loadPairs = async () => {
        loadPairsCalled = true;
      };
      (controller as any).loadData = async () => {
        loadDataCalled = true;
      };

      // Simulate tab hidden 20 seconds ago
      (controller as any).lastHiddenAt = Date.now() - 20_000;
      (globalThis as any).document.visibilityState = "visible";

      // Trigger visibilitychange handler
      (controller as any).onVisibilityChange();

      expect(reconnected).toBe(true);
      expect(rhBook.isSnapshotReceived).toBe(false);
      expect(rhBook.offset).toBe(0);
      expect(coreBook.isSnapshotReceived).toBe(false);
      expect(coreBook.offset).toBe(0);
      expect((controller as any).lastHiddenAt).toBe(0); // Reset timer!
      expect(loadPairsCalled).toBe(false); // Does not run loadPairs to avoid clobbering WS snapshots!
      expect(loadDataCalled).toBe(true);

      controller.destroy();
    });
  });

  describe("Bug 4: Viewport Range Debounce & Live Price Preservation", () => {
    it("preserves live mid price at the live edge during fetchRangeDataDebounced", async () => {
      const controller = new AnalyticsController();
      const mockPair = {
        symbol: "AAPL",
        rhMarketId: 1,
        coreMarketId: 2,
        markPrice: 150,
        indexPrice: 150,
        hedgeSideConfig: { isRhLong: true },
        rh: { markPrice: 150 },
        core: { markPrice: 150 },
      };
      (controller as any).activePair = mockPair;
      (controller as any).pairs = [mockPair];
      (controller as any).activeSymbol = "AAPL";

      const rhBook = createEmptyBook(1);
      const coreBook = createEmptyBook(2);
      rhBook.isSnapshotReceived = true;
      coreBook.isSnapshotReceived = true;
      (controller as any).rhBook = rhBook;
      (controller as any).coreBook = coreBook;

      // Live prices from WebSocket
      (controller as any).lastKnownRhMid = 155.0;
      (controller as any).lastKnownCoreMid = 154.5;

      const nowSec = Math.floor(Date.now() / 1000);

      // REST API returns older candle ending 2 minutes ago at 150.0
      (globalThis as any).fetch = async (url: string) => {
        if (url.includes("candles")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              c: [
                {
                  t: (nowSec - 180) * 1000,
                  o: 149.0,
                  h: 149.0,
                  l: 149.0,
                  c: 149.0,
                  v: 100,
                  V: 14900,
                },
                {
                  t: (nowSec - 120) * 1000,
                  o: 150.0,
                  h: 150.0,
                  l: 150.0,
                  c: 150.0,
                  v: 100,
                  V: 15000,
                },
              ],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      try {
        await (controller as any).fetchRangeDataDebounced(nowSec - 300, nowSec);

        // The last point must now be the live mid price (155 / 154.5), NOT the stale REST 150
        const activePoints = (controller as any).activePoints;
        expect(activePoints.length).toBeGreaterThanOrEqual(2);
        const lastPoint = activePoints[activePoints.length - 1]!;
        expect(lastPoint.rhPrice).toBe(155.0);
        expect(lastPoint.corePrice).toBe(154.5);
        expect(lastPoint.basisUsd).toBe(0.5);
      } finally {
        controller.destroy();
      }
    });

    it("does not attach live point to historical past view when user scrolls back", async () => {
      const controller = new AnalyticsController();
      const mockPair = {
        symbol: "AAPL",
        rhMarketId: 1,
        coreMarketId: 2,
        markPrice: 150,
        indexPrice: 150,
        hedgeSideConfig: { isRhLong: true },
        rh: { markPrice: 150 },
        core: { markPrice: 150 },
      };
      (controller as any).activePair = mockPair;
      (controller as any).pairs = [mockPair];
      (controller as any).activeSymbol = "AAPL";

      const rhBook = createEmptyBook(1);
      const coreBook = createEmptyBook(2);
      rhBook.isSnapshotReceived = true;
      coreBook.isSnapshotReceived = true;
      (controller as any).rhBook = rhBook;
      (controller as any).coreBook = coreBook;

      (controller as any).lastKnownRhMid = 155.0;
      (controller as any).lastKnownCoreMid = 154.5;

      const nowSec = Math.floor(Date.now() / 1000);
      const pastFrom = nowSec - 86400;
      const pastTo = pastFrom + 300;

      (globalThis as any).fetch = async (url: string) => {
        if (url.includes("candles")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              c: [
                {
                  t: (pastFrom + 60) * 1000,
                  o: 130.0,
                  h: 130.0,
                  l: 130.0,
                  c: 130.0,
                  v: 100,
                  V: 13000,
                },
                {
                  t: (pastFrom + 120) * 1000,
                  o: 131.0,
                  h: 131.0,
                  l: 131.0,
                  c: 131.0,
                  v: 100,
                  V: 13100,
                },
              ],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      try {
        await (controller as any).fetchRangeDataDebounced(pastFrom, pastTo);

        const activePoints = (controller as any).activePoints;
        expect(activePoints.length).toBe(2);
        const lastPoint = activePoints[activePoints.length - 1]!;
        // Historical points preserved, NOT overwritten by live mid prices 155.0 / 154.5
        expect(lastPoint.rhPrice).toBe(131.0);
        expect(lastPoint.corePrice).toBe(131.0);
      } finally {
        controller.destroy();
      }
    });

    it("loadData inlines live point before setData and calculating stats/bands when live prices exist", async () => {
      const controller = new AnalyticsController();
      const mockPair = {
        symbol: "AAPL",
        rhMarketId: 1,
        coreMarketId: 2,
        markPrice: 110.0,
        indexPrice: 110.0,
        dailyPriceChange: 0,
        dailyVolumeUsd: 0,
        openInterestUsd: 0,
        fundingRate1h: 0,
        hedgeSideConfig: { isRhLong: true },
        rh: { markPrice: 110.0 },
        core: { markPrice: 110.0 },
      };
      (controller as any).activePair = mockPair;
      (controller as any).pairs = [mockPair];
      (controller as any).activeSymbol = "AAPL";

      const rhBook = createEmptyBook(1);
      const coreBook = createEmptyBook(2);
      rhBook.isSnapshotReceived = true;
      coreBook.isSnapshotReceived = true;
      (controller as any).rhBook = rhBook;
      (controller as any).coreBook = coreBook;
      (controller as any).lastKnownRhMid = 120.0;
      (controller as any).lastKnownCoreMid = 119.0;
      (controller as any).activeTimeframe = "1h";

      const nowSec = Math.floor(Date.now() / 1000);
      (globalThis as any).fetch = async (url: string) => {
        if (url.includes("candles")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              c: [
                {
                  t: (nowSec - 120) * 1000,
                  o: 110.0,
                  h: 110.0,
                  l: 110.0,
                  c: 110.0,
                  v: 10,
                  V: 1100,
                },
              ],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      try {
        await (controller as any).loadData();

        const activePoints = (controller as any).activePoints;
        expect(activePoints.length).toBeGreaterThanOrEqual(1);
        const lastPoint = activePoints[activePoints.length - 1]!;
        expect(lastPoint.rhPrice).toBe(120.0);
        expect(lastPoint.corePrice).toBe(119.0);
        expect(lastPoint.basisUsd).toBe(1.0);
        expect((controller as any).currentStats).not.toBeNull();
      } finally {
        controller.destroy();
      }
    });
  });
});
