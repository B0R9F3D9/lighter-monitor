export interface OrderBookLevel {
  price: number;
  totalBase: number;
  totalUsd: number;
}

export interface OrderBook {
  marketId: number;
  asks: Map<number, number>;
  bids: Map<number, number>;
  isSnapshotReceived: boolean;
  lastUpdatedTs: number;
  offset: number;
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

export interface ExecutionLegs {
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
  copyQty: string;
  qtyLabel: string;
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
  pointCostUsd: number;
  pointsEarned: number;
  maxLevelsSwept: number;
  minDepthUsd: number;
  status: "READY" | "SLIPPAGE" | "LOW LIQ" | "STALE";
  legs: ExecutionLegs;
  computedAt?: number;
}

export interface EmaEntry {
  cost: number;
  lastTs: number;
}

export interface TerminalState {
  markets: Map<string, MarketInfo>;
  coreBooks: Map<number, OrderBook>;
  rhBooks: Map<number, OrderBook>;
  targetSizeUsd: number;
  filterEquities: boolean;
  filterReadyOnly: boolean;
  minLeverageFilter: number;
  searchQuery: string;
  sortColumn: keyof MarketMetrics | "leverageNum";
  sortDirection: "asc" | "desc";
  isAutoSortEnabled: boolean;
  displayedSymbolsOrder: string[];
  rerankTimerRemaining: number;
  emaMap: Map<string, EmaEntry>;
  expandedSymbol: string | null;
  isCoreConnected: boolean;
  isRhConnected: boolean;
}

export interface RowDomCache {
  tr: HTMLTableRowElement;
  verdictEl: HTMLElement;
  copyBtn: HTMLButtonElement;
  rtLossEl: HTMLElement;
  ptCostEl: HTMLElement;
  turnoverDragEl: HTMLElement;
  midPriceEl: HTMLElement;
  deltaMidEl: HTMLElement | null;
  depthEl: HTMLElement;
  volEl: HTMLElement | null;
  chevronEl: SVGElement | null;
  verdictText: string;
}
