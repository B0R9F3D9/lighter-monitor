import { InlineKeyboard } from "grammy";
import { Env, LighterAccount, LighterNetwork, MarketPriceSnapshot, ActivePositionWatchItem, TrackedAccountKey } from "../types";
import { CONFIG } from "../config";
import { 
  getNextAccountsForSync, 
  touchFailedAccounts, 
  batchUpdatePositionsCache, 
  syncAccountOpenPositions,
  getActivePositionsForMonitoring,
  removeBlockedUser 
} from "../db/queries";
import { fetchLighterAccount, fetchExchangeStats, findMarketPrice } from "../lighter/api";
import { analyzePositionRisk } from "../lighter/math";
import { formatPriceStepAlert } from "../bot/formatters";
import { getBot } from "../bot/bot";

// Динамический умный кулдаун на лету от порога пользователя
export function getSmartCooldownSeconds(threshold: number): number {
  if (threshold <= 0.5) return 180; // 3 минуты (для XAU / агрессивных плеч 15x-25x)
  if (threshold <= 1.0) return 300; // 5 минут (стандарт)
  return 480;                       // 8 минут (для свинга с шагом 1.5% - 3%)
}

// Кандидат на отправку алерта
export interface AlertCandidate {
  item: ActivePositionWatchItem;
  currentPrice: number;
  baseline: number;
  priceDeltaPercent: number;
  absDelta: number;
  urgency: number; // Относительный вес: absDelta / threshold
}

// Пакетное выполнение D1 стейтментов чанками до 100 штук
export async function executeD1BatchInChunks(
  db: D1Database, 
  stmts: D1PreparedStatement[], 
  chunkSize: number = 100
): Promise<void> {
  for (let i = 0; i < stmts.length; i += chunkSize) {
    const chunk = stmts.slice(i, i + chunkSize);
    await db.batch(chunk);
  }
}

export async function runCronMonitor(env: Env): Promise<void> {
  const bot = getBot(env);
  const now = Math.floor(Date.now() / 1000);
  const startTime = Date.now();
  const MAX_WALL_CLOCK_MS = 20_000; // 20 сек таймаут (Time-Budgeting)
  const MAX_JIT_CHECKS_PER_CRON = 15;

  let subrequestsUsed = 0;
  let jitChecksDone = 0;

  // 1. ФОНОВЫЙ ROUND-ROBIN (синхронизируем до 2 аккаунтов за тик со спасением очереди при ошибках)
  const accountsToSync = await getNextAccountsForSync(env.DB, 2);
  const jitCache = new Map<string, LighterAccount | null>();
  const failedAccounts: TrackedAccountKey[] = [];
  const cacheUpdates: Array<{ network: LighterNetwork; account: LighterAccount; cachedPositions: any[] }> = [];

  for (const accKey of accountsToSync) {
    if (subrequestsUsed >= CONFIG.MAX_SUBREQUESTS_PER_CRON - 20) break;
    const syncedData = await fetchLighterAccount(accKey.network, accKey.accountIndex);
    subrequestsUsed++;

    const cacheKey = `${accKey.network}:${accKey.accountIndex}`;
    jitCache.set(cacheKey, syncedData);

    if (syncedData) {
      await syncAccountOpenPositions(env.DB, accKey.network, accKey.accountIndex, syncedData.positions);
      cacheUpdates.push({
        network: accKey.network,
        account: syncedData,
        cachedPositions: syncedData.positions.map(analyzePositionRisk).filter(Boolean) as any
      });
    } else {
      failedAccounts.push(accKey);
    }
  }

  if (cacheUpdates.length > 0) {
    await batchUpdatePositionsCache(env.DB, cacheUpdates);
  }
  if (failedAccounts.length > 0) {
    await touchFailedAccounts(env.DB, failedAccounts);
  }

  // 2. Единый JOIN: получаем открытые позиции всех пользователей
  const items = await getActivePositionsForMonitoring(env.DB);
  if (items.length === 0) return;

  // 3. Загружаем срезы цен биржи (1-2 запроса на всю систему)
  const neededNetworks = Array.from(new Set(items.map(i => i.network)));
  const priceSnapshots = new Map<LighterNetwork, Map<string, MarketPriceSnapshot>>();

  for (const net of neededNetworks) {
    if (subrequestsUsed >= CONFIG.MAX_SUBREQUESTS_PER_CRON - 10) break;
    const snap = await fetchExchangeStats(net);
    subrequestsUsed++;
    priceSnapshots.set(net, snap);
  }

  const newPositionsToInit: D1PreparedStatement[] = [];
  const candidateAlerts: AlertCandidate[] = [];

  // 4. ФАЗА А: Мгновенная in-memory фильтрация и оценка срочности без сетевых запросов
  for (const item of items) {
    const netMap = priceSnapshots.get(item.network);
    if (!netMap) continue;

    const market = findMarketPrice(netMap, item.symbol);
    if (!market || market.price <= 0) continue;

    const currentPrice = market.price;

    // ПЕРВЫЙ ТИК: пакуем в единый batch без отправки спама
    if (item.last_price === null) {
      newPositionsToInit.push(
        env.DB.prepare(`
          INSERT INTO user_token_alerts (telegram_id, network, account_index, market_id, symbol, last_price, last_alerted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(telegram_id, network, account_index, market_id) DO UPDATE SET last_price = excluded.last_price
        `).bind(item.telegram_id, item.network, item.account_index, item.market_id, item.symbol, currentPrice, now)
      );
      continue;
    }

    // Проверка шага цены
    const baseline = item.last_price;
    const priceDeltaPercent = ((currentPrice - baseline) / baseline) * 100;
    const absDelta = Math.abs(priceDeltaPercent);

    if (absDelta < item.alert_threshold) continue;

    // Динамический кулдаун (3-8 минут с пробитием при двойном скачке)
    const cooldownSeconds = getSmartCooldownSeconds(item.alert_threshold);
    const timeSinceLastAlert = item.last_alerted_at ? (now - item.last_alerted_at) : Infinity;
    const isDoubleJump = absDelta >= (item.alert_threshold * 2);

    if (timeSinceLastAlert < cooldownSeconds && !isDoubleJump) continue;

    // Позиция квалифицирована на алерт: считаем относительную срочность
    const urgency = item.alert_threshold > 0 ? (absDelta / item.alert_threshold) : absDelta;
    candidateAlerts.push({
      item,
      currentPrice,
      baseline,
      priceDeltaPercent,
      absDelta,
      urgency
    });
  }

  // Сортировка по убыванию срочности (наибольшее превышение порога идет первым)
  candidateAlerts.sort((a, b) => b.urgency - a.urgency);

  // 5. ФАЗА Б: Приоритетная JIT-проверка и доставка алертов
  const alertUpdateStmts: D1PreparedStatement[] = [];
  const zombieCleanupStmts: D1PreparedStatement[] = [];
  const cleanedZombieKeys = new Set<string>();
  const lastSentTimeByUser = new Map<number, number>();

  for (const candidate of candidateAlerts) {
    // Защита по времени: если прошло более 20 секунд, прерываем цикл до следующей минуты
    if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
      console.warn("Cron wall-clock budget reached (20s). Postponing remaining checks.");
      break;
    }

    const { item, currentPrice, baseline, priceDeltaPercent } = candidate;

    // JIT-проверка с использованием теплого jitCache
    const cacheKey = `${item.network}:${item.account_index}`;
    let freshAccount = jitCache.get(cacheKey);

    if (freshAccount === undefined) {
      // Защита от шторма на рынке: лимит новых JIT сетевых запросов
      if (jitChecksDone >= MAX_JIT_CHECKS_PER_CRON || subrequestsUsed >= CONFIG.MAX_SUBREQUESTS_PER_CRON - 5) {
        break;
      }
      freshAccount = await fetchLighterAccount(item.network, item.account_index);
      subrequestsUsed++;
      jitChecksDone++;
      jitCache.set(cacheKey, freshAccount);
    }

    if (!freshAccount) continue;

    const livePosition = Array.isArray(freshAccount?.positions)
      ? freshAccount.positions.find(
          p => p.market_id === item.market_id && Math.abs(parseFloat(p.position || "0")) > 0
        )
      : undefined;

    // ЗОМБИ ЛИКВИДИРОВАН: пакетное накопление стейтментов удаления (с дедупликацией по ключу)
    if (!livePosition) {
      const zKey = `${item.network}:${item.account_index}:${item.market_id}`;
      if (!cleanedZombieKeys.has(zKey)) {
        cleanedZombieKeys.add(zKey);
        zombieCleanupStmts.push(
          env.DB.prepare("DELETE FROM account_open_positions WHERE network = ? AND account_index = ? AND market_id = ?")
            .bind(item.network, item.account_index, item.market_id),
          env.DB.prepare("DELETE FROM user_token_alerts WHERE network = ? AND account_index = ? AND market_id = ?")
            .bind(item.network, item.account_index, item.market_id)
        );
      }
      continue;
    }

    // ОТПРАВКА 3-СЛОЙНОГО БОЕВОГО АЛЕРТА
    const isLong = item.is_long === 1;
    const unPnl = parseFloat(livePosition.unrealized_pnl || "0");
    const liqPrice = parseFloat(livePosition.liquidation_price || "0");
    const distancePercent = (liqPrice > 0 && currentPrice > 0)
      ? Math.abs((currentPrice - liqPrice) / currentPrice) * 100
      : null;

    const alertText = formatPriceStepAlert({
      network: item.network,
      accountIndex: item.account_index,
      alias: item.alias,
      symbol: item.symbol,
      isLong,
      entryPrice: item.entry_price,
      currentPrice,
      baselinePrice: baseline,
      priceDeltaPercent,
      unrealizedPnl: unPnl,
      liqPrice,
      distancePercent
    });

    // Проверка режима «Тихий сон» (Mute)
    if (item.muted_until && now < item.muted_until) {
      alertUpdateStmts.push(
        env.DB.prepare(`
          INSERT INTO user_token_alerts (telegram_id, network, account_index, market_id, symbol, last_price, last_alerted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(telegram_id, network, account_index, market_id) DO UPDATE SET
            last_price = excluded.last_price,
            last_alerted_at = excluded.last_alerted_at
        `).bind(item.telegram_id, item.network, item.account_index, item.market_id, item.symbol, currentPrice, now)
      );
      continue;
    }

    const lighterUrl = item.network === 'mainnet' 
      ? "https://app.lighter.xyz/" 
      : "https://rh.lighter.xyz/";

    const keyboard = new InlineKeyboard()
      .text("🔄 Обновить", `refresh:${item.network}:${item.account_index}`)
      .url("🌐 Открыть биржу", lighterUrl);

    try {
      if (subrequestsUsed < CONFIG.MAX_SUBREQUESTS_PER_CRON) {
        // Троттлинг Telegram: минимум 300 мс между сообщениями одному и тому же пользователю
        const lastSentAt = lastSentTimeByUser.get(item.telegram_id) || 0;
        const timeSinceLastSent = Date.now() - lastSentAt;
        if (timeSinceLastSent < 300) {
          await new Promise(r => setTimeout(r, 300 - timeSinceLastSent));
        }

        await bot.api.sendMessage(item.telegram_id, alertText, {
          parse_mode: "HTML",
          reply_markup: keyboard
        });
        subrequestsUsed++;
        lastSentTimeByUser.set(item.telegram_id, Date.now());

        alertUpdateStmts.push(
          env.DB.prepare(`
            INSERT INTO user_token_alerts (telegram_id, network, account_index, market_id, symbol, last_price, last_alerted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(telegram_id, network, account_index, market_id) DO UPDATE SET
              last_price = excluded.last_price,
              last_alerted_at = excluded.last_alerted_at
          `).bind(item.telegram_id, item.network, item.account_index, item.market_id, item.symbol, currentPrice, now)
        );
      }
    } catch (err: any) {
      if (err?.error_code === 403) {
        await removeBlockedUser(env.DB, item.telegram_id);
      } else {
        console.error(`Failed to send alert to ${item.telegram_id}:`, err);
      }
    }
  }

  // 6. Единая пакетная транзакция в D1 чанками
  const allUpdates = [...newPositionsToInit, ...alertUpdateStmts, ...zombieCleanupStmts];
  if (allUpdates.length > 0) {
    await executeD1BatchInChunks(env.DB, allUpdates);
  }
}
