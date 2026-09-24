import { LighterNetwork } from "./types";

export const CONFIG = {
  NETWORKS: {
    rh: {
      id: "rh" as LighterNetwork,
      name: "Robinhood Lighter",
      shortLabel: "RH",
      badge: "[RH]",
      baseUrl: "https://api.rh.lighter.xyz/api/v1",
    },
    mainnet: {
      id: "mainnet" as LighterNetwork,
      name: "Lighter Mainnet",
      shortLabel: "Mainnet",
      badge: "[Mainnet]",
      baseUrl: "https://mainnet.zklighter.elliot.ai/api/v1",
    },
  },
  DEFAULT_NETWORK: "rh" as LighterNetwork,
  MAX_TRACKED_ACCOUNTS_PER_USER: 10,

  // Управление бюджетом Cloudflare Free Subrequests
  MAX_SUBREQUESTS_PER_CRON: 45,
  ACCOUNTS_BATCH_SIZE: 20,
  LIGHTER_CHUNK_CONCURRENCY: 5,

  // Wall-Clock защита
  FETCH_TIMEOUT_MS: 3000,

  // Пороги рисков
  DEFAULT_ALERT_THRESHOLD: 0.5, // По умолчанию 0.5% (оптимум для XAU и плеча 15-25x)
  MIN_ALERT_THRESHOLD: 0.1,
  MAX_ALERT_THRESHOLD: 50.0,
  CLEARANCE_MULTIPLIER: 1.3, // Сброс алерта при уходе цены на 30% выше порога
  ALERT_COOLDOWN_SECONDS: 180, // 3 минуты базовый кулдаун

  TIERS: {
    CRITICAL_2: { maxDistance: 1.0, cooldownSeconds: 600, label: "КРИТИЧЕСКИЙ РИСК (<1.0%)" },
    DANGER_5: { maxDistance: 1.5, cooldownSeconds: 900, label: "ВЫСОКИЙ РИСК (<1.5%)" },
    WARN_10: { maxDistance: 2.5, cooldownSeconds: 1800, label: "ВНИМАНИЕ (<2.5%)" },
  },
  CLEARANCE_DISTANCE: 12.0, // Дистанция, при которой алерт сбрасывается из базы

  // Веса приоритета алертов для диспетчеризации
  PRIORITY_WEIGHTS: {
    LIQUIDATED: 4,
    CRITICAL_2: 3,
    DANGER_5: 2,
    WARN_10: 1,
    SAFE: 0,
  } as Record<string, number>,
};
