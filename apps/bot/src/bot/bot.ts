import { Bot, InlineKeyboard, Keyboard } from "grammy";
import {
  Env,
  PositionRiskAnalysis,
  LighterNetwork,
  LIGHTER_NETWORKS,
  SpreadDirection,
  SPREAD_DIRECTIONS,
  SPREAD_UNITS,
  WIZARD_STEPS,
} from "../types";
import { CONFIG, getLighterAuthToken } from "../config";
import {
  fetchLighterAccountWithStatus,
  fetchInChunks,
  fetchExchangeStats,
  findMarketPrice,
} from "../lighter/api";
import {
  analyzePositionRisk,
  unpackPosition,
  formatPriceFine,
  computeSpreadBasis,
  parseSpreadThresholdInput,
  isMuted as checkIsMuted,
} from "../lighter/math";
import { MEMORY_PRICES, getMemoryPrice } from "../cache/memory";
import {
  batchUpdatePositionsCache,
  getUserThreshold,
  setUserThreshold,
  syncAccountOpenPositions,
  getUserSettings,
  setUserMute,
  getUserWizardState,
  setUserWizardState,
  updateAccountAlias,
  removeTrackedAccount,
  updateUserActivity,
  getSystemStats,
  getUserTrackedAccounts,
  getUserPositionsFullState,
  getAccountsPositionsCache,
  getUserAccountCardDetails,
  getUserSpreadTargets,
  getUserSpreadStats,
  addSpreadTarget,
  deleteSpreadTarget,
  toggleSpreadTargetActive,
  updateSpreadTarget,
  setSpreadTargetMute,
  setSpreadSymbolMute,
  setUserSpreadMute,
  getUserSpreadMute,
  setUserUpdatesMute,
  getUserUpdatesMute,
  setAllUserMutes,
  setUserTargetHitsThreshold,
  updateUserLastSeenVersion,
} from "../db/queries";
import {
  formatPositionsReport,
  formatSpreadHubView,
  getSpreadAlertKeyboard,
  formatTicksWord,
} from "./formatters";
import {
  formatReleaseNotification,
  getChangelogKeyboard,
  invalidateCompletedVersionCache,
} from "./release_notifier";
import { APP_VERSION, RELEASE_TITLE, RELEASE_HIGHLIGHTS } from "../version";
import { runInBackground } from "../utils/background";
import { invalidateActiveSymbolsCache } from "../cron/monitor";

let botInstance: Bot | null = null;
let currentEnv: Env | null = null;
const knownUsers = new Map<number, number>();

export function isUserAdmin(env: Env, userId?: number, username?: string): boolean {
  const rawAdmin = (env.ADMIN_TELEGRAM_ID || "").trim();
  if (!rawAdmin) {
    // Если переменная не задана в окружении, разрешаем доступ (для локальной разработки/тестов)
    return true;
  }

  const cleanUsername = username ? username.replace(/^@/, "").toLowerCase() : "";
  const userIdStr = userId ? String(userId) : "";

  // Поддерживаем список через запятую, очищаем кавычки и префиксы вида ADMIN_TELEGRAM_ID=
  const adminTokens = rawAdmin
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/^ADMIN_TELEGRAM_ID\s*=\s*/i, ""),
    )
    .filter(Boolean);

  for (const token of adminTokens) {
    const cleanToken = token.replace(/^@/, "").toLowerCase();
    if (userIdStr && token === userIdStr) return true;
    if (cleanUsername && cleanToken === cleanUsername) return true;
  }

  return false;
}

function getPositionsKeyboard(
  filterIndex?: number,
  filterNetwork?: LighterNetwork,
): InlineKeyboard {
  const refreshCb =
    filterIndex && filterNetwork
      ? `refresh:${filterNetwork}:${filterIndex}`
      : filterIndex
        ? `refresh_positions_${filterIndex}`
        : "refresh_positions";
  return new InlineKeyboard().text("🔄 Обновить", refreshCb);
}

export function formatAlertMuteStatus(mutedUntil: number, nowSec: number): string {
  if (mutedUntil <= nowSec) {
    return "🔔 Включены";
  }
  if (mutedUntil >= CONFIG.MUTE_FOREVER_TIMESTAMP) {
    return "⏸ Выключены (до включения)";
  }
  const remainingMinutes = Math.ceil((mutedUntil - nowSec) / 60);
  if (remainingMinutes >= 60) {
    const hours = Math.floor(remainingMinutes / 60);
    const mins = remainingMinutes % 60;
    return mins > 0 ? `🔕 Заглушены (еще ${hours}ч ${mins}м)` : `🔕 Заглушены (еще ${hours}ч)`;
  }
  return `🔕 Заглушены (еще ${remainingMinutes}м)`;
}

function formatThreshold(val: number): string {
  const str = Number(val.toFixed(4)).toString();
  return str.includes(".") ? str : `${str}.0`;
}

export function getStatsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🔄 Обновить", "refresh_stats");
}

export function getMainKeyboard(env?: Env, userId?: number, username?: string): Keyboard {
  const activeEnv = env || currentEnv;
  const isAdmin = activeEnv ? isUserAdmin(activeEnv, userId, username) : false;
  const kb = new Keyboard()
    .text("📊 Мои позиции")
    .text("📐 Мои таргеты")
    .row()
    .text("💼 Мои аккаунты")
    .text("⚙️ Настройки");

  if (isAdmin) {
    kb.row().text("📈 Админ статистика");
  }

  return kb.resized().persistent();
}

async function renderAdminDashboard(env: Env): Promise<string> {
  const stats = await getSystemStats(env.DB);
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Топ токенов по открытому интересу
  const tokenBreakdown =
    stats.topTokens.length > 0
      ? stats.topTokens
          .map((t) => {
            const notionalStr = t.notionalUsd ? ` ($${t.notionalUsd.toLocaleString("en-US")})` : "";
            return `  • <b>${t.symbol}:</b> ${t.count} поз.${notionalStr}`;
          })
          .join("\n") + "\n"
      : "  • <i>нет открытых сделок</i>\n";

  // 2. Дисбаланс Long / Short и системная дельта
  const longPercent =
    stats.totalOpenInterestUsd > 0
      ? Math.round((stats.longOiUsd / stats.totalOpenInterestUsd) * 100)
      : 50;
  const shortPercent = 100 - longPercent;
  const deltaSign = stats.netDeltaUsd >= 0 ? "+" : "";
  const deltaEmoji =
    stats.netDeltaUsd > 0
      ? "🟢 Long-heavy"
      : stats.netDeltaUsd < 0
        ? "🔴 Short-heavy"
        : "⚪️ Нейтральная";

  // 3. Риски ликвидации
  const r = stats.riskDistribution;
  let riskSummary = `  • Риски: 🟢 Safe: <b>${r.safe}</b> | 🟡 Warn: <b>${r.warning}</b> | 🟠 Danger: <b>${r.danger}</b> | 🔴 Crit: <b>${r.critical}</b>\n`;
  if (stats.closestLiquidation) {
    const cl = stats.closestLiquidation;
    const netBadge = cl.network === "rh" ? "🟠 RH" : "⚡️ Mainnet";
    riskSummary += `  • Ближайшая ликв: <b>${cl.symbol}</b> (${netBadge} #${cl.accountIndex}) — <b>${cl.distancePercent}%</b>\n`;
  }

  // 4. Таргеты спреда
  const sp = stats.spreadStats;
  let spreadTopStr = "";
  if (sp.topSymbols && sp.topSymbols.length > 0) {
    spreadTopStr = `  • Топ пар: ${sp.topSymbols.map((s) => `<b>${s.symbol}</b> (${s.count})`).join(", ")}\n`;
  }
  const hittingBadge =
    sp.hittingNowTargets > 0 ? ` <i>(⚠️ подтверждается: ${sp.hittingNowTargets})</i>` : "";

  // 5. Крон и надежность
  let cronSection = "";
  if (stats.cron24hStats) {
    const c24 = stats.cron24hStats;
    cronSection +=
      `⚡️ <b>Крон и аптайм (24ч):</b>\n` +
      `  • Аптайм: <b>${c24.uptimePercent}%</b> (${c24.totalRuns - c24.failedRuns}/${c24.totalRuns} тиков | сбоев: ${c24.failedRuns})\n` +
      `  • Скорость тика: ср. <b>${c24.avgDurationMs} мс</b> | макс. <b>${c24.maxDurationMs} мс</b>\n` +
      `  • Пик subrequests: <b>${c24.maxSubrequests} / 50</b> (запас ${Math.max(0, 50 - c24.maxSubrequests)})\n\n`;
  }

  if (stats.lastCron) {
    const c = stats.lastCron;
    const cronAgoSec = nowSec - c.timestamp;
    const cronAgoText =
      cronAgoSec < 60 ? `${cronAgoSec} сек назад` : `${Math.round(cronAgoSec / 60)} мин назад`;
    cronSection +=
      `⚙️ <b>Последний тик (${cronAgoText}):</b>\n` +
      `  • Длительность: <b>${c.duration_ms} мс</b> | Subrequests: <b>${c.subrequests_used} / 50</b>\n` +
      `  • Проверено поз: <b>${c.total_positions_checked}</b> (JIT: <b>${c.jit_checks_performed}</b>)\n` +
      `  • Алертов: <b>${c.alerts_sent}</b> | Спредов: <b>${c.spread_alerts_sent ?? 0}</b>\n\n`;
  }

  if (
    stats.lastCronError &&
    (!stats.lastCron || stats.lastCronError.timestamp >= stats.lastCron.timestamp)
  ) {
    const errAgoSec = nowSec - stats.lastCronError.timestamp;
    const errAgoText =
      errAgoSec < 60 ? `${errAgoSec} сек назад` : `${Math.round(errAgoSec / 60)} мин назад`;
    const safeErr = (stats.lastCronError.error || "Unknown error")
      .slice(0, 100)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    cronSection +=
      `⚠️ <b>Сбой в последнем тике (${errAgoText}):</b>\n` +
      `  • Ошибка: <code>${safeErr}</code>\n` +
      `  • Длительность: <b>${stats.lastCronError.duration_ms} мс</b>\n\n`;
  }

  const hasAuth = Boolean(
    env.LIGHTER_API_KEY || env.LIGHTER_API_KEY_MAINNET || env.LIGHTER_API_KEY_RH,
  );
  let authStatusText = "";
  if (hasAuth) {
    const parts: string[] = [];
    if (env.LIGHTER_API_KEY) parts.push("Global");
    if (env.LIGHTER_API_KEY_MAINNET) parts.push("Mainnet");
    if (env.LIGHTER_API_KEY_RH) parts.push("RH");
    authStatusText = `🟢 <b>Авторизован (${parts.join(", ")})</b> — <i>24,000+ req/min</i>`;
  } else {
    authStatusText = `⚪️ <b>Публичный IP-режим</b> — <i>60 req/min (без мастер-ключа)</i>`;
  }

  const heartbeatText = env.HEALTHCHECK_URL
    ? `🟢 <b>Подключен</b> <i>(Healthcheck Heartbeat)</i>`
    : `⚪️ <i>Не настроен (HEALTHCHECK_URL отсутствует)</i>`;

  const now = new Date();
  const timeStr = now.toLocaleTimeString("ru-RU", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const maxPosText =
    stats.maxPositionSizeUsd > 0
      ? `  • Сделки: ср. <b>$${Math.round(stats.avgPositionSizeUsd).toLocaleString("en-US")}</b> | макс. <b>$${Math.round(stats.maxPositionSizeUsd).toLocaleString("en-US")}</b>${stats.maxPositionSymbol ? ` (${stats.maxPositionSymbol})` : ""}\n`
      : "";

  return (
    `📈 <b>АДМИН-ПАНЕЛЬ LIGHTER MONITOR (v${APP_VERSION.replace(/^v/, "")})</b>\n\n` +
    `👥 <b>Пользователи и активность:</b>\n` +
    `  • Всего юзеров: <b>${stats.totalUsers}</b> (активных 24ч: <b>${stats.activeUsers24h}</b> | новых: <b>+${stats.users24h}</b>)\n` +
    `  • Счетов в базе: <b>${stats.totalTracked}</b> (🟠 RH: ${stats.trackedRh} | ⚡️ Mainnet: ${stats.trackedMainnet})\n` +
    `  • Счетов/юзер: <b>${stats.avgAccountsPerUser}</b> | На мьюте: <b>${stats.mutedUsersCount}</b>\n\n` +
    `💰 <b>Объем портфеля и риски:</b>\n` +
    `  • Совокупный залог: <b>$${stats.totalCollateralUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> (ср. <b>$${Math.round(stats.avgCollateralUsd).toLocaleString("en-US")}</b>)\n` +
    `  • Открытый интерес (OI): <b>$${stats.totalOpenInterestUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> | Плечо: <b>${stats.effectiveLeverage}x</b>\n` +
    `  • Баланс: 🟢 Long: <b>$${Math.round(stats.longOiUsd).toLocaleString("en-US")}</b> (${longPercent}%) | 🔴 Short: <b>$${Math.round(stats.shortOiUsd).toLocaleString("en-US")}</b> (${shortPercent}%)\n` +
    `  • Чистая дельта: <b>${deltaSign}$${Math.round(stats.netDeltaUsd).toLocaleString("en-US")}</b> <i>(${deltaEmoji})</i>\n` +
    `  • Позиций: <b>${stats.activePositionsCount}</b> (счетов в позициях: <b>${stats.activeAccountsCount}</b>)\n` +
    maxPosText +
    riskSummary +
    tokenBreakdown +
    `\n📐 <b>Таргеты спреда (Robinhood vs Core):</b>\n` +
    `  • Таргетов: <b>${sp.totalTargets}</b> (активных: <b>${sp.activeTargets}</b> | взведено: <b>${sp.armedTargets}</b>)${hittingBadge}\n` +
    `  • Направления: 🟢 RH &lt; Core: <b>${sp.rhCheaperCount}</b> | 🔵 RH &gt; Core: <b>${sp.rhExpensiveCount}</b>\n` +
    `  • Трейдеров в спредах: <b>${sp.uniqueUsersCount}</b> | Алертов за 24ч: <b>${sp.alertsSent24h}</b>\n` +
    spreadTopStr +
    `\n⏱ <b>Здоровье очереди и лаги кэша:</b>\n` +
    `  • Мин. лаг: <b>${stats.minQueueLagMinutes} мин.</b> | Ср. лаг: <b>${stats.avgQueueLagMinutes} мин.</b> | Макс: <b>${stats.maxQueueLagMinutes} мин.</b>\n\n` +
    `${cronSection}` +
    `🔑 <b>Статус API Lighter:</b>\n${authStatusText}\n\n` +
    `📡 <b>Heartbeat:</b> ${heartbeatText}\n\n` +
    `🕒 <i>Срез данных: ${timeStr} UTC</i>`
  );
}

export function getBot(env: Env): Bot {
  currentEnv = env;
  if (botInstance) return botInstance;

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const getMainKb = (ctx?: any) => getMainKeyboard(env, ctx?.from?.id, ctx?.from?.username);

  const liveSpreadCache = new Map<
    string,
    { rhPrice: number; corePrice: number; expiresAt: number }
  >();

  const getLiveSpreadQuote = async (
    symbol: string,
  ): Promise<{ rhPrice: number; corePrice: number } | null> => {
    const normSym = symbol.trim().toUpperCase();
    const now = Date.now();
    const cached = liveSpreadCache.get(normSym);
    if (cached && cached.expiresAt > now) {
      return { rhPrice: cached.rhPrice, corePrice: cached.corePrice };
    }

    const activeSet = new Set([normSym]);
    const [snapRh, snapMainnet] = await Promise.all([
      fetchExchangeStats(
        LIGHTER_NETWORKS.RH,
        activeSet,
        getLighterAuthToken(env, LIGHTER_NETWORKS.RH),
      ),
      fetchExchangeStats(
        LIGHTER_NETWORKS.MAINNET,
        activeSet,
        getLighterAuthToken(env, LIGHTER_NETWORKS.MAINNET),
      ),
    ]);
    const rhMarket = findMarketPrice(snapRh, normSym);
    const coreMarket = findMarketPrice(snapMainnet, normSym);

    const rhPrice = rhMarket?.price ?? getMemoryPrice(LIGHTER_NETWORKS.RH, normSym) ?? 0;
    const corePrice = coreMarket?.price ?? getMemoryPrice(LIGHTER_NETWORKS.MAINNET, normSym) ?? 0;

    if (rhPrice <= 0 || corePrice <= 0) {
      return null;
    }

    liveSpreadCache.set(normSym, { rhPrice, corePrice, expiresAt: now + 8000 });
    return { rhPrice, corePrice };
  };

  const showDirectionPicker = async (ctx: any, symbol: string, isEdit: boolean = false) => {
    const normSym = symbol.trim().toUpperCase();
    const stats = await getUserSpreadStats(env.DB, ctx.from!.id);
    const existingTargets = await getUserSpreadTargets(env.DB, ctx.from!.id);
    const isAlreadyTracking = existingTargets.some((t) => t.symbol === normSym);

    if (!isAlreadyTracking && stats.tokenCount >= CONFIG.MAX_SPREAD_TOKENS_PER_USER) {
      const warnText = `⚠️ Вы уже отслеживаете максимум <b>${CONFIG.MAX_SPREAD_TOKENS_PER_USER}</b> токенов. Удалите ненужные токены в меню спредов перед добавлением новых.`;
      const kb = new InlineKeyboard().text("« К спредам", "spread_menu");
      if (isEdit) {
        try {
          return await ctx.editMessageText(warnText, { parse_mode: "HTML", reply_markup: kb });
        } catch {}
      }
      return ctx.reply(warnText, { parse_mode: "HTML", reply_markup: kb });
    }

    if (stats.totalTargets >= CONFIG.MAX_SPREAD_TARGETS_PER_USER) {
      const warnText = `⚠️ Вы достигли лимита в <b>${CONFIG.MAX_SPREAD_TARGETS_PER_USER}</b> таргетов. Удалите старые таргеты перед добавлением новых.`;
      const kb = new InlineKeyboard().text("« К спредам", "spread_menu");
      if (isEdit) {
        try {
          return await ctx.editMessageText(warnText, { parse_mode: "HTML", reply_markup: kb });
        } catch {}
      }
      return ctx.reply(warnText, { parse_mode: "HTML", reply_markup: kb });
    }

    const quote = await getLiveSpreadQuote(normSym);
    if (!quote) {
      const errText =
        `⚠️ Инструмент <b>${normSym}</b> не найден или не торгуется одновременно на Robinhood Lighter и Lighter Core.\n\n` +
        `Проверьте тикер (например: <code>SPY</code>, <code>QQQ</code>, <code>XAU</code>, <code>NVDA</code>, <code>AAPL</code>):`;
      const kb = new InlineKeyboard()
        .text("SPY", "sp_sym:SPY")
        .text("QQQ", "sp_sym:QQQ")
        .text("XAU", "sp_sym:XAU")
        .row()
        .text("NVDA", "sp_sym:NVDA")
        .text("AAPL", "sp_sym:AAPL")
        .row()
        .text("❌ Отмена", "spread_menu");
      if (isEdit) {
        try {
          return await ctx.editMessageText(errText, { parse_mode: "HTML", reply_markup: kb });
        } catch {}
      }
      return ctx.reply(errText, { parse_mode: "HTML", reply_markup: kb });
    }

    const { basisUsd, basisBps } = computeSpreadBasis(quote.rhPrice, quote.corePrice);
    const sign = basisUsd >= 0 ? "+" : "-";

    const text =
      `🎯 <b>Настройка таргета спреда: ${normSym}</b>\n\n` +
      `• 🟠 RH Price: <b>$${formatPriceFine(quote.rhPrice)}</b>\n` +
      `• ⚡️ Core Price: <b>$${formatPriceFine(quote.corePrice)}</b>\n` +
      `• 📐 Текущий базис: <b>${sign}$${Math.abs(basisUsd).toFixed(3)}</b> (<code>${basisBps >= 0 ? "+" : ""}${basisBps.toFixed(2)} bps</code>)\n\n` +
      `Выберите условие для алерта:\n\n` +
      `🟢 <b>RH &lt; Core</b> (Robinhood дешевле Core)\n` +
      `🔵 <b>RH &gt; Core</b> (Robinhood дороже Core)`;

    const kb = new InlineKeyboard()
      .text("🟢 RH < Core", `sp_dir:${normSym}:${SPREAD_DIRECTIONS.RH_CHEAPER}`)
      .row()
      .text("🔵 RH > Core", `sp_dir:${normSym}:${SPREAD_DIRECTIONS.RH_EXPENSIVE}`)
      .row()
      .text("❌ Отмена", "spread_menu");

    if (isEdit) {
      try {
        return await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch {}
    }
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showPresetPicker = async (
    ctx: any,
    symbol: string,
    direction: SpreadDirection,
    isEdit: boolean = false,
    editTargetId?: number,
  ) => {
    const quote = await getLiveSpreadQuote(symbol);
    const refPrice =
      quote && quote.corePrice > 0
        ? quote.corePrice
        : getMemoryPrice(LIGHTER_NETWORKS.MAINNET, symbol) ||
          getMemoryPrice(LIGHTER_NETWORKS.RH, symbol) ||
          0;
    const dirLabel =
      direction === SPREAD_DIRECTIONS.RH_CHEAPER ? "🟢 RH &lt; Core" : "🔵 RH &gt; Core";

    let text = editTargetId
      ? `✏️ <b>Изменение таргета ${symbol}</b>\nУсловие: <b>${dirLabel}</b>\n\n`
      : `🎯 <b>Целевой спред для ${symbol}</b>\nУсловие: <b>${dirLabel}</b>\n\n`;

    if (quote) {
      const { basisUsd, basisBps } = computeSpreadBasis(quote.rhPrice, quote.corePrice);
      const sign = basisUsd >= 0 ? "+" : "-";
      text +=
        `• Текущая цена Core: <b>$${formatPriceFine(quote.corePrice)}</b>\n` +
        `• Текущий базис: <b>${sign}$${Math.abs(basisUsd).toFixed(3)}</b> (<code>${basisBps >= 0 ? "+" : ""}${basisBps.toFixed(2)} bps</code>)\n\n`;
    }

    text += `Выберите порог bps (в скобках расчет в $) или введите свой вариант:`;

    const kb = new InlineKeyboard();
    const presets = CONFIG.SPREAD_DEFAULT_BPS_PRESETS;
    const idSuffix = editTargetId ? `:${editTargetId}` : "";
    const dirSign = direction === SPREAD_DIRECTIONS.RH_CHEAPER ? "-" : "+";

    for (let i = 0; i < presets.length; i++) {
      const bps = presets[i]!;
      let btnLabel = `${bps} bps`;
      if (refPrice > 0) {
        const cents = (refPrice * bps) / 10000;
        const centsFormatted = cents >= 1 ? cents.toFixed(2) : cents.toFixed(3);
        btnLabel = `${bps} bps (${dirSign}$${centsFormatted})`;
      }
      kb.text(btnLabel, `sp_pr:${symbol}:${direction}:${bps}${idSuffix}`);
      if (i % 2 === 1) kb.row();
    }

    kb.row().text("✏️ Ввести свой ($ или bps)", `sp_custom:${symbol}:${direction}${idSuffix}`);

    if (editTargetId) {
      const otherDir: SpreadDirection =
        direction === SPREAD_DIRECTIONS.RH_CHEAPER
          ? SPREAD_DIRECTIONS.RH_EXPENSIVE
          : SPREAD_DIRECTIONS.RH_CHEAPER;
      const otherDirLabel =
        otherDir === SPREAD_DIRECTIONS.RH_CHEAPER ? "🟢 RH < Core" : "🔵 RH > Core";
      kb.row().text(`🔄 Условие: ${otherDirLabel}`, `sp_flip_dir:${editTargetId}:${otherDir}`);
      kb.row().text("« Назад к таргету", `sp_target:${editTargetId}`);
    } else {
      kb.row().text("« Назад", `sp_sym:${symbol}`).text("❌ Отмена", "spread_menu");
    }

    if (isEdit) {
      try {
        return await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch {}
    }
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  const handleSpreadMenu = async (ctx: any, isEdit: boolean = false) => {
    const telegramId = ctx.from!.id;
    const targets = await getUserSpreadTargets(env.DB, telegramId);
    const spreadMutedUntil = await getUserSpreadMute(env.DB, telegramId);
    const isMutedAll = checkIsMuted(spreadMutedUntil);
    const nowSec = Math.floor(Date.now() / 1000);

    const uniqueSymbols = Array.from(new Set(targets.map((t) => t.symbol)));
    const quotes = new Map<string, { rhPrice: number; corePrice: number }>();

    if (uniqueSymbols.length > 0) {
      const activeSet = new Set(uniqueSymbols);
      const [snapRh, snapMainnet] = await Promise.all([
        fetchExchangeStats(
          LIGHTER_NETWORKS.RH,
          activeSet,
          getLighterAuthToken(env, LIGHTER_NETWORKS.RH),
        ),
        fetchExchangeStats(
          LIGHTER_NETWORKS.MAINNET,
          activeSet,
          getLighterAuthToken(env, LIGHTER_NETWORKS.MAINNET),
        ),
      ]);
      for (const sym of uniqueSymbols) {
        const rhM = findMarketPrice(snapRh, sym);
        const coreM = findMarketPrice(snapMainnet, sym);
        const rhPrice = rhM?.price ?? getMemoryPrice(LIGHTER_NETWORKS.RH, sym) ?? 0;
        const corePrice = coreM?.price ?? getMemoryPrice(LIGHTER_NETWORKS.MAINNET, sym) ?? 0;
        if (rhPrice > 0 && corePrice > 0) {
          quotes.set(sym, { rhPrice, corePrice });
          liveSpreadCache.set(sym, { rhPrice, corePrice, expiresAt: Date.now() + 8000 });
        }
      }
    }

    const text = formatSpreadHubView(targets, quotes, isMutedAll, nowSec);
    const kb = new InlineKeyboard()
      .text("✏️ Изменить", "sp_manage")
      .text("🔄 Обновить", "spread_menu");

    if (isEdit) {
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch (err: any) {
        if (!err?.message?.includes("message is not modified")) {
          console.warn("[handleSpreadMenu] editMessageText error:", err?.message || err);
        }
      }
      return;
    }
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  const handleSpreadManage = async (ctx: any, isEdit: boolean = true) => {
    const telegramId = ctx.from!.id;
    const targets = await getUserSpreadTargets(env.DB, telegramId);
    const nowSec = Math.floor(Date.now() / 1000);

    const now = new Date(nowSec * 1000);
    const timeStr = now.toLocaleTimeString("ru-RU", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const kb = new InlineKeyboard();
    // Большая кнопка "+ Добавить"
    kb.text("➕ Добавить таргет", "sp_wiz_start").row();

    if (targets.length === 0) {
      const emptyText =
        `⚙️ <b>Управление таргетами</b>\n\n` +
        `У вас пока нет настроенных таргетов спреда.\n` +
        `Нажмите <b>➕ Добавить таргет</b> выше, чтобы создать первый.\n\n` +
        `🕒 <i>Обновлено: ${timeStr} UTC</i>`;
      kb.text("« Назад к просмотру", "spread_menu");

      if (isEdit) {
        try {
          return await ctx.editMessageText(emptyText, { parse_mode: "HTML", reply_markup: kb });
        } catch {}
      }
      return ctx.reply(emptyText, { parse_mode: "HTML", reply_markup: kb });
    }

    // Кнопки по каждому существующему таргету (как в Мои аккаунты)
    for (const t of targets) {
      const isCheaper = t.direction === SPREAD_DIRECTIONS.RH_CHEAPER;
      const dirIcon = isCheaper ? "🟢" : "🔵";
      const dirShort = isCheaper ? "RH < Core" : "RH > Core";
      const val =
        t.unit === SPREAD_UNITS.BPS
          ? `${t.target_delta.toFixed(1)} bps`
          : `$${t.target_delta.toFixed(2)}`;
      const statusIcon = t.is_active === 0 ? "⏸" : "✅";
      const label = `${t.symbol} ${dirIcon} ${dirShort} ≥${val} [${statusIcon}]`;
      kb.text(label, `sp_target:${t.id}`).row();
    }

    kb.text("« Назад к просмотру", "spread_menu");

    const text =
      `⚙️ <b>Управление таргетами (${targets.length}/${CONFIG.MAX_SPREAD_TARGETS_PER_USER}):</b>\n\n` +
      `Нажмите на таргет ниже для управления (пауза, удаление) или добавьте новый:\n\n` +
      `🕒 <i>Обновлено: ${timeStr} UTC</i>`;

    if (isEdit) {
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch (err: any) {
        if (!err?.message?.includes("message is not modified")) {
          console.warn("[handleSpreadManage] editMessageText error:", err?.message || err);
        }
      }
      return;
    }
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showSpreadTargetCard = async (ctx: any, targetId: number, isEdit: boolean = true) => {
    const telegramId = ctx.from!.id;
    const allTargets = await getUserSpreadTargets(env.DB, telegramId);
    const target = allTargets.find((t) => t.id === targetId);

    if (!target) {
      const notFoundText = `⚠️ Таргет не найден или уже удален.`;
      const kb = new InlineKeyboard().text("« Назад к списку", "sp_manage");
      if (isEdit) {
        try {
          return await ctx.editMessageText(notFoundText, { parse_mode: "HTML", reply_markup: kb });
        } catch {}
      }
      return ctx.reply(notFoundText, { parse_mode: "HTML", reply_markup: kb });
    }

    const quote = await getLiveSpreadQuote(target.symbol);
    const isCheaper = target.direction === SPREAD_DIRECTIONS.RH_CHEAPER;
    const dirLabel = isCheaper ? "🟢 RH &lt; Core" : "🔵 RH &gt; Core";
    const dirSign = isCheaper ? "-" : "+";
    const refPrice =
      quote && quote.corePrice > 0
        ? quote.corePrice
        : quote?.rhPrice ||
          getMemoryPrice(LIGHTER_NETWORKS.MAINNET, target.symbol) ||
          getMemoryPrice(LIGHTER_NETWORKS.RH, target.symbol) ||
          0;
    let targetVal = "";
    if (target.unit === SPREAD_UNITS.BPS) {
      if (refPrice > 0) {
        const cents = (refPrice * target.target_delta) / 10000;
        const centsFormatted = cents >= 1 ? cents.toFixed(2) : cents.toFixed(3);
        targetVal = `${target.target_delta.toFixed(1)} bps (${dirSign}$${centsFormatted})`;
      } else {
        targetVal = `${target.target_delta.toFixed(1)} bps`;
      }
    } else {
      if (refPrice > 0) {
        const bps = (target.target_delta / refPrice) * 10000;
        targetVal = `$${target.target_delta.toFixed(2)} (${dirSign}${bps.toFixed(1)} bps)`;
      } else {
        targetVal = `$${target.target_delta.toFixed(2)}`;
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const effectiveMutedUntil = Math.max(target.muted_until || 0, target.symbol_muted_until || 0);

    let statusBadge = "Активен (взведен)";
    if (target.is_active === 0) {
      statusBadge = "⏸ Выключен";
    } else if (effectiveMutedUntil > nowSec) {
      if (effectiveMutedUntil >= 2000000000) {
        statusBadge = "⏸ Выключен (в настройках / токен)";
      } else {
        const leftMin = Math.ceil((effectiveMutedUntil - nowSec) / 60);
        statusBadge = `🔕 Заглушен (еще ${leftMin}м)`;
      }
    } else if (target.armed === 0) {
      statusBadge = "⏳ Ждет отката";
    }

    let text =
      `🎯 <b>Таргет: ${target.symbol}</b>\n\n` +
      `• Инструмент: <b>${target.symbol}</b>\n` +
      `• Условие: <b>${dirLabel}</b> (<b>≥${targetVal}</b>)\n` +
      `• Статус: <b>${statusBadge}</b>\n`;

    if (quote) {
      const { basisUsd, basisBps } = computeSpreadBasis(quote.rhPrice, quote.corePrice);
      const sign = basisUsd >= 0 ? "+" : "-";
      text +=
        `\n• 🟠 RH Price: <b>$${formatPriceFine(quote.rhPrice)}</b>\n` +
        `• ⚡️ Core Price: <b>$${formatPriceFine(quote.corePrice)}</b>\n` +
        `• 📐 Текущий базис: <b>${sign}$${Math.abs(basisUsd).toFixed(3)}</b> (<code>${basisBps >= 0 ? "+" : ""}${basisBps.toFixed(2)} bps</code>)\n`;
    }

    const kb = new InlineKeyboard();
    const toggleLabel = target.is_active === 1 ? "⏸ Приостановить" : "▶️ Включить";
    kb.text(toggleLabel, `sp_tog:${target.id}`)
      .text(`➕ Еще для ${target.symbol}`, `sp_sym:${target.symbol}`)
      .row();

    if (effectiveMutedUntil > nowSec) {
      kb.text(
        `🔔 Размьютить ${target.symbol}`,
        `sp_sym_unmute_card:${target.symbol}:${target.id}`,
      ).row();
    }

    kb.text("✏️ Изменить", `sp_edit:${target.id}`)
      .text("🗑 Удалить", `sp_del:${target.id}`)
      .row()
      .text("« Назад к списку таргетов", "sp_manage");

    if (isEdit) {
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch (err: any) {
        if (!err?.message?.includes("message is not modified")) {
          console.warn("[showSpreadTargetCard] editMessageText error:", err?.message || err);
        }
      }
      return;
    }
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  bot.catch((err) => {
    console.error("Unhandled error in bot handler:", err.error || err);
  });

  // Пропуск входящих событий Telegram без оверхеда на трейсинг
  bot.use(async (_ctx, next) => {
    await next();
  });

  // Сохранение пользователя в БД и троттлинг обновления last_active_at (не чаще раза в 5 минут)
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      const userId = ctx.from.id;
      const now = Math.floor(Date.now() / 1000);
      const lastRecorded = knownUsers.get(userId);
      if (lastRecorded === undefined) {
        knownUsers.set(userId, now);
        runInBackground(
          env.DB.prepare(`
            INSERT INTO users (telegram_id, username, first_name, created_at, last_seen_version, last_active_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET
              username = excluded.username,
              first_name = excluded.first_name,
              last_seen_version = COALESCE(users.last_seen_version, excluded.last_seen_version),
              last_active_at = excluded.last_active_at
          `)
            .bind(
              userId,
              ctx.from.username || null,
              ctx.from.first_name || null,
              now,
              APP_VERSION,
              now,
            )
            .run(),
        );
      } else if (now - lastRecorded >= 300) {
        knownUsers.set(userId, now);
        runInBackground(updateUserActivity(env.DB, userId));
      }
    }
    return next();
  });

  // /start
  bot.command("start", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, null);

    const countRes = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_tracked_accounts WHERE telegram_id = ?",
    )
      .bind(ctx.from!.id)
      .first<{ cnt: number }>();

    if (!countRes || countRes.cnt === 0) {
      const welcomeText =
        `👋 <b>Добро пожаловать в Lighter Monitor!</b>\n\n` +
        `Бот в реальном времени мониторит ваши позиции на <b>Robinhood Lighter</b> и <b>Lighter Mainnet</b>, ` +
        `рассчитывает риски ликвидации и присылает сигналы при импульсах цены.\n\n` +
        `Подключите ваш первый аккаунт для мониторинга:`;
      const kb = new InlineKeyboard();
      const webAppUrl = (currentEnv?.WEBAPP_URL || env.WEBAPP_URL)?.trim().replace(/\/$/, "");
      if (webAppUrl && webAppUrl.startsWith("https://")) {
        kb.webApp("🚀 Открыть Web App", webAppUrl).row();
      }
      kb.text("➕ Подключить аккаунт", "wizard_start_add");
      await ctx.reply(welcomeText, { parse_mode: "HTML", reply_markup: getMainKb(ctx) });
      return ctx.reply("Нажмите кнопку ниже, чтобы начать:", { reply_markup: kb });
    }

    await ctx.reply(
      `👋 <b>С возвращением в Lighter Monitor!</b>\n\n` +
        `Используйте кнопки меню ниже для управления аккаунтами, позициями и таргетами спреда.`,
      { parse_mode: "HTML", reply_markup: getMainKb(ctx) },
    );
  });

  // ==========================================
  // ВИЗАРД ДОБАВЛЕНИЯ АККАУНТА (ПОШАГОВЫЙ)
  // ==========================================

  const startAddWizard = async (ctx: any, isEdit: boolean = false) => {
    await setUserWizardState(env.DB, ctx.from!.id, null);

    const countRes = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_tracked_accounts WHERE telegram_id = ?",
    )
      .bind(ctx.from!.id)
      .first<{ cnt: number }>();

    if (countRes && countRes.cnt >= CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER) {
      const msg = `⚠️ Достигнут лимит: нельзя отслеживать более ${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER} аккаунтов.`;
      if (isEdit) {
        return ctx
          .editMessageText(msg, {
            reply_markup: new InlineKeyboard().text("💼 Мои аккаунты", "action_list"),
          })
          .catch(() => {});
      }
      return ctx.reply(msg, { reply_markup: getMainKb(ctx) });
    }

    const text = `➕ <b>Подключение аккаунта Lighter</b>\n\nВыберите сеть биржи для подключения:`;
    const kb = new InlineKeyboard()
      .text("🟠 Robinhood Lighter", `wizard_net:${LIGHTER_NETWORKS.RH}`)
      .row()
      .text("⚡️ Lighter Mainnet", `wizard_net:${LIGHTER_NETWORKS.MAINNET}`)
      .row()
      .text("❌ Отмена", "wizard_cancel");

    if (isEdit) {
      try {
        return await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch {}
    }
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  bot.callbackQuery("wizard_start_add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startAddWizard(ctx, true);
  });

  bot.callbackQuery(/^wizard_net:(rh|mainnet)$/, async (ctx) => {
    const network = ctx.match[1] as LighterNetwork;
    const netConfig = CONFIG.NETWORKS[network];
    await setUserWizardState(env.DB, ctx.from!.id, {
      step: WIZARD_STEPS.AWAIT_INDEX,
      network,
    });
    await ctx.answerCallbackQuery();

    const exampleIdx = network === LIGHTER_NETWORKS.RH ? "31704" : "749329";
    const text =
      `➕ <b>Подключение ${netConfig.name}</b> <code>${netConfig.badge}</code>\n\n` +
      `Отправьте в чат числовой индекс аккаунта (например: <code>${exampleIdx}</code>):`;
    const kb = new InlineKeyboard().text("❌ Отмена", "wizard_cancel");

    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }
  });

  bot.callbackQuery("wizard_cancel", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, null);
    await ctx.answerCallbackQuery({ text: "Отменено" });
    try {
      await ctx.editMessageText("❌ Действие отменено.", {
        reply_markup: new InlineKeyboard().text("💼 Мои аккаунты", "action_list"),
      });
    } catch {
      await ctx.reply("❌ Действие отменено.", { reply_markup: getMainKb(ctx) });
    }
  });

  const completeAccountCreation = async (ctx: any, state: any, alias: string | null) => {
    const netConfig = CONFIG.NETWORKS[state.network as LighterNetwork];
    const now = Math.floor(Date.now() / 1000);

    try {
      await env.DB.prepare(`
        INSERT INTO user_tracked_accounts (telegram_id, network, account_index, alias, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
        .bind(ctx.from!.id, state.network, state.accountIndex, alias, now)
        .run();
      invalidateActiveSymbolsCache();

      const activePositions = (state.positions || []).filter(
        (p: any) => Math.abs(parseFloat(p.position || p.size || "0")) > 0,
      );
      const risks = activePositions.map(analyzePositionRisk).filter(Boolean);
      await batchUpdatePositionsCache(env.DB, [
        {
          network: state.network,
          account: {
            index: state.accountIndex,
            l1_address: state.l1Address,
            collateral: String(state.collateral),
            available_balance: "0",
            total_asset_value: "0",
            positions: state.positions || [],
          } as any,
          cachedPositions: risks as any,
        },
      ]);
      await syncAccountOpenPositions(
        env.DB,
        state.network,
        state.accountIndex,
        state.positions || [],
      );
    } catch (e: any) {
      if (!e?.message?.includes("UNIQUE")) throw e;
    }

    await setUserWizardState(env.DB, ctx.from!.id, null);

    const postKb = new InlineKeyboard()
      .text("📊 Мои позиции", "action_positions")
      .row()
      .text("💼 Мои аккаунты", "action_list");

    await ctx.reply(
      `🎉 Аккаунт <b>#${state.accountIndex}</b> <code>${netConfig.badge}</code> успешно подключен!\n` +
        `🏷 Имя: ${alias ? `<b>${alias}</b>` : "<i>нет</i>"}\n` +
        `💳 Адрес: <code>${state.l1Address}</code>\n` +
        `💰 Залог: <b>$${Number(state.collateral).toFixed(2)}</b>\n\n` +
        `Мониторинг активен. Проверка рисков выполняется каждую минуту.`,
      { parse_mode: "HTML", reply_markup: postKb },
    );
  };

  bot.callbackQuery("wizard_skip_alias", async (ctx) => {
    const state = await getUserWizardState(env.DB, ctx.from!.id);
    if (!state || state.step !== WIZARD_STEPS.AWAIT_ALIAS) {
      return ctx.answerCallbackQuery({ text: "Сессия истекла" });
    }
    await ctx.answerCallbackQuery();
    await completeAccountCreation(ctx, state, null);
  });

  // ==========================================
  // ТЕКСТОВЫЙ ОБРАБОТЧИК (ВИЗАРД И ДИАЛОГИ)
  // ==========================================
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();

    // Не перехватываем команды со слэшем и кнопки Reply-клавиатуры
    if (
      text.startsWith("/") ||
      [
        "📊 Мои позиции",
        "Мои позиции",
        "📊 Мои сделки",
        "Мои сделки",
        "📐 Мои таргеты",
        "Мои таргеты",
        "📈 Таргеты спреда",
        "Таргеты спреда",
        "💼 Мои аккаунты",
        "Мои аккаунты",
        "💼 Мои кошельки",
        "Мои кошельки",
        "➕ Добавить кошелек",
        "➕ Добавить аккаунт",
        "Добавить кошелек",
        "Добавить аккаунт",
        "⚙️ Настройки",
        "Настройки",
        "📈 Админ статистика",
        "Админ статистика",
      ].includes(text)
    ) {
      await setUserWizardState(env.DB, ctx.from!.id, null);
      return next();
    }

    const state = await getUserWizardState(env.DB, ctx.from!.id);
    if (!state) return next();

    // 1. Шаг ввода индекса
    if (state.step === WIZARD_STEPS.AWAIT_INDEX) {
      const netConfig = CONFIG.NETWORKS[state.network];
      if (!/^\d+$/.test(text)) {
        return ctx.reply(
          `⚠️ Пожалуйста, отправьте только числовой индекс аккаунта (например: <code>${state.network === LIGHTER_NETWORKS.RH ? "31704" : "749329"}</code>):`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("❌ Отмена", "wizard_cancel"),
          },
        );
      }
      const accountIndex = parseInt(text, 10);

      const exists = await env.DB.prepare(
        "SELECT 1 FROM user_tracked_accounts WHERE telegram_id = ? AND network = ? AND account_index = ?",
      )
        .bind(ctx.from!.id, state.network, accountIndex)
        .first();

      if (exists) {
        await setUserWizardState(env.DB, ctx.from!.id, null);
        return ctx.reply(`Вы уже отслеживаете аккаунт #${accountIndex} в сети ${netConfig.name}.`, {
          reply_markup: getMainKb(ctx),
        });
      }

      await ctx.reply(`🔍 Проверяем аккаунт #${accountIndex} в ${netConfig.name}...`);
      const authToken = getLighterAuthToken(currentEnv || env, state.network);
      const result = await fetchLighterAccountWithStatus(
        state.network,
        accountIndex,
        false,
        authToken,
      );

      if (result.status === "RATE_LIMIT") {
        return ctx.reply(
          `⚠️ Биржа ${netConfig.name} временно перегружена запросами. Попробуйте через 30 секунд.`,
          { reply_markup: new InlineKeyboard().text("❌ Отмена", "wizard_cancel") },
        );
      }

      if (!result.account) {
        const explorerLink =
          state.network === LIGHTER_NETWORKS.MAINNET
            ? `\nПроверьте индекс: https://app.lighter.xyz/explorer/accounts/${accountIndex}`
            : "";
        return ctx.reply(
          `⚠️ Аккаунт #${accountIndex} не найден в сети ${netConfig.name}.${explorerLink}\n\nПроверьте цифры и попробуйте снова:`,
          { reply_markup: new InlineKeyboard().text("❌ Отмена", "wizard_cancel") },
        );
      }

      const acc = result.account;
      const shortAddr = acc.l1_address
        ? `${acc.l1_address.slice(0, 6)}...${acc.l1_address.slice(-4)}`
        : "—";
      const collateral = parseFloat(acc.collateral || "0");

      await setUserWizardState(env.DB, ctx.from!.id, {
        step: WIZARD_STEPS.AWAIT_ALIAS,
        network: state.network,
        accountIndex,
        l1Address: acc.l1_address,
        collateral,
        positions: acc.positions || [],
      });

      const kb = new InlineKeyboard()
        .text("⏩ Пропустить имя", "wizard_skip_alias")
        .row()
        .text("❌ Отмена", "wizard_cancel");

      return ctx.reply(
        `✅ <b>Аккаунт #${accountIndex} найден!</b>\n` +
          `💳 Адрес: <code>${shortAddr}</code>\n` +
          `💰 Залог: <b>$${collateral.toFixed(2)}</b>\n\n` +
          `Теперь отправьте понятное имя (алиас), например: <b>Мейн</b> или <b>Хедж</b>:`,
        { parse_mode: "HTML", reply_markup: kb },
      );
    }

    // 2. Шаг ввода алиаса
    if (state.step === WIZARD_STEPS.AWAIT_ALIAS) {
      const alias = text.slice(0, 32);
      await completeAccountCreation(ctx, state, alias);
      return;
    }

    // 3. Шаг переименования
    if (state.step === WIZARD_STEPS.AWAIT_RENAME) {
      const newAlias = text.slice(0, 32);
      await updateAccountAlias(env.DB, ctx.from!.id, state.network, state.accountIndex, newAlias);
      await setUserWizardState(env.DB, ctx.from!.id, null);
      await ctx.reply(`✅ Имя аккаунта #${state.accountIndex} изменено на <b>${newAlias}</b>.`, {
        parse_mode: "HTML",
        reply_markup: getMainKb(ctx),
      });
      await showAccountCard(ctx, state.network, state.accountIndex, false);
      return;
    }

    // 4. Шаг ввода процента для алертов
    if (state.step === WIZARD_STEPS.AWAIT_THRESHOLD) {
      const cleaned = text.replace(",", ".");
      const val = parseFloat(cleaned);
      if (isNaN(val) || val < CONFIG.MIN_ALERT_THRESHOLD || val > CONFIG.MAX_ALERT_THRESHOLD) {
        return ctx.reply(
          `⚠️ Пожалуйста, укажите число от <b>${CONFIG.MIN_ALERT_THRESHOLD}%</b> до <b>${CONFIG.MAX_ALERT_THRESHOLD}%</b> (например: <code>0.4</code>):`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("❌ Отмена", "action_threshold"),
          },
        );
      }
      await setUserThreshold(env.DB, ctx.from!.id, val);
      await setUserWizardState(env.DB, ctx.from!.id, null);
      await ctx.reply(`✅ Шаг цены для алертов установлен на <b>${formatThreshold(val)}%</b>.`, {
        parse_mode: "HTML",
        reply_markup: getMainKb(ctx),
      });
      await handleSettingsSpikes(ctx);
      return;
    }

    // 4b. Шаг ввода порога подтверждения тиков для таргетов спреда
    if (state.step === WIZARD_STEPS.AWAIT_TARGET_HITS) {
      const val = parseInt(text.trim(), 10);
      if (isNaN(val) || val < 1 || val > 60) {
        return ctx.reply(
          `⚠️ Пожалуйста, укажите целое число от <b>1</b> до <b>60</b> (например: <code>1</code>, <code>2</code>, <code>3</code> или <code>5</code>):\n\n` +
            `<i>⏱ Крон запускается <b>раз в минуту</b>. Каждое совпадение — это 1 минута стабильного удержания спреда.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("❌ Отмена", "cfg_targets"),
          },
        );
      }
      await setUserTargetHitsThreshold(env.DB, ctx.from!.id, val);
      await setUserWizardState(env.DB, ctx.from!.id, null);
      await ctx.reply(
        `✅ Порог подтверждения таргетов установлен на <b>${val}</b> ${formatTicksWord(val)} (~${val} мин удержания).\n\n` +
          `<i>⏱ Крон запускается <b>раз в минуту</b>.</i>`,
        {
          parse_mode: "HTML",
          reply_markup: getMainKb(ctx),
        },
      );
      await handleSettingsTargets(ctx);
      return;
    }

    // 5. Шаг ввода тикера спреда
    if (state.step === WIZARD_STEPS.SPREAD_AWAIT_SYMBOL) {
      const symbol = text.trim().toUpperCase();
      await setUserWizardState(env.DB, ctx.from!.id, null);
      await showDirectionPicker(ctx, symbol, false);
      return;
    }

    // 6. Шаг ввода дельты спреда (в долларах или bps)
    if (state.step === WIZARD_STEPS.SPREAD_AWAIT_DELTA) {
      const parsed = parseSpreadThresholdInput(text, state.corePrice);
      if (!parsed) {
        const cancelCb = state.editTargetId ? `sp_target:${state.editTargetId}` : "sp_manage";
        return ctx.reply(
          `⚠️ Не удалось распознать порог. Пожалуйста, укажите число в долларах (например: <code>0.15</code> или <code>$0.15</code>) или в bps (например: <code>5bps</code> или <code>0.05%</code>):`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("❌ Отмена", cancelCb),
          },
        );
      }

      let initialArmed = 1;
      if (state.corePrice > 0 && state.rhPrice > 0) {
        const { basisUsd, basisBps } = computeSpreadBasis(state.rhPrice, state.corePrice);
        const actualDiffUsd =
          state.direction === SPREAD_DIRECTIONS.RH_CHEAPER ? -basisUsd : basisUsd;
        const actualDiffBps =
          state.direction === SPREAD_DIRECTIONS.RH_CHEAPER ? -basisBps : basisBps;
        const currentMetric = parsed.unit === SPREAD_UNITS.BPS ? actualDiffBps : actualDiffUsd;
        if (currentMetric >= parsed.value) {
          initialArmed = 0;
        }
      }

      const isEditing = Boolean(state.editTargetId);
      const editTargetId = state.editTargetId;

      if (editTargetId) {
        await updateSpreadTarget(
          env.DB,
          ctx.from!.id,
          editTargetId,
          state.direction,
          parsed.value,
          parsed.unit,
          initialArmed,
        );
      } else {
        await addSpreadTarget(
          env.DB,
          ctx.from!.id,
          state.symbol,
          state.direction,
          parsed.value,
          parsed.unit,
          initialArmed,
        );
      }
      invalidateActiveSymbolsCache();
      await setUserWizardState(env.DB, ctx.from!.id, null);

      const dirLabel =
        state.direction === SPREAD_DIRECTIONS.RH_CHEAPER ? "🟢 RH &lt; Core" : "🔵 RH &gt; Core";
      const dirSign = state.direction === SPREAD_DIRECTIONS.RH_CHEAPER ? "-" : "+";
      let targetStr = parsed.unit === SPREAD_UNITS.BPS ? `${parsed.value} bps` : `$${parsed.value}`;
      if (parsed.unit === SPREAD_UNITS.BPS && state.corePrice > 0) {
        const cents = (state.corePrice * parsed.value) / 10000;
        const centsFormatted = cents >= 1 ? cents.toFixed(2) : cents.toFixed(3);
        targetStr = `${parsed.value} bps (${dirSign}$${centsFormatted})`;
      } else if (parsed.unit === SPREAD_UNITS.USD && state.corePrice > 0) {
        const bps = (parsed.value / state.corePrice) * 10000;
        targetStr = `$${parsed.value} (${dirSign}${bps.toFixed(1)} bps)`;
      }

      let confirmText = isEditing
        ? `✅ <b>Таргет спреда успешно изменен!</b>\n\n`
        : `✅ <b>Таргет спреда успешно добавлен!</b>\n\n`;
      confirmText +=
        `• Инструмент: <b>${state.symbol}</b>\n` +
        `• Условие: <b>${dirLabel}</b>\n` +
        `• Целевой спред: <b>${targetStr}</b>\n`;

      if (initialArmed === 0) {
        confirmText += `\n⚠️ <i>Текущий спред уже достиг цели. Таргет взведется автоматически при откате ниже 80% порога.</i>`;
      } else {
        confirmText += `• Статус: <b>Взведен и активен</b>`;
      }

      const kb = new InlineKeyboard();
      if (isEditing && editTargetId) {
        kb.text(`🎯 К таргету`, `sp_target:${editTargetId}`).row();
      } else {
        kb.text(`➕ Еще таргет для ${state.symbol}`, `sp_sym:${state.symbol}`).row();
      }
      kb.text(`📐 Мои таргеты`, "spread_menu");

      return ctx.reply(confirmText, { parse_mode: "HTML", reply_markup: kb });
    }

    return next();
  });

  // ==========================================
  // ИНТЕРАКТИВНОЕ УПРАВЛЕНИЕ АККАУНТАМИ
  // ==========================================

  const showAccountCard = async (
    ctx: any,
    network: LighterNetwork,
    accountIndex: number,
    isEdit: boolean = true,
  ) => {
    const cardData = await getUserAccountCardDetails(env.DB, ctx.from!.id, network, accountIndex);

    if (!cardData) {
      const notFoundMsg = `Аккаунт #${accountIndex} не найден среди ваших отслеживаемых.`;
      if (isEdit) {
        return ctx
          .editMessageText(notFoundMsg, {
            reply_markup: new InlineKeyboard().text("💼 Мои аккаунты", "action_list"),
          })
          .catch(() => {});
      }
      return ctx.reply(notFoundMsg, { reply_markup: getMainKb(ctx) });
    }

    const netConfig = CONFIG.NETWORKS[network];
    const shortAddr = cardData.l1_address
      ? `${cardData.l1_address.slice(0, 6)}...${cardData.l1_address.slice(-4)}`
      : "—";
    const collateral = parseFloat(String(cardData.collateral || 0));

    let positionsCount = 0;
    let symbolsSummary = "";
    if (cardData.positions_json) {
      try {
        const parsed = JSON.parse(cardData.positions_json) as any[];
        const active = parsed.filter((p) => {
          if (Array.isArray(p)) return Number(p[4]) > 0;
          return Math.abs(parseFloat(p.position || p.size || "0")) > 0;
        });
        positionsCount = active.length;
        if (positionsCount > 0) {
          const syms = active.map((p) => (Array.isArray(p) ? p[1] : p.symbol)).filter(Boolean);
          symbolsSummary = ` (${syms.join(", ")})`;
        }
      } catch {}
    }

    const card =
      `💼 <b>Управление аккаунтом #${accountIndex}</b> <code>${netConfig.badge}</code>\n\n` +
      `🏷 <b>Имя:</b> ${cardData.alias ? `<b>${cardData.alias}</b>` : "<i>не задано</i>"}\n` +
      `💳 <b>Адрес:</b> <code>${shortAddr}</code>\n` +
      `💰 <b>Залог:</b> $${collateral.toFixed(2)}\n` +
      `📊 <b>Открытых позиций:</b> ${positionsCount}${symbolsSummary}\n`;

    const kb = new InlineKeyboard()
      .text("📊 Позиции", `refresh:${network}:${accountIndex}`)
      .text("✏️ Сменить имя", `rename_acc:${network}:${accountIndex}`)
      .row()
      .text("🗑 Удалить из бота", `confirm_del_acc:${network}:${accountIndex}`)
      .row()
      .text("⬅️ К списку аккаунтов", "action_list");

    if (isEdit) {
      try {
        return await ctx.editMessageText(card, { parse_mode: "HTML", reply_markup: kb });
      } catch {}
    }
    await ctx.reply(card, { parse_mode: "HTML", reply_markup: kb });
  };

  bot.callbackQuery(/^manage_acc:([a-z0-9_-]+):(\d+)$/, async (ctx) => {
    const network = ctx.match[1] as LighterNetwork;
    const accountIndex = parseInt(ctx.match[2]!, 10);
    await ctx.answerCallbackQuery();
    await showAccountCard(ctx, network, accountIndex, true);
  });

  bot.callbackQuery(/^rename_acc:([a-z0-9_-]+):(\d+)$/, async (ctx) => {
    const network = ctx.match[1] as LighterNetwork;
    const accountIndex = parseInt(ctx.match[2]!, 10);
    await setUserWizardState(env.DB, ctx.from!.id, {
      step: WIZARD_STEPS.AWAIT_RENAME,
      network,
      accountIndex,
    });
    await ctx.answerCallbackQuery();
    const netConfig = CONFIG.NETWORKS[network];
    const kb = new InlineKeyboard().text("❌ Отмена", `manage_acc:${network}:${accountIndex}`);
    await ctx.editMessageText(
      `✏️ Отправьте в чат новое имя (алиас) для аккаунта <b>#${accountIndex}</b> <code>${netConfig.badge}</code>:\n\n` +
        `<i>(например: <b>Основной</b> или <b>Хедж</b>)</i>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^confirm_del_acc:([a-z0-9_-]+):(\d+)$/, async (ctx) => {
    const network = ctx.match[1] as LighterNetwork;
    const accountIndex = parseInt(ctx.match[2]!, 10);
    await ctx.answerCallbackQuery();
    const netConfig = CONFIG.NETWORKS[network];
    const kb = new InlineKeyboard()
      .text("🗑 Да, удалить", `del_acc:${network}:${accountIndex}`)
      .text("❌ Отмена", `manage_acc:${network}:${accountIndex}`);

    await ctx.editMessageText(
      `⚠️ Вы уверены, что хотите удалить аккаунт <b>#${accountIndex}</b> <code>${netConfig.badge}</code> из отслеживания?`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^del_acc:([a-z0-9_-]+):(\d+)$/, async (ctx) => {
    const network = ctx.match[1] as LighterNetwork;
    const accountIndex = parseInt(ctx.match[2]!, 10);
    await removeTrackedAccount(env.DB, ctx.from!.id, network, accountIndex);
    await ctx.answerCallbackQuery({ text: `Аккаунт #${accountIndex} удален` });
    await handleList(ctx, true);
  });

  // Функция вывода списка аккаунтов /accounts
  const handleList = async (ctx: any, isEdit: boolean = false) => {
    try {
      const results = await getUserTrackedAccounts(env.DB, ctx.from!.id);

      if (!results || results.length === 0) {
        const emptyText =
          `👋 <b>Добро пожаловать в Lighter Monitor!</b>\n\n` +
          `Бот отслеживает ваши позиции на <b>Robinhood Lighter</b> и <b>Lighter Mainnet</b>, ` +
          `рассчитывает риски и защищает от ликвидации.\n\n` +
          `У вас пока нет подключенных аккаунтов. Давайте подключим первый:`;
        const emptyKb = new InlineKeyboard().text("➕ Подключить аккаунт", "wizard_start_add");

        if (isEdit) {
          return ctx
            .editMessageText(emptyText, { parse_mode: "HTML", reply_markup: emptyKb })
            .catch(() => {});
        }
        return ctx.reply(emptyText, { parse_mode: "HTML", reply_markup: emptyKb });
      }

      const kb = new InlineKeyboard();
      for (const r of results) {
        const netIcon = r.network === LIGHTER_NETWORKS.RH ? "🟠" : "⚡️";
        const aliasStr = r.alias ? ` (${r.alias})` : "";
        const label = `${netIcon} #${r.account_index}${aliasStr}`;
        kb.text(label, `manage_acc:${r.network}:${r.account_index}`).row();
      }
      kb.text("➕ Добавить аккаунт", "wizard_start_add").text("🔄 Обновить", "refresh_list");

      const now = new Date();
      const timeStr = now.toLocaleTimeString("ru-RU", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const msg =
        `📋 <b>Ваши отслеживаемые аккаунты (${results.length}/${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER}):</b>\n\n` +
        `Нажмите на аккаунт для управления:\n\n` +
        `🕒 <i>Обновлено: ${timeStr} UTC</i>`;

      if (isEdit) {
        try {
          await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: kb });
        } catch (err: any) {
          if (!err?.message?.includes("message is not modified")) {
            await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
          }
        }
      } else {
        await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
      }
    } catch (err) {
      console.error("[handleList] Error:", err);
    }
  };

  bot.command("accounts", (ctx) => handleList(ctx));

  bot.callbackQuery("refresh_list", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "🔄 Обновляем..." });
    await handleList(ctx, true);
  });
  bot.callbackQuery("action_list", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleList(ctx, true);
  });

  // ==========================================
  // ВЫВОД ПОЗИЦИЙ (/positions) С ХЕДЖ-ИТОГОМ
  // ==========================================

  const handlePositions = async (
    ctx: any,
    filterIndex?: number,
    forceRefresh: boolean = false,
    isEdit: boolean = false,
    filterNetwork?: LighterNetwork,
  ) => {
    try {
      const { rows: userFullRows, userThreshold: preloadedThreshold } =
        await getUserPositionsFullState(env.DB, ctx.from!.id, filterIndex, filterNetwork);

      let trackedList: Array<{
        network: LighterNetwork;
        account_index: number;
        alias: string | null;
      }> = [];
      let cacheMap = new Map<string, any>();
      let userThreshold = preloadedThreshold;

      if (userFullRows.length > 0) {
        for (const row of userFullRows) {
          trackedList.push({
            network: row.network,
            account_index: row.account_index,
            alias: row.alias,
          });
          if (row.l1_address || row.positions_json) {
            cacheMap.set(`${row.network}:${row.account_index}`, row);
          }
        }
      } else if (filterIndex) {
        trackedList = filterNetwork
          ? [{ network: filterNetwork, account_index: filterIndex, alias: null }]
          : [
              { network: LIGHTER_NETWORKS.RH, account_index: filterIndex, alias: null },
              { network: LIGHTER_NETWORKS.MAINNET, account_index: filterIndex, alias: null },
            ];
        cacheMap = await getAccountsPositionsCache(env.DB, trackedList);
      }

      if (trackedList.length === 0) {
        if (filterIndex) {
          return ctx.reply(`Аккаунт #${filterIndex} не найден среди ваших отслеживаемых.`, {
            reply_markup: getMainKb(ctx),
          });
        }
        const emptyText =
          `👋 <b>Добро пожаловать в Lighter Monitor!</b>\n\n` +
          `Бот в реальном времени отслеживает ваши позиции на <b>Robinhood Lighter</b> и <b>Lighter Mainnet</b>, ` +
          `рассчитывает риски и защищает от ликвидации.\n\n` +
          `У вас пока нет подключенных аккаунтов. Давайте подключим первый:`;
        const emptyKb = new InlineKeyboard().text("➕ Подключить аккаунт", "wizard_start_add");
        if (isEdit) {
          return ctx
            .editMessageText(emptyText, { parse_mode: "HTML", reply_markup: emptyKb })
            .catch(() => {});
        }
        return ctx.reply(emptyText, { parse_mode: "HTML", reply_markup: emptyKb });
      }

      const nowSec = Math.floor(Date.now() / 1000);
      let isRateLimited = false;

      // TTL кэша: 50 секунд.
      // Если данные в D1 свежие (< 50 сек) -> отдаем мгновенно из согласованной базы без лишних subrequests.
      // Принудительный рефреш (forceRefresh) или устаревшие данные опрашивают биржу.
      const STALE_TTL_SEC = 50;
      const accountsNeedingSync = trackedList.filter((item) => {
        const key = `${item.network}:${item.account_index}`;
        const c = cacheMap.get(key);
        const lastUpdated = c?.last_updated_at || 0;
        return !lastUpdated || nowSec - lastUpdated >= STALE_TTL_SEC;
      });

      // Синхронный опрос, если данные устарели или запрошен принудительный сброс
      const toFetch = forceRefresh ? trackedList : accountsNeedingSync;
      const freshMap = new Map<string, any>();

      if (toFetch.length > 0) {
        const settled = await fetchInChunks(
          toFetch,
          CONFIG.LIGHTER_CHUNK_CONCURRENCY || 5,
          (item) =>
            fetchLighterAccountWithStatus(
              item.network,
              item.account_index,
              true,
              getLighterAuthToken(currentEnv || env, item.network),
            ),
        );
        toFetch.forEach((item, i) => {
          const res = settled[i];
          if (res && res.status === "fulfilled") {
            if (res.value.status === "OK" && res.value.account) {
              freshMap.set(`${item.network}:${item.account_index}`, res.value.account);
            } else if (res.value.status === "RATE_LIMIT") {
              isRateLimited = true;
            } else {
              console.warn(
                `[handlePositions] Fetch ${item.network}:${item.account_index} status=${res.value.status}: ${res.value.message}`,
              );
            }
          } else if (res && res.status === "rejected") {
            console.error(
              `[handlePositions] Fetch ${item.network}:${item.account_index} rejected:`,
              res.reason,
            );
          }
        });

        if (freshMap.size > 0) {
          const updates: Array<{ network: LighterNetwork; account: any; cachedPositions: any[] }> =
            [];
          const syncPromises: Promise<any>[] = [];

          for (const item of toFetch) {
            const key = `${item.network}:${item.account_index}`;
            const acc = freshMap.get(key);
            if (acc) {
              updates.push({
                network: item.network,
                account: acc,
                cachedPositions: acc.positions || [],
              });
              syncPromises.push(
                syncAccountOpenPositions(
                  env.DB,
                  item.network,
                  item.account_index,
                  acc.positions,
                ).catch((e) => console.error("syncAccountOpenPositions error:", e)),
              );
            }
          }
          // Фоновая фиксация в D1 (не задерживает ответ клиенту)
          runInBackground(
            Promise.all([
              ...syncPromises,
              batchUpdatePositionsCache(env.DB, updates).catch((e) =>
                console.error("Cache update error:", e),
              ),
            ]),
          );
        }
      }

      if (userThreshold === undefined) {
        userThreshold = await getUserThreshold(env.DB, ctx.from.id);
      }
      let totalUnPnl = 0;
      let totalCollateral = 0;
      const cards: string[] = [];

      // РЕНДЕРИНГ: Свежие данные > Согласованная база D1 (никаких слепых memAcc из разных изолятов!)
      for (const item of trackedList) {
        const key = `${item.network}:${item.account_index}`;
        const fresh = freshMap.get(key);
        const cached = cacheMap.get(key);
        let card = "";
        let accPositions: PositionRiskAnalysis[] = [];
        let accCollateral = 0;

        if (fresh) {
          accPositions = fresh.positions
            .map(analyzePositionRisk)
            .filter(Boolean) as PositionRiskAnalysis[];
          accCollateral = parseFloat(fresh.collateral || "0");
          card = formatPositionsReport(
            item.network,
            item.account_index,
            item.alias,
            accCollateral,
            accPositions,
            userThreshold,
          );
        } else if (cached && (cached.l1_address || cached.positions_json)) {
          let parsedPositions: any[] = [];
          if (cached.positions_json) {
            try {
              parsedPositions = JSON.parse(cached.positions_json);
            } catch {}
          }
          accPositions = parsedPositions
            .map((p: any) => unpackPosition(p, item.network, MEMORY_PRICES))
            .filter(Boolean) as PositionRiskAnalysis[];
          accCollateral = parseFloat(String(cached.collateral || 0));

          card = formatPositionsReport(
            item.network,
            item.account_index,
            item.alias,
            accCollateral,
            accPositions,
            userThreshold,
          );
        } else {
          if (filterIndex && !fresh && !cached) continue;
          const netBadge =
            CONFIG.NETWORKS[item.network]?.badge || `[${item.network.toUpperCase()}]`;
          card = `Аккаунт #${item.account_index} ${netBadge}: данные временно недоступны.\n`;
        }

        const trimmedCard = card.trim();
        if (!trimmedCard) continue;

        cards.push(trimmedCard);
        totalCollateral += accCollateral;
        for (const pos of accPositions) {
          totalUnPnl += pos.unrealizedPnl;
        }
      }

      const posKeyboard = getPositionsKeyboard(filterIndex, filterNetwork);

      if (cards.length > 0) {
        const separator = "\n─────────────\n";
        let combinedReport = cards.join(separator);

        const pnlSign = totalUnPnl >= 0 ? "📈 +" : "📉 -";
        const totalPnlStr = `${pnlSign}$${Math.abs(totalUnPnl).toFixed(2)}`;
        const summaryBlock = `${separator}📊 <b>ИТОГО:</b>\n• UnPnL: <b>${totalPnlStr}</b>\n• Маржа: <b>$${totalCollateral.toFixed(2)}</b>`;
        combinedReport += summaryBlock;

        const now = new Date();
        const timeStr = now.toLocaleTimeString("ru-RU", {
          timeZone: "UTC",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        let footerSuffix = "";
        if (freshMap.size > 0) {
          footerSuffix = `\n\n🕒 <i>Обновлено: ${timeStr} UTC</i>`;
        } else {
          // Берем самый свежий актуальный срез из D1
          let latestCacheSec = 0;
          for (const item of trackedList) {
            const c = cacheMap.get(`${item.network}:${item.account_index}`);
            const ts = c?.last_updated_at || 0;
            if (ts > latestCacheSec) {
              latestCacheSec = ts;
            }
          }
          const cacheDate = new Date((latestCacheSec || nowSec) * 1000);
          const cacheTimeStr = cacheDate.toLocaleTimeString("ru-RU", {
            timeZone: "UTC",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          footerSuffix = `\n\n🕒 <i>Кэш от: ${cacheTimeStr} UTC</i>`;
        }
        if (isRateLimited) {
          footerSuffix += `\n⚠️ <i>Биржа временно перегружена запросами. Показаны последние сохраненные данные.</i>`;
        }

        combinedReport += footerSuffix;

        if (combinedReport.length > 3800) {
          let currentChunk = "";
          for (let i = 0; i < cards.length; i++) {
            const piece = i === 0 ? cards[i] : separator + cards[i];
            if ((currentChunk + piece).length > 3800) {
              await ctx.reply(currentChunk, { parse_mode: "HTML" });
              currentChunk = cards[i];
            } else {
              currentChunk += piece;
            }
          }
          currentChunk += `${summaryBlock}${footerSuffix}`;
          await ctx.reply(currentChunk, { parse_mode: "HTML", reply_markup: posKeyboard });
          return;
        }

        if (isEdit) {
          try {
            await ctx.editMessageText(combinedReport, {
              parse_mode: "HTML",
              reply_markup: posKeyboard,
            });
          } catch (err: any) {
            if (!err?.message?.includes("message is not modified")) {
              await ctx.reply(combinedReport, { parse_mode: "HTML", reply_markup: posKeyboard });
            }
          }
        } else {
          await ctx.reply(combinedReport, { parse_mode: "HTML", reply_markup: posKeyboard });
        }
      } else if (filterIndex) {
        await ctx.reply(`Аккаунт #${filterIndex} не найден ни в одной из поддерживаемых сетей.`, {
          reply_markup: getMainKb(ctx),
        });
      }
    } catch (err) {
      console.error("[handlePositions] Error:", err);
    }
  };

  bot.command("positions", async (ctx) => {
    const arg = ctx.match ? ctx.match.trim() : "";
    const filter = arg && /^\d+$/.test(arg) ? parseInt(arg, 10) : undefined;
    await handlePositions(ctx, filter);
  });

  bot.callbackQuery("action_positions", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handlePositions(ctx);
  });

  bot.callbackQuery(/^refresh:([a-z0-9_-]+):(\d+)$/, async (ctx) => {
    const network = ctx.match[1] as LighterNetwork;
    const accountIndex = parseInt(ctx.match[2]!, 10);
    await ctx.answerCallbackQuery({ text: "🔄 Обновляем..." });
    await handlePositions(ctx, accountIndex, true, true, network);
  });

  bot.callbackQuery(/^refresh_positions(?:_(\d+))?$/, async (ctx) => {
    const filter = ctx.match[1] ? parseInt(ctx.match[1], 10) : undefined;
    await ctx.answerCallbackQuery({ text: "🔄 Обновляем..." });
    await handlePositions(ctx, filter, true, true);
  });

  // ==========================================
  // МЕНЮ НАСТРОЕК (ПОРОГ И ТИХИЙ СОН)
  // ==========================================

  const handleSettingsMain = async (ctx: any, isEdit: boolean = false) => {
    const telegramId = ctx.from!.id;
    const nowSec = Math.floor(Date.now() / 1000);
    const [settings, spreadStats] = await Promise.all([
      getUserSettings(env.DB, telegramId),
      getUserSpreadStats(env.DB, telegramId),
    ]);

    const targetsMutedUntil = settings.spreadMutedUntil;
    const updatesMutedUntil = settings.updatesMutedUntil;

    const spikesMuted = settings.mutedUntil > nowSec;
    const targetsMuted = targetsMutedUntil > nowSec;
    const updatesMuted = updatesMutedUntil > nowSec;
    const allMuted = spikesMuted && targetsMuted && updatesMuted;
    const anyMuted = spikesMuted || targetsMuted || updatesMuted;

    let globalStatus = "🔔 Все уведомления активны";
    if (allMuted) {
      if (
        settings.mutedUntil >= CONFIG.MUTE_FOREVER_TIMESTAMP &&
        targetsMutedUntil >= CONFIG.MUTE_FOREVER_TIMESTAMP &&
        updatesMutedUntil >= CONFIG.MUTE_FOREVER_TIMESTAMP
      ) {
        globalStatus = "⏸ Все уведомления выключены";
      } else {
        globalStatus = "🔕 Бот полностью заглушен";
      }
    } else if (anyMuted) {
      globalStatus = "🔕 Частично заглушен";
    }

    const text =
      `⚙️ <b>Центр настроек уведомлений</b>\n\n` +
      `⚡️ <b>Спайки цен (позиции):</b>\n` +
      `• Порог: <b>±${formatThreshold(settings.alertThreshold)}%</b>\n` +
      `• Статус: <b>${formatAlertMuteStatus(settings.mutedUntil, nowSec)}</b>\n\n` +
      `📐 <b>Таргеты спреда (RH ↔ Core):</b>\n` +
      `• Настроено: <b>${spreadStats.totalTargets}/${CONFIG.MAX_SPREAD_TARGETS_PER_USER}</b> (токенов: <b>${spreadStats.tokenCount}/${CONFIG.MAX_SPREAD_TOKENS_PER_USER}</b>)\n` +
      `• Порог: <b>${settings.targetHitsThreshold || 3} ${formatTicksWord(settings.targetHitsThreshold || 3)}</b> <i>(~${settings.targetHitsThreshold || 3} мин)</i>\n` +
      `• Статус: <b>${formatAlertMuteStatus(targetsMutedUntil, nowSec)}</b>\n\n` +
      `🚀 <b>Релизы и обновления:</b>\n` +
      `• Статус: <b>${formatAlertMuteStatus(updatesMutedUntil, nowSec)}</b>\n\n` +
      `🔕 <b>Общий статус бота:</b>\n` +
      `• <b>${globalStatus}</b>\n\n` +
      `<i>Выберите раздел для настройки или режим сна:</i>`;

    const kb = new InlineKeyboard()
      .text("⚡️ Спайки цен", "cfg_spikes")
      .text("📐 Таргеты спреда", "cfg_targets")
      .row()
      .text("🚀 Релизы и обновления", "cfg_updates")
      .row();

    if (anyMuted) {
      kb.text("🔔 Включить всё", "cfg_mute_all:0").row();
    }
    kb.text("🔕 Заглушить всего бота", "cfg_menu_all");

    if (isEdit) {
      try {
        return await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch (err: any) {
        if (!err?.message?.includes("message is not modified")) {
          console.warn("[handleSettingsMain] edit error:", err?.message || err);
        }
      }
      return;
    }
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  const handleSettingsSpikes = async (
    ctx: any,
    isEdit: boolean = false,
    knownMutedUntil?: number,
  ) => {
    const telegramId = ctx.from!.id;
    const nowSec = Math.floor(Date.now() / 1000);
    const settings = await getUserSettings(env.DB, telegramId);
    const mutedUntil = knownMutedUntil !== undefined ? knownMutedUntil : settings.mutedUntil;
    const isMuted = mutedUntil > nowSec;

    const text =
      `⚡️ <b>Настройки алертов спайков цен</b>\n\n` +
      `Отслеживание резких движений цены по открытым позициям аккаунтов.\n\n` +
      `🎯 <b>Текущий шаг цены:</b> <b>±${formatThreshold(settings.alertThreshold)}%</b>\n` +
      `<i>(Для золота XAU на плече 15–25x рекомендуется 0.3%–0.5%)</i>\n\n` +
      `🔔 <b>Статус уведомлений:</b> <b>${formatAlertMuteStatus(mutedUntil, nowSec)}</b>\n\n` +
      `Выберите шаг цены или режим сна:`;

    const kb = new InlineKeyboard();
    const presets = [0.3, 0.5, 0.8, 1.0, 1.5, 2.0];
    for (let i = 0; i < presets.length; i++) {
      const p = presets[i]!;
      const label = Math.abs(p - settings.alertThreshold) < 0.001 ? `✅ ${p}%` : `${p}%`;
      kb.text(label, `set_thresh_${p}`);
      if (i === 2) kb.row();
    }
    kb.row();
    const isCustom = !presets.some((p) => Math.abs(p - settings.alertThreshold) < 0.001);
    const customLabel = isCustom
      ? `✏️ Свой % (сейчас ${formatThreshold(settings.alertThreshold)}%)`
      : `✏️ Ввести свой %`;
    kb.text(customLabel, "custom_threshold").row();

    if (isMuted) {
      kb.text("🔔 Включить спайки", "cfg_mute_spikes:0").row();
    }
    kb.text("🔕 1ч", "cfg_mute_spikes:3600")
      .text("🔕 4ч", "cfg_mute_spikes:14400")
      .text("🔕 24ч", "cfg_mute_spikes:86400")
      .row()
      .text("⏸ Выключить (до включения)", "cfg_mute_spikes:forever")
      .row()
      .text("« Назад в настройки", "cfg_main");

    if (isEdit) {
      try {
        return await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch (err: any) {
        if (!err?.message?.includes("message is not modified")) {
          console.warn("[handleSettingsSpikes] edit error:", err?.message || err);
        }
      }
      return;
    }
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  const handleSettingsTargets = async (
    ctx: any,
    isEdit: boolean = false,
    knownMutedUntil?: number,
  ) => {
    const telegramId = ctx.from!.id;
    const nowSec = Math.floor(Date.now() / 1000);
    const [settings, spreadStats] = await Promise.all([
      getUserSettings(env.DB, telegramId),
      getUserSpreadStats(env.DB, telegramId),
    ]);
    const targetsMutedUntil =
      knownMutedUntil !== undefined ? knownMutedUntil : settings.spreadMutedUntil;
    const isMuted = targetsMutedUntil > nowSec;
    const hitsThreshold = settings.targetHitsThreshold || 3;

    const text =
      `📐 <b>Настройки алертов таргетов спреда</b>\n\n` +
      `Уведомления о достижении целевого спреда между Robinhood Lighter и Lighter Core.\n\n` +
      `🎯 <b>Настроено таргетов:</b> <b>${spreadStats.totalTargets}/${CONFIG.MAX_SPREAD_TARGETS_PER_USER}</b> (токенов: <b>${spreadStats.tokenCount}/${CONFIG.MAX_SPREAD_TOKENS_PER_USER}</b>)\n` +
      `🔔 <b>Статус уведомлений:</b> <b>${formatAlertMuteStatus(targetsMutedUntil, nowSec)}</b>\n` +
      `⏱ <b>Порог подтверждения:</b> <b>${hitsThreshold} ${formatTicksWord(hitsThreshold)}</b> <i>(~${hitsThreshold} мин)</i>\n\n` +
      `⏱ <i>Крон проверяет рынок <b>раз в минуту</b>. Порог задает, сколько минут подряд спред должен удерживаться выше цели до отправки алерта:\n` +
      `• <b>1 тик (1 мин):</b> моментально (подходит для быстрой реакции, но возможен шум при минутных проколах стакана)\n` +
      `• <b>3 тика (3 мин, дефолт):</b> баланс скорости и фильтрации сквизов ликвидности\n` +
      `• <b>5 тиков (5 мин):</b> гарантированное удержание стабильного базиса</i>\n\n` +
      `Выберите порог подтверждения или режим сна:`;

    const kb = new InlineKeyboard();
    const presets = [1, 2, 3, 5];
    for (const p of presets) {
      const label =
        p === hitsThreshold ? `✅ ${p} ${formatTicksWord(p)}` : `${p} ${formatTicksWord(p)}`;
      kb.text(label, `cfg_hits:${p}`);
    }
    kb.row();

    const isCustom = !presets.includes(hitsThreshold);
    const customLabel = isCustom
      ? `✏️ Свой порог (сейчас ${hitsThreshold})`
      : `✏️ Ввести свой порог`;
    kb.text(customLabel, "cfg_custom_hits").row();

    if (isMuted) {
      kb.text("🔔 Включить таргеты", "cfg_mute_targets:0").row();
    }
    kb.text("🔕 1ч", "cfg_mute_targets:3600")
      .text("🔕 4ч", "cfg_mute_targets:14400")
      .text("🔕 24ч", "cfg_mute_targets:86400")
      .row()
      .text("⏸ Выключить (до включения)", "cfg_mute_targets:forever")
      .row()
      .text("« Назад в настройки", "cfg_main");

    if (isEdit) {
      try {
        return await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch (err: any) {
        if (!err?.message?.includes("message is not modified")) {
          console.warn("[handleSettingsTargets] edit error:", err?.message || err);
        }
      }
      return;
    }
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  const handleSettingsUpdates = async (
    ctx: any,
    isEdit: boolean = false,
    knownMutedUntil?: number,
  ) => {
    const telegramId = ctx.from!.id;
    const nowSec = Math.floor(Date.now() / 1000);
    const updatesMutedUntil =
      knownMutedUntil !== undefined
        ? knownMutedUntil
        : await getUserUpdatesMute(env.DB, telegramId);
    const isMuted = updatesMutedUntil > nowSec;

    const text =
      `🚀 <b>Настройки уведомлений об обновлениях</b>\n\n` +
      `Краткие анонсы новых версий бота и веб-терминала со списком изменений и ссылкой на релиз.\n\n` +
      `🔔 <b>Статус уведомлений:</b> <b>${formatAlertMuteStatus(updatesMutedUntil, nowSec)}</b>\n\n` +
      `Выберите режим сна для обновлений:`;

    const kb = new InlineKeyboard();
    if (isMuted) {
      kb.text("🔔 Включить обновления", "cfg_mute_updates:0").row();
    }
    kb.text("🔕 1ч", "cfg_mute_updates:3600")
      .text("🔕 4ч", "cfg_mute_updates:14400")
      .text("🔕 24ч", "cfg_mute_updates:86400")
      .row()
      .text("⏸ Выключить (до включения)", "cfg_mute_updates:forever")
      .row()
      .text("« Назад в настройки", "cfg_main");

    if (isEdit) {
      try {
        return await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch (err: any) {
        if (!err?.message?.includes("message is not modified")) {
          console.warn("[handleSettingsUpdates] edit error:", err?.message || err);
        }
      }
      return;
    }
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  const handleSettingsAll = async (ctx: any, isEdit: boolean = false, knownMutedUntil?: number) => {
    const telegramId = ctx.from!.id;
    const nowSec = Math.floor(Date.now() / 1000);
    let spikesMutedUntil: number;
    let targetsMutedUntil: number;
    let updatesMutedUntil: number;

    if (knownMutedUntil !== undefined) {
      spikesMutedUntil = knownMutedUntil;
      targetsMutedUntil = knownMutedUntil;
      updatesMutedUntil = knownMutedUntil;
    } else {
      const settings = await getUserSettings(env.DB, telegramId);
      spikesMutedUntil = settings.mutedUntil;
      targetsMutedUntil = settings.spreadMutedUntil;
      updatesMutedUntil = settings.updatesMutedUntil;
    }
    const anyMuted =
      spikesMutedUntil > nowSec || targetsMutedUntil > nowSec || updatesMutedUntil > nowSec;

    const text =
      `🔕 <b>Управление всеми уведомлениями бота</b>\n\n` +
      `Режим действует одновременно на <b>спайки цен</b>, <b>таргеты спреда</b> и <b>обновления бота</b>.\n\n` +
      `• Спайки позиций: <b>${formatAlertMuteStatus(spikesMutedUntil, nowSec)}</b>\n` +
      `• Таргеты спреда: <b>${formatAlertMuteStatus(targetsMutedUntil, nowSec)}</b>\n` +
      `• Обновления бота: <b>${formatAlertMuteStatus(updatesMutedUntil, nowSec)}</b>\n\n` +
      `Выберите режим сна для всего бота:`;

    const kb = new InlineKeyboard();
    if (anyMuted) {
      kb.text("🔔 Включить все уведомления", "cfg_mute_all:0").row();
    }
    kb.text("🔕 1ч", "cfg_mute_all:3600")
      .text("🔕 4ч", "cfg_mute_all:14400")
      .text("🔕 24ч", "cfg_mute_all:86400")
      .row()
      .text("⏸ Выключить всё (до включения)", "cfg_mute_all:forever")
      .row()
      .text("« Назад в настройки", "cfg_main");

    if (isEdit) {
      try {
        return await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch (err: any) {
        if (!err?.message?.includes("message is not modified")) {
          console.warn("[handleSettingsAll] edit error:", err?.message || err);
        }
      }
      return;
    }
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  bot.command("settings", async (ctx) => {
    await handleSettingsMain(ctx);
  });

  const handleStats = async (ctx: any) => {
    const activeEnv = currentEnv || env;
    const userId = ctx.from?.id;
    const username = ctx.from?.username;

    if (!isUserAdmin(activeEnv, userId, username)) {
      return ctx.reply(
        `⛔️ <b>Доступ ограничен</b>\n\nЭта команда доступна только администратору бота.`,
        {
          parse_mode: "HTML",
          reply_markup: getMainKb(ctx),
        },
      );
    }

    try {
      const report = await renderAdminDashboard(activeEnv);
      await ctx.reply(report, { parse_mode: "HTML", reply_markup: getStatsKeyboard() });
    } catch (err: any) {
      console.error("Failed to load /stats:", err);
      await ctx.reply(`⚠️ Ошибка загрузки дашборда: ${err?.message || err}`);
    }
  };

  bot.command("stats", handleStats);

  bot.callbackQuery("refresh_stats", async (ctx) => {
    const activeEnv = currentEnv || env;
    const userId = ctx.from?.id;
    const username = ctx.from?.username;

    if (!isUserAdmin(activeEnv, userId, username)) {
      return ctx.answerCallbackQuery({ text: "⛔️ Доступ ограничен", show_alert: true });
    }

    try {
      const report = await renderAdminDashboard(activeEnv);
      await ctx.editMessageText(report, {
        parse_mode: "HTML",
        reply_markup: getStatsKeyboard(),
      });
      await ctx.answerCallbackQuery({ text: "🔄 Обновлено" });
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      if (errMsg.includes("message is not modified")) {
        await ctx.answerCallbackQuery({ text: "Данные уже актуальны" });
      } else {
        console.error("Failed to refresh stats:", err);
        await ctx.answerCallbackQuery({ text: "⚠️ Ошибка обновления" });
      }
    }
  });

  bot.callbackQuery("custom_threshold", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, { step: WIZARD_STEPS.AWAIT_THRESHOLD });
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text("❌ Отмена", "action_threshold");
    await ctx.editMessageText(
      `✏️ <b>Настройка шага цены для алертов</b>\n\n` +
        `Отправьте желаемый шаг цены числом в чат:\n` +
        `<i>(от <b>${CONFIG.MIN_ALERT_THRESHOLD}%</b> до <b>${CONFIG.MAX_ALERT_THRESHOLD}%</b>, например: <b>0.4</b> или <b>0.7</b>)</i>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery("cfg_main", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleSettingsMain(ctx, true);
  });

  bot.callbackQuery("cfg_spikes", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleSettingsSpikes(ctx, true);
  });

  bot.callbackQuery("cfg_targets", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, null);
    await ctx.answerCallbackQuery();
    await handleSettingsTargets(ctx, true);
  });

  bot.callbackQuery(/^cfg_hits:(\d+)$/, async (ctx) => {
    const val = parseInt(ctx.match[1]!, 10);
    await setUserWizardState(env.DB, ctx.from!.id, null);
    await setUserTargetHitsThreshold(env.DB, ctx.from!.id, val);
    await ctx.answerCallbackQuery({
      text: `Порог установлен: ${val} ${formatTicksWord(val)} (~${val} мин)`,
    });
    await handleSettingsTargets(ctx, true);
  });

  bot.callbackQuery("cfg_custom_hits", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, { step: WIZARD_STEPS.AWAIT_TARGET_HITS });
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text("❌ Отмена", "cfg_targets");
    await ctx.editMessageText(
      `⏱ <b>Настройка порога подтверждения таргетов</b>\n\n` +
        `Крон проверяет рынок <b>раз в минуту</b>. Порог указывает, сколько минут подряд спред должен удерживаться выше таргета до отправки уведомления.\n\n` +
        `• <b>1 тик:</b> быстрый алерт (может ловить минутные проколы стакана)\n` +
        `• <b>3 тика (дефолт):</b> баланс скорости и фильтрации сквизов\n` +
        `• <b>5 тиков:</b> гарантированное удержание стабильного базиса\n\n` +
        `Отправьте желаемое число подтверждений числом в чат (от <b>1</b> до <b>60</b>):`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery("cfg_updates", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleSettingsUpdates(ctx, true);
  });

  bot.callbackQuery("cfg_menu_all", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleSettingsAll(ctx, true);
  });

  bot.callbackQuery(/^cfg_mute_spikes:(3600|14400|86400|forever|0)$/, async (ctx) => {
    const dur = ctx.match[1];
    const nowSec = Math.floor(Date.now() / 1000);
    const mutedUntil =
      dur === "0"
        ? 0
        : dur === "forever"
          ? CONFIG.MUTE_FOREVER_TIMESTAMP
          : nowSec + parseInt(dur, 10);
    await setUserMute(env.DB, ctx.from!.id, mutedUntil);
    const toast =
      dur === "0"
        ? "🔔 Спайки цен включены"
        : dur === "forever"
          ? "⏸ Спайки выключены (до включения)"
          : dur === "3600"
            ? "🔕 Спайки заглушены на 1 час"
            : dur === "14400"
              ? "🔕 Спайки заглушены на 4 часа"
              : "🔕 Спайки заглушены на 24 часа";
    await Promise.all([
      ctx.answerCallbackQuery({ text: toast }),
      handleSettingsSpikes(ctx, true, mutedUntil),
    ]);
  });

  bot.callbackQuery(/^cfg_mute_targets:(3600|14400|86400|forever|0)$/, async (ctx) => {
    const dur = ctx.match[1];
    const nowSec = Math.floor(Date.now() / 1000);
    const mutedUntil =
      dur === "0"
        ? 0
        : dur === "forever"
          ? CONFIG.MUTE_FOREVER_TIMESTAMP
          : nowSec + parseInt(dur, 10);
    await setUserSpreadMute(env.DB, ctx.from!.id, mutedUntil);
    const toast =
      dur === "0"
        ? "🔔 Таргеты спреда включены"
        : dur === "forever"
          ? "⏸ Таргеты выключены (до включения)"
          : dur === "3600"
            ? "🔕 Таргеты заглушены на 1 час"
            : dur === "14400"
              ? "🔕 Таргеты заглушены на 4 часа"
              : "🔕 Таргеты заглушены на 24 часа";
    await Promise.all([
      ctx.answerCallbackQuery({ text: toast }),
      handleSettingsTargets(ctx, true, mutedUntil),
    ]);
  });

  bot.callbackQuery(/^cfg_mute_updates:(3600|14400|86400|forever|0)$/, async (ctx) => {
    const dur = ctx.match[1];
    const nowSec = Math.floor(Date.now() / 1000);
    const mutedUntil =
      dur === "0"
        ? 0
        : dur === "forever"
          ? CONFIG.MUTE_FOREVER_TIMESTAMP
          : nowSec + parseInt(dur, 10);
    const dbOps: Promise<any>[] = [setUserUpdatesMute(env.DB, ctx.from!.id, mutedUntil)];
    if (dur === "0") {
      dbOps.push(updateUserLastSeenVersion(env.DB, ctx.from!.id, APP_VERSION));
      invalidateCompletedVersionCache();
    }
    await Promise.all(dbOps);
    const toast =
      dur === "0"
        ? "🔔 Обновления включены"
        : dur === "forever"
          ? "⏸ Обновления выключены (до включения)"
          : dur === "3600"
            ? "🔕 Обновления заглушены на 1 час"
            : dur === "14400"
              ? "🔕 Обновления заглушены на 4 часа"
              : "🔕 Обновления заглушены на 24 часа";
    await Promise.all([
      ctx.answerCallbackQuery({ text: toast }),
      handleSettingsUpdates(ctx, true, mutedUntil),
    ]);
  });

  bot.callbackQuery(/^cfg_mute_all:(3600|14400|86400|forever|0)$/, async (ctx) => {
    const dur = ctx.match[1];
    const nowSec = Math.floor(Date.now() / 1000);
    const mutedUntil =
      dur === "0"
        ? 0
        : dur === "forever"
          ? CONFIG.MUTE_FOREVER_TIMESTAMP
          : nowSec + parseInt(dur, 10);
    const dbOps: Promise<any>[] = [setAllUserMutes(env.DB, ctx.from!.id, mutedUntil)];
    if (dur === "0") {
      dbOps.push(updateUserLastSeenVersion(env.DB, ctx.from!.id, APP_VERSION));
      invalidateCompletedVersionCache();
    }
    await Promise.all(dbOps);
    const toast =
      dur === "0"
        ? "🔔 Все уведомления включены"
        : dur === "forever"
          ? "⏸ Все уведомления выключены (до включения)"
          : dur === "3600"
            ? "🔕 Все уведомления заглушены на 1 час"
            : dur === "14400"
              ? "🔕 Все уведомления заглушены на 4 часа"
              : "🔕 Все уведомления заглушены на 24 часа";
    const nextScreen =
      dur === "0" ? handleSettingsMain(ctx, true) : handleSettingsAll(ctx, true, mutedUntil);
    await Promise.all([ctx.answerCallbackQuery({ text: toast }), nextScreen]);
  });

  bot.callbackQuery("action_threshold", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, null);
    await ctx.answerCallbackQuery();
    await handleSettingsSpikes(ctx, true);
  });

  bot.callbackQuery(/^set_thresh_(\d+(\.\d+)?)$/, async (ctx) => {
    const val = parseFloat(ctx.match[1]);
    await setUserWizardState(env.DB, ctx.from!.id, null);
    await setUserThreshold(env.DB, ctx.from!.id, val);
    await ctx.answerCallbackQuery({ text: `Шаг установлен: ${val}%` });
    await handleSettingsSpikes(ctx, true);
  });

  bot.callbackQuery("settings_mute_4h", async (ctx) => {
    const mutedUntil = Math.floor(Date.now() / 1000) + 4 * 3600;
    await setUserMute(env.DB, ctx.from!.id, mutedUntil);
    await ctx.answerCallbackQuery({ text: "🔕 Спайки заглушены на 4 часа" });
    await handleSettingsSpikes(ctx, true);
  });

  bot.callbackQuery("settings_mute_forever", async (ctx) => {
    await setUserMute(env.DB, ctx.from!.id, CONFIG.MUTE_FOREVER_TIMESTAMP);
    await ctx.answerCallbackQuery({ text: "⏸ Спайки выключены (до включения)" });
    await handleSettingsSpikes(ctx, true);
  });

  bot.callbackQuery("settings_unmute", async (ctx) => {
    await setUserMute(env.DB, ctx.from!.id, 0);
    await ctx.answerCallbackQuery({ text: "🔔 Спайки включены" });
    await handleSettingsSpikes(ctx, true);
  });

  // ==========================================
  // МЬЮТЫ ПОЗИЦИЙ ИЗ СООБЩЕНИЙ АЛЕРТОВ
  // ==========================================

  bot.callbackQuery(/^pos_mute:(3600|14400|forever)$/, async (ctx) => {
    const dur = ctx.match[1];
    const nowSec = Math.floor(Date.now() / 1000);
    const mutedUntil =
      dur === "forever" ? CONFIG.MUTE_FOREVER_TIMESTAMP : nowSec + parseInt(dur, 10);
    await setUserMute(env.DB, ctx.from!.id, mutedUntil);
    const label =
      dur === "forever" ? "выключены (до включения)" : dur === "3600" ? "на 1 час" : "на 4 часа";
    await ctx.answerCallbackQuery({ text: `🔕 Уведомления заглушены ${label}` });

    try {
      const currentMarkup = ctx.callbackQuery.message?.reply_markup;
      if (currentMarkup?.inline_keyboard) {
        const newKeyboard = new InlineKeyboard();
        for (const row of currentMarkup.inline_keyboard) {
          const isMuteRow = row.some((btn: any) => btn.callback_data?.startsWith("pos_mute:"));
          if (isMuteRow) {
            newKeyboard.text("🔔 Включить уведомления", "pos_unmute").row();
          } else {
            for (const btn of row as any[]) {
              if (btn.url) newKeyboard.url(btn.text, btn.url);
              else if (btn.callback_data) newKeyboard.text(btn.text, btn.callback_data);
            }
            newKeyboard.row();
          }
        }
        await ctx.editMessageReplyMarkup({ reply_markup: newKeyboard });
      }
    } catch {}
  });

  bot.callbackQuery("pos_unmute", async (ctx) => {
    await setUserMute(env.DB, ctx.from!.id, 0);
    await ctx.answerCallbackQuery({ text: "🔔 Уведомления снова включены" });
    try {
      const currentMarkup = ctx.callbackQuery.message?.reply_markup;
      if (currentMarkup?.inline_keyboard) {
        const newKeyboard = new InlineKeyboard();
        for (const row of currentMarkup.inline_keyboard) {
          const isUnmuteRow = row.some((btn: any) => btn.callback_data === "pos_unmute");
          if (isUnmuteRow) {
            newKeyboard
              .text("🔕 1ч", "pos_mute:3600")
              .text("🔕 4ч", "pos_mute:14400")
              .text("⏸ Выкл", "pos_mute:forever")
              .row();
          } else {
            for (const btn of row as any[]) {
              if (btn.url) newKeyboard.url(btn.text, btn.url);
              else if (btn.callback_data) newKeyboard.text(btn.text, btn.callback_data);
            }
            newKeyboard.row();
          }
        }
        await ctx.editMessageReplyMarkup({ reply_markup: newKeyboard });
      }
    } catch {}
  });

  // ==========================================
  // КОМАНДЫ И ОБРАБОТЧИКИ ТАРГЕТОВ СПРЕДА
  // ==========================================

  bot.command("targets", async (ctx) => {
    await handleSpreadMenu(ctx);
  });

  bot.callbackQuery("spread_menu", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, null);
    await ctx.answerCallbackQuery();
    await handleSpreadMenu(ctx, true);
  });

  bot.callbackQuery("sp_wiz_start", async (ctx) => {
    const telegramId = ctx.from!.id;
    const stats = await getUserSpreadStats(env.DB, telegramId);
    if (stats.totalTargets >= CONFIG.MAX_SPREAD_TARGETS_PER_USER) {
      await ctx.answerCallbackQuery({
        text: `⚠️ Лимит таргетов исчерпан (${stats.totalTargets}/${CONFIG.MAX_SPREAD_TARGETS_PER_USER})`,
        show_alert: true,
      });
      return;
    }

    const allTargets = await getUserSpreadTargets(env.DB, telegramId);
    const userTrackedTokens = Array.from(new Set(allTargets.map((t) => t.symbol)));

    await ctx.answerCallbackQuery();

    if (stats.tokenCount >= CONFIG.MAX_SPREAD_TOKENS_PER_USER) {
      await setUserWizardState(env.DB, telegramId, null);
      const promptText =
        `🎯 <b>Добавление таргета спреда</b>\n\n` +
        `⚠️ Достигнут лимит уникальных токенов (<b>${stats.tokenCount}/${CONFIG.MAX_SPREAD_TOKENS_PER_USER}</b>).\n` +
        `Вы можете добавить еще таргет к вашим уже отслеживаемым токенам (всего таргетов: ${stats.totalTargets}/${CONFIG.MAX_SPREAD_TARGETS_PER_USER}):\n\n` +
        `Выберите токен:`;

      const kb = new InlineKeyboard();
      for (let i = 0; i < userTrackedTokens.length; i++) {
        kb.text(userTrackedTokens[i]!, `sp_sym:${userTrackedTokens[i]}`);
        if (i % 3 === 2) kb.row();
      }
      kb.row().text("❌ Отмена", "sp_manage");

      try {
        await ctx.editMessageText(promptText, { parse_mode: "HTML", reply_markup: kb });
      } catch {
        await ctx.reply(promptText, { parse_mode: "HTML", reply_markup: kb });
      }
      return;
    }

    await setUserWizardState(env.DB, telegramId, { step: WIZARD_STEPS.SPREAD_AWAIT_SYMBOL });

    const promptText =
      `🎯 <b>Добавление таргета спреда</b>\n\n` +
      `Введите тикер токена (например: <code>SPY</code>, <code>QQQ</code>, <code>XAU</code>, <code>NVDA</code>, <code>AAPL</code>) ` +
      `или выберите из популярных ниже:`;

    const kb = new InlineKeyboard()
      .text("SPY", "sp_sym:SPY")
      .text("QQQ", "sp_sym:QQQ")
      .text("XAU", "sp_sym:XAU")
      .row()
      .text("NVDA", "sp_sym:NVDA")
      .text("AAPL", "sp_sym:AAPL");

    const extraTokens = userTrackedTokens.filter(
      (t) => !["SPY", "QQQ", "XAU", "NVDA", "AAPL"].includes(t),
    );
    if (extraTokens.length > 0) {
      kb.row();
      for (let i = 0; i < extraTokens.length; i++) {
        kb.text(extraTokens[i]!, `sp_sym:${extraTokens[i]}`);
        if (i % 3 === 2) kb.row();
      }
    }
    kb.row().text("❌ Отмена", "sp_manage");

    try {
      await ctx.editMessageText(promptText, { parse_mode: "HTML", reply_markup: kb });
    } catch {
      await ctx.reply(promptText, { parse_mode: "HTML", reply_markup: kb });
    }
  });

  bot.callbackQuery(/^sp_sym:([A-Za-z0-9._-]+)$/, async (ctx) => {
    const symbol = ctx.match[1];
    await setUserWizardState(env.DB, ctx.from!.id, null);
    await ctx.answerCallbackQuery();
    await showDirectionPicker(ctx, symbol, true);
  });

  bot.callbackQuery(/^sp_dir:([A-Za-z0-9._-]+):(rh_cheaper|rh_expensive)$/, async (ctx) => {
    const symbol = ctx.match[1];
    const dir = ctx.match[2] as SpreadDirection;
    await ctx.answerCallbackQuery();
    await showPresetPicker(ctx, symbol, dir, true);
  });

  bot.callbackQuery(
    /^sp_pr:([A-Za-z0-9._-]+):(rh_cheaper|rh_expensive):(\d+(\.\d+)?)(?::(\d+))?$/,
    async (ctx) => {
      const symbol = ctx.match[1]!.toUpperCase();
      const direction = ctx.match[2] as SpreadDirection;
      const bps = parseFloat(ctx.match[3]!);
      const editTargetId = ctx.match[5] ? parseInt(ctx.match[5]!, 10) : undefined;

      const quote = await getLiveSpreadQuote(symbol);
      const refPrice =
        quote && quote.corePrice > 0
          ? quote.corePrice
          : getMemoryPrice(LIGHTER_NETWORKS.MAINNET, symbol) ||
            getMemoryPrice(LIGHTER_NETWORKS.RH, symbol) ||
            0;
      const targetDeltaUsd = refPrice > 0 ? (refPrice * bps) / 10000 : 0;

      let initialArmed = 1;
      let currentBasisBps = 0;
      if (quote) {
        const { basisBps } = computeSpreadBasis(quote.rhPrice, quote.corePrice);
        currentBasisBps = direction === SPREAD_DIRECTIONS.RH_CHEAPER ? -basisBps : basisBps;
        if (currentBasisBps >= bps) {
          initialArmed = 0;
        }
      }

      const isEditing = Boolean(editTargetId);
      if (editTargetId) {
        await updateSpreadTarget(
          env.DB,
          ctx.from!.id,
          editTargetId,
          direction,
          bps,
          SPREAD_UNITS.BPS,
          initialArmed,
        );
        await ctx.answerCallbackQuery({ text: `Таргет изменен на ${bps} bps!` });
      } else {
        await addSpreadTarget(
          env.DB,
          ctx.from!.id,
          symbol,
          direction,
          bps,
          SPREAD_UNITS.BPS,
          initialArmed,
        );
        await ctx.answerCallbackQuery({ text: `Таргет ${bps} bps добавлен!` });
      }

      invalidateActiveSymbolsCache();
      await setUserWizardState(env.DB, ctx.from!.id, null);

      const dirLabel =
        direction === SPREAD_DIRECTIONS.RH_CHEAPER ? "🟢 RH &lt; Core" : "🔵 RH &gt; Core";
      const dirSign = direction === SPREAD_DIRECTIONS.RH_CHEAPER ? "-" : "+";
      const centsFormatted =
        targetDeltaUsd >= 1 ? targetDeltaUsd.toFixed(2) : targetDeltaUsd.toFixed(3);

      let confirmText = isEditing
        ? `✅ <b>Таргет спреда успешно изменен!</b>\n\n`
        : `✅ <b>Таргет спреда успешно добавлен!</b>\n\n`;

      confirmText +=
        `• Инструмент: <b>${symbol}</b>\n` +
        `• Условие: <b>${dirLabel}</b>\n` +
        `• Целевой спред: <b>${bps} bps</b> (${dirSign}$${centsFormatted})\n`;

      if (initialArmed === 0) {
        confirmText += `\n⚠️ <i>Текущий спред (${currentBasisBps.toFixed(1)} bps) уже достиг цели. Таргет взведется автоматически при откате ниже ${(bps * CONFIG.SPREAD_REARM_RATIO).toFixed(1)} bps (80%).</i>`;
      } else {
        confirmText += `• Статус: <b>Взведен и активен</b>`;
      }

      const kb = new InlineKeyboard();
      if (isEditing && editTargetId) {
        kb.text(`🎯 К таргету`, `sp_target:${editTargetId}`).row();
      } else {
        kb.text(`➕ Еще таргет для ${symbol}`, `sp_sym:${symbol}`).row();
      }
      kb.text(`📐 Мои таргеты`, "spread_menu");

      try {
        await ctx.editMessageText(confirmText, { parse_mode: "HTML", reply_markup: kb });
      } catch {
        await ctx.reply(confirmText, { parse_mode: "HTML", reply_markup: kb });
      }
    },
  );

  bot.callbackQuery(
    /^sp_custom:([A-Za-z0-9._-]+):(rh_cheaper|rh_expensive)(?::(\d+))?$/,
    async (ctx) => {
      const symbol = ctx.match[1]!.toUpperCase();
      const direction = ctx.match[2] as SpreadDirection;
      const editTargetId = ctx.match[3] ? parseInt(ctx.match[3]!, 10) : undefined;
      const quote = await getLiveSpreadQuote(symbol);
      const rhPrice = quote ? quote.rhPrice : 0;
      const corePrice = quote ? quote.corePrice : 0;

      await setUserWizardState(env.DB, ctx.from!.id, {
        step: WIZARD_STEPS.SPREAD_AWAIT_DELTA,
        symbol,
        direction,
        rhPrice,
        corePrice,
        editTargetId,
      });
      await ctx.answerCallbackQuery();

      const dirLabel =
        direction === SPREAD_DIRECTIONS.RH_CHEAPER ? "🟢 RH &lt; Core" : "🔵 RH &gt; Core";
      const title = editTargetId
        ? `✏️ <b>Изменение целевого спреда для ${symbol}</b>\n`
        : `✏️ <b>Введите целевой спред для ${symbol}</b>\n`;

      const prompt =
        title +
        `Условие: <b>${dirLabel}</b>\n\n` +
        `Отправьте желаемое значение в долларах или в bps:\n` +
        `• В долларах/центах: <code>0.15</code> или <code>$0.15</code>\n` +
        `• В базисных пунктах: <code>5bps</code> или <code>0.05%</code>\n\n` +
        `<i>Текущая цена ${symbol}: ~$${formatPriceFine(corePrice)}</i>`;

      const cancelCb = editTargetId ? `sp_target:${editTargetId}` : "sp_manage";
      const kb = new InlineKeyboard().text("❌ Отмена", cancelCb);
      await ctx.reply(prompt, { parse_mode: "HTML", reply_markup: kb });
    },
  );

  bot.callbackQuery(/^sp_edit:(\d+)$/, async (ctx) => {
    const targetId = parseInt(ctx.match[1]!, 10);
    const targets = await getUserSpreadTargets(env.DB, ctx.from!.id);
    const target = targets.find((t) => t.id === targetId);
    if (!target) {
      await ctx.answerCallbackQuery({ text: "Таргет не найден" });
      await handleSpreadManage(ctx, true);
      return;
    }
    await ctx.answerCallbackQuery();
    await showPresetPicker(ctx, target.symbol, target.direction, true, target.id);
  });

  bot.callbackQuery(/^sp_flip_dir:(\d+):(rh_cheaper|rh_expensive)$/, async (ctx) => {
    const targetId = parseInt(ctx.match[1]!, 10);
    const newDir = ctx.match[2] as SpreadDirection;
    const targets = await getUserSpreadTargets(env.DB, ctx.from!.id);
    const target = targets.find((t) => t.id === targetId);
    if (!target) {
      await ctx.answerCallbackQuery({ text: "Таргет не найден" });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Условие изменено (выберите порог)" });
    await showPresetPicker(ctx, target.symbol, newDir, true, targetId);
  });

  bot.callbackQuery("sp_manage", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, null);
    await ctx.answerCallbackQuery();
    await handleSpreadManage(ctx, true);
  });

  bot.callbackQuery(/^sp_target:(\d+)$/, async (ctx) => {
    const targetId = parseInt(ctx.match[1]!, 10);
    await ctx.answerCallbackQuery();
    await showSpreadTargetCard(ctx, targetId, true);
  });

  bot.callbackQuery(/^sp_del(?:_ask|_confirm)?:(\d+)$/, async (ctx) => {
    const targetId = parseInt(ctx.match[1]!, 10);
    await deleteSpreadTarget(env.DB, ctx.from!.id, targetId);
    await ctx.answerCallbackQuery({ text: "🗑 Таргет удален" });
    await handleSpreadManage(ctx, true);
  });

  bot.callbackQuery(/^sp_tog:(\d+)$/, async (ctx) => {
    const targetId = parseInt(ctx.match[1], 10);
    const targets = await getUserSpreadTargets(env.DB, ctx.from!.id);
    const target = targets.find((t) => t.id === targetId);
    if (!target) {
      await ctx.answerCallbackQuery({ text: "Таргет не найден" });
      return;
    }

    const newActive = target.is_active === 1 ? 0 : 1;
    await toggleSpreadTargetActive(env.DB, ctx.from!.id, targetId, newActive);
    await ctx.answerCallbackQuery({
      text: newActive === 1 ? "▶️ Таргет включен" : "⏸ Таргет поставлен на паузу",
    });
    await showSpreadTargetCard(ctx, targetId, true);
  });

  bot.callbackQuery(/^sp_sym_unmute_card:([A-Za-z0-9._-]+):(\d+)$/, async (ctx) => {
    const symbol = ctx.match[1]!;
    const targetId = parseInt(ctx.match[2]!, 10);
    await setSpreadSymbolMute(env.DB, ctx.from!.id, symbol, 0);
    await setSpreadTargetMute(env.DB, ctx.from!.id, targetId, 0);
    await ctx.answerCallbackQuery({ text: `🔔 Алерты ${symbol} включены` });
    await showSpreadTargetCard(ctx, targetId, true);
  });

  bot.callbackQuery(/^sp_sym_mute:([A-Za-z0-9._-]+):(\d+|off)$/, async (ctx) => {
    const symbol = ctx.match[1];
    const dur = ctx.match[2];
    const nowSec = Math.floor(Date.now() / 1000);

    let mutedUntil = nowSec;
    let label = "";

    if (dur === "off") {
      mutedUntil = CONFIG.MUTE_FOREVER_TIMESTAMP;
      label = `⏸ Все алерты ${symbol} выключены (до включения)`;
    } else {
      const sec = parseInt(dur, 10);
      mutedUntil = nowSec + sec;
      const hours = Math.round(sec / 3600);
      label = `🔕 Все алерты ${symbol} заглушены на ${hours}ч`;
    }

    await setSpreadSymbolMute(env.DB, ctx.from!.id, symbol, mutedUntil);
    await ctx.answerCallbackQuery({ text: label });

    try {
      const unMuteKb = new InlineKeyboard().text(
        `🔔 Включить алерты ${symbol}`,
        `sp_sym_unmute:${symbol}`,
      );
      await ctx.editMessageReplyMarkup({ reply_markup: unMuteKb });
    } catch {}
  });

  bot.callbackQuery(/^sp_sym_unmute:([A-Za-z0-9._-]+)$/, async (ctx) => {
    const symbol = ctx.match[1];
    await setSpreadSymbolMute(env.DB, ctx.from!.id, symbol, 0);
    await ctx.answerCallbackQuery({ text: `🔔 Алерты ${symbol} снова активны` });

    try {
      const kb = getSpreadAlertKeyboard(0, symbol);
      await ctx.editMessageReplyMarkup({ reply_markup: kb });
    } catch {}
  });

  // ==========================================
  // КНОПКИ НИЖНЕЙ КЛАВИАТУРЫ (REPLY KEYBOARD)
  // ==========================================

  bot.hears(["📊 Мои позиции", "Мои позиции", "📊 Мои сделки", "Мои сделки"], async (ctx) => {
    await handlePositions(ctx);
  });

  bot.hears(
    ["📐 Мои таргеты", "Мои таргеты", "📈 Таргеты спреда", "Таргеты спреда"],
    async (ctx) => {
      await handleSpreadMenu(ctx);
    },
  );

  bot.hears(["💼 Мои аккаунты", "Мои аккаунты", "💼 Мои кошельки", "Мои кошельки"], async (ctx) => {
    await handleList(ctx);
  });

  bot.hears(
    ["➕ Добавить кошелек", "➕ Добавить аккаунт", "Добавить кошелек", "Добавить аккаунт"],
    async (ctx) => {
      await startAddWizard(ctx, false);
    },
  );

  bot.hears(["⚙️ Настройки", "Настройки"], async (ctx) => {
    await handleSettingsMain(ctx);
  });

  bot.hears(["📈 Админ статистика", "Админ статистика"], async (ctx) => {
    await handleStats(ctx);
  });

  // ==========================================
  // СПРАВКА И ПОМОЩЬ (/help)
  // ==========================================
  const handleHelp = async (ctx: any) => {
    const helpText =
      `🤖 <b>Lighter Monitor — Справка</b>\n\n` +
      `Бот отслеживает позиции и спред цен на DEX Lighter в двух сетях:\n` +
      `• 🟠 <b>Robinhood Lighter</b> (RH)\n` +
      `• ⚡️ <b>Lighter Mainnet</b>\n\n` +
      `<b>Доступные команды:</b>\n` +
      `• /positions — 📊 Открытые позиции, PnL, маржа и риск ликвидации\n` +
      `• /accounts — 💼 Подключенные аккаунты и управление\n` +
      `• /targets — 📐 Таргеты спреда между Robinhood Lighter и Lighter Core\n` +
      `• /settings — ⚙️ Параметры уведомлений и режим сна\n` +
      `• /changelog — 📋 Что нового в этой версии\n` +
      `• /start — 🚀 Главное меню\n` +
      `• /stats — 📈 Системная статистика (для админа)\n` +
      `• /help — ℹ️ Справка и возможности\n\n` +
      `<b>Как работают алерты:</b>\n` +
      `Крон каждую минуту проверяет цены. Уведомление приходит при движении против позиции (рост риска/просадка) на установленный шаг, либо при достижении таргета спреда.`;

    await ctx.reply(helpText, { parse_mode: "HTML", reply_markup: getMainKb(ctx) });
  };

  bot.command("help", handleHelp);

  // ==========================================
  // СПИСОК ИЗМЕНЕНИЙ И РЕЛИЗЫ (/changelog)
  // ==========================================
  bot.command("changelog", async (ctx) => {
    const text = formatReleaseNotification(APP_VERSION, RELEASE_TITLE, RELEASE_HIGHLIGHTS);
    const keyboard = getChangelogKeyboard(APP_VERSION, env.WEBAPP_URL);
    if (ctx.from?.id) {
      runInBackground(updateUserLastSeenVersion(env.DB, ctx.from.id, APP_VERSION));
    }
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  // ==========================================
  // ДЕФОЛТНЫЙ FALLBACK (ОТВЕТ НА ЛЮБОЙ НЕРАСПОЗНАННЫЙ ТЕКСТ)
  // ==========================================
  bot.on("message:text", async (ctx) => {
    const fallbackText =
      `ℹ️ <b>Команда не распознана.</b>\n\n` +
      `Используйте кнопки меню внизу экрана или стандартные команды:\n` +
      `• /positions — 📊 Мои позиции\n` +
      `• /accounts — 💼 Мои аккаунты\n` +
      `• /targets — 📐 Мои таргеты\n` +
      `• /settings — ⚙️ Настройки\n` +
      `• /changelog — 📋 Что нового\n` +
      `• /start — 🚀 Главное меню\n` +
      `• /stats — 📈 Статистика\n` +
      `• /help — ℹ️ Справка`;
    await ctx.reply(fallbackText, { parse_mode: "HTML", reply_markup: getMainKb(ctx) });
  });

  bot.on("message", async (ctx) => {
    await ctx.reply("ℹ️ Используйте кнопки меню ниже для управления ботом:", {
      reply_markup: getMainKb(ctx),
    });
  });

  botInstance = bot;
  return bot;
}
