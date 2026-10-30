import { LighterNetwork, LIGHTER_NETWORKS } from "./types";

export const CONFIG = {
  NETWORKS: {
    rh: {
      id: LIGHTER_NETWORKS.RH,
      name: "Robinhood Lighter",
      shortLabel: "RH",
      badge: "[RH]",
      baseUrl: "https://lighter-proxy.vercel.app/rh/api/v1",
    },
    mainnet: {
      id: LIGHTER_NETWORKS.MAINNET,
      name: "Lighter Mainnet",
      shortLabel: "Mainnet",
      badge: "[Mainnet]",
      baseUrl: "https://lighter-proxy.vercel.app/api/v1",
    },
  },
  DEFAULT_NETWORK: LIGHTER_NETWORKS.RH,
  MAX_TRACKED_ACCOUNTS_PER_USER: 10,

  // Управление бюджетом Cloudflare Free Subrequests
  MAX_SUBREQUESTS_PER_CRON: 45,
  ACCOUNTS_BATCH_SIZE: 20,
  LIGHTER_CHUNK_CONCURRENCY: 5,
  RELEASE_NOTIFICATION_BATCH_SIZE: 5, // Пачка рассылки обновлений юзерам за один крон-тик

  // Wall-Clock защита
  FETCH_TIMEOUT_MS: 5000,

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

  // Настройки таргетов спреда (RH vs Core)
  MAX_SPREAD_TOKENS_PER_USER: 10,
  MAX_SPREAD_TARGETS_PER_USER: 30,
  SPREAD_POPULAR_SYMBOLS: ["SPY", "QQQ", "XAU", "NVDA", "AAPL"] as const,
  SPREAD_DEFAULT_BPS_PRESETS: [1, 2, 3, 5, 7, 10] as const,
  SPREAD_ALERT_COOLDOWN_SECONDS: 300, // 5 минут базовый кулдаун между повторами
  SPREAD_REARM_RATIO: 0.8, // Откат до 80% порога для повторного взведения
  SPREAD_MAX_PRICE_DIFF_RATIO: 0.1, // 10% санитарный лимит расхождения цен
  MAX_SPREAD_ALERTS_PER_TICK: 8, // Кап отправок спредов за один крон-тик
  SPREAD_TARGET_MIN_CONSECUTIVE_HITS: 3, // Минимум 3 тика (~2-3 мин) подряд для подтверждения (отсекает секундные сопли/wicks)
  MUTE_FOREVER_TIMESTAMP: 2147483647, // 2038 год (сентинел "до включения")
};

/**
 * Возвращает токен авторизации Lighter API из переменных окружения.
 * Сначала проверяется сеть-специфичный ключ (LIGHTER_API_KEY_MAINNET / LIGHTER_API_KEY_RH),
 * затем глобальный запасной ключ LIGHTER_API_KEY.
 */
export function getLighterAuthToken(env?: any, network?: LighterNetwork): string | undefined {
  if (!env) return undefined;
  if (network === LIGHTER_NETWORKS.MAINNET && env.LIGHTER_API_KEY_MAINNET) {
    const val = String(env.LIGHTER_API_KEY_MAINNET).trim();
    if (val) return val;
  }
  if (network === LIGHTER_NETWORKS.RH && env.LIGHTER_API_KEY_RH) {
    const val = String(env.LIGHTER_API_KEY_RH).trim();
    if (val) return val;
  }
  if (env.LIGHTER_API_KEY) {
    const val = String(env.LIGHTER_API_KEY).trim();
    if (val) return val;
  }
  return undefined;
}
