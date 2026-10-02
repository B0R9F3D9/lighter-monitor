/**
 * Shared Lighter network configuration & endpoints.
 */
export const CONFIG = {
  CORE_API_URL: "https://mainnet.zklighter.elliot.ai/api/v1",
  RH_API_URL: "https://api.rh.lighter.xyz/api/v1",
  CORE_WS_URL: "wss://mainnet.zklighter.elliot.ai/stream?readonly=true",
  RH_WS_URL: "wss://api.rh.lighter.xyz/stream?readonly=true",
} as const;

export const LIGHTER_CONFIG = CONFIG;
