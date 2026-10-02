export type CheckerNetwork = "rh" | "mainnet";

export interface LighterTrade {
  trade_id: number;
  trade_id_str: string;
  tx_hash: string;
  type: string; // "trade" | "liquidation" | "deleverage" | "market-settlement"
  market_id: number;
  market_kind?: string; // "perps" | "spot"
  size: string;
  price: string;
  usd_amount: string;
  ask_id: number | string;
  bid_id: number | string;
  ask_account_id: number;
  bid_account_id: number;
  is_maker_ask: boolean;
  block_height: number;
  timestamp: number; // Unix timestamp in ms or sec
  taker_fee?: number;
  maker_fee?: number;
  transaction_time?: number; // Microseconds
  ask_account_pnl?: string;
  bid_account_pnl?: string;
  ask_client_id_str?: string;
  bid_client_id_str?: string;
  taker_position_size_before?: string;
  maker_position_size_before?: string;
}

export interface TradesApiResponse {
  code: number;
  message?: string;
  next_cursor?: string;
  trades?: LighterTrade[];
}

export interface FetchTradesOptions {
  network: CheckerNetwork;
  accountIndex: number;
  authToken?: string;
  sortBy?: "timestamp" | "block_height" | "trade_id";
  sortDir?: "desc" | "asc";
  limit?: number;
  marketType?: "all" | "spot" | "perp";
  marketId?: number;
  cursor?: string;
}

export interface FetchProgress {
  page: number;
  tradesCount: number;
  latestTimestamp?: number;
  cursor?: string;
  bytesReceived: number;
  elapsedMs: number;
}

export interface CheckerSummaryMetrics {
  totalTrades: number;
  totalVolumeUsd: number;
  totalRealizedPnl: number;
  totalFeesUsd: number;
  makerTradesCount: number;
  takerTradesCount: number;
  buyTradesCount: number;
  sellTradesCount: number;
  firstTradeTime: number | null;
  lastTradeTime: number | null;
  uniqueMarketsCount: number;
}

export interface ParsedTradeView {
  raw: LighterTrade;
  tradeId: string;
  timeFormatted: string;
  timestampMs: number;
  marketSymbol: string;
  marketId: number;
  marketKind: string;
  type: string;
  side: "BUY" | "SELL";
  role: "MAKER" | "TAKER";
  price: number;
  size: number;
  usdValue: number;
  realizedPnl: number;
  feeUsd: number;
  txHash: string;
  txHashShort: string;
  fillsCount?: number;
}

export interface ExportPayload {
  version: "1.0";
  exported_at: string;
  exported_at_unix: number;
  network: CheckerNetwork;
  network_name: string;
  account_index: number;
  l1_address?: string;
  total_trades: number;
  truncated?: boolean;
  row_cap?: number;
  summary: {
    total_volume_usd: number;
    total_realized_pnl_usd: number;
    total_fees_usd: number;
    buy_trades_count: number;
    sell_trades_count: number;
    maker_trades_count: number;
    taker_trades_count: number;
    first_trade_time_utc: string | null;
    last_trade_time_utc: string | null;
  };
  trades: LighterTrade[];
}

export type HedgeMatchStatus = "HEDGED" | "PARTIAL" | "UNHEDGED";

export interface HedgePair {
  id: string;
  marketSymbol: string;
  matchedSize: number;

  // RH Leg
  rhTradeId: string;
  rhSide: "BUY" | "SELL";
  rhPrice: number;
  rhSize: number;
  rhFeeUsd: number;
  rhTimestampMs: number;
  rhTimeFormatted: string;
  rhTxHash: string;
  rhRole: "MAKER" | "TAKER";
  rhFillsCount?: number;

  // Core Leg
  coreTradeId: string;
  coreSide: "BUY" | "SELL";
  corePrice: number;
  coreSize: number;
  coreFeeUsd: number;
  coreTimestampMs: number;
  coreTimeFormatted: string;
  coreTxHash: string;
  coreRole: "MAKER" | "TAKER";
  coreFillsCount?: number;

  // Comparison & PnL
  buyPrice: number;
  sellPrice: number;
  priceDelta: number; // sellPrice - buyPrice
  pricePnlUsd: number; // (sellPrice - buyPrice) * matchedSize
  totalFeesUsd: number; // rhFeeUsd + coreFeeUsd
  netPnlUsd: number; // pricePnlUsd - totalFeesUsd
  notionalUsd: number; // matchedSize * ((rhPrice + corePrice) / 2)
  pnlBps: number; // (netPnlUsd / notionalUsd) * 10000
  timeDeltaSec: number; // (coreTimestampMs - rhTimestampMs) / 1000
  status: "HEDGED" | "PARTIAL";
}

export interface UnhedgedTrade {
  id?: string;
  tradeId: string;
  network: "RH" | "CORE";
  marketSymbol: string;
  side: "BUY" | "SELL";
  role: "MAKER" | "TAKER";
  unhedgedSize: number;
  originalSize: number;
  price: number;
  usdValue: number;
  feeUsd: number;
  timestampMs: number;
  timeFormatted: string;
  txHash: string;
  fillsCount?: number;
}

export interface SelectedHedgeMetrics {
  selectedCount: number;
  pairsCount: number;
  unhedgedCount: number;
  totalVolumeUsd: number;
  totalNetPnlUsd: number;
  totalPricePnlUsd: number;
  totalFeesUsd: number;
  avgPnlBps: number;
}

export interface HedgeSummaryMetrics {
  totalPairs: number;
  totalHedgedVolumeUsd: number;
  totalNetPnlUsd: number;
  totalPricePnlUsd: number;
  totalFeesUsd: number;
  avgPnlBps: number;
  bestPairPnlUsd: number;
  worstPairPnlUsd: number;
  totalUnhedgedTrades: number;
  unhedgedVolumeUsd: number;
  unhedgedRhCount: number;
  unhedgedCoreCount: number;
  rhAccountIndex: number | null;
  coreAccountIndex: number | null;
  rhTotalTrades: number;
  coreTotalTrades: number;
  firstTradeTime: number | null;
  lastTradeTime: number | null;
}

export interface HedgeMatchingResult {
  pairs: HedgePair[];
  unhedged: UnhedgedTrade[];
  metrics: HedgeSummaryMetrics;
}
