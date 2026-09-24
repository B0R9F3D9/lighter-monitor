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
} from "../db/queries";
import { fetchLighterAccount, fetchExchangeStats, findMarketPrice } from "../lighter/api";
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
  // Холодный старт изолята: наполняем кэш и делаем полный срез
  if (priceReferenceCache.size === 0) {
    for (const [, netMap] of currentSnapshots) {
      for (const [sym, snap] of netMap) {
        if (snap.price > 0) {
          priceReferenceCache.set(sym.toUpperCase(), { price: snap.price, lastCheckedAt: nowSec });
        }
      }
    }
    return { movedSymbols: [], isFullSweep: true };
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
  const MAX_WALL_CLOCK_MS = 20_000; // 20 сек таймаут (Time-Budgeting)
  const MAX_JIT_CHECKS_PER_CRON = 15;

  let subrequestsUsed = 0;
  let jitChecksDone = 0;

  // 1. АДАПТИВНЫЙ ФОНОВЫЙ ROUND-ROBIN (приоритет новым и активным аккаунтам)
  const accountsToSync = await getNextAccountsForSync(env.DB, 2, now);
  const jitCache = new Map<string, LighterAccount | null>();
  const failedAccounts: TrackedAccountKey[] = [];
  const cacheUpdates: Array<{
    network: LighterNetwork;
    account: LighterAccount;
    cachedPositions: any[];
  }> = [];

  for (const accKey of accountsToSync) {
    if (subrequestsUsed >= CONFIG.MAX_SUBREQUESTS_PER_CRON - 20) break;
    const syncedData = await fetchLighterAccount(accKey.network, accKey.accountIndex);
    subrequestsUsed++;

    const cacheKey = `${accKey.network}:${accKey.accountIndex}`;
    jitCache.set(cacheKey, syncedData);

    if (syncedData) {
      await syncAccountOpenPositions(
        env.DB,
        accKey.network,
        accKey.accountIndex,
        syncedData.positions,
      );
      cacheUpdates.push({
        network: accKey.network,
        account: syncedData,
        cachedPositions: syncedData.positions.map(analyzePositionRisk).filter(Boolean) as any,
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
  const lastSentTimeByUser = new Map<number, number>();

  // Шаг Б.1: Отбираем уникальные аккаунты для JIT-проверки среди топ кандидатов
  const pendingJitKeys: TrackedAccountKey[] = [];
  const seenAccKeys = new Set<string>();

  for (const candidate of candidateAlerts) {
    const key = `${candidate.item.network}:${candidate.item.account_index}`;
    if (!jitCache.has(key) && !seenAccKeys.has(key)) {
      seenAccKeys.add(key);
      pendingJitKeys.push({
        network: candidate.item.network,
        accountIndex: candidate.item.account_index,
      });
      if (pendingJitKeys.length >= MAX_JIT_CHECKS_PER_CRON) break;
    }
  }

  // Шаг Б.2: Параллельный опрос пачками по 3 аккаунта
  const JIT_CONCURRENCY = 3;
  for (let i = 0; i < pendingJitKeys.length; i += JIT_CONCURRENCY) {
    if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
      console.warn("Cron wall-clock budget reached (20s). Postponing remaining JIT checks.");
      break;
    }
    if (subrequestsUsed + JIT_CONCURRENCY >= CONFIG.MAX_SUBREQUESTS_PER_CRON - 5) {
      break;
    }

    const chunk = pendingJitKeys.slice(i, i + JIT_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((acc) => fetchLighterAccount(acc.network, acc.accountIndex)),
    );
    subrequestsUsed += chunk.length;
    jitChecksDone += chunk.length;

    for (let j = 0; j < chunk.length; j++) {
      const acc = chunk[j]!;
      const res = results[j]!;
      const cacheKey = `${acc.network}:${acc.accountIndex}`;
      jitCache.set(cacheKey, res.status === "fulfilled" ? res.value : null);
    }
  }

  // Шаг Б.3: Доставка алертов (все аккаунты уже в горячем jitCache)
  for (const candidate of candidateAlerts) {
    if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
      console.warn("Cron wall-clock budget reached (20s). Postponing remaining checks.");
      break;
    }

    const { item, currentPrice, baseline, priceDeltaPercent } = candidate;
    const cacheKey = `${item.network}:${item.account_index}`;
    const freshAccount = jitCache.get(cacheKey);

    if (!freshAccount) continue;

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

    // ОТПРАВКА 3-СЛОЙНОГО БОЕВОГО АЛЕРТА
    const isLong = item.is_long === 1;
    const unPnl = parseFloat(livePosition.unrealized_pnl || "0");
    const liqPrice = parseFloat(livePosition.liquidation_price || "0");
    const distancePercent =
      liqPrice > 0 && currentPrice > 0
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
      distancePercent,
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

    const lighterUrl =
      item.network === "mainnet" ? "https://app.lighter.xyz/" : "https://rh.lighter.xyz/";

    const keyboard = new InlineKeyboard()
      .text("🔄 Обновить", `refresh:${item.network}:${item.account_index}`)
      .url("🌐 Открыть биржу", lighterUrl);

    try {
      if (subrequestsUsed < CONFIG.MAX_SUBREQUESTS_PER_CRON) {
        // Троттлинг Telegram: минимум 300 мс между сообщениями одному и тому же пользователю
        const lastSentAt = lastSentTimeByUser.get(item.telegram_id) || 0;
        const timeSinceLastSent = Date.now() - lastSentAt;
        if (timeSinceLastSent < 300) {
          await new Promise((r) => setTimeout(r, 300 - timeSinceLastSent));
        }

        await bot.api.sendMessage(item.telegram_id, alertText, {
          parse_mode: "HTML",
          reply_markup: keyboard,
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
