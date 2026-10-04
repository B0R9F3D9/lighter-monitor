import type { FlatOrderBookSide as IFlatOrderBookSide, OrderBook, OrderBookLevel } from "./types";
import { CONFIG } from "./config";
import type { WsOrderBookData } from "../shared/ws";

export class FlatOrderBookSide implements IFlatOrderBookSide {
  readonly isAsk: boolean;
  readonly capacity: number;
  count: number = 0;
  totalDepthUsd: number = 0;
  totalDepthBase: number = 0;
  readonly prices: Float64Array;
  readonly sizes: Float64Array;
  readonly totalUsds: Float64Array;

  constructor(
    isAsk: boolean,
    capacityOrEntries?: number | Iterable<readonly [number, number]>,
    capacity: number = 80,
  ) {
    this.isAsk = isAsk;
    let cap = capacity;
    let initialEntries: Iterable<readonly [number, number]> | null = null;
    if (typeof capacityOrEntries === "number") {
      cap = capacityOrEntries;
    } else if (capacityOrEntries != null) {
      initialEntries = capacityOrEntries;
    }
    this.capacity = cap;
    this.prices = new Float64Array(cap);
    this.sizes = new Float64Array(cap);
    this.totalUsds = new Float64Array(cap);

    if (initialEntries) {
      for (const [p, s] of initialEntries) {
        this.set(p, s);
      }
    }
  }

  clear(): void {
    this.count = 0;
    this.totalDepthUsd = 0;
    this.totalDepthBase = 0;
  }

  recalibrateDepth(): void {
    let u = 0;
    let b = 0;
    const count = this.count;
    const sizes = this.sizes;
    const totalUsds = this.totalUsds;
    for (let i = 0; i < count; i++) {
      b += sizes[i]!;
      u += totalUsds[i]!;
    }
    this.totalDepthBase = b;
    this.totalDepthUsd = u;
  }

  find(price: number): number {
    let low = 0;
    let high = this.count - 1;
    const isAsk = this.isAsk;
    const prices = this.prices;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const midPrice = prices[mid]!;
      if (midPrice === price) {
        return mid;
      }
      if (isAsk ? midPrice < price : midPrice > price) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return ~low;
  }

  has(price: number): boolean {
    return this.find(price) >= 0;
  }

  get(price: number): number | undefined {
    const idx = this.find(price);
    return idx >= 0 ? this.sizes[idx] : undefined;
  }

  get size(): number {
    return this.count;
  }

  delete(price: number): boolean {
    return this.remove(price);
  }

  remove(price: number): boolean {
    const idx = this.find(price);
    if (idx < 0) return false;
    this.totalDepthUsd -= this.totalUsds[idx]!;
    this.totalDepthBase -= this.sizes[idx]!;
    if (this.totalDepthUsd < 0) this.totalDepthUsd = 0;
    if (this.totalDepthBase < 0) this.totalDepthBase = 0;
    if (idx < this.count - 1) {
      this.prices.copyWithin(idx, idx + 1, this.count);
      this.sizes.copyWithin(idx, idx + 1, this.count);
      this.totalUsds.copyWithin(idx, idx + 1, this.count);
    }
    this.count--;
    if (this.count === 0) {
      this.totalDepthUsd = 0;
      this.totalDepthBase = 0;
    }
    return true;
  }

  set(price: number, size: number): void {
    if (size <= 0) {
      this.remove(price);
      return;
    }
    const idx = this.find(price);
    if (idx >= 0) {
      const oldUsd = this.totalUsds[idx]!;
      const oldBase = this.sizes[idx]!;
      const newUsd = price * size;
      this.sizes[idx] = size;
      this.totalUsds[idx] = newUsd;
      this.totalDepthUsd += (newUsd - oldUsd);
      this.totalDepthBase += (size - oldBase);
      if (this.totalDepthUsd < 0) this.totalDepthUsd = 0;
      if (this.totalDepthBase < 0) this.totalDepthBase = 0;
      return;
    }

    const insertIdx = ~idx;
    if (insertIdx >= this.capacity) {
      return;
    }

    const oldCount = this.count;
    if (oldCount === this.capacity) {
      const lastIdx = this.capacity - 1;
      this.totalDepthUsd -= this.totalUsds[lastIdx]!;
      this.totalDepthBase -= this.sizes[lastIdx]!;
    } else {
      this.count++;
    }

    const moveEnd = Math.min(oldCount, this.capacity - 1);
    if (insertIdx < moveEnd) {
      this.prices.copyWithin(insertIdx + 1, insertIdx, moveEnd);
      this.sizes.copyWithin(insertIdx + 1, insertIdx, moveEnd);
      this.totalUsds.copyWithin(insertIdx + 1, insertIdx, moveEnd);
    }

    const newUsd = price * size;
    this.prices[insertIdx] = price;
    this.sizes[insertIdx] = size;
    this.totalUsds[insertIdx] = newUsd;
    this.totalDepthUsd += newUsd;
    this.totalDepthBase += size;
    if (this.totalDepthUsd < 0) this.totalDepthUsd = 0;
    if (this.totalDepthBase < 0) this.totalDepthBase = 0;
  }
}

export function getOrCreateBook(bookMap: Map<number, OrderBook>, marketId: number): OrderBook {
  let b = bookMap.get(marketId);
  if (!b) {
    b = {
      marketId,
      asks: new FlatOrderBookSide(true),
      bids: new FlatOrderBookSide(false),
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

export function updateBookFromWs(
  book: OrderBook,
  orderBook: WsOrderBookData,
  isSnapshot = false,
  offset = 0,
): void {
  const asks: FlatOrderBookSide = ("prices" in book.asks)
    ? (book.asks as FlatOrderBookSide)
    : (book.asks = new FlatOrderBookSide(true, (book.asks as Map<number, number>).entries()));
  const bids: FlatOrderBookSide = ("prices" in book.bids)
    ? (book.bids as FlatOrderBookSide)
    : (book.bids = new FlatOrderBookSide(false, (book.bids as Map<number, number>).entries()));

  if (isSnapshot) {
    asks.clear();
    bids.clear();
  }

  let asksChanged = isSnapshot;
  let bidsChanged = isSnapshot;

  if (orderBook.asks && orderBook.asks.length > 0) {
    asksChanged = true;
    for (let i = 0; i < orderBook.asks.length; i++) {
      const item = orderBook.asks[i]!;
      const p = +item.price;
      const s = +item.size;
      if (isNaN(p) || isNaN(s)) continue;
      asks.set(p, s);
    }
    if (isSnapshot) asks.recalibrateDepth();
  }

  if (orderBook.bids && orderBook.bids.length > 0) {
    bidsChanged = true;
    for (let i = 0; i < orderBook.bids.length; i++) {
      const item = orderBook.bids[i]!;
      const p = +item.price;
      const s = +item.size;
      if (isNaN(p) || isNaN(s)) continue;
      bids.set(p, s);
    }
    if (isSnapshot) bids.recalibrateDepth();
  }

  if (asksChanged) book.cachedAsks = null;
  if (bidsChanged) book.cachedBids = null;

  book.isSnapshotReceived = true;
  book.lastUpdatedTs = Date.now();
  if (offset) book.offset = offset;
}

export const ASC_COMP = (a: number, b: number): number => a - b;

export function getSortedLevels(
  bookOrSide: OrderBook | FlatOrderBookSide | Map<number, number>,
  isAsk: boolean,
  limit: number = CONFIG.ORDERBOOK_LEVELS_LIMIT,
): OrderBookLevel[] {
  let side: FlatOrderBookSide;
  let book: OrderBook | null = null;

  if ("asks" in bookOrSide) {
    book = bookOrSide;
    if (isAsk && book.cachedAsks != null) return book.cachedAsks;
    if (!isAsk && book.cachedBids != null) return book.cachedBids;
    if (isAsk) {
      if (!("prices" in book.asks)) {
        book.asks = new FlatOrderBookSide(true, (book.asks as Map<number, number>).entries());
      }
      side = book.asks;
    } else {
      if (!("prices" in book.bids)) {
        book.bids = new FlatOrderBookSide(false, (book.bids as Map<number, number>).entries());
      }
      side = book.bids;
    }
  } else if ("prices" in bookOrSide) {
    side = bookOrSide;
  } else {
    // Legacy Map support
    side = new FlatOrderBookSide(isAsk, bookOrSide.entries());
  }

  const take = Math.min(side.count, limit);
  const arr: OrderBookLevel[] = [];
  for (let i = 0; i < take; i++) {
    arr.push({
      price: side.prices[i]!,
      totalBase: side.sizes[i]!,
      totalUsd: side.totalUsds[i]!,
    });
  }

  if (book) {
    if (isAsk) book.cachedAsks = arr;
    else book.cachedBids = arr;
  }

  return arr;
}
