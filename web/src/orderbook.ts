import type { OrderBook, OrderBookLevel } from "./types";
import { CONFIG } from "./config";

export function getOrCreateBook(bookMap: Map<number, OrderBook>, marketId: number): OrderBook {
  let b = bookMap.get(marketId);
  if (!b) {
    b = {
      marketId,
      asks: new Map(),
      bids: new Map(),
      isSnapshotReceived: false,
      lastUpdatedTs: 0,
      offset: 0,
    };
    bookMap.set(marketId, b);
  }
  return b;
}

export interface WsOrderBookData {
  asks?: Array<{ price: string | number; size: string | number }>;
  bids?: Array<{ price: string | number; size: string | number }>;
}

export function updateBookFromWs(
  book: OrderBook,
  orderBook: WsOrderBookData,
  isSnapshot = false,
  offset = 0,
): void {
  if (isSnapshot) {
    book.asks.clear();
    book.bids.clear();
  }
  if (orderBook.asks) {
    for (const { price, size } of orderBook.asks) {
      const p = typeof price === "number" ? price : parseFloat(price);
      const s = typeof size === "number" ? size : parseFloat(size);
      if (isNaN(p) || isNaN(s)) continue;
      if (s <= 0) book.asks.delete(p);
      else book.asks.set(p, s);
    }
  }
  if (orderBook.bids) {
    for (const { price, size } of orderBook.bids) {
      const p = typeof price === "number" ? price : parseFloat(price);
      const s = typeof size === "number" ? size : parseFloat(size);
      if (isNaN(p) || isNaN(s)) continue;
      if (s <= 0) book.bids.delete(p);
      else book.bids.set(p, s);
    }
  }
  book.isSnapshotReceived = true;
  book.lastUpdatedTs = Date.now();
  if (offset) book.offset = offset;
}

export function getSortedLevels(
  map: Map<number, number>,
  isAsk: boolean,
  limit: number = CONFIG.ORDERBOOK_LEVELS_LIMIT,
): OrderBookLevel[] {
  const arr: OrderBookLevel[] = [];
  for (const [price, totalBase] of map.entries()) {
    arr.push({ price, totalBase, totalUsd: price * totalBase });
  }
  arr.sort((a, b) => (isAsk ? a.price - b.price : b.price - a.price));
  return arr.length > limit ? arr.slice(0, limit) : arr;
}
