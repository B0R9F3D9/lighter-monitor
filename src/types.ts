export type LighterNetwork = "rh" | "mainnet";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET_TOKEN?: string;
  ADMIN_TELEGRAM_ID?: string;
  HEALTHCHECK_URL?: string;
}

export interface TrackedAccountKey {
  network: LighterNetwork;
  accountIndex: number;
}

export interface UserTrackedAccountRow {
  id: number;
  telegram_id: number;
  network: LighterNetwork;
  account_index: number;
  alias: string | null;
  created_at: number;
}

export interface LighterPosition {
  market_id: number;
  symbol: string;
  sign: number;
  position: string;
  avg_entry_price: string;
  position_value: string;
  unrealized_pnl: string;
  realized_pnl: string;
  liquidation_price: string;
  allocated_margin: string;
}

export interface LighterAccount {
  index: number;
  l1_address: string;
  collateral: string;
  total_asset_value: string;
  available_balance: string;
  positions: LighterPosition[];
}

export interface LighterApiResponse {
  code: number;
  total: number;
  accounts: LighterAccount[];
}

export type AlertTier = "CRITICAL_2" | "DANGER_5" | "WARN_10" | "LIQUIDATED" | "SAFE";

export interface PositionRiskAnalysis {
  marketId: number;
  symbol: string;
  isLong: boolean;
  size: number;
  posValue: number;
  entryPrice: number;
  markPrice: number;
  liqPrice: number;
  unrealizedPnl: number;
  distancePercent: number | null;
  tier: AlertTier;
}

export interface CachedPositionPayload {
  marketId: number;
  symbol: string;
  isLong: boolean;
  size: number;
  posValue: number;
  entryPrice: number;
  markPrice: number;
  liqPrice: number;
  unrealizedPnl: number;
  distancePercent: number | null;
  tier: AlertTier;
}

export type WizardState = (
  | { step: "AWAIT_INDEX"; network: LighterNetwork }
  | {
      step: "AWAIT_ALIAS";
      network: LighterNetwork;
      accountIndex: number;
      l1Address: string;
      collateral: number;
      positions: any[];
    }
  | { step: "AWAIT_RENAME"; network: LighterNetwork; accountIndex: number }
  | { step: "AWAIT_THRESHOLD" }
) & { ts?: number };

export interface ActivePositionWatchItem {
  telegram_id: number;
  alert_threshold: number;
  muted_until: number;
  alias: string | null;
  network: LighterNetwork;
  account_index: number;
  market_id: number;
  symbol: string;
  is_long: number;
  entry_price: number;
  size: number;
  last_price: number | null;
  last_alerted_at: number | null;
}

export interface MarketPriceSnapshot {
  symbol: string;
  price: number;
  dailyChange: number;
}

export interface PriceStepAlertParams {
  network: LighterNetwork;
  accountIndex: number;
  alias: string | null;
  symbol: string;
  isLong: boolean;
  entryPrice: number;
  currentPrice: number;
  baselinePrice: number;
  priceDeltaPercent: number;
  unrealizedPnl: number;
  liqPrice: number;
  distancePercent: number | null;
}

export interface SystemStats {
  totalUsers: number;
  totalTracked: number;
  trackedRh: number;
  trackedMainnet: number;
  activePositionsCount: number;
  maxQueueLagMinutes: number;
  topTokens: Array<{ symbol: string; count: number }>;
}
