import { Env, LighterAccount, AlertTask, CachedPositionPayload } from "../types";
import { CONFIG } from "../config";
import { 
  getAccountsForCronBatch, 
  touchFailedAccounts, 
  batchUpdatePositionsCache, 
  getAccountSubscribers, 
  removeBlockedUser,
  clearSafeAlerts
} from "../db/queries";
import { fetchInChunks, fetchLighterAccount } from "../lighter/api";
import { analyzePositionRisk } from "../lighter/math";
import { formatLiquidationAlert, formatPositionWipedAlert } from "../bot/formatters";
import { getBot } from "../bot/bot";

export async function runCronMonitor(env: Env): Promise<void> {
  const bot = getBot(env);
  let subrequestsUsed = 0;

  // 1. Выборка аккаунтов по честному Round-Robin
  const accountsToPoll = await getAccountsForCronBatch(env.DB, CONFIG.ACCOUNTS_BATCH_SIZE);
  if (accountsToPoll.length === 0) return;

  // 2. Читаем предыдущие снимки для точечной детекции ликвидации
  const placeholders = accountsToPoll.map(() => "?").join(",");
  const { results: oldCacheRows } = await env.DB.prepare(
    `SELECT account_index, positions_json FROM account_positions_cache WHERE account_index IN (${placeholders})`
  ).bind(...accountsToPoll).all<{ account_index: number; positions_json: string }>();

  const oldCacheMap = new Map((oldCacheRows || []).map(r => [r.account_index, r]));

  // 3. Опрос Lighter API пачками по 5 параллельных запросов (таймаут 2.5 сек)
  const fetchResults = await fetchInChunks(accountsToPoll, CONFIG.LIGHTER_CHUNK_CONCURRENCY, fetchLighterAccount);
  subrequestsUsed += accountsToPoll.length;

  const failedIndices: number[] = [];
  const validAccounts: Array<{ account: LighterAccount; cachedPositions: CachedPositionPayload[] }> = [];
  const alertsToSend: AlertTask[] = [];

  for (let i = 0; i < accountsToPoll.length; i++) {
    const accIndex = accountsToPoll[i]!;
    const res = fetchResults[i];

    if (!res || res.status !== "fulfilled" || !res.value) {
      failedIndices.push(accIndex);
      continue;
    }

    const account = res.value;
    const oldCache = oldCacheMap.get(accIndex);

    const activePositions = account.positions.filter(p => Math.abs(parseFloat(p.position || "0")) > 0);
    const risks = activePositions.map(analyzePositionRisk).filter(Boolean);

    const cachedPositions: CachedPositionPayload[] = risks.map(r => ({ ...r! }));
    validAccounts.push({ account, cachedPositions });

    // Детекция закрытия/ликвидации только позиций с прошлым высоким риском
    if (oldCache && oldCache.positions_json) {
      try {
        const oldPositions = JSON.parse(oldCache.positions_json) as CachedPositionPayload[];
        for (const oldP of oldPositions) {
          const stillOpen = activePositions.some(p => p.market_id === oldP.marketId);
          if (!stillOpen && (oldP.tier === 'CRITICAL_2' || oldP.tier === 'DANGER_5')) {
            const subs = await getAccountSubscribers(env.DB, accIndex);
            for (const sub of subs) {
              alertsToSend.push({
                telegramId: sub.telegram_id,
                text: formatPositionWipedAlert(accIndex, sub.alias, oldP.symbol),
                accountIndex: accIndex,
                marketId: oldP.marketId,
                tier: 'LIQUIDATED',
                distance: 0
              });
            }
          }
        }
      } catch (err) {
        console.error(`Error parsing old cache for account #${accIndex}:`, err);
      }
    }

    // Проверка текущих открытых позиций
    for (const r of risks) {
      if (!r) continue;

      // Сброс истории алертов при выходе в безопасную зону (> 12%)
      if (r.distancePercent !== null && r.distancePercent > CONFIG.CLEARANCE_DISTANCE) {
        await clearSafeAlerts(env.DB, accIndex, r.marketId);
        continue;
      }

      if (r.tier === 'SAFE' || r.tier === 'LIQUIDATED') continue;

      const subs = await getAccountSubscribers(env.DB, accIndex);

      for (const sub of subs) {
        const cooldown = CONFIG.TIERS[r.tier].cooldownSeconds;
        const now = Math.floor(Date.now() / 1000);

        const lastAlert = await env.DB.prepare(
          "SELECT sent_at FROM alert_logs WHERE telegram_id = ? AND account_index = ? AND market_id = ? AND alert_tier = ?"
        ).bind(sub.telegram_id, accIndex, r.marketId, r.tier).first<{ sent_at: number }>();

        if (!lastAlert || (now - lastAlert.sent_at) >= cooldown) {
          alertsToSend.push({
            telegramId: sub.telegram_id,
            text: formatLiquidationAlert(accIndex, sub.alias, r),
            accountIndex: accIndex,
            marketId: r.marketId,
            tier: r.tier,
            distance: r.distancePercent || 0
          });
        }
      }
    }
  }

  // 4. Обновление упавших аккаунтов (для непрерывного Round-Robin)
  if (failedIndices.length > 0) {
    await touchFailedAccounts(env.DB, failedIndices);
  }

  // 5. Пакетная запись кэша успешных аккаунтов
  if (validAccounts.length > 0) {
    await batchUpdatePositionsCache(env.DB, validAccounts);
  }

  // 6. Сортировка приоритетов
  alertsToSend.sort((a, b) => (CONFIG.PRIORITY_WEIGHTS[b.tier] || 0) - (CONFIG.PRIORITY_WEIGHTS[a.tier] || 0));

  // 7. Группировка алертов по пользователям
  const userAlertsMap = new Map<number, AlertTask[]>();
  for (const alert of alertsToSend) {
    const list = userAlertsMap.get(alert.telegramId) || [];
    list.push(alert);
    userAlertsMap.set(alert.telegramId, list);
  }

  // 8. Рассылка с контролем подзапросов и безопасным делением длинных текстов
  const maxUserDispatches = CONFIG.MAX_SUBREQUESTS_PER_CRON - subrequestsUsed;
  const targetUsers = Array.from(userAlertsMap.entries()).slice(0, Math.max(0, maxUserDispatches));

  for (const [telegramId, userTasks] of targetUsers) {
    try {
      const combinedText = userTasks.map(t => t.text).join("\n\n────────────────\n\n");

      if (combinedText.length > 3900) {
        for (const t of userTasks) {
          if (subrequestsUsed >= CONFIG.MAX_SUBREQUESTS_PER_CRON) break;
          await bot.api.sendMessage(telegramId, t.text, { parse_mode: "HTML" });
          subrequestsUsed++;
          await new Promise(r => setTimeout(r, 1000));
        }
      } else {
        await bot.api.sendMessage(telegramId, combinedText, { parse_mode: "HTML" });
        subrequestsUsed++;
      }

      const now = Math.floor(Date.now() / 1000);
      const logStatements = userTasks.map(t => env.DB.prepare(`
        INSERT INTO alert_logs (telegram_id, account_index, market_id, alert_tier, last_distance, sent_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(telegram_id, account_index, market_id, alert_tier) DO UPDATE SET
          last_distance = excluded.last_distance,
          sent_at = excluded.sent_at
      `).bind(t.telegramId, t.accountIndex, t.marketId, t.tier, t.distance, now));

      if (logStatements.length > 0) {
        await env.DB.batch(logStatements);
      }

      await new Promise(res => setTimeout(res, 60));
    } catch (err: any) {
      if (err?.error_code === 403) {
        console.warn(`User ${telegramId} blocked the bot. Deleting via batch.`);
        await removeBlockedUser(env.DB, telegramId);
      } else {
        console.error(`Failed to send alert to ${telegramId}:`, err);
      }
    }
  }
}
