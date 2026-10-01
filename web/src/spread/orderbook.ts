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
  const asks = orderBook.asks;
  if (asks) {
    const len = asks.length;
    for (let i = 0; i < len; i++) {
      const item = asks[i]!;
      const price = item.price;
      const size = item.size;
      const p = typeof price === "number" ? price : +price;
      const s = typeof size === "number" ? size : +size;
      if (isNaN(p) || isNaN(s)) continue;
      if (s <= 0) book.asks.delete(p);
      else book.asks.set(p, s);
    }
  }
  const bids = orderBook.bids;
  if (bids) {
    const len = bids.length;
    for (let i = 0; i < len; i++) {
      const item = bids[i]!;
      const price = item.price;
      const size = item.size;
      const p = typeof price === "number" ? price : +price;
      const s = typeof size === "number" ? size : +size;
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
  const size = map.size;
  if (size === 0) return [];

  const prices: number[] = [];
  for (const price of map.keys()) {
    prices.push(price);
  }

  prices.sort(isAsk ? (a, b) => a - b : (a, b) => b - a);

  const count = size > limit ? limit : size;
  const result: OrderBookLevel[] = [];
  for (let i = 0; i < count; i++) {
    const p = prices[i]!;
    const totalBase = map.get(p)!;
    result.push({ price: p, totalBase, totalUsd: p * totalBase });
  }
  return result;
}
