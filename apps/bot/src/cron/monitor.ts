import { Api, InlineKeyboard } from "grammy";
import {
  Env,
  LighterAccount,
  LighterNetwork,
  MarketPriceSnapshot,
  ActivePositionWatchItem,
  TrackedAccountKey,
  SpreadTargetRow,
} from "../types";
import { CONFIG, getLighterAuthToken } from "../config";
import {
  getNextAccountsForSync,
  buildTouchFailedAccountsStmts,
  buildBatchUpdatePositionsCacheStmts,
  buildSyncAccountOpenPositionsStmts,
  getActivePositionsForMonitoring,
  getDistinctActiveSymbols,
  getActiveSpreadTargetsForMonitoring,
  removeBlockedUser,
  ensureDatabaseSchema,
} from "../db/queries";
import { getCronStatements } from "../db/statements";
import {
  fetchLighterAccount,
  fetchInChunks,
  fetchExchangeStats,
  findMarketPrice,
} from "../lighter/api";
import { computePositionsFingerprint } from "../lighter/math";
import { getMemoryAccount } from "../cache/memory";
import { formatPriceStepAlert, formatSpreadAlert, getSpreadAlertKeyboard } from "../bot/formatters";
import { pingHealthcheckSuccess, pingHealthcheckFail } from "../utils/healthcheck";

// Динамический умный кулдаун на лету от порога пользователя
export function getSmartCooldownSeconds(threshold: number): number {
  if (threshold <= 0.5) return 180; // 3 минуты (для XAU / агрессивных плеч 15x-25x)
  if (threshold <= 1.0) return 300; // 5 минут (стандарт)
  return 480; // 8 минут (для свинга с шагом 1.5% - 3%)
}

// Проверка увеличения риска по позиции от изменения цены:
// Для LONG: риск растет при падении цены ниже базовой (currentPrice < baseline)
// Для SHORT: риск растет при росте цены выше базовой (currentPrice > baseline)
export function isPositionRiskIncreasing(
  isLong: boolean,
  currentPrice: number,
  baseline: number,
): boolean {
  return isLong ? currentPrice < baseline : currentPrice > baseline;
}

// Кандидат на отправку алерта
interface AlertCandidate {
  item: ActivePositionWatchItem;
  currentPrice: number;
  baseline: number;
  priceDeltaPercent: number;
  absDelta: number;
  urgency: number; // Относительный вес: absDelta / threshold
}

// Пакетное выполнение D1 стейтментов чанками до 100 штук
async function executeD1BatchInChunks(
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
  // Холодный старт изолята: прогреваем кэш цен и форсируем полный срез активных позиций,
  // чтобы ни один спайк не был упущен из-за пересоздания изолята!
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

export async function runCronMonitor(env: Env, _ctx?: ExecutionContext): Promise<void> {
  const startTime = Date.now();
  const now = Math.floor(startTime / 1000);
  let subrequestsUsed = 0;

  try {
    const MAX_WALL_CLOCK_MS = 14_000; // 14 сек таймаут
    const allUpdates: D1PreparedStatement[] = [];

    // Пре-компиляция D1 стейтментов из кэша (Zero-Alloc на горячем пути)
    const stmts = getCronStatements(env.DB);

    // 0. Гарантируем актуальность схемы БД (Cold-start auto-migration)
    await ensureDatabaseSchema(env.DB);

    // 1. ЗАГРУЖАЕМ СРЕЗЫ ЦЕН БИРЖИ ПАРАЛЛЕЛЬНО (Целевой парсинг только активных инструментов)
    const uniqueSymbols = await getDistinctActiveSymbols(env.DB);
    const activeSymbolsSet = uniqueSymbols.length > 0 ? new Set(uniqueSymbols) : undefined;

    const priceSnapshots = new Map<LighterNetwork, Map<string, MarketPriceSnapshot>>();
    const [snapRh, snapMainnet] = await Promise.all([
      fetchExchangeStats("rh", activeSymbolsSet, getLighterAuthToken(env, "rh")),
      fetchExchangeStats("mainnet", activeSymbolsSet, getLighterAuthToken(env, "mainnet")),
    ]);
    subrequestsUsed += 2;
    priceSnapshots.set("rh", snapRh);
    priceSnapshots.set("mainnet", snapMainnet);

    // 1b. МОНИТОРИНГ ТАРГЕТОВ СПРЕДА RH vs CORE
    let spreadAlertsSent = 0;
    if (snapRh.size > 0 && snapMainnet.size > 0) {
      try {
        const spreadTargets = await getActiveSpreadTargetsForMonitoring(env.DB, now);
        if (spreadTargets.length > 0) {
          interface SpreadCand {
            target: SpreadTargetRow;
            rhPrice: number;
            corePrice: number;
            actualDiffUsd: number;
            actualDiffBps: number;
            basisSigned: number;
            basisBps: number;
            metric: number;
          }
          const candidates: SpreadCand[] = [];

          for (let i = 0; i < spreadTargets.length; i++) {
            const target = spreadTargets[i]!;
            const rhSnap = findMarketPrice(snapRh, target.symbol);
            const coreSnap = findMarketPrice(snapMainnet, target.symbol);

            if (!rhSnap || rhSnap.price <= 0 || !coreSnap || coreSnap.price <= 0) continue;

            const rhPrice = rhSnap.price;
            const corePrice = coreSnap.price;

            // Санитарный лимит расхождения цен (>10% от цены Core считается аномалией)
            if (Math.abs(rhPrice - corePrice) / corePrice > CONFIG.SPREAD_MAX_PRICE_DIFF_RATIO) {
              continue;
            }

            const basisSigned = rhPrice - corePrice;
            const basisBps = (basisSigned / corePrice) * 10000;

            const actualDiffUsd =
              target.direction === "rh_cheaper" ? corePrice - rhPrice : rhPrice - corePrice;
            const actualDiffBps = (actualDiffUsd / corePrice) * 10000;

            const metric = target.unit === "bps" ? actualDiffBps : actualDiffUsd;

            if (target.armed === 1) {
              if (metric >= target.target_delta) {
                // Проверка мьютов
                const isUserMuted = (target.user_spread_muted_until ?? 0) > now;
                const isSymMuted = (target.symbol_muted_until ?? 0) > now;
                const isTargetMuted = target.muted_until > now;

                if (isUserMuted || isSymMuted || isTargetMuted) {
                  continue;
                }

                // Проверка кулдауна
                const timeSinceLast = target.last_alerted_at
                  ? now - target.last_alerted_at
                  : Infinity;
                if (timeSinceLast < CONFIG.SPREAD_ALERT_COOLDOWN_SECONDS) {
                  continue;
                }

                candidates.push({
                  target,
                  rhPrice,
                  corePrice,
                  actualDiffUsd,
                  actualDiffBps,
                  basisSigned,
                  basisBps,
                  metric,
                });
              }
            } else {
              // Re-arm: сработавшая цель снова взводится, когда спред откатился ниже threshold * 0.8
              if (metric <= target.target_delta * CONFIG.SPREAD_REARM_RATIO) {
                allUpdates.push(stmts.updateSpreadRearm.bind(target.id));
              }
            }
          }

          if (candidates.length > 0 && env.TELEGRAM_BOT_TOKEN) {
            const api = new Api(env.TELEGRAM_BOT_TOKEN);
            const remainingSubreqs = Math.max(
              0,
              CONFIG.MAX_SUBREQUESTS_PER_CRON - subrequestsUsed - 15,
            );
            const maxSpreadSends = Math.min(CONFIG.MAX_SPREAD_ALERTS_PER_TICK, remainingSubreqs);
            const toSend = candidates.slice(0, maxSpreadSends);

            const sendPromises = toSend.map(async (cand) => {
              const alertText = formatSpreadAlert({
                targetId: cand.target.id,
                symbol: cand.target.symbol,
                direction: cand.target.direction,
                targetDelta: cand.target.target_delta,
                unit: cand.target.unit,
                rhPrice: cand.rhPrice,
                corePrice: cand.corePrice,
                actualDiff: cand.actualDiffUsd,
                basisSigned: cand.basisSigned,
                basisBps: cand.basisBps,
              });

              try {
                await api.sendMessage(cand.target.telegram_id, alertText, {
                  parse_mode: "HTML",
                  reply_markup: getSpreadAlertKeyboard(cand.target.id, cand.target.symbol),
                });
                return { success: true, cand, err: null };
              } catch (err: any) {
                return { success: false, cand, err };
              }
            });

            const results = await Promise.allSettled(sendPromises);
            subrequestsUsed += results.length;

            for (const r of results) {
              if (r.status !== "fulfilled") continue;
              const { success, cand, err } = r.value;
              if (success) {
                spreadAlertsSent++;
                allUpdates.push(stmts.updateSpreadAlertSent.bind(now, cand.metric, cand.target.id));
              } else {
                if (err?.error_code === 403) {
                  await removeBlockedUser(env.DB, cand.target.telegram_id);
                } else if (err?.error_code === 429) {
                  console.warn(`[spread] Rate limited (429) for user ${cand.target.telegram_id}`);
                } else {
                  console.error(
                    `[spread] Failed to send alert to ${cand.target.telegram_id}:`,
                    err?.message || err,
                  );
                }
              }
            }
          }
        }
      } catch (spreadErr) {
        console.error("[spread] Error in checkSpreadAlerts:", spreadErr);
      }
    }

    // 2. REVERSE INDEXING: Вычисляем инструменты с реальным импульсом
    const { movedSymbols, isFullSweep } = getMovedSymbols(priceSnapshots, now);

    const items = isFullSweep
      ? await getActivePositionsForMonitoring(env.DB)
      : await getActivePositionsForMonitoring(env.DB, movedSymbols);
    const candidateAlerts: AlertCandidate[] = [];

    // 3. ФАЗА А: Мгновенная in-memory фильтрация и оценка срочности без сетевых запросов
    const itemsCount = items.length;
    for (let i = 0; i < itemsCount; i++) {
      const item = items[i]!;
      const netMap = priceSnapshots.get(item.network);
      if (!netMap) continue;

      const market = findMarketPrice(netMap, item.symbol);
      if (!market || market.price <= 0) continue;

      const currentPrice = market.price;

      // ПЕРВЫЙ ТИК: пакуем в единый batch без отправки спама
      if (item.last_price === null) {
        allUpdates.push(
          stmts.upsertAlertPrice.bind(
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

      const isLong = item.is_long === 1;
      const isRiskIncreasing = isPositionRiskIncreasing(isLong, currentPrice, baseline);

      if (!isRiskIncreasing) {
        // Цена сдвинулась в пользу позиции: подтягиваем базовую отметку без отправки алерта
        allUpdates.push(
          stmts.upsertAlertPrice.bind(
            item.telegram_id,
            item.network,
            item.account_index,
            item.market_id,
            item.symbol,
            currentPrice,
            item.last_alerted_at,
          ),
        );
        continue;
      }

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

    if (candidateAlerts.length > 1) {
      candidateAlerts.sort((a, b) => b.urgency - a.urgency);
    }

    let roundRobinSyncedCount = 0;
    let jitChecksDone = 0;
    let alertsSentCount = 0;
    const jitCache = new Map<string, LighterAccount | null>();
    const cleanedZombieKeys = new Set<string>();

    // 4. КОНФЛИКТ-МЕНЕДЖЕР (HFT Guard): Разделение Round-Robin и JIT
    if (candidateAlerts.length === 0) {
      // РЫНОК СПОКОЕН: Фоновый Round-Robin синк (до 5 аккаунтов)
      const accountsToSync = await getNextAccountsForSync(env.DB, 5, now, 0);

      if (accountsToSync.length > 0) {
        const syncResults = await fetchInChunks(accountsToSync, 5, (acc) =>
          fetchLighterAccount(
            acc.network,
            acc.accountIndex,
            false,
            getLighterAuthToken(env, acc.network),
          ),
        );
        subrequestsUsed += accountsToSync.length;

        const failedAccounts: TrackedAccountKey[] = [];
        const cacheUpdates: Array<{
          network: LighterNetwork;
          account: LighterAccount;
          cachedPositions: any[];
        }> = [];

        for (let i = 0; i < accountsToSync.length; i++) {
          const accKey = accountsToSync[i]!;
          const res = syncResults[i];
          const syncedData = res?.status === "fulfilled" ? res.value : null;

          jitCache.set(`${accKey.network}:${accKey.accountIndex}`, syncedData);

          if (syncedData) {
            roundRobinSyncedCount++;

            // Fast Zero-Alloc Fingerprint Dirty Checking
            const currentFingerprint = computePositionsFingerprint(syncedData.positions || []);
            const memAcc = getMemoryAccount(accKey.network, accKey.accountIndex);
            let hasChanged = true;
            if (memAcc) {
              hasChanged = memAcc.fingerprint !== currentFingerprint;
            } else if (accKey.positionsJson) {
              try {
                const cachedPositions = JSON.parse(accKey.positionsJson);
                hasChanged = computePositionsFingerprint(cachedPositions) !== currentFingerprint;
              } catch {
                hasChanged = true;
              }
            }

            if (hasChanged) {
              allUpdates.push(
                ...buildSyncAccountOpenPositionsStmts(
                  env.DB,
                  accKey.network,
                  accKey.accountIndex,
                  syncedData.positions,
                  now,
                  stmts.upsertOpenPos,
                ),
              );
            }

            cacheUpdates.push({
              network: accKey.network,
              account: syncedData,
              cachedPositions: syncedData.positions,
            });
          } else {
            failedAccounts.push(accKey);
          }
        }

        if (cacheUpdates.length > 0) {
          allUpdates.push(
            ...buildBatchUpdatePositionsCacheStmts(env.DB, cacheUpdates, now, stmts.upsertCache),
          );
        }
        if (failedAccounts.length > 0) {
          allUpdates.push(
            ...buildTouchFailedAccountsStmts(env.DB, failedAccounts, now, stmts.touchFailed),
          );
        }
      }
    } else {
      // РЫНОК АКТИВЕН: ФАЗА Б (Селективный JIT + доставка алертов). Фоновый RR пропускается ради CPU.
      const maxJitForThisTick = candidateAlerts.length > 20 ? 6 : 10;
      const pendingJitKeys: TrackedAccountKey[] = [];
      const seenAccKeys = new Set<string>();

      for (let i = 0; i < candidateAlerts.length; i++) {
        const candidate = candidateAlerts[i]!;
        const { item, currentPrice } = candidate;
        const key = `${item.network}:${item.account_index}`;
        if (jitCache.has(key) || seenAccKeys.has(key)) continue;

        const liqPrice = item.liquidation_price || 0;
        const distancePercent =
          liqPrice > 0 && currentPrice > 0
            ? Math.abs((currentPrice - liqPrice) / currentPrice) * 100
            : null;

        const stalenessSec = item.last_updated_at ? now - item.last_updated_at : Infinity;
        const isRiskZone = distancePercent !== null && distancePercent <= 5.0;
        const isStale = stalenessSec >= 60;

        if (isRiskZone || isStale) {
          seenAccKeys.add(key);
          pendingJitKeys.push({
            network: item.network,
            accountIndex: item.account_index,
          });
          if (pendingJitKeys.length >= maxJitForThisTick) break;
        }
      }

      // Шаг Б.2: Параллельный опрос аккаунтов пачками по 5 штук
      const JIT_CHUNK = 5;
      for (let i = 0; i < pendingJitKeys.length; i += JIT_CHUNK) {
        if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
          console.warn("Cron wall-clock budget reached. Postponing remaining JIT checks.");
          break;
        }
        if (subrequestsUsed + JIT_CHUNK >= CONFIG.MAX_SUBREQUESTS_PER_CRON - 5) break;

        const chunk = pendingJitKeys.slice(i, i + JIT_CHUNK);
        const results = await Promise.allSettled(
          chunk.map((acc) =>
            fetchLighterAccount(
              acc.network,
              acc.accountIndex,
              false,
              getLighterAuthToken(env, acc.network),
            ),
          ),
        );
        subrequestsUsed += chunk.length;
        jitChecksDone += chunk.length;

        for (let j = 0; j < chunk.length; j++) {
          const acc = chunk[j]!;
          const res = results[j];
          const syncedData = res?.status === "fulfilled" ? res.value : null;
          jitCache.set(`${acc.network}:${acc.accountIndex}`, syncedData);

          if (syncedData) {
            const currentFingerprint = computePositionsFingerprint(syncedData.positions || []);
            const memAcc = getMemoryAccount(acc.network, acc.accountIndex);
            let hasChanged = true;
            if (memAcc) {
              hasChanged = memAcc.fingerprint !== currentFingerprint;
            } else if (acc.positionsJson) {
              try {
                const cachedPositions = JSON.parse(acc.positionsJson);
                hasChanged = computePositionsFingerprint(cachedPositions) !== currentFingerprint;
              } catch {
                hasChanged = true;
              }
            }

            if (hasChanged) {
              allUpdates.push(
                ...buildSyncAccountOpenPositionsStmts(
                  env.DB,
                  acc.network,
                  acc.accountIndex,
                  syncedData.positions,
                  now,
                  stmts.upsertOpenPos,
                ),
              );
            }
            allUpdates.push(
              ...buildBatchUpdatePositionsCacheStmts(
                env.DB,
                [
                  {
                    network: acc.network,
                    account: syncedData,
                    cachedPositions: syncedData.positions,
                  },
                ],
                now,
                stmts.upsertCache,
              ),
            );
          }
        }
      }

      // Шаг Б.3: Фильтрация, удаление зомби и агрегация алертов
      interface PendingUserAlert {
        item: ActivePositionWatchItem;
        currentPrice: number;
        alertText: string;
      }
      const alertsByUser = new Map<number, PendingUserAlert[]>();

      for (let i = 0; i < candidateAlerts.length; i++) {
        const candidate = candidateAlerts[i]!;
        const { item, currentPrice, baseline, priceDeltaPercent } = candidate;
        const cacheKey = `${item.network}:${item.account_index}`;
        const freshAccount = jitCache.get(cacheKey);

        let unPnl: number;
        let liqPrice: number;
        let distancePercent: number | null = null;

        if (freshAccount) {
          const livePosition = Array.isArray(freshAccount?.positions)
            ? freshAccount.positions.find(
                (p) =>
                  p.market_id === item.market_id && Math.abs(parseFloat(p.position || "0")) > 0,
              )
            : undefined;

          if (!livePosition) {
            const zKey = `${item.network}:${item.account_index}:${item.market_id}`;
            if (!cleanedZombieKeys.has(zKey)) {
              cleanedZombieKeys.add(zKey);
              allUpdates.push(
                stmts.deleteZombiePos.bind(item.network, item.account_index, item.market_id),
                stmts.deleteZombieAlert.bind(item.network, item.account_index, item.market_id),
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
          const isLong = item.is_long === 1;
          unPnl = (currentPrice - item.entry_price) * item.size * (isLong ? 1 : -1);
          liqPrice = item.liquidation_price || 0;
          distancePercent =
            liqPrice > 0 && currentPrice > 0
              ? Math.abs((currentPrice - liqPrice) / currentPrice) * 100
              : null;
        }

        if (item.muted_until && now < item.muted_until) {
          allUpdates.push(
            stmts.upsertAlertSent.bind(
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

      // Шаг Б.4: Параллельная отправка агрегированных алертов одной волной
      const userEntries = Array.from(alertsByUser.entries());

      if (userEntries.length > 0 && env.TELEGRAM_BOT_TOKEN) {
        if (Date.now() - startTime <= MAX_WALL_CLOCK_MS) {
          const api = new Api(env.TELEGRAM_BOT_TOKEN);
          await Promise.allSettled(
            userEntries.map(async ([telegramId, alerts]) => {
              if (subrequestsUsed >= CONFIG.MAX_SUBREQUESTS_PER_CRON - 1) return;

              const combinedText = alerts
                .map((a) => a.alertText)
                .join("\n\n───────────────────\n\n");
              let keyboard: InlineKeyboard;

              if (alerts.length === 1) {
                const first = alerts[0]!;
                const lighterUrl =
                  first.item.network === "mainnet"
                    ? "https://app.lighter.xyz/"
                    : "https://rh.lighter.xyz/";
                keyboard = new InlineKeyboard()
                  .text("🔄 Обновить", `refresh:${first.item.network}:${first.item.account_index}`)
                  .url("🌐 Открыть биржу", lighterUrl)
                  .row()
                  .text("🔕 1ч", "pos_mute:3600")
                  .text("🔕 4ч", "pos_mute:14400")
                  .text("⏸ Выкл", "pos_mute:forever");
              } else {
                keyboard = new InlineKeyboard()
                  .text("📊 Мои позиции", "action_positions")
                  .url("🌐 Открыть биржу", "https://app.lighter.xyz/")
                  .row()
                  .text("🔕 1ч", "pos_mute:3600")
                  .text("🔕 4ч", "pos_mute:14400")
                  .text("⏸ Выкл", "pos_mute:forever");
              }

              try {
                await api.sendMessage(telegramId, combinedText, {
                  parse_mode: "HTML",
                  reply_markup: keyboard,
                });
                subrequestsUsed++;

                for (let k = 0; k < alerts.length; k++) {
                  const a = alerts[k]!;
                  alertsSentCount++;
                  allUpdates.push(
                    stmts.upsertAlertSent.bind(
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
        } else {
          console.warn("Cron wall-clock budget reached. Postponing remaining alert deliveries.");
        }
      }
    }

    // 5. Единая пакетная транзакция в D1 (кэш позиций + синхронизация + алерты + зомби + метрики)
    const durationMs = Date.now() - startTime;
    const executionMetrics = {
      event: "cron_completed",
      duration_ms: durationMs,
      subrequests_used: subrequestsUsed,
      round_robin_synced: roundRobinSyncedCount,
      total_positions_checked: items.length,
      candidates_count: candidateAlerts.length,
      jit_checks_performed: jitChecksDone,
      alerts_sent: alertsSentCount,
      spread_alerts_sent: spreadAlertsSent,
      zombies_cleaned: cleanedZombieKeys.size,
      timestamp: now,
    };

    allUpdates.push(stmts.saveMetrics.bind(JSON.stringify(executionMetrics), now));

    if (allUpdates.length > 0) {
      await executeD1BatchInChunks(env.DB, allUpdates);
    }

    // 6. СТРУКТУРИРОВАННЫЙ JSON-ЛОГ (Observability & Cloudflare Dashboard / Axiom)
    console.log(JSON.stringify(executionMetrics));

    // 7. ПИНГ HEALTHCHECK (гарантированная доставка до выхода из изолята)
    if (env.HEALTHCHECK_URL) {
      await pingHealthcheckSuccess(env.HEALTHCHECK_URL, executionMetrics);
    }
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    console.error("Cron monitor execution failed:", err);

    const errorMetrics = {
      event: "cron_failed",
      error: err?.message || String(err),
      stack: err?.stack,
      duration_ms: durationMs,
      subrequests_used: subrequestsUsed,
      timestamp: now,
    };

    // Запись ошибки в D1 bot_system_metrics для видимости в /stats
    try {
      await env.DB.prepare(`
        INSERT INTO bot_system_metrics (key, value_json, updated_at)
        VALUES ('last_cron_error', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
        .bind(JSON.stringify(errorMetrics), now)
        .run();
    } catch (dbErr) {
      console.error("Failed to persist cron error metric:", dbErr);
    }

    // Отправка сигнала ошибки на healthcheck (эндпоинт /fail с логами)
    if (env.HEALTHCHECK_URL) {
      await pingHealthcheckFail(env.HEALTHCHECK_URL, err, errorMetrics);
    }

    throw err;
  }
}
