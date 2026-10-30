export const LIGHTER_NETWORKS = {
  RH: "rh",
  MAINNET: "mainnet",
} as const;

export type LighterNetwork = (typeof LIGHTER_NETWORKS)[keyof typeof LIGHTER_NETWORKS];

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET_TOKEN?: string;
  ADMIN_TELEGRAM_ID?: string;
  HEALTHCHECK_URL?: string;
  LIGHTER_API_KEY?: string;
  LIGHTER_API_KEY_MAINNET?: string;
  LIGHTER_API_KEY_RH?: string;
  WEBAPP_URL?: string;
  ASSETS?: Fetcher;
  CRON_SECRET?: string;
}

export interface TrackedAccountKey {
  network: LighterNetwork;
  accountIndex: number;
  positionsJson?: string | null;
  lastUpdatedAt?: number | null;
  collateral?: number | null;
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

export const SPREAD_DIRECTIONS = {
  RH_CHEAPER: "rh_cheaper",
  RH_EXPENSIVE: "rh_expensive",
} as const;

export type SpreadDirection = (typeof SPREAD_DIRECTIONS)[keyof typeof SPREAD_DIRECTIONS];

export const SPREAD_UNITS = {
  USD: "usd",
  BPS: "bps",
} as const;

export type SpreadUnit = (typeof SPREAD_UNITS)[keyof typeof SPREAD_UNITS];

export interface SpreadTargetRow {
  id: number;
  telegram_id: number;
  symbol: string;
  direction: SpreadDirection;
  target_delta: number;
  unit: SpreadUnit;
  is_active: number;
  armed: number;
  muted_until: number;
  last_alerted_at: number | null;
  last_spread: number | null;
  created_at: number;
  consecutive_hits?: number;
  user_spread_muted_until?: number;
  symbol_muted_until?: number;
  target_hits_threshold?: number;
}

export interface TopOrderBook {
  bestBid: number;
  bestBidSize: number;
  bestAsk: number;
  bestAskSize: number;
}

export interface SpreadAlertOrderBookLeg {
  rhPrice: number;
  rhSize: number;
  rhType: "Ask" | "Bid";
  corePrice: number;
  coreSize: number;
  coreType: "Ask" | "Bid";
  execBps: number;
  execUsd: number;
}

export interface SpreadAlertParams {
  targetId: number | string;
  symbol: string;
  direction: SpreadDirection;
  targetDelta: number;
  unit: SpreadUnit;
  rhPrice: number;
  corePrice: number;
  actualDiff: number;
  basisSigned: number;
  basisBps: number;
  confirmedTicks?: number;
  minTicks?: number;
  orderBook?: SpreadAlertOrderBookLeg;
}

export const WIZARD_STEPS = {
  AWAIT_INDEX: "AWAIT_INDEX",
  AWAIT_ALIAS: "AWAIT_ALIAS",
  AWAIT_RENAME: "AWAIT_RENAME",
  AWAIT_THRESHOLD: "AWAIT_THRESHOLD",
  AWAIT_TARGET_HITS: "AWAIT_TARGET_HITS",
  SPREAD_AWAIT_SYMBOL: "SPREAD_AWAIT_SYMBOL",
  SPREAD_AWAIT_DIRECTION: "SPREAD_AWAIT_DIRECTION",
  SPREAD_AWAIT_DELTA: "SPREAD_AWAIT_DELTA",
} as const;

export type WizardStep = (typeof WIZARD_STEPS)[keyof typeof WIZARD_STEPS];

export type WizardState = (
  | { step: typeof WIZARD_STEPS.AWAIT_INDEX; network: LighterNetwork }
  | {
      step: typeof WIZARD_STEPS.AWAIT_ALIAS;
      network: LighterNetwork;
      accountIndex: number;
      l1Address: string;
      collateral: number;
      positions: any[];
    }
  | { step: typeof WIZARD_STEPS.AWAIT_RENAME; network: LighterNetwork; accountIndex: number }
  | { step: typeof WIZARD_STEPS.AWAIT_THRESHOLD }
  | { step: typeof WIZARD_STEPS.AWAIT_TARGET_HITS }
  | { step: typeof WIZARD_STEPS.SPREAD_AWAIT_SYMBOL }
  | {
      step: typeof WIZARD_STEPS.SPREAD_AWAIT_DIRECTION;
      symbol: string;
      rhPrice: number;
      corePrice: number;
    }
  | {
      step: typeof WIZARD_STEPS.SPREAD_AWAIT_DELTA;
      symbol: string;
      direction: SpreadDirection;
      rhPrice: number;
      corePrice: number;
      editTargetId?: number;
    }
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
  liquidation_price?: number;
  last_updated_at?: number;
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

export interface CronExecutionMetrics {
  event: string;
  duration_ms: number;
  subrequests_used: number;
  round_robin_synced: number;
  total_positions_checked: number;
  candidates_count: number;
  jit_checks_performed: number;
  alerts_sent: number;
  spread_alerts_sent?: number;
  zombies_cleaned: number;
  timestamp: number;
}

export interface CronErrorMetrics {
  event: string;
  error: string;
  stack?: string;
  duration_ms: number;
  subrequests_used: number;
  timestamp: number;
}

export interface Cron24hStats {
  totalRuns: number;
  failedRuns: number;
  uptimePercent: number;
  avgDurationMs: number;
  maxDurationMs: number;
  maxSubrequests: number;
  lastZombiesCleaned: number;
}

export interface RiskDistribution {
  critical: number; // < 2%
  danger: number; // < 5%
  warning: number; // < 10%
  safe: number; // >= 10% или без цены ликвидации
}

export interface ClosestLiquidation {
  symbol: string;
  network: LighterNetwork;
  accountIndex: number;
  distancePercent: number;
  isLong: boolean;
}

export interface SpreadTargetStats {
  totalTargets: number;
  activeTargets: number;
  armedTargets: number;
  hittingNowTargets: number;
  uniqueUsersCount: number;
  rhCheaperCount: number;
  rhExpensiveCount: number;
  alertsSent24h: number;
  topSymbols: Array<{ symbol: string; count: number }>;
}

export interface SystemStats {
  // 1. Пользователи и активность
  totalUsers: number;
  users24h: number;
  activeUsers24h: number;
  totalTracked: number;
  trackedRh: number;
  trackedMainnet: number;
  avgAccountsPerUser: number;
  mutedUsersCount: number;

  // 2. Портфель и позиции
  activeAccountsCount: number;
  activePositionsCount: number;
  totalLongs: number;
  totalShorts: number;
  totalOpenInterestUsd: number;
  longOiUsd: number;
  shortOiUsd: number;
  netDeltaUsd: number;
  avgPositionSizeUsd: number;
  maxPositionSizeUsd: number;
  maxPositionSymbol?: string | null;
  totalCollateralUsd: number;
  avgCollateralUsd: number;
  effectiveLeverage: number;

  // 3. Зоны риска ликвидации
  riskDistribution: RiskDistribution;
  closestLiquidation?: ClosestLiquidation | null;

  // 4. Таргеты спреда
  spreadStats: SpreadTargetStats;

  // 5. Очередь и кэш
  minQueueLagMinutes: number;
  avgQueueLagMinutes: number;
  maxQueueLagMinutes: number;
  topTokens: Array<{ symbol: string; count: number; notionalUsd?: number }>;

  // 6. Отказоустойчивость и крон
  lastCron?: CronExecutionMetrics | null;
  lastCronError?: CronErrorMetrics | null;
  cron24hStats?: Cron24hStats | null;
}
