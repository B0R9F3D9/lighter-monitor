import { InlineKeyboard } from "grammy";
import {
  Env,
  LighterAccount,
  LighterNetwork,
  MarketPriceSnapshot,
  ActivePositionWatchItem,
  TrackedAccountKey,
} from "../types";
import { CONFIG } from "../config";
import {
  getNextAccountsForSync,
  touchFailedAccounts,
  batchUpdatePositionsCache,
  syncAccountOpenPositions,
  getActivePositionsForMonitoring,
  removeBlockedUser,
  ensureDatabaseSchema,
} from "../db/queries";
import {
  fetchLighterAccount,
  fetchInChunks,
  fetchExchangeStats,
  findMarketPrice,
} from "../lighter/api";
import { analyzePositionRisk } from "../lighter/math";
import { formatPriceStepAlert } from "../bot/formatters";
import { getBot } from "../bot/bot";

// Динамический умный кулдаун на лету от порога пользователя
export function getSmartCooldownSeconds(threshold: number): number {
  if (threshold <= 0.5) return 180; // 3 минуты (для XAU / агрессивных плеч 15x-25x)
  if (threshold <= 1.0) return 300; // 5 минут (стандарт)
  return 480; // 8 минут (для свинга с шагом 1.5% - 3%)
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
  chunkSize: number = 100,
): Promise<void> {
  for (let i = 0; i < stmts.length; i += chunkSize) {
    const chunk = stmts.slice(i, i + chunkSize);
    await db.batch(chunk);
  }
}

interface PriceRef {
  price: number;
  lastCheckedAt: number;
}

// In-memory кэш цен для обратного поиска (Reverse Indexing)
const priceReferenceCache = new Map<string, PriceRef>();

export function resetPriceReferenceCache(): void {
  priceReferenceCache.clear();
}

export function getMovedSymbols(
  currentSnapshots: Map<LighterNetwork, Map<string, MarketPriceSnapshot>>,
  nowSec: number,
  minMoveThreshold: number = 0.05, // 0.05% отсечка для надежного улавливания пользовательского шага 0.1%
  maxAgeSeconds: number = 600, // 10 минут принудительный пересчет для защиты от дрейфа
): { movedSymbols: string[]; isFullSweep: boolean } {
  // Холодный старт изолята: прогреваем кэш цен без тяжелого полного среза базы
  if (priceReferenceCache.size === 0) {
    for (const [, netMap] of currentSnapshots) {
      for (const [sym, snap] of netMap) {
        if (snap.price > 0) {
          priceReferenceCache.set(sym.toUpperCase(), { price: snap.price, lastCheckedAt: nowSec });
        }
      }
    }
    return { movedSymbols: [], isFullSweep: false };
  }

  const moved = new Set<string>();

  for (const [, netMap] of currentSnapshots) {
    for (const [rawSym, snap] of netMap) {
      if (snap.price <= 0) continue;
      const sym = rawSym.toUpperCase();
      const ref = priceReferenceCache.get(sym);

      if (!ref) {
        moved.add(sym);
        priceReferenceCache.set(sym, { price: snap.price, lastCheckedAt: nowSec });
        continue;
      }

      const deltaPercent = Math.abs((snap.price - ref.price) / ref.price) * 100;
      const isExpired = nowSec - ref.lastCheckedAt >= maxAgeSeconds;

      if (deltaPercent >= minMoveThreshold || isExpired) {
        moved.add(sym);
        ref.price = snap.price;
        ref.lastCheckedAt = nowSec;
      }
    }
  }

  return { movedSymbols: Array.from(moved), isFullSweep: false };
}

export async function runCronMonitor(env: Env): Promise<void> {
  const bot = getBot(env);
  const now = Math.floor(Date.now() / 1000);
  const startTime = Date.now();
  const MAX_WALL_CLOCK_MS = 14_000; // 14 сек безопасный таймаут (гарантирует завершение всего цикла до 15с)
  await ensureDatabaseSchema(env.DB);

  let subrequestsUsed = 0;
  let jitChecksDone = 0;

  // 1. АДАПТИВНЫЙ ФОНОВЫЙ ROUND-ROBIN (приоритет новым и активным аккаунтам, ускорен до 4)
  const accountsToSync = await getNextAccountsForSync(env.DB, 4, now);
  const jitCache = new Map<string, LighterAccount | null>();
  const failedAccounts: TrackedAccountKey[] = [];
  const cacheUpdates = new Map<
    string,
    {
      network: LighterNetwork;
      account: LighterAccount;
      cachedPositions: any[];
    }
  >();

  if (accountsToSync.length > 0) {
    const syncResults = await fetchInChunks(accountsToSync, 2, (acc) =>
      fetchLighterAccount(acc.network, acc.accountIndex),
    );
    subrequestsUsed += accountsToSync.length;

    for (let i = 0; i < accountsToSync.length; i++) {
      const accKey = accountsToSync[i]!;
      const res = syncResults[i];
      const syncedData = res?.status === "fulfilled" ? res.value : null;

      const cacheKey = `${accKey.network}:${accKey.accountIndex}`;
      jitCache.set(cacheKey, syncedData);

      if (syncedData) {
        await syncAccountOpenPositions(
          env.DB,
          accKey.network,
          accKey.accountIndex,
          syncedData.positions,
        );
        cacheUpdates.set(cacheKey, {
          network: accKey.network,
          account: syncedData,
          cachedPositions: syncedData.positions.map(analyzePositionRisk).filter(Boolean) as any,
        });
      } else {
        failedAccounts.push(accKey);
      }
    }
  }

  if (failedAccounts.length > 0) {
    await touchFailedAccounts(env.DB, failedAccounts);
  }

  // 2. ЗАГРУЖАЕМ СРЕЗЫ ЦЕН БИРЖИ (2 подзапроса на всю систему)
  const priceSnapshots = new Map<LighterNetwork, Map<string, MarketPriceSnapshot>>();
  const networks: LighterNetwork[] = ["rh", "mainnet"];

  for (const net of networks) {
    if (subrequestsUsed >= CONFIG.MAX_SUBREQUESTS_PER_CRON - 10) break;
    const snap = await fetchExchangeStats(net);
    subrequestsUsed++;
    priceSnapshots.set(net, snap);
  }

  // 3. REVERSE INDEXING: Вычисляем инструменты с реальным импульсом (или делаем полный срез)
  const { movedSymbols, isFullSweep } = getMovedSymbols(priceSnapshots, now);

  const items = isFullSweep
    ? await getActivePositionsForMonitoring(env.DB)
    : await getActivePositionsForMonitoring(env.DB, movedSymbols);

  if (items.length === 0) return;

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
        `).bind(
          item.telegram_id,
          item.network,
          item.account_index,
          item.market_id,
          item.symbol,
          currentPrice,
          now,
        ),
      );
      continue;
    }

    // Проверка шага цены
    const baseline = item.last_price;
    if (baseline <= 0) continue;
    const priceDeltaPercent = ((currentPrice - baseline) / baseline) * 100;
    const absDelta = Math.abs(priceDeltaPercent);

    if (absDelta < item.alert_threshold) continue;

    // Динамический кулдаун (3-8 минут с пробитием при двойном скачке)
    const cooldownSeconds = getSmartCooldownSeconds(item.alert_threshold);
    const timeSinceLastAlert = item.last_alerted_at ? now - item.last_alerted_at : Infinity;
    const isDoubleJump = absDelta >= item.alert_threshold * 2;

    if (timeSinceLastAlert < cooldownSeconds && !isDoubleJump) continue;

    // Позиция квалифицирована на алерт: считаем относительную срочность
    const urgency = item.alert_threshold > 0 ? absDelta / item.alert_threshold : absDelta;
    candidateAlerts.push({
      item,
      currentPrice,
      baseline,
      priceDeltaPercent,
      absDelta,
      urgency,
    });
  }

  // Сортировка по убыванию срочности (наибольшее превышение порога идет первым)
  candidateAlerts.sort((a, b) => b.urgency - a.urgency);

  // 5. ФАЗА Б: Параллельная JIT-актуализация и доставка алертов
  const alertUpdateStmts: D1PreparedStatement[] = [];
  const zombieCleanupStmts: D1PreparedStatement[] = [];
  const cleanedZombieKeys = new Set<string>();

  // Шаг Б.1: Селективный JIT отбор (только позиции близкие к ликвидации или требующие проверки на зомби)
  // Динамический балансировщик квот: если алертов много (> 20), отдаем приоритет отправке сообщений в Telegram!
  const maxJitForThisTick = candidateAlerts.length > 20 ? 4 : 8;
  const pendingJitKeys: TrackedAccountKey[] = [];
  const seenAccKeys = new Set<string>();

  for (const candidate of candidateAlerts) {
    const { item, currentPrice } = candidate;
    const key = `${item.network}:${item.account_index}`;
    if (jitCache.has(key) || seenAccKeys.has(key)) continue;

    const liqPrice = item.liquidation_price || 0;
    const distancePercent =
      liqPrice > 0 && currentPrice > 0
        ? Math.abs((currentPrice - liqPrice) / currentPrice) * 100
        : null;

    const isNearLiquidation = distancePercent !== null && distancePercent <= 3.5;
    const isStale = item.last_updated_at ? now - item.last_updated_at >= 7200 : true;

    // В JIT очередь попадают позиции в зоне риска (<= 3.5% от ликвидации) или не обновлявшиеся > 2 часов
    if (isNearLiquidation || isStale) {
      seenAccKeys.add(key);
      pendingJitKeys.push({
        network: item.network,
        accountIndex: item.account_index,
      });
      if (pendingJitKeys.length >= maxJitForThisTick) break;
    }
  }

  // Шаг Б.2: Параллельный опрос аккаунтов пачками по 3 штуки (Promise.allSettled без искусственных пауз)
  const JIT_CHUNK = 3;
  for (let i = 0; i < pendingJitKeys.length; i += JIT_CHUNK) {
    if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
      console.warn("Cron wall-clock budget reached. Postponing remaining JIT checks.");
      break;
    }
    if (subrequestsUsed + JIT_CHUNK >= CONFIG.MAX_SUBREQUESTS_PER_CRON - 5) break;

    const chunk = pendingJitKeys.slice(i, i + JIT_CHUNK);
    const results = await Promise.allSettled(
      chunk.map((acc) => fetchLighterAccount(acc.network, acc.accountIndex)),
    );
    subrequestsUsed += chunk.length;
    jitChecksDone += chunk.length;

    for (let j = 0; j < chunk.length; j++) {
      const acc = chunk[j]!;
      const res = results[j];
      const syncedData = res?.status === "fulfilled" ? res.value : null;
      const cacheKey = `${acc.network}:${acc.accountIndex}`;
      jitCache.set(cacheKey, syncedData);

      // JIT-СИНК: сразу актуализируем открытые позиции в D1 без ожидания Round-Robin очереди
      if (syncedData) {
        await syncAccountOpenPositions(env.DB, acc.network, acc.accountIndex, syncedData.positions);
        cacheUpdates.set(cacheKey, {
          network: acc.network,
          account: syncedData,
          cachedPositions: syncedData.positions.map(analyzePositionRisk).filter(Boolean) as any,
        });
      }
    }
  }

  // Шаг Б.3: Фильтрация, удаление зомби и агрегация алертов по пользователям
  interface PendingUserAlert {
    item: ActivePositionWatchItem;
    currentPrice: number;
    alertText: string;
  }
  const alertsByUser = new Map<number, PendingUserAlert[]>();

  for (const candidate of candidateAlerts) {
    const { item, currentPrice, baseline, priceDeltaPercent } = candidate;
    const cacheKey = `${item.network}:${item.account_index}`;
    const freshAccount = jitCache.get(cacheKey);

    let unPnl: number;
    let liqPrice: number;
    let distancePercent: number | null = null;

    if (freshAccount) {
      // Аккаунт был проверен через JIT: ищем актуальную сделку на бирже
      const livePosition = Array.isArray(freshAccount?.positions)
        ? freshAccount.positions.find(
            (p) => p.market_id === item.market_id && Math.abs(parseFloat(p.position || "0")) > 0,
          )
        : undefined;

      // ЗОМБИ ЛИКВИДИРОВАН: пакетное накопление стейтментов удаления (с дедупликацией по ключу)
      if (!livePosition) {
        const zKey = `${item.network}:${item.account_index}:${item.market_id}`;
        if (!cleanedZombieKeys.has(zKey)) {
          cleanedZombieKeys.add(zKey);
          zombieCleanupStmts.push(
            env.DB.prepare(
              "DELETE FROM account_open_positions WHERE network = ? AND account_index = ? AND market_id = ?",
            ).bind(item.network, item.account_index, item.market_id),
            env.DB.prepare(
              "DELETE FROM user_token_alerts WHERE network = ? AND account_index = ? AND market_id = ?",
            ).bind(item.network, item.account_index, item.market_id),
          );
        }
        continue;
      }

      unPnl = parseFloat(livePosition.unrealized_pnl || "0");
      liqPrice = parseFloat(livePosition.liquidation_price || "0");
      distancePercent =
        liqPrice > 0 && currentPrice > 0
          ? Math.abs((currentPrice - liqPrice) / currentPrice) * 100
          : null;
    } else {
      // СЕЛЕКТИВНЫЙ JIT: Безопасная позиция, UnPnL вычисляется математически прямо в памяти
      const isLong = item.is_long === 1;
      unPnl = (currentPrice - item.entry_price) * item.size * (isLong ? 1 : -1);
      liqPrice = item.liquidation_price || 0;
      distancePercent =
        liqPrice > 0 && currentPrice > 0
          ? Math.abs((currentPrice - liqPrice) / currentPrice) * 100
          : null;

      // Если расчетная ликвидация в опасной зоне (<= 3.5%), но аккаунт не попал в JIT этого тика,
      // откладываем алерт до верификации биржей на следующем тике
      if (distancePercent !== null && distancePercent <= 3.5) {
        continue;
      }
    }

    // Проверка режима «Тихий сон» (Mute)
    if (item.muted_until && now < item.muted_until) {
      alertUpdateStmts.push(
        env.DB.prepare(`
          INSERT INTO user_token_alerts (telegram_id, network, account_index, market_id, symbol, last_price, last_alerted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(telegram_id, network, account_index, market_id) DO UPDATE SET
            last_price = excluded.last_price,
            last_alerted_at = excluded.last_alerted_at
        `).bind(
          item.telegram_id,
          item.network,
          item.account_index,
          item.market_id,
          item.symbol,
          currentPrice,
          now,
        ),
      );
      continue;
    }

    const isLong = item.is_long === 1;
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
      distancePercent,
    });

    const userAlerts = alertsByUser.get(item.telegram_id) || [];
    userAlerts.push({ item, currentPrice, alertText });
    alertsByUser.set(item.telegram_id, userAlerts);
  }

  // Шаг Б.4: Параллельная отправка агрегированных алертов (0 мс сна, защита от 429)
  const userEntries = Array.from(alertsByUser.entries());
  const ALERT_SEND_CONCURRENCY = 3;

  for (let i = 0; i < userEntries.length; i += ALERT_SEND_CONCURRENCY) {
    if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
      console.warn("Cron wall-clock budget reached. Postponing remaining alert deliveries.");
      break;
    }
    if (subrequestsUsed >= CONFIG.MAX_SUBREQUESTS_PER_CRON) break;

    const chunk = userEntries.slice(i, i + ALERT_SEND_CONCURRENCY);
    await Promise.allSettled(
      chunk.map(async ([telegramId, alerts]) => {
        if (subrequestsUsed >= CONFIG.MAX_SUBREQUESTS_PER_CRON) return;

        const combinedText = alerts.map((a) => a.alertText).join("\n\n───────────────────\n\n");
        let keyboard: InlineKeyboard;

        if (alerts.length === 1) {
          const first = alerts[0]!;
          const lighterUrl =
            first.item.network === "mainnet"
              ? "https://app.lighter.xyz/"
              : "https://rh.lighter.xyz/";
          keyboard = new InlineKeyboard()
            .text("🔄 Обновить", `refresh:${first.item.network}:${first.item.account_index}`)
            .url("🌐 Открыть биржу", lighterUrl);
        } else {
          keyboard = new InlineKeyboard()
            .text("📊 Мои сделки", "action_positions")
            .url("🌐 Открыть биржу", "https://app.lighter.xyz/");
        }

        try {
          await bot.api.sendMessage(telegramId, combinedText, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
          subrequestsUsed++;

          for (const a of alerts) {
            alertUpdateStmts.push(
              env.DB.prepare(`
                INSERT INTO user_token_alerts (telegram_id, network, account_index, market_id, symbol, last_price, last_alerted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(telegram_id, network, account_index, market_id) DO UPDATE SET
                  last_price = excluded.last_price,
                  last_alerted_at = excluded.last_alerted_at
              `).bind(
                a.item.telegram_id,
                a.item.network,
                a.item.account_index,
                a.item.market_id,
                a.item.symbol,
                a.currentPrice,
                now,
              ),
            );
          }
        } catch (err: any) {
          if (err?.error_code === 403) {
            await removeBlockedUser(env.DB, telegramId);
          } else if (err?.error_code === 429) {
            console.warn(
              `[telegram] Rate limited (429) for user ${telegramId}, retry_after: ${err?.parameters?.retry_after ?? "unknown"}s`,
            );
          } else {
            console.error(`Failed to send alert to ${telegramId}:`, err);
          }
        }
      }),
    );
  }

  // 6. Единая пакетная транзакция в D1 чанками (кэш позиций + алерты + зомби)
  if (cacheUpdates.size > 0) {
    await batchUpdatePositionsCache(env.DB, Array.from(cacheUpdates.values()));
  }
  const allUpdates = [...newPositionsToInit, ...alertUpdateStmts, ...zombieCleanupStmts];
  if (allUpdates.length > 0) {
    await executeD1BatchInChunks(env.DB, allUpdates);
  }

  // 7. СТРУКТУРИРОВАННЫЙ JSON-ЛОГ (Observability & Cloudflare Dashboard / Axiom)
  const durationMs = Date.now() - startTime;
  const executionMetrics = {
    event: "cron_completed",
    duration_ms: durationMs,
    subrequests_used: subrequestsUsed,
    round_robin_synced: accountsToSync.length,
    total_positions_checked: items.length,
    candidates_count: candidateAlerts.length,
    jit_checks_performed: jitChecksDone,
    alerts_sent: alertUpdateStmts.length,
    zombies_cleaned: zombieCleanupStmts.length / 2,
    timestamp: now,
  };
  console.log(JSON.stringify(executionMetrics));

  // 8. WATCHDOG / HEARTBEAT (Healthchecks.io / Better Stack)
  if (env.HEALTHCHECK_URL) {
    try {
      await fetch(env.HEALTHCHECK_URL);
    } catch (err) {
      console.warn("Healthcheck ping failed:", err);
    }
  }
}
