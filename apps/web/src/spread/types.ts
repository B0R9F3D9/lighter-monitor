import type { HedgeSideConfig, HedgeStrategyCategory, TokenCategoryType } from "../shared";

export interface OrderBookLevel {
  price: number;
  totalBase: number;
  totalUsd: number;
}

export interface FlatOrderBookSide {
  readonly isAsk: boolean;
  readonly capacity: number;
  count: number;
  totalDepthUsd: number;
  totalDepthBase: number;
  readonly prices: Float64Array;
  readonly sizes: Float64Array;
  readonly totalUsds: Float64Array;
  clear(): void;
  remove(price: number): boolean;
  set(price: number, size: number): void;
  find(price: number): number;
  has(price: number): boolean;
  get(price: number): number | undefined;
  delete(price: number): boolean;
  readonly size: number;
  recalibrateDepth(): void;
}

export interface OrderBook {
  marketId: number;
  asks: FlatOrderBookSide | Map<number, number>;
  bids: FlatOrderBookSide | Map<number, number>;
  isSnapshotReceived: boolean;
  lastUpdatedTs: number;
  offset: number;
  cachedAsks?: OrderBookLevel[] | null;
  cachedBids?: OrderBookLevel[] | null;
}

export interface SimFillResult {
  isComplete: boolean;
  avgPrice: number;
  bestPrice: number;
  slippageBps: number;
  levelsSwept: number;
  totalCostUsd: number;
  filledBase: number;
  totalAvailableUsd: number;
  totalAvailableBase: number;
}

export interface MarketInfo {
  symbol: string;
  leverage: string;
  leverageNum: number;
  rhLeverage: string;
  coreLeverage: string;
  rhMarketId: number;
  coreMarketId: number;
  rhVolume24h: number;
  coreVolume24h: number;
  totalVolume24h: number;
  rhOiUsd: number;
  coreOiUsd: number;
  totalOiUsd: number;
  latestMetrics: MarketMetrics | null;
}

interface ExecutionLegs {
  entryRh: SimFillResult;
  entryCore: SimFillResult;
  exitRh: SimFillResult;
  exitCore: SimFillResult;
  rhBestAsk: number;
  coreBestBid: number;
  rhBestBid: number;
  coreBestAsk: number;
  rhMid: number;
  coreMid: number;
}

export type DynamicSizeMode = "none" | "min_burn" | "max_vol";

export interface MarketMetrics {
  symbol: string;
  leverage: string;
  leverageNum: number;
  rhLeverage: string;
  coreLeverage: string;
  midPrice: number;
  rhMid: number;
  coreMid: number;
  deltaMidUsd: number;
  deltaMidBps: number;
  baseQty: number;
  allFilled: boolean;
  isStale: boolean;
  totalVolume24h: number;
  rhVolume24h: number;
  totalOiUsd: number;
  rawSpreadBps: number;
  slippageBps: number;
  entryDragBps: number;
  exitDragBps: number;
  entryLossUsd: number;
  exitLossUsd: number;
  vwapTotalDragBps: number;
  costUsd: number;
  rawCostUsd: number;
  maxLevelsSwept: number;
  minDepthUsd: number;
  optimalSizeUsd: number;
  effectiveTargetUsd: number;
  isDynamic: boolean;
  dynamicMode: DynamicSizeMode;
  status: "READY" | "SLIPPAGE" | "LOW LIQ" | "STALE";
  isRhLong: boolean;
  hedgeCategory: HedgeStrategyCategory;
  hedgeSideConfig: HedgeSideConfig;
  legs: ExecutionLegs;
  computedAt?: number;
}

interface EmaEntry {
  cost: number;
  lastTs: number;
}

export interface TerminalState {
  markets: Map<string, MarketInfo>;
  coreBooks: Map<number, OrderBook>;
  rhBooks: Map<number, OrderBook>;
  targetSizeUsd: number;
  isDynamicSize: boolean;
  dynamicMode: DynamicSizeMode;
  maxCapUsd: number;
  filterEquities: boolean;
  categoryFilter: TokenCategoryType;
  filterReadyOnly: boolean;
  minLeverageFilter: number;
  searchQuery: string;
  sortColumn: keyof MarketMetrics | "leverageNum";
  sortDirection: "asc" | "desc";
  isAutoSortEnabled: boolean;
  displayedSymbolsOrder: string[];
  rerankTimerRemaining: number;
  rerankIntervalSec: number;
  emaMap: Map<string, EmaEntry>;
  expandedSymbol: string | null;
  isCoreConnected: boolean;
  isRhConnected: boolean;
}

export interface RowDomCache {
  tr: HTMLTableRowElement;
  verdictEl: HTMLElement;
  sizeEl: HTMLElement;
  rtLossEl: HTMLElement;
  entryBpsEl: HTMLElement;
  entryUsdEl: HTMLElement;
  exitBpsEl: HTMLElement;
  exitUsdEl: HTMLElement;
  midPriceEl: HTMLElement;
  deltaMidEl: HTMLElement | null;
  volEl: HTMLElement | null;
  oiEl: HTMLElement | null;
  chevronEl: SVGElement | null;
  verdictText: string;
  lastVol?: number;
  lastOi?: number;
  lastTargetUsd?: number;
  lastIsDynamic?: boolean;
  lastCostUsd?: number;
  lastCostTier?: number;
  lastEntryLossUsd?: number;
  lastEntryDragBps?: number;
  lastExitLossUsd?: number;
  lastExitDragBps?: number;
  lastMidPrice?: number;
  lastDeltaMidUsd?: number;
  lastDeltaMidBps?: number;
}
