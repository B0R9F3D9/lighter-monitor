import { describe, expect, it } from "bun:test";
import {
  createEmptyBook,
  updateBookFromWs,
  getBookMidPrice,
  getBookBestPrices,
} from "../src/shared/orderbook";
import { evaluateSignalVerdict } from "../src/analytics/math";

describe("Analytics WebSocket & Real-Time Price Tracking", () => {
  it("tracks orderbook snapshots and computes mid prices for RH and Core", () => {
    const rhBook = createEmptyBook(1);
    const coreBook = createEmptyBook(2);

    expect(getBookMidPrice(rhBook)).toBe(0);
    expect(getBookMidPrice(coreBook)).toBe(0);

    // Initial snapshots
    updateBookFromWs(
      rhBook,
      {
        bids: [
          { price: 531.1, size: 10 },
          { price: 531.0, size: 20 },
        ],
        asks: [
          { price: 531.3, size: 15 },
          { price: 531.4, size: 25 },
        ],
      },
      true,
    );

    updateBookFromWs(
      coreBook,
      {
        bids: [
          { price: 531.3, size: 8 },
          { price: 531.2, size: 18 },
        ],
        asks: [
          { price: 531.5, size: 12 },
          { price: 531.6, size: 22 },
        ],
      },
      true,
    );

    const rhMid = getBookMidPrice(rhBook);
    const coreMid = getBookMidPrice(coreBook);

    expect(rhMid).toBeCloseTo(531.2, 4);
    expect(coreMid).toBeCloseTo(531.4, 4);

    // Compute basis
    const basisUsd = rhMid - coreMid;
    const midPrice = (rhMid + coreMid) / 2;
    const basisBps = (basisUsd / midPrice) * 10000;

    expect(basisUsd).toBeCloseTo(-0.2, 4); // RH is 20 cents cheaper (discount)
    expect(basisBps).toBeCloseTo((-0.2 / 531.3) * 10000, 2);
  });

  it("handles delta updates and cancellations in real time", () => {
    const book = createEmptyBook(10);

    // Initial snapshot
    updateBookFromWs(
      book,
      {
        bids: [
          { price: 100.0, size: 5 },
          { price: 99.5, size: 10 },
        ],
        asks: [
          { price: 100.5, size: 5 },
          { price: 101.0, size: 10 },
        ],
      },
      true,
    );

    expect(getBookMidPrice(book)).toBeCloseTo(100.25, 4);

    // Delta update: top bid at 100.0 cancelled (size = 0), new ask at 100.2 added
    updateBookFromWs(
      book,
      {
        bids: [{ price: 100.0, size: 0 }],
        asks: [{ price: 100.2, size: 2 }],
      },
      false,
    );

    const { bestBid, bestAsk } = getBookBestPrices(book);
    expect(bestBid).toBe(99.5);
    expect(bestAsk).toBe(100.2);
    expect(getBookMidPrice(book)).toBeCloseTo((99.5 + 100.2) / 2, 4);
  });

  it("rejects crossed orderbooks safely without crashing", () => {
    const book = createEmptyBook(42);

    updateBookFromWs(
      book,
      {
        bids: [{ price: 102.0, size: 10 }],
        asks: [{ price: 101.0, size: 10 }], // Best bid > best ask = crossed!
      },
      true,
    );

    expect(getBookMidPrice(book)).toBe(0);
  });

  it("computes live Z-Score and verdict dynamically from live basis", () => {
    const meanBasisUsd = -0.1;
    const stdDevUsd = 0.2;
    const isRhLong = true; // RH discount is favorable

    // Case 1: Basis is -$0.50 (well below mean -0.10) -> favorable entry!
    const basisUsd1 = -0.5;
    const zScore1 = (basisUsd1 - meanBasisUsd) / stdDevUsd; // (-0.5 - (-0.1)) / 0.2 = -2.0
    const effZScore1 = isRhLong ? zScore1 : -zScore1;
    expect(effZScore1).toBeCloseTo(-2.0, 2);
    expect(evaluateSignalVerdict(effZScore1)).toBe("EXCELLENT ENTRY");

    // Case 2: Basis is +$0.40 (above mean) -> overheated!
    const basisUsd2 = 0.4;
    const zScore2 = (basisUsd2 - meanBasisUsd) / stdDevUsd; // (0.4 - (-0.1)) / 0.2 = +2.5
    const effZScore2 = isRhLong ? zScore2 : -zScore2;
    expect(effZScore2).toBeCloseTo(2.5, 2);
    expect(evaluateSignalVerdict(effZScore2)).toBe("OVERHEATED");
  });

  describe("OrderBook Sequence Offset & Snapshot Guarding", () => {
    it("drops delta updates if snapshot was never received or was reset", () => {
      const book = createEmptyBook(100);
      expect(book.isSnapshotReceived).toBe(false);

      // Delta before snapshot must be ignored
      updateBookFromWs(
        book,
        {
          bids: [{ price: 50.0, size: 10 }],
          asks: [{ price: 51.0, size: 10 }],
        },
        false,
      );

      expect(book.isSnapshotReceived).toBe(false);
      expect(getBookMidPrice(book)).toBe(0);
      expect(book.bids.size).toBe(0);
      expect(book.asks.size).toBe(0);

      // Now receive snapshot
      updateBookFromWs(
        book,
        {
          bids: [{ price: 50.0, size: 10 }],
          asks: [{ price: 51.0, size: 10 }],
        },
        true,
        1000,
      );
      expect(book.isSnapshotReceived).toBe(true);
      expect(book.offset).toBe(1000);
      expect(getBookMidPrice(book)).toBe(50.5);

      // Reset book on connection drop / visibility change
      book.isSnapshotReceived = false;
      expect(getBookMidPrice(book)).toBe(0);

      // Delta arriving after reset before new snapshot must be ignored
      updateBookFromWs(
        book,
        {
          bids: [{ price: 52.0, size: 5 }],
        },
        false,
        1001,
      );
      // Mid price must still be 0 (invalidated)
      expect(getBookMidPrice(book)).toBe(0);
    });

    it("drops stale and duplicate sequence offsets", () => {
      const book = createEmptyBook(101);

      // Snapshot with sequence offset 500
      updateBookFromWs(
        book,
        {
          bids: [{ price: 100.0, size: 10 }],
          asks: [{ price: 102.0, size: 10 }],
        },
        true,
        500,
      );
      expect(book.offset).toBe(500);
      expect(getBookMidPrice(book)).toBe(101.0);

      // Duplicate offset 500 should be rejected
      updateBookFromWs(
        book,
        {
          bids: [{ price: 100.5, size: 20 }],
        },
        false,
        500,
      );
      expect(book.bids.get(100.5)).toBeUndefined();
      expect(book.offset).toBe(500);

      // Older offset 490 should be rejected
      updateBookFromWs(
        book,
        {
          bids: [{ price: 100.5, size: 20 }],
        },
        false,
        490,
      );
      expect(book.bids.get(100.5)).toBeUndefined();
      expect(book.offset).toBe(500);

      // Newer offset 501 should be accepted
      updateBookFromWs(
        book,
        {
          bids: [{ price: 100.5, size: 20 }],
        },
        false,
        501,
      );
      expect(book.bids.get(100.5)).toBe(20);
      expect(book.offset).toBe(501);
      expect(getBookMidPrice(book)).toBe((100.5 + 102.0) / 2);
    });
  });

  describe("WebSocketManager Health & Reconnect", () => {
    it("provides checkHealthAndReconnect to detect stale or dead sockets", () => {
      // Mock WebSocket
      const originalWs = globalThis.WebSocket;
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

      try {
        const { WebSocketManager } = require("../src/shared/ws");
        const mgr = new WebSocketManager({});

        // Trigger health check - sockets are null, should initiate connections
        mgr.checkHealthAndReconnect();
        expect((mgr as any).coreWs).not.toBeNull();
        expect((mgr as any).rhWs).not.toBeNull();

        // Simulate stale messages (> 15 seconds ago)
        mgr.lastCoreMsgAt = Date.now() - 20_000;
        mgr.lastRhMsgAt = Date.now() - 20_000;

        const prevCoreWs = (mgr as any).coreWs;
        const prevRhWs = (mgr as any).rhWs;

        mgr.checkHealthAndReconnect();

        // Sockets should have been reconnected (new instances created)
        expect((mgr as any).coreWs).not.toBe(prevCoreWs);
        expect((mgr as any).rhWs).not.toBe(prevRhWs);

        mgr.disconnectAll();
      } finally {
        globalThis.WebSocket = originalWs;
      }
    });
  });
});
