import { Bot, InlineKeyboard, Keyboard } from "grammy";
import { Env, PositionRiskAnalysis, LighterNetwork } from "../types";
import { CONFIG, getLighterAuthToken } from "../config";
import { fetchLighterAccountWithStatus, fetchInChunks } from "../lighter/api";
import { analyzePositionRisk } from "../lighter/math";
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
  getSystemStats,
} from "../db/queries";
import { formatPositionsReport } from "./formatters";
import { Tracer } from "../utils/tracer";
import { runInBackground } from "../utils/background";

let botInstance: Bot | null = null;
let currentEnv: Env | null = null;
const knownUsers = new Set<number>();

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

function getSettingsKeyboard(threshold: number, mutedUntil: number): InlineKeyboard {
  const presets = [0.3, 0.5, 0.8, 1.0, 1.5, 2.0];
  const kb = new InlineKeyboard();
  for (let i = 0; i < presets.length; i++) {
    const p = presets[i]!;
    const label = Math.abs(p - threshold) < 0.001 ? `✅ ${p}%` : `${p}%`;
    kb.text(label, `set_thresh_${p}`);
    if (i === 2) kb.row();
  }
  kb.row();
  const isCustom = !presets.some((p) => Math.abs(p - threshold) < 0.001);
  const customLabel = isCustom ? `✏️ Свой % (сейчас ${threshold.toFixed(1)}%)` : `✏️ Ввести свой %`;
  kb.text(customLabel, "custom_threshold");
  kb.row();

  const isMuted = mutedUntil > Math.floor(Date.now() / 1000);
  if (isMuted) {
    kb.text("🔔 Включить уведомления", "settings_unmute");
  } else {
    kb.text("🔕 Заглушить на 4 часа", "settings_mute_4h");
  }
  return kb;
}

export function getStatsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🔄 Обновить", "refresh_stats");
}

export function getMainKeyboard(env?: Env, userId?: number, username?: string): Keyboard {
  const activeEnv = env || currentEnv;
  const isAdmin = activeEnv ? isUserAdmin(activeEnv, userId, username) : false;
  const kb = new Keyboard()
    .text("📊 Мои сделки")
    .text("💼 Мои кошельки")
    .row()
    .text("➕ Добавить кошелек")
    .text("⚙️ Настройки");

  if (isAdmin) {
    kb.row().text("📈 Админ статистика");
  }

  return kb.resized().persistent();
}

async function renderAdminDashboard(env: Env): Promise<string> {
  const stats = await getSystemStats(env.DB);
  const tokenBreakdown =
    stats.topTokens.length > 0
      ? stats.topTokens.map((t) => `  • <b>${t.symbol}:</b> ${t.count} поз.`).join("\n") + "\n"
      : "  • <i>нет открытых сделок</i>\n";

  const nowSec = Math.floor(Date.now() / 1000);
  let cronSection = "";
  if (stats.lastCron) {
    const c = stats.lastCron;
    const cronAgoSec = nowSec - c.timestamp;
    const cronAgoText =
      cronAgoSec < 60 ? `${cronAgoSec} сек назад` : `${Math.round(cronAgoSec / 60)} мин назад`;
    cronSection =
      `⚙️ <b>Последний тик крона (${cronAgoText}):</b>\n` +
      `  • Длительность: <b>${c.duration_ms} мс</b>\n` +
      `  • Subrequests: <b>${c.subrequests_used} / 50</b>\n` +
      `  • Позиций проверено: <b>${c.total_positions_checked}</b> (JIT: <b>${c.jit_checks_performed}</b>)\n` +
      `  • Алертов отправлено: <b>${c.alerts_sent}</b>\n\n`;
  }

  if (
    stats.lastCronError &&
    (!stats.lastCron || stats.lastCronError.timestamp >= stats.lastCron.timestamp)
  ) {
    const errAgoSec = nowSec - stats.lastCronError.timestamp;
    const errAgoText =
      errAgoSec < 60 ? `${errAgoSec} сек назад` : `${Math.round(errAgoSec / 60)} мин назад`;
    cronSection +=
      `⚠️ <b>Сбой в последнем тике крона (${errAgoText}):</b>\n` +
      `  • Ошибка: <code>${stats.lastCronError.error.slice(0, 100)}</code>\n` +
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

  const now = new Date();
  const timeStr = now.toLocaleTimeString("ru-RU", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    `👥 <b>Пользователи и счета:</b>\n` +
    `  • Пользователи: <b>${stats.totalUsers}</b> (новых за 24ч: <b>+${stats.users24h}</b>)\n` +
    `  • Всего кошельков: <b>${stats.totalTracked}</b> (🟠 RH: ${stats.trackedRh} | ⚡️ Mainnet: ${stats.trackedMainnet})\n` +
    `  • Активных счетов: <b>${stats.activeAccountsCount}</b>\n\n` +
    `💰 <b>Объем портфеля:</b>\n` +
    `  • Совокупный залог: <b>$${stats.totalCollateralUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>\n` +
    `  • Открытый интерес (OI): <b>$${stats.totalOpenInterestUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>\n` +
    `  • Позиции: <b>${stats.activePositionsCount}</b> (🟢 Long: ${stats.totalLongs} | 🔴 Short: ${stats.totalShorts})\n` +
    `${tokenBreakdown}\n` +
    `⏱ <b>Здоровье очереди и лаги:</b>\n` +
    `  • Мин. лаг синхронизации: <b>${stats.minQueueLagMinutes} мин.</b>\n` +
    `  • Средний лаг кэша: <b>${stats.avgQueueLagMinutes} мин.</b>\n` +
    `  • Макс. лаг очереди: <b>${stats.maxQueueLagMinutes} мин.</b> <i>(норма &lt; 30–45 мин)</i>\n\n` +
    `${cronSection}` +
    `🔑 <b>Статус API Lighter:</b>\n${authStatusText}\n\n` +
    `🕒 <i>Срез данных: ${timeStr} UTC</i>`
  );
}

export function getBot(env: Env): Bot {
  currentEnv = env;
  if (botInstance) return botInstance;

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const getMainKb = (ctx?: any) => getMainKeyboard(env, ctx?.from?.id, ctx?.from?.username);

  bot.catch((err) => {
    console.error("Unhandled error in bot handler:", err.error || err);
  });

  // Сквозной легковесный трейсинг всех входящих событий Telegram
  bot.use(async (ctx, next) => {
    const trace = new Tracer("telegram_update", {
      updateId: ctx.update?.update_id,
      userId: ctx.from?.id,
      action: ctx.message?.text || ctx.callbackQuery?.data || "other",
    });
    try {
      await next();
    } finally {
      trace.end();
    }
  });

  // Сохранение пользователя в БД при первом взаимодействии в изоляте (в фоне без задержки ответа)
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      const userId = ctx.from.id;
      if (!knownUsers.has(userId)) {
        knownUsers.add(userId);
        runInBackground(
          env.DB.prepare(`
            INSERT INTO users (telegram_id, username, first_name, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET
              username = excluded.username,
              first_name = excluded.first_name
          `)
            .bind(
              userId,
              ctx.from.username || null,
              ctx.from.first_name || null,
              Math.floor(Date.now() / 1000),
            )
            .run(),
        );
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
        `Подключите ваш первый кошелек для мониторинга:`;
      const kb = new InlineKeyboard().text("➕ Подключить аккаунт", "wizard_start_add");
      await ctx.reply(welcomeText, { parse_mode: "HTML", reply_markup: getMainKb(ctx) });
      return ctx.reply("Нажмите кнопку ниже, чтобы начать:", { reply_markup: kb });
    }

    await ctx.reply(
      `👋 <b>С возвращением в Lighter Monitor!</b>\n\n` +
        `Используйте кнопки меню ниже для управления кошельками, просмотра сделок и настройки алертов.`,
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
            reply_markup: new InlineKeyboard().text("💼 Мои кошельки", "action_list"),
          })
          .catch(() => {});
      }
      return ctx.reply(msg, { reply_markup: getMainKb(ctx) });
    }

    const text = `➕ <b>Подключение аккаунта Lighter</b>\n\nВыберите сеть биржи для подключения:`;
    const kb = new InlineKeyboard()
      .text("🟠 Robinhood Lighter", "wizard_net:rh")
      .row()
      .text("⚡️ Lighter Mainnet", "wizard_net:mainnet")
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
    await setUserWizardState(env.DB, ctx.from!.id, { step: "AWAIT_INDEX", network });
    await ctx.answerCallbackQuery();

    const exampleIdx = network === "rh" ? "31704" : "749329";
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
        reply_markup: new InlineKeyboard().text("💼 Мои кошельки", "action_list"),
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
      .text("📊 Показать сделки", "action_positions")
      .row()
      .text("💼 Мои кошельки", "action_list");

    await ctx.reply(
      `🎉 Аккаунт <b>#${state.accountIndex}</b> <code>${netConfig.badge}</code> успешно подключен!\n` +
        `🏷 Имя: ${alias ? `<b>${alias}</b>` : "<i>нет</i>"}\n` +
        `💳 Кошелек: <code>${state.l1Address}</code>\n` +
        `💰 Залог: <b>$${Number(state.collateral).toFixed(2)}</b>\n\n` +
        `Мониторинг активен. Проверка рисков выполняется каждую минуту.`,
      { parse_mode: "HTML", reply_markup: postKb },
    );
  };

  bot.callbackQuery("wizard_skip_alias", async (ctx) => {
    const state = await getUserWizardState(env.DB, ctx.from!.id);
    if (!state || state.step !== "AWAIT_ALIAS") {
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
        "📊 Мои сделки",
        "Мои сделки",
        "📊 Позиции",
        "Позиции",
        "💼 Мои кошельки",
        "Мои кошельки",
        "📋 Аккаунты",
        "Аккаунты",
        "📋 Мои аккаунты",
        "➕ Добавить кошелек",
        "➕ Добавить",
        "Добавить кошелек",
        "⚙️ Настройки",
        "Настройки",
        "⚙️ Порог алертов",
        "Порог алертов",
        "📈 Админ статистика",
        "Админ статистика",
        "👑 Админ-панель",
        "Админ-панель",
        "📊 Статистика",
        "Статистика",
      ].includes(text)
    ) {
      await setUserWizardState(env.DB, ctx.from!.id, null);
      return next();
    }

    const state = await getUserWizardState(env.DB, ctx.from!.id);
    if (!state) return next();

    // 1. Шаг ввода индекса
    if (state.step === "AWAIT_INDEX") {
      const netConfig = CONFIG.NETWORKS[state.network];
      if (!/^\d+$/.test(text)) {
        return ctx.reply(
          `⚠️ Пожалуйста, отправьте только числовой индекс аккаунта (например: <code>${state.network === "rh" ? "31704" : "749329"}</code>):`,
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
          state.network === "mainnet"
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
        step: "AWAIT_ALIAS",
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
          `💳 Кошелек: <code>${shortAddr}</code>\n` +
          `💰 Залог: <b>$${collateral.toFixed(2)}</b>\n\n` +
          `Теперь отправьте понятное имя (алиас), например: <b>Мейн</b> или <b>Хедж</b>:`,
        { parse_mode: "HTML", reply_markup: kb },
      );
    }

    // 2. Шаг ввода алиаса
    if (state.step === "AWAIT_ALIAS") {
      const alias = text.slice(0, 32);
      await completeAccountCreation(ctx, state, alias);
      return;
    }

    // 3. Шаг переименования
    if (state.step === "AWAIT_RENAME") {
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
    if (state.step === "AWAIT_THRESHOLD") {
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
      await ctx.reply(`✅ Шаг цены для алертов установлен на <b>${val.toFixed(1)}%</b>.`, {
        parse_mode: "HTML",
        reply_markup: getMainKb(ctx),
      });
      await handleSettings(ctx);
      return;
    }

    return next();
  });

  // CLI-команда добавления (для совместимости)
  const handleAdd = async (ctx: any, network: LighterNetwork, rawMatch: string) => {
    const args = (rawMatch || "").trim().split(/\s+/).filter(Boolean);
    const indexStr = args[0];
    const alias = args.slice(1).join(" ") || null;
    const netConfig = CONFIG.NETWORKS[network];

    if (!indexStr || !/^\d+$/.test(indexStr)) {
      const cmdName = network === "rh" ? "/add_rh" : "/add_mainnet";
      const exampleIdx = network === "rh" ? "31704" : "749329";
      return ctx.reply(
        `Укажите числовой индекс аккаунта ${netConfig.name}.\n` +
          `Пример: <code>${cmdName} ${exampleIdx} ${alias || "Основной"}</code>`,
        { parse_mode: "HTML" },
      );
    }

    const accountIndex = parseInt(indexStr, 10);
    const countRes = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_tracked_accounts WHERE telegram_id = ?",
    )
      .bind(ctx.from!.id)
      .first<{ cnt: number }>();

    if (countRes && countRes.cnt >= CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER) {
      return ctx.reply(
        `Достигнут лимит: нельзя отслеживать более ${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER} аккаунтов суммарно.`,
        { reply_markup: getMainKb(ctx) },
      );
    }

    await ctx.reply(`Проверяем аккаунт в ${netConfig.name}...`);
    const authToken = getLighterAuthToken(currentEnv || env, network);
    const result = await fetchLighterAccountWithStatus(network, accountIndex, false, authToken);

    if (result.status === "RATE_LIMIT") {
      return ctx.reply(
        `⚠️ Биржа ${netConfig.name} временно перегружена запросами. Попробуйте через 30 секунд.`,
        { reply_markup: getMainKb(ctx) },
      );
    }

    if (!result.account) {
      return ctx.reply(`Аккаунт #${accountIndex} не найден в ${netConfig.name}.`, {
        reply_markup: getMainKb(ctx),
      });
    }

    const account = result.account;
    try {
      await env.DB.prepare(`
        INSERT INTO user_tracked_accounts (telegram_id, network, account_index, alias, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
        .bind(ctx.from!.id, network, accountIndex, alias, Math.floor(Date.now() / 1000))
        .run();

      const activePositions = account.positions.filter(
        (p) => Math.abs(parseFloat(p.position || "0")) > 0,
      );
      const risks = activePositions.map(analyzePositionRisk).filter(Boolean);
      await batchUpdatePositionsCache(env.DB, [
        {
          network,
          account,
          cachedPositions: risks as any,
        },
      ]);
      await syncAccountOpenPositions(env.DB, network, accountIndex, account.positions);

      await ctx.reply(
        `Аккаунт <b>#${accountIndex}</b> добавлен в <b>${netConfig.name}</b> <code>${netConfig.badge}</code>.\n` +
          `Алиас: ${alias ? `<b>${alias}</b>` : "<i>нет</i>"}\n` +
          `Кошелек: <code>${account.l1_address}</code>\n\n` +
          `Мониторинг активен.`,
        { parse_mode: "HTML", reply_markup: getMainKb(ctx) },
      );
    } catch (e: any) {
      if (e?.message && e.message.includes("UNIQUE")) {
        return ctx.reply(`Вы уже отслеживаете аккаунт #${accountIndex} в сети ${netConfig.name}.`, {
          reply_markup: getMainKb(ctx),
        });
      }
      throw e;
    }
  };

  bot.command("add_rh", async (ctx) => {
    await handleAdd(ctx, "rh", ctx.match);
  });

  bot.command("add_mainnet", async (ctx) => {
    await handleAdd(ctx, "mainnet", ctx.match);
  });

  bot.command("add", async (ctx) => {
    const rawMatch = ctx.match ? ctx.match.trim() : "";
    const args = rawMatch.split(/\s+/).filter(Boolean);
    const firstArg = args[0]?.toLowerCase();

    if (firstArg === "rh" || firstArg === "robinhood") {
      await handleAdd(ctx, "rh", args.slice(1).join(" "));
    } else if (firstArg === "mainnet" || firstArg === "main") {
      await handleAdd(ctx, "mainnet", args.slice(1).join(" "));
    } else if (firstArg && /^\d+$/.test(firstArg)) {
      await handleAdd(ctx, "rh", rawMatch);
    } else {
      await startAddWizard(ctx);
    }
  });

  // CLI-команда удаления (для совместимости)
  const handleRemove = async (ctx: any, network: LighterNetwork, rawMatch: string) => {
    const indexStr = (rawMatch || "").trim();
    const netConfig = CONFIG.NETWORKS[network];

    if (!indexStr || !/^\d+$/.test(indexStr)) {
      const cmdName = network === "rh" ? "/remove_rh" : "/remove_mainnet";
      return ctx.reply(
        `Укажите индекс для удаления из ${netConfig.name}: <code>${cmdName} 31704</code>`,
        { parse_mode: "HTML" },
      );
    }

    const accountIndex = parseInt(indexStr, 10);
    const removed = await removeTrackedAccount(env.DB, ctx.from!.id, network, accountIndex);

    if (!removed) {
      return ctx.reply(
        `Аккаунт #${accountIndex} не найден среди ваших отслеживаемых в ${netConfig.name}.`,
        { reply_markup: getMainKb(ctx) },
      );
    }

    await ctx.reply(
      `Аккаунт #${accountIndex} <code>${netConfig.badge}</code> удален из отслеживания.`,
      { parse_mode: "HTML", reply_markup: getMainKb(ctx) },
    );
  };

  bot.command("remove_rh", async (ctx) => {
    await handleRemove(ctx, "rh", ctx.match);
  });

  bot.command("remove_mainnet", async (ctx) => {
    await handleRemove(ctx, "mainnet", ctx.match);
  });

  bot.command("remove", async (ctx) => {
    const rawMatch = ctx.match ? ctx.match.trim() : "";
    const args = rawMatch.split(/\s+/).filter(Boolean);
    const firstArg = args[0]?.toLowerCase();

    if (firstArg === "rh") {
      await handleRemove(ctx, "rh", args.slice(1).join(" "));
    } else if (firstArg === "mainnet") {
      await handleRemove(ctx, "mainnet", args.slice(1).join(" "));
    } else {
      await handleList(ctx);
    }
  });

  // ==========================================
  // ИНТЕРАКТИВНОЕ УПРАВЛЕНИЕ КОШЕЛЬКАМИ
  // ==========================================

  const showAccountCard = async (
    ctx: any,
    network: LighterNetwork,
    accountIndex: number,
    isEdit: boolean = true,
  ) => {
    const accRow = await env.DB.prepare(
      "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? AND network = ? AND account_index = ?",
    )
      .bind(ctx.from!.id, network, accountIndex)
      .first<{ network: LighterNetwork; account_index: number; alias: string | null }>();

    if (!accRow) {
      const notFoundMsg = `Аккаунт #${accountIndex} не найден среди ваших отслеживаемых.`;
      if (isEdit) {
        return ctx
          .editMessageText(notFoundMsg, {
            reply_markup: new InlineKeyboard().text("💼 Мои кошельки", "action_list"),
          })
          .catch(() => {});
      }
      return ctx.reply(notFoundMsg, { reply_markup: getMainKb(ctx) });
    }

    const cacheRow = await env.DB.prepare(
      "SELECT * FROM account_positions_cache WHERE network = ? AND account_index = ?",
    )
      .bind(network, accountIndex)
      .first<any>();

    const netConfig = CONFIG.NETWORKS[network];
    const shortAddr = cacheRow?.l1_address
      ? `${cacheRow.l1_address.slice(0, 6)}...${cacheRow.l1_address.slice(-4)}`
      : "—";
    const collateral = parseFloat(String(cacheRow?.collateral || 0));

    let positionsCount = 0;
    let symbolsSummary = "";
    if (cacheRow?.positions_json) {
      try {
        const parsed = JSON.parse(cacheRow.positions_json) as any[];
        const active = parsed.filter((p) => Math.abs(parseFloat(p.position || p.size || "0")) > 0);
        positionsCount = active.length;
        if (positionsCount > 0) {
          const syms = active.map((p) => p.symbol).filter(Boolean);
          symbolsSummary = ` (${syms.join(", ")})`;
        }
      } catch {}
    }

    const card =
      `💼 <b>Управление аккаунтом #${accountIndex}</b> <code>${netConfig.badge}</code>\n\n` +
      `🏷 <b>Имя:</b> ${accRow.alias ? `<b>${accRow.alias}</b>` : "<i>не задано</i>"}\n` +
      `💳 <b>Кошелек:</b> <code>${shortAddr}</code>\n` +
      `💰 <b>Залог:</b> $${collateral.toFixed(2)}\n` +
      `📊 <b>Открытых сделок:</b> ${positionsCount}${symbolsSummary}\n`;

    const kb = new InlineKeyboard()
      .text("📊 Сделки", `refresh:${network}:${accountIndex}`)
      .text("✏️ Сменить имя", `rename_acc:${network}:${accountIndex}`)
      .row()
      .text("🗑 Удалить из бота", `confirm_del_acc:${network}:${accountIndex}`)
      .row()
      .text("⬅️ К списку кошельков", "action_list");

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
    await setUserWizardState(env.DB, ctx.from!.id, { step: "AWAIT_RENAME", network, accountIndex });
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

  // Функция вывода списка кошельков /list
  const handleList = async (ctx: any, isEdit: boolean = false) => {
    const trace = new Tracer("handle_list", { userId: ctx.from?.id, isEdit });
    try {
      const { results } = await env.DB.prepare(`
        SELECT network, account_index, alias 
        FROM user_tracked_accounts 
        WHERE telegram_id = ? 
        ORDER BY network ASC, id ASC
      `)
        .bind(ctx.from!.id)
        .all<{ network: LighterNetwork; account_index: number; alias: string | null }>();
      trace.mark("d1_query");

      if (!results || results.length === 0) {
        const emptyText =
          `👋 <b>Добро пожаловать в Lighter Monitor!</b>\n\n` +
          `Бот отслеживает ваши позиции на <b>Robinhood Lighter</b> и <b>Lighter Mainnet</b>, ` +
          `рассчитывает риски и защищает от ликвидации.\n\n` +
          `У вас пока нет подключенных кошельков. Давайте подключим первый:`;
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
        const netIcon = r.network === "rh" ? "🟠" : "⚡️";
        const aliasStr = r.alias ? ` (${r.alias})` : "";
        const label = `${netIcon} #${r.account_index}${aliasStr}`;
        kb.text(label, `manage_acc:${r.network}:${r.account_index}`).row();
      }
      kb.text("➕ Добавить кошелек", "wizard_start_add").text("🔄 Обновить", "refresh_list");

      const now = new Date();
      const timeStr = now.toLocaleTimeString("ru-RU", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const msg =
        `📋 <b>Ваши отслеживаемые кошельки (${results.length}/${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER}):</b>\n\n` +
        `Нажмите на кошелек для управления:\n\n` +
        `🕒 <i>Обновлено: ${timeStr} UTC</i>`;

      trace.mark("render");
      trace.set("accountCount", results.length);

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
      trace.mark("telegram_send");
    } finally {
      trace.end();
    }
  };

  bot.command("list", (ctx) => handleList(ctx));
  bot.command("accounts", (ctx) => handleList(ctx));
  bot.command("wallets", (ctx) => handleList(ctx));

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
    const trace = new Tracer("handle_positions", {
      userId: ctx.from?.id,
      forceRefresh,
      filterIndex,
      filterNetwork,
    });

    try {
      let trackedList: Array<{
        network: LighterNetwork;
        account_index: number;
        alias: string | null;
      }> = [];

      if (filterIndex) {
        if (filterNetwork) {
          const { results } = await env.DB.prepare(
            "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? AND network = ? AND account_index = ?",
          )
            .bind(ctx.from!.id, filterNetwork, filterIndex)
            .all<{ network: LighterNetwork; account_index: number; alias: string | null }>();
          trackedList =
            results && results.length > 0
              ? results
              : [{ network: filterNetwork, account_index: filterIndex, alias: null }];
        } else {
          const { results } = await env.DB.prepare(
            "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? AND account_index = ?",
          )
            .bind(ctx.from!.id, filterIndex)
            .all<{ network: LighterNetwork; account_index: number; alias: string | null }>();
          trackedList = results || [];
          if (trackedList.length === 0) {
            trackedList = [
              { network: "rh", account_index: filterIndex, alias: null },
              { network: "mainnet", account_index: filterIndex, alias: null },
            ];
          }
        }
      } else {
        const { results } = await env.DB.prepare(
          "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? ORDER BY network ASC, id ASC",
        )
          .bind(ctx.from!.id)
          .all<{ network: LighterNetwork; account_index: number; alias: string | null }>();
        trackedList = results || [];
      }

      trace.mark("d1_load_tracked");

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
          `У вас пока нет подключенных кошельков. Давайте подключим первый:`;
        const emptyKb = new InlineKeyboard().text("➕ Подключить аккаунт", "wizard_start_add");
        if (isEdit) {
          return ctx
            .editMessageText(emptyText, { parse_mode: "HTML", reply_markup: emptyKb })
            .catch(() => {});
        }
        return ctx.reply(emptyText, { parse_mode: "HTML", reply_markup: emptyKb });
      }

      // Загрузка кэша из D1
      const cacheMap = new Map<string, any>();
      if (trackedList.length > 0) {
        if (!filterIndex) {
          const { results: cachedRows } = await env.DB.prepare(`
            SELECT c.* 
            FROM account_positions_cache c
            JOIN user_tracked_accounts uta 
              ON c.network = uta.network AND c.account_index = uta.account_index
            WHERE uta.telegram_id = ?
          `)
            .bind(ctx.from!.id)
            .all<any>();

          if (cachedRows) {
            for (const row of cachedRows) {
              cacheMap.set(`${row.network}:${row.account_index}`, row);
            }
          }
        } else {
          const rows = await Promise.all(
            trackedList.map((item) =>
              env.DB.prepare(
                "SELECT * FROM account_positions_cache WHERE network = ? AND account_index = ?",
              )
                .bind(item.network, item.account_index)
                .first<any>(),
            ),
          );
          for (const row of rows) {
            if (row) {
              cacheMap.set(`${row.network}:${row.account_index}`, row);
            }
          }
        }
      }

      trace.mark("d1_load_cache");

      const nowSec = Math.floor(Date.now() / 1000);
      let isRateLimited = false;

      // При клике "🔄 Обновить" (forceRefresh === true) ВСЕГДА опрашиваем биржу напрямую без ограничений.
      // В обычном режиме (/positions или меню) опрашиваем биржу, если кэш старше 5 секунд, либо отдаем из D1.
      const toFetch = forceRefresh
        ? trackedList
        : trackedList.filter((item) => {
            const key = `${item.network}:${item.account_index}`;
            const c = cacheMap.get(key);
            return !c || !c.l1_address || !c.last_updated_at || nowSec - c.last_updated_at >= 5;
          });

      const freshMap = new Map<string, any>();
      trace.set("toFetchCount", toFetch.length);
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
        trace.mark("lighter_api_fetch");
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
                cachedPositions: acc.positions.map(analyzePositionRisk).filter(Boolean),
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
          runInBackground(
            Promise.all([
              ...syncPromises,
              batchUpdatePositionsCache(env.DB, updates).catch((e) =>
                console.error("Cache update error:", e),
              ),
            ]),
          );
          trace.mark("d1_sync_and_cache_dispatched");
        }
      }

      const userThreshold = await getUserThreshold(env.DB, ctx.from.id);
      let totalUnPnl = 0;
      let totalCollateral = 0;
      const cards: string[] = [];

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
        } else if (cached && cached.l1_address && cached.positions_json) {
          const parsedPositions = JSON.parse(cached.positions_json) as any[];
          accPositions = parsedPositions
            .map((p: any) => {
              if (p.marketId !== undefined && p.tier !== undefined) {
                return p as PositionRiskAnalysis;
              }
              return analyzePositionRisk(p);
            })
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
        const separator = "\n───────────────────\n";
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
          let oldestCacheSec = nowSec;
          for (const item of trackedList) {
            const c = cacheMap.get(`${item.network}:${item.account_index}`);
            if (c?.last_updated_at && c.last_updated_at < oldestCacheSec) {
              oldestCacheSec = c.last_updated_at;
            }
          }
          const cacheDate = new Date(oldestCacheSec * 1000);
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
        trace.mark("calc_and_render");
        trace.set("cardsCount", cards.length);

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
          trace.mark("telegram_send");
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
        trace.mark("telegram_send");
      } else if (filterIndex) {
        await ctx.reply(`Аккаунт #${filterIndex} не найден ни в одной из поддерживаемых сетей.`, {
          reply_markup: getMainKb(ctx),
        });
        trace.mark("telegram_send");
      }
    } finally {
      trace.end();
    }
  };

  bot.command("positions", async (ctx) => {
    const arg = ctx.match ? ctx.match.trim() : "";
    const filter = arg && /^\d+$/.test(arg) ? parseInt(arg, 10) : undefined;
    await handlePositions(ctx, filter);
  });

  bot.command("deals", async (ctx) => {
    await handlePositions(ctx);
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

  const handleSettings = async (ctx: any, isEdit: boolean = false) => {
    const settings = await getUserSettings(env.DB, ctx.from!.id);
    const nowSec = Math.floor(Date.now() / 1000);
    const isMuted = settings.mutedUntil > nowSec;

    let muteText = "🔔 <b>Уведомления:</b> Активны";
    if (isMuted) {
      const remainingMinutes = Math.ceil((settings.mutedUntil - nowSec) / 60);
      const muteUntilDate = new Date(settings.mutedUntil * 1000);
      const timeStr = muteUntilDate.toLocaleTimeString("ru-RU", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
      });
      muteText = `🔕 <b>Уведомления заглушены:</b> еще ${remainingMinutes} мин (до ${timeStr} UTC)`;
    }

    const text =
      `⚙️ <b>Настройки Lighter Monitor</b>\n\n` +
      `🎯 <b>Шаг цены для алертов:</b> <b>${settings.alertThreshold.toFixed(1)}%</b>\n` +
      `<i>(Для золота XAU на плече 15–25x рекомендуется 0.3%–0.5%)</i>\n\n` +
      `${muteText}\n\n` +
      `Выберите шаг цены или режим сна:`;

    const kb = getSettingsKeyboard(settings.alertThreshold, settings.mutedUntil);
    if (isEdit) {
      try {
        return await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch {}
    }
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  };

  bot.command("threshold", async (ctx) => {
    const arg = ctx.match ? ctx.match.trim() : "";
    if (arg) {
      const cleaned = arg.replace(",", ".");
      const val = parseFloat(cleaned);
      if (isNaN(val) || val < CONFIG.MIN_ALERT_THRESHOLD || val > CONFIG.MAX_ALERT_THRESHOLD) {
        return ctx.reply(
          `Укажите процент от ${CONFIG.MIN_ALERT_THRESHOLD}% до ${CONFIG.MAX_ALERT_THRESHOLD}%.\n` +
            `Пример: <code>/threshold 0.5</code>`,
          { parse_mode: "HTML" },
        );
      }
      await setUserThreshold(env.DB, ctx.from!.id, val);
      return ctx.reply(`Шаг цены для алертов установлен на <b>${val.toFixed(1)}%</b>.`, {
        parse_mode: "HTML",
        reply_markup: getMainKb(ctx),
      });
    }
    await handleSettings(ctx);
  });

  bot.command("settings", async (ctx) => {
    await handleSettings(ctx);
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

  bot.command(["stats", "admin"], handleStats);

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
    await setUserWizardState(env.DB, ctx.from!.id, { step: "AWAIT_THRESHOLD" });
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text("❌ Отмена", "action_threshold");
    await ctx.editMessageText(
      `✏️ <b>Настройка шага цены для алертов</b>\n\n` +
        `Отправьте желаемый шаг цены числом в чат:\n` +
        `<i>(от <b>${CONFIG.MIN_ALERT_THRESHOLD}%</b> до <b>${CONFIG.MAX_ALERT_THRESHOLD}%</b>, например: <b>0.4</b> или <b>0.7</b>)</i>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery("action_threshold", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, null);
    await ctx.answerCallbackQuery();
    await handleSettings(ctx, true);
  });

  bot.callbackQuery(/^set_thresh_(\d+(\.\d+)?)$/, async (ctx) => {
    const val = parseFloat(ctx.match[1]);
    await setUserWizardState(env.DB, ctx.from!.id, null);
    await setUserThreshold(env.DB, ctx.from!.id, val);
    await ctx.answerCallbackQuery({ text: `Шаг установлен: ${val}%` });
    await handleSettings(ctx, true);
  });

  bot.callbackQuery("settings_mute_4h", async (ctx) => {
    const mutedUntil = Math.floor(Date.now() / 1000) + 4 * 3600;
    await setUserMute(env.DB, ctx.from!.id, mutedUntil);
    await ctx.answerCallbackQuery({ text: "🔕 Уведомления заглушены на 4 часа" });
    await handleSettings(ctx, true);
  });

  bot.callbackQuery("settings_unmute", async (ctx) => {
    await setUserMute(env.DB, ctx.from!.id, 0);
    await ctx.answerCallbackQuery({ text: "🔔 Уведомления включены" });
    await handleSettings(ctx, true);
  });

  // ==========================================
  // КНОПКИ НИЖНЕЙ КЛАВИАТУРЫ (REPLY KEYBOARD)
  // ==========================================

  bot.hears(["📊 Мои сделки", "Мои сделки", "📊 Позиции", "Позиции"], async (ctx) => {
    await handlePositions(ctx);
  });

  bot.hears(
    ["💼 Мои кошельки", "Мои кошельки", "📋 Аккаунты", "Аккаунты", "📋 Мои аккаунты"],
    async (ctx) => {
      await handleList(ctx);
    },
  );

  bot.hears(["➕ Добавить кошелек", "➕ Добавить", "Добавить кошелек"], async (ctx) => {
    await startAddWizard(ctx);
  });

  bot.hears(["⚙️ Настройки", "Настройки", "⚙️ Порог алертов", "Порог алертов"], async (ctx) => {
    await handleSettings(ctx);
  });

  bot.hears(
    [
      "📈 Админ статистика",
      "Админ статистика",
      "👑 Админ-панель",
      "Админ-панель",
      "📊 Статистика",
      "Статистика",
    ],
    async (ctx) => {
      await handleStats(ctx);
    },
  );

  // ==========================================
  // СПРАВКА И ПОМОЩЬ (/help, /menu)
  // ==========================================
  const handleHelp = async (ctx: any) => {
    const helpText =
      `🤖 <b>Lighter Monitor — Справка</b>\n\n` +
      `Бот отслеживает ваши позиции на DEX Lighter в двух сетях:\n` +
      `• 🟠 <b>Robinhood Lighter</b> (RH)\n` +
      `• ⚡️ <b>Lighter Mainnet</b>\n\n` +
      `<b>Основные команды:</b>\n` +
      `• /positions (или 📊 Мои сделки) — сводка по всем открытым позициям, PnL, марже и расстоянию до ликвидации\n` +
      `• /list (или 💼 Мои кошельки) — список подключенных аккаунтов с управлением\n` +
      `• /add — подключение кошелька\n` +
      `• /threshold — настройка шага цены для алертов (по умолчанию 0.5%)\n` +
      `• /settings — параметры уведомлений и режим сна\n` +
      `• /stats — системная статистика и метрики\n\n` +
      `<b>Как работают алерты:</b>\n` +
      `Крон каждую минуту проверяет цены. Уведомление приходит только при движении против позиции (рост риска/просадка) на установленный шаг. При прибыли бот не спамит.`;

    await ctx.reply(helpText, { parse_mode: "HTML", reply_markup: getMainKb(ctx) });
  };

  bot.command(["help", "menu"], handleHelp);

  // ==========================================
  // ДЕФОЛТНЫЙ FALLBACK (ОТВЕТ НА ЛЮБОЙ НЕРАСПОЗНАННЫЙ ТЕКСТ)
  // ==========================================
  bot.on("message:text", async (ctx) => {
    const fallbackText =
      `ℹ️ <b>Команда не распознана.</b>\n\n` +
      `Используйте кнопки меню внизу экрана или стандартные команды:\n` +
      `• /positions — 📊 Открытые сделки и риски\n` +
      `• /list — 💼 Мои кошельки\n` +
      `• /add — ➕ Добавить кошелек\n` +
      `• /threshold — ⚙️ Шаг цены для алертов\n` +
      `• /help — ℹ️ Подробная справка`;
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
