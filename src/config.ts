export const CONFIG = {
  LIGHTER_RH_BASE_URL: "https://api.rh.lighter.xyz/api/v1",
  MAX_TRACKED_ACCOUNTS_PER_USER: 10,

  // Управление бюджетом Cloudflare Free Subrequests
  MAX_SUBREQUESTS_PER_CRON: 45,
  ACCOUNTS_BATCH_SIZE: 20,
  LIGHTER_CHUNK_CONCURRENCY: 5,

  // Wall-Clock защита (4 чанка * 2.5 сек = 10 сек)
  FETCH_TIMEOUT_MS: 2500,

  // Пороги рисков
  TIERS: {
    CRITICAL_2: { maxDistance: 2.5, cooldownSeconds: 600, label: "КРИТИЧЕСКИЙ РИСК (<2.5%)" },
    DANGER_5:   { maxDistance: 5.0, cooldownSeconds: 1800, label: "ВЫСОКИЙ РИСК (<5%)" },
    WARN_10:    { maxDistance: 10.0, cooldownSeconds: 7200, label: "ВНИМАНИЕ (<10%)" },
  },
  CLEARANCE_DISTANCE: 12.0, // Дистанция, при которой алерт сбрасывается из базы

  // Веса приоритета алертов для диспетчеризации
  PRIORITY_WEIGHTS: {
    'LIQUIDATED': 4,
    'CRITICAL_2': 3,
    'DANGER_5': 2,
    'WARN_10': 1,
    'SAFE': 0
  } as Record<string, number>,
};
