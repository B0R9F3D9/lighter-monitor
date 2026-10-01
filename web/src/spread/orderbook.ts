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
      cachedAsks: null,
      cachedBids: null,
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
  let asksChanged = isSnapshot;
  let bidsChanged = isSnapshot;

  if (isSnapshot) {
    book.asks.clear();
    book.bids.clear();
  }
  if (orderBook.asks && orderBook.asks.length > 0) {
    asksChanged = true;
    for (let i = 0; i < orderBook.asks.length; i++) {
      const item = orderBook.asks[i]!;
      const price = item.price;
      const size = item.size;
      const p = typeof price === "number" ? price : +price;
      const s = typeof size === "number" ? size : +size;
      if (isNaN(p) || isNaN(s)) continue;
      if (s <= 0) book.asks.delete(p);
      else book.asks.set(p, s);
    }
  }
  if (orderBook.bids && orderBook.bids.length > 0) {
    bidsChanged = true;
    for (let i = 0; i < orderBook.bids.length; i++) {
      const item = orderBook.bids[i]!;
      const price = item.price;
      const size = item.size;
      const p = typeof price === "number" ? price : +price;
      const s = typeof size === "number" ? size : +size;
      if (isNaN(p) || isNaN(s)) continue;
      if (s <= 0) book.bids.delete(p);
      else book.bids.set(p, s);
    }
  }

  // Сбрасываем кэш ТОЛЬКО если были изменения!
  if (asksChanged) book.cachedAsks = null;
  if (bidsChanged) book.cachedBids = null;

  book.isSnapshotReceived = true;
  book.lastUpdatedTs = Date.now();
  if (offset) book.offset = offset;
}

export const ASC_COMP = (a: number, b: number): number => a - b;
export const DESC_COMP = (a: number, b: number): number => b - a;

export function getSortedLevels(
  bookOrMap: OrderBook | Map<number, number>,
  isAsk: boolean,
  limit: number = CONFIG.ORDERBOOK_LEVELS_LIMIT,
): OrderBookLevel[] {
  let book: OrderBook | null = null;
  let map: Map<number, number>;

  if ("asks" in bookOrMap) {
    book = bookOrMap;
    if (isAsk && book.cachedAsks != null) return book.cachedAsks;
    if (!isAsk && book.cachedBids != null) return book.cachedBids;
    map = isAsk ? book.asks : book.bids;
  } else {
    map = bookOrMap;
  }

  const n = map.size;
  if (n === 0) return [];

  const keys = Array.from(map.keys());
  keys.sort(isAsk ? ASC_COMP : DESC_COMP);

  // 1. Прунинг мертвых/устаревших уровней: защищаем Map от бесконечного разрастания
  // Сохраняем безопасную глубину (80 уровней = 2x от 40), чтобы гарантированно не отбросить нужные уровни
  const maxRetain = Math.max(limit * 2, CONFIG.ORDERBOOK_PRUNE_LIMIT ?? 80);
  if (keys.length > maxRetain) {
    for (let i = maxRetain; i < keys.length; i++) {
      map.delete(keys[i]!);
    }
  }

  // 2. Отбираем топ-уровни для симуляции и расчета
  const take = Math.min(keys.length, limit);
  const arr: OrderBookLevel[] = [];
  for (let i = 0; i < take; i++) {
    const p = keys[i]!;
    const base = map.get(p)!;
    arr.push({ price: p, totalBase: base, totalUsd: p * base });
  }

  if (book) {
    if (isAsk) book.cachedAsks = arr;
    else book.cachedBids = arr;
  }

  return arr;
}
