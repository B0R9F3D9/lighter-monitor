export const CONFIG = {
  CORE_API_URL: "https://mainnet.zklighter.elliot.ai/api/v1",
  RH_API_URL: "https://api.rh.lighter.xyz/api/v1",
  CORE_WS_URL: "wss://mainnet.zklighter.elliot.ai/stream?readonly=true",
  RH_WS_URL: "wss://api.rh.lighter.xyz/stream?readonly=true",
  RERANK_INTERVAL_SEC: 5,
  THROTTLE_MS: 100,
  SOCKET_SILENCE_TIMEOUT_MS: 20000,
  LEADER_FRESHNESS_WINDOW_MS: 3500,
  EMA_TAU_MS: 2500,
  ORDERBOOK_LEVELS_LIMIT: 40,
} as const;

export const CRYPTO_SYMBOLS: ReadonlySet<string> = new Set([
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "SUI",
  "NEAR",
  "HYPE",
  "ZEC",
  "CASHCAT",
  "PONS",
  "VVV",
  "LIT",
  "BE",
  "ANSEM",
]);

export const COMMODITY_SYMBOLS: ReadonlySet<string> = new Set(["XAU", "XAG", "USO", "SLV"]);

export const INDEX_ETF_SYMBOLS: ReadonlySet<string> = new Set([
  "SPY",
  "QQQ",
  "SOXL",
  "SPCX",
  "SGOV",
]);

export const NON_EQUITY_SYMBOLS: ReadonlySet<string> = new Set([
  ...CRYPTO_SYMBOLS,
  ...COMMODITY_SYMBOLS,
  ...INDEX_ETF_SYMBOLS,
]);

export const STORAGE_KEYS = {
  FONT: "terminal_font",
  SIZE: "terminal_size",
  SIZE_MODE: "terminal_size_mode",
  MAX_CAP: "terminal_max_cap",
  LEVERAGE: "terminal_leverage",
  FILTER_EQUITIES: "terminal_filter_equities",
  FILTER_READY: "terminal_filter_ready",
} as const;
