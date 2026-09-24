import { Env, LighterAccount, AlertTask, CachedPositionPayload, TrackedAccountKey } from "../types";
import { CONFIG } from "../config";
import { 
  getAccountsForCronBatch, 
  touchFailedAccounts, 
  batchUpdatePositionsCache, 
  getAccountSubscribers, 
  removeBlockedUser 
} from "../db/queries";
import { fetchInChunks, fetchLighterAccount } from "../lighter/api";
import { analyzePositionRisk } from "../lighter/math";
import { formatLiquidationAlert, formatPositionWipedAlert } from "../bot/formatters";
import { getBot } from "../bot/bot";

export async function runCronMonitor(env: Env): Promise<void> {
  const bot = getBot(env);
  let subrequestsUsed = 0;

  // 1. Выборка аккаунтов по честному Round-Robin среди всех сетей
  const accountsToPoll = await getAccountsForCronBatch(env.DB, CONFIG.ACCOUNTS_BATCH_SIZE);
  if (accountsToPoll.length === 0) return;

  // 2. Читаем предыдущие снимки для точечной детекции ликвидации
  const keys = accountsToPoll.map(a => `${a.network}:${a.accountIndex}`);
  const placeholders = keys.map(() => "?").join(",");
  const { results: oldCacheRows } = await env.DB.prepare(
    `SELECT network, account_index, positions_json FROM account_positions_cache WHERE (network || ':' || account_index) IN (${placeholders})`
  ).bind(...keys).all<{ network: string; account_index: number; positions_json: string }>();

  const oldCacheMap = new Map((oldCacheRows || []).map(r => [`${r.network}:${r.account_index}`, r]));

  // 3. Опрос Lighter API пачками по 5 параллельных запросов (таймаут 2.5 сек)
  const fetchResults = await fetchInChunks(
    accountsToPoll, 
    CONFIG.LIGHTER_CHUNK_CONCURRENCY, 
    (target) => fetchLighterAccount(target.network, target.accountIndex)
  );
  subrequestsUsed += accountsToPoll.length;

  const failedAccounts: TrackedAccountKey[] = [];
  const validAccounts: Array<{ network: any; account: LighterAccount; cachedPositions: CachedPositionPayload[] }> = [];
  const alertsToSend: AlertTask[] = [];

  for (let i = 0; i < accountsToPoll.length; i++) {
    const target = accountsToPoll[i]!;
    const res = fetchResults[i];

    if (!res || res.status !== "fulfilled" || !res.value) {
      failedAccounts.push(target);
      continue;
    }

    const account = res.value;
    const oldCache = oldCacheMap.get(`${target.network}:${target.accountIndex}`);

    const activePositions = account.positions.filter(p => Math.abs(parseFloat(p.position || "0")) > 0);
    const risks = activePositions.map(analyzePositionRisk).filter(Boolean);

    const cachedPositions: CachedPositionPayload[] = risks.map(r => ({ ...r! }));
    validAccounts.push({ network: target.network, account, cachedPositions });

    // Детекция закрытия/ликвидации только позиций с прошлым высоким риском
    if (oldCache && oldCache.positions_json) {
      try {
        const oldPositions = JSON.parse(oldCache.positions_json) as CachedPositionPayload[];
        for (const oldP of oldPositions) {
          const stillOpen = activePositions.some(p => p.market_id === oldP.marketId);
          if (!stillOpen && (oldP.tier === 'CRITICAL_2' || oldP.tier === 'DANGER_5')) {
            const subs = await getAccountSubscribers(env.DB, target.network, target.accountIndex);
            for (const sub of subs) {
              alertsToSend.push({
                telegramId: sub.telegram_id,
                text: formatPositionWipedAlert(target.network, target.accountIndex, sub.alias, oldP.symbol),
                network: target.network,
                accountIndex: target.accountIndex,
                marketId: oldP.marketId,
                tier: 'LIQUIDATED',
                distance: 0
              });
            }
          }
        }
      } catch (err) {
        console.error(`Error parsing old cache for [${target.network}] #${target.accountIndex}:`, err);
      }
    }

    // Проверка текущих открытых позиций
    for (const r of risks) {
      if (!r) continue;

      const subs = await getAccountSubscribers(env.DB, target.network, target.accountIndex);

      for (const sub of subs) {
        const userThreshold = sub.alert_threshold ?? CONFIG.DEFAULT_ALERT_THRESHOLD;

        // Сброс истории алертов при выходе цены в безопасную зону выше порога пользователя
        if (r.distancePercent !== null && r.distancePercent > userThreshold * CONFIG.CLEARANCE_MULTIPLIER) {
          await env.DB.prepare(
            "DELETE FROM alert_logs WHERE telegram_id = ? AND network = ? AND account_index = ? AND market_id = ?"
          ).bind(sub.telegram_id, target.network, target.accountIndex, r.marketId).run();
          continue;
        }

        // Проверяем, пробил ли процент порог пользователя
        if (r.distancePercent !== null && r.distancePercent <= userThreshold) {
          const cooldown = CONFIG.ALERT_COOLDOWN_SECONDS;
          const now = Math.floor(Date.now() / 1000);

          const lastAlert = await env.DB.prepare(
            "SELECT sent_at, last_distance FROM alert_logs WHERE telegram_id = ? AND network = ? AND account_index = ? AND market_id = ? AND alert_tier = ?"
          ).bind(sub.telegram_id, target.network, target.accountIndex, r.marketId, r.tier).first<{ sent_at: number; last_distance: number }>();

          // Алерт шлем, если прошло > 15 мин кулдауна ИЛИ если дистанция сократилась еще сильнее (на >= 0.3%)
          const isSignificantlyWorse = lastAlert && (lastAlert.last_distance - r.distancePercent >= 0.3);
          if (!lastAlert || (now - lastAlert.sent_at) >= cooldown || isSignificantlyWorse) {
            alertsToSend.push({
              telegramId: sub.telegram_id,
              text: formatLiquidationAlert(target.network, target.accountIndex, sub.alias, r),
              network: target.network,
              accountIndex: target.accountIndex,
              marketId: r.marketId,
              tier: r.tier,
              distance: r.distancePercent || 0
            });
          }
        }
      }
    }
  }

  // 4. Обновление упавших аккаунтов (для непрерывного Round-Robin)
  if (failedAccounts.length > 0) {
    await touchFailedAccounts(env.DB, failedAccounts);
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
      const combinedText = userTasks.map(t => t.text.trim()).join("\n\n");

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
        INSERT INTO alert_logs (telegram_id, network, account_index, market_id, alert_tier, last_distance, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(telegram_id, network, account_index, market_id, alert_tier) DO UPDATE SET
          last_distance = excluded.last_distance,
          sent_at = excluded.sent_at
      `).bind(t.telegramId, t.network, t.accountIndex, t.marketId, t.tier, t.distance, now));

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
