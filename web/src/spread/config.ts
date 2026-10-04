import { FONT_STORAGE_KEY, CONFIG as SHARED_CONFIG, NON_EQUITY_SYMBOLS } from "../shared";

export { NON_EQUITY_SYMBOLS };

export const CONFIG = {
  ...SHARED_CONFIG,
  DEFAULT_RERANK_INTERVAL_SEC: 0,
  RERANK_INTERVAL_SEC: 0,
  THROTTLE_MS: 0,
  SOCKET_SILENCE_TIMEOUT_MS: 20000,
  LEADER_FRESHNESS_WINDOW_MS: 3500,
  ORDERBOOK_LEVELS_LIMIT: 40,
  ORDERBOOK_PRUNE_LIMIT: 80,
} as const;

export const STORAGE_KEYS = {
  FONT: FONT_STORAGE_KEY,
  SIZE: "terminal_size",
  SIZE_MODE: "terminal_size_mode",
  MAX_CAP: "terminal_max_cap",
  LEVERAGE: "terminal_leverage",
  FILTER_EQUITIES: "terminal_filter_equities",
  FILTER_READY: "terminal_filter_ready",
  RERANK_INTERVAL: "terminal_rerank_interval",
} as const;
