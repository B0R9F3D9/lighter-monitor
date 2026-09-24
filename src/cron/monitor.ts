import { InlineKeyboard } from "grammy";
import { Env, LighterAccount, LighterNetwork, MarketPriceSnapshot } from "../types";
import { CONFIG } from "../config";
import { 
  getNextAccountForSync, 
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

export async function runCronMonitor(env: Env): Promise<void> {
  const bot = getBot(env);
  const now = Math.floor(Date.now() / 1000);
  const startTime = Date.now();
  const MAX_WALL_CLOCK_MS = 20_000; // 20 сек таймаут (Time-Budgeting)
  const MAX_JIT_CHECKS_PER_CRON = 15;

  let subrequestsUsed = 0;
  let jitChecksDone = 0;

  // 1. ФОНОВЫЙ ROUND-ROBIN (1 аккаунт за тик со спасением очереди при ошибках)
  const accountToSync = await getNextAccountForSync(env.DB);
  let syncedAccountData: LighterAccount | null = null;

  if (accountToSync) {
    syncedAccountData = await fetchLighterAccount(accountToSync.network, accountToSync.accountIndex);
    subrequestsUsed++;

    if (syncedAccountData) {
      await syncAccountOpenPositions(env.DB, accountToSync.network, accountToSync.accountIndex, syncedAccountData.positions);
      await batchUpdatePositionsCache(env.DB, [{
        network: accountToSync.network,
        account: syncedAccountData,
        cachedPositions: syncedAccountData.positions.map(analyzePositionRisk).filter(Boolean) as any
      }]);
    } else {
      // Спасение от зависания: проталкиваем очередь вперед даже при временном сбое API
      await touchFailedAccounts(env.DB, [accountToSync]);
    }
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

  // 4. In-Memory JIT-кэш: ПРЕДЗАПОЛНЯЕМ данными из Шага 1 (теплый кэш)
  const jitCache = new Map<string, LighterAccount | null>();
  if (accountToSync && syncedAccountData) {
    jitCache.set(`${accountToSync.network}:${accountToSync.accountIndex}`, syncedAccountData);
  }

  const newPositionsToInit: D1PreparedStatement[] = [];
  const alertUpdateStmts: D1PreparedStatement[] = [];
  let lastTelegramId = 0;

  for (const item of items) {
    // Защита по времени: если прошло более 20 секунд, прерываем цикл до следующей минуты
    if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
      console.warn("Cron wall-clock budget reached (20s). Postponing remaining checks.");
      break;
    }

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

    // Защита от шторма на рынке (лимит JIT проверок)
    if (jitChecksDone >= MAX_JIT_CHECKS_PER_CRON || subrequestsUsed >= CONFIG.MAX_SUBREQUESTS_PER_CRON - 5) {
      break;
    }

    // JIT-проверка с использованием теплого jitCache
    const cacheKey = `${item.network}:${item.account_index}`;
    let freshAccount = jitCache.get(cacheKey);

    if (freshAccount === undefined) {
      freshAccount = await fetchLighterAccount(item.network, item.account_index);
      subrequestsUsed++;
      jitChecksDone++;
      jitCache.set(cacheKey, freshAccount);
    }

    if (!freshAccount) continue;

    const livePosition = freshAccount.positions.find(
      p => p.market_id === item.market_id && Math.abs(parseFloat(p.position || "0")) > 0
    );

    // ЗОМБИ ЛИКВИДИРОВАН: удаление закрытой позиции для ВСЕХ подписчиков кошелька
    if (!livePosition) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM account_open_positions WHERE network = ? AND account_index = ? AND market_id = ?")
          .bind(item.network, item.account_index, item.market_id),
        env.DB.prepare("DELETE FROM user_token_alerts WHERE network = ? AND account_index = ? AND market_id = ?")
          .bind(item.network, item.account_index, item.market_id)
      ]);
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

    const keyboard = new InlineKeyboard()
      .text("🔄 Обновить позиции", `refresh:${item.network}:${item.account_index}`);

    try {
      if (subrequestsUsed < CONFIG.MAX_SUBREQUESTS_PER_CRON) {
        // Троттлинг Telegram: пауза 1 сек при последовательной отправке одному пользователю
        if (item.telegram_id === lastTelegramId) {
          await new Promise(r => setTimeout(r, 1000));
        }

        await bot.api.sendMessage(item.telegram_id, alertText, {
          parse_mode: "HTML",
          reply_markup: keyboard
        });
        subrequestsUsed++;
        lastTelegramId = item.telegram_id;

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

  // 5. Единая пакетная транзакция в D1
  const allUpdates = [...newPositionsToInit, ...alertUpdateStmts];
  if (allUpdates.length > 0) {
    await env.DB.batch(allUpdates);
  }
}
