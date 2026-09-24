export type LighterNetwork = 'rh' | 'mainnet';

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET_TOKEN?: string;
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

export type AlertTier = 'CRITICAL_2' | 'DANGER_5' | 'WARN_10' | 'LIQUIDATED' | 'SAFE';

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

export interface AlertTask {
  telegramId: number;
  text: string;
  network: LighterNetwork;
  accountIndex: number;
  marketId: number;
  tier: AlertTier;
  distance: number;
}

export interface SubscriberRecord {
  telegram_id: number;
  alias: string | null;
  alert_threshold: number;
}
