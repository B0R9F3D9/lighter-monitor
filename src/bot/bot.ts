import { Bot, InlineKeyboard, Keyboard } from "grammy";
import { Env, PositionRiskAnalysis, LighterNetwork } from "../types";
import { CONFIG } from "../config";
import { fetchLighterAccount, fetchLighterAccountWithStatus } from "../lighter/api";
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
  removeTrackedAccount
} from "../db/queries";
import { formatPositionsReport } from "./formatters";

let botInstance: Bot | null = null;
const knownUsers = new Set<number>();

export function getBot(env: Env): Bot {
  if (botInstance) return botInstance;

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Основная нижняя клавиатура пользователя (Zero-CLI Reply Keyboard)
  const replyKeyboard = new Keyboard()
    .text("📊 Мои сделки").text("💼 Мои кошельки")
    .row()
    .text("➕ Добавить кошелек").text("⚙️ Настройки")
    .resized()
    .persistent();

  const mainKeyboard = replyKeyboard;

  // Сохранение пользователя в БД при первом взаимодействии в изоляте (защита от лишних D1 записей)
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      const userId = ctx.from.id;
      if (!knownUsers.has(userId)) {
        await env.DB.prepare(`
          INSERT INTO users (telegram_id, username, first_name, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(telegram_id) DO UPDATE SET
            username = excluded.username,
            first_name = excluded.first_name
        `).bind(
          userId,
          ctx.from.username || null,
          ctx.from.first_name || null,
          Math.floor(Date.now() / 1000)
        ).run();
        knownUsers.add(userId);
      }
    }
    return next();
  });

  // /start
  bot.command("start", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, null);

    const countRes = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_tracked_accounts WHERE telegram_id = ?"
    ).bind(ctx.from!.id).first<{ cnt: number }>();

    if (!countRes || countRes.cnt === 0) {
      const welcomeText = 
        `👋 <b>Добро пожаловать в Lighter Monitor!</b>\n\n` +
        `Бот в реальном времени мониторит ваши позиции на <b>Robinhood Lighter</b> и <b>Lighter Mainnet</b>, ` +
        `рассчитывает риски ликвидации и присылает сигналы при импульсах цены.\n\n` +
        `• <b>Zero-CLI:</b> Управляйте кошельками и сделками кнопками ниже.\n` +
        `• <b>XAU 15x–25x:</b> 3-слойные алерты с мгновенным переходом на биржу.\n\n` +
        `Подключите ваш первый кошелек для мониторинга:`;
      const kb = new InlineKeyboard().text("➕ Подключить аккаунт", "wizard_start_add");
      await ctx.reply(welcomeText, { parse_mode: "HTML", reply_markup: mainKeyboard });
      return ctx.reply("Нажмите кнопку ниже, чтобы начать:", { reply_markup: kb });
    }

    await ctx.reply(
      `👋 <b>С возвращением в Lighter Monitor!</b>\n\n` +
      `Используйте кнопки меню ниже для управления кошельками, просмотра сделок и настройки алертов.`,
      { parse_mode: "HTML", reply_markup: mainKeyboard }
    );
  });

  // ==========================================
  // ВИЗАРД ДОБАВЛЕНИЯ АККАУНТА (ПОШАГОВЫЙ)
  // ==========================================

  const startAddWizard = async (ctx: any, isEdit: boolean = false) => {
    await setUserWizardState(env.DB, ctx.from!.id, null);

    const countRes = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_tracked_accounts WHERE telegram_id = ?"
    ).bind(ctx.from!.id).first<{ cnt: number }>();

    if (countRes && countRes.cnt >= CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER) {
      const msg = `⚠️ Достигнут лимит: нельзя отслеживать более ${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER} аккаунтов.`;
      if (isEdit) {
        return ctx.editMessageText(msg, { reply_markup: new InlineKeyboard().text("💼 Мои кошельки", "action_list") }).catch(() => {});
      }
      return ctx.reply(msg, { reply_markup: mainKeyboard });
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

    const exampleIdx = network === 'rh' ? "31704" : "749329";
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
        reply_markup: new InlineKeyboard().text("💼 Мои кошельки", "action_list")
      });
    } catch {
      await ctx.reply("❌ Действие отменено.", { reply_markup: mainKeyboard });
    }
  });

  const completeAccountCreation = async (ctx: any, state: any, alias: string | null) => {
    const netConfig = CONFIG.NETWORKS[state.network as LighterNetwork];
    const now = Math.floor(Date.now() / 1000);

    try {
      await env.DB.prepare(`
        INSERT INTO user_tracked_accounts (telegram_id, network, account_index, alias, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(ctx.from!.id, state.network, state.accountIndex, alias, now).run();

      const activePositions = (state.positions || []).filter((p: any) => Math.abs(parseFloat(p.position || p.size || "0")) > 0);
      const risks = activePositions.map(analyzePositionRisk).filter(Boolean);
      await batchUpdatePositionsCache(env.DB, [{
        network: state.network,
        account: {
          index: state.accountIndex,
          l1_address: state.l1Address,
          collateral: String(state.collateral),
          available_balance: "0",
          total_asset_value: "0",
          positions: state.positions || []
        } as any,
        cachedPositions: risks as any
      }]);
      await syncAccountOpenPositions(env.DB, state.network, state.accountIndex, state.positions || []);
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
      { parse_mode: "HTML", reply_markup: postKb }
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
    if (text.startsWith("/") || 
        ["📊 Мои сделки", "Мои сделки", "📊 Позиции", "Позиции", 
         "💼 Мои кошельки", "Мои кошельки", "📋 Аккаунты", "Аккаунты", "📋 Мои аккаунты",
         "➕ Добавить кошелек", "➕ Добавить", "Добавить кошелек",
         "⚙️ Настройки", "Настройки", "⚙️ Порог алертов", "Порог алертов"].includes(text)) {
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
          `⚠️ Пожалуйста, отправьте только числовой индекс аккаунта (например: <code>${state.network === 'rh' ? '31704' : '749329'}</code>):`,
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("❌ Отмена", "wizard_cancel") }
        );
      }
      const accountIndex = parseInt(text, 10);

      const exists = await env.DB.prepare(
        "SELECT 1 FROM user_tracked_accounts WHERE telegram_id = ? AND network = ? AND account_index = ?"
      ).bind(ctx.from!.id, state.network, accountIndex).first();

      if (exists) {
        await setUserWizardState(env.DB, ctx.from!.id, null);
        return ctx.reply(
          `Вы уже отслеживаете аккаунт #${accountIndex} в сети ${netConfig.name}.`,
          { reply_markup: mainKeyboard }
        );
      }

      await ctx.reply(`🔍 Проверяем аккаунт #${accountIndex} в ${netConfig.name}...`);
      const result = await fetchLighterAccountWithStatus(state.network, accountIndex);

      if (result.status === 'RATE_LIMIT') {
        return ctx.reply(
          `⚠️ API ${netConfig.name} временно ограничивает запросы (Rate Limit 429). Попробуйте через 30 секунд.`,
          { reply_markup: new InlineKeyboard().text("❌ Отмена", "wizard_cancel") }
        );
      }

      if (!result.account) {
        const explorerLink = state.network === 'mainnet'
          ? `\nПроверьте индекс: https://app.lighter.xyz/explorer/accounts/${accountIndex}`
          : '';
        return ctx.reply(
          `⚠️ Аккаунт #${accountIndex} не найден в сети ${netConfig.name}.${explorerLink}\n\nПроверьте цифры и попробуйте снова:`,
          { reply_markup: new InlineKeyboard().text("❌ Отмена", "wizard_cancel") }
        );
      }

      const acc = result.account;
      const shortAddr = acc.l1_address ? `${acc.l1_address.slice(0, 6)}...${acc.l1_address.slice(-4)}` : "—";
      const collateral = parseFloat(acc.collateral || "0");

      await setUserWizardState(env.DB, ctx.from!.id, {
        step: "AWAIT_ALIAS",
        network: state.network,
        accountIndex,
        l1Address: acc.l1_address,
        collateral,
        positions: acc.positions || []
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
        { parse_mode: "HTML", reply_markup: kb }
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
      await ctx.reply(
        `✅ Имя аккаунта #${state.accountIndex} изменено на <b>${newAlias}</b>.`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
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
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("❌ Отмена", "action_threshold") }
        );
      }
      await setUserThreshold(env.DB, ctx.from!.id, val);
      await setUserWizardState(env.DB, ctx.from!.id, null);
      await ctx.reply(
        `✅ Шаг цены для алертов установлен на <b>${val.toFixed(1)}%</b>.`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
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
      const cmdName = network === 'rh' ? '/add_rh' : '/add_mainnet';
      const exampleIdx = network === 'rh' ? '31704' : '749329';
      return ctx.reply(
        `Укажите числовой индекс аккаунта ${netConfig.name}.\n` +
        `Пример: <code>${cmdName} ${exampleIdx} ${alias || "Основной"}</code>`, 
        { parse_mode: "HTML" }
      );
    }

    const accountIndex = parseInt(indexStr, 10);
    const countRes = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_tracked_accounts WHERE telegram_id = ?"
    ).bind(ctx.from!.id).first<{ cnt: number }>();

    if (countRes && countRes.cnt >= CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER) {
      return ctx.reply(
        `Достигнут лимит: нельзя отслеживать более ${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER} аккаунтов суммарно.`,
        { reply_markup: mainKeyboard }
      );
    }

    await ctx.reply(`Проверяем аккаунт в ${netConfig.name} API...`);
    const result = await fetchLighterAccountWithStatus(network, accountIndex);

    if (result.status === 'RATE_LIMIT') {
      return ctx.reply(
        `⚠️ API ${netConfig.name} временно ограничивает запросы (Rate Limit 429). Повторите через 30–60 секунд.`,
        { reply_markup: mainKeyboard }
      );
    }

    if (!result.account) {
      return ctx.reply(`Аккаунт #${accountIndex} не найден в ${netConfig.name}.`, { reply_markup: mainKeyboard });
    }

    const account = result.account;
    try {
      await env.DB.prepare(`
        INSERT INTO user_tracked_accounts (telegram_id, network, account_index, alias, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(ctx.from!.id, network, accountIndex, alias, Math.floor(Date.now() / 1000)).run();

      const activePositions = account.positions.filter(p => Math.abs(parseFloat(p.position || "0")) > 0);
      const risks = activePositions.map(analyzePositionRisk).filter(Boolean);
      await batchUpdatePositionsCache(env.DB, [{
        network,
        account,
        cachedPositions: risks as any
      }]);
      await syncAccountOpenPositions(env.DB, network, accountIndex, account.positions);

      await ctx.reply(
        `Аккаунт <b>#${accountIndex}</b> добавлен в <b>${netConfig.name}</b> <code>${netConfig.badge}</code>.\n` +
        `Алиас: ${alias ? `<b>${alias}</b>` : "<i>нет</i>"}\n` +
        `Кошелек: <code>${account.l1_address}</code>\n\n` +
        `Мониторинг активен.`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    } catch (e: any) {
      if (e?.message && e.message.includes("UNIQUE")) {
        return ctx.reply(
          `Вы уже отслеживаете аккаунт #${accountIndex} в сети ${netConfig.name}.`,
          { reply_markup: mainKeyboard }
        );
      }
      throw e;
    }
  };

  bot.command("add_rh", async (ctx) => {
    await handleAdd(ctx, 'rh', ctx.match);
  });

  bot.command("add_mainnet", async (ctx) => {
    await handleAdd(ctx, 'mainnet', ctx.match);
  });

  bot.command("add", async (ctx) => {
    const rawMatch = ctx.match ? ctx.match.trim() : "";
    const args = rawMatch.split(/\s+/).filter(Boolean);
    const firstArg = args[0]?.toLowerCase();

    if (firstArg === "rh" || firstArg === "robinhood") {
      await handleAdd(ctx, 'rh', args.slice(1).join(" "));
    } else if (firstArg === "mainnet" || firstArg === "main") {
      await handleAdd(ctx, 'mainnet', args.slice(1).join(" "));
    } else if (firstArg && /^\d+$/.test(firstArg)) {
      await handleAdd(ctx, 'rh', rawMatch);
    } else {
      await startAddWizard(ctx);
    }
  });

  // CLI-команда удаления (для совместимости)
  const handleRemove = async (ctx: any, network: LighterNetwork, rawMatch: string) => {
    const indexStr = (rawMatch || "").trim();
    const netConfig = CONFIG.NETWORKS[network];

    if (!indexStr || !/^\d+$/.test(indexStr)) {
      const cmdName = network === 'rh' ? '/remove_rh' : '/remove_mainnet';
      return ctx.reply(
        `Укажите индекс для удаления из ${netConfig.name}: <code>${cmdName} 31704</code>`, 
        { parse_mode: "HTML" }
      );
    }

    const accountIndex = parseInt(indexStr, 10);
    const removed = await removeTrackedAccount(env.DB, ctx.from!.id, network, accountIndex);

    if (!removed) {
      return ctx.reply(
        `Аккаунт #${accountIndex} не найден среди ваших отслеживаемых в ${netConfig.name}.`,
        { reply_markup: mainKeyboard }
      );
    }

    await ctx.reply(
      `Аккаунт #${accountIndex} <code>${netConfig.badge}</code> удален из отслеживания.`, 
      { parse_mode: "HTML", reply_markup: mainKeyboard }
    );
  };

  bot.command("remove_rh", async (ctx) => {
    await handleRemove(ctx, 'rh', ctx.match);
  });

  bot.command("remove_mainnet", async (ctx) => {
    await handleRemove(ctx, 'mainnet', ctx.match);
  });

  bot.command("remove", async (ctx) => {
    const rawMatch = ctx.match ? ctx.match.trim() : "";
    const args = rawMatch.split(/\s+/).filter(Boolean);
    const firstArg = args[0]?.toLowerCase();

    if (firstArg === "rh") {
      await handleRemove(ctx, 'rh', args.slice(1).join(" "));
    } else if (firstArg === "mainnet") {
      await handleRemove(ctx, 'mainnet', args.slice(1).join(" "));
    } else {
      await handleList(ctx);
    }
  });

  // ==========================================
  // ИНТЕРАКТИВНОЕ УПРАВЛЕНИЕ КОШЕЛЬКАМИ
  // ==========================================

  const showAccountCard = async (ctx: any, network: LighterNetwork, accountIndex: number, isEdit: boolean = true) => {
    const accRow = await env.DB.prepare(
      "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? AND network = ? AND account_index = ?"
    ).bind(ctx.from!.id, network, accountIndex).first<{ network: LighterNetwork; account_index: number; alias: string | null }>();

    if (!accRow) {
      const notFoundMsg = `Аккаунт #${accountIndex} не найден среди ваших отслеживаемых.`;
      if (isEdit) {
        return ctx.editMessageText(notFoundMsg, { reply_markup: new InlineKeyboard().text("💼 Мои кошельки", "action_list") }).catch(() => {});
      }
      return ctx.reply(notFoundMsg, { reply_markup: mainKeyboard });
    }

    const cacheRow = await env.DB.prepare(
      "SELECT * FROM account_positions_cache WHERE network = ? AND account_index = ?"
    ).bind(network, accountIndex).first<any>();

    const netConfig = CONFIG.NETWORKS[network];
    const shortAddr = cacheRow?.l1_address ? `${cacheRow.l1_address.slice(0, 6)}...${cacheRow.l1_address.slice(-4)}` : "—";
    const collateral = parseFloat(String(cacheRow?.collateral || 0));

    let positionsCount = 0;
    let symbolsSummary = "";
    if (cacheRow?.positions_json) {
      try {
        const parsed = JSON.parse(cacheRow.positions_json) as any[];
        const active = parsed.filter(p => Math.abs(parseFloat(p.position || p.size || "0")) > 0);
        positionsCount = active.length;
        if (positionsCount > 0) {
          const syms = active.map(p => p.symbol).filter(Boolean);
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
      { parse_mode: "HTML", reply_markup: kb }
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
      { parse_mode: "HTML", reply_markup: kb }
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
    const { results } = await env.DB.prepare(`
      SELECT network, account_index, alias 
      FROM user_tracked_accounts 
      WHERE telegram_id = ? 
      ORDER BY network ASC, id ASC
    `).bind(ctx.from!.id).all<{ network: LighterNetwork; account_index: number; alias: string | null }>();

    if (!results || results.length === 0) {
      const emptyText = 
        `👋 <b>Добро пожаловать в Lighter Monitor!</b>\n\n` +
        `Бот отслеживает ваши позиции на <b>Robinhood Lighter</b> и <b>Lighter Mainnet</b>, ` +
        `рассчитывает риски и защищает от ликвидации.\n\n` +
        `У вас пока нет подключенных кошельков. Давайте подключим первый:`;
      const emptyKb = new InlineKeyboard().text("➕ Подключить аккаунт", "wizard_start_add");

      if (isEdit) {
        return ctx.editMessageText(emptyText, { parse_mode: "HTML", reply_markup: emptyKb }).catch(() => {});
      }
      return ctx.reply(emptyText, { parse_mode: "HTML", reply_markup: emptyKb });
    }

    const kb = new InlineKeyboard();
    for (const r of results) {
      const netIcon = r.network === 'rh' ? '🟠' : '⚡️';
      const aliasStr = r.alias ? ` (${r.alias})` : "";
      const label = `${netIcon} #${r.account_index}${aliasStr}`;
      kb.text(label, `manage_acc:${r.network}:${r.account_index}`).row();
    }
    kb.text("➕ Добавить кошелек", "wizard_start_add")
      .text("🔄 Обновить", "refresh_list");

    const now = new Date();
    const timeStr = now.toLocaleTimeString("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const msg = `📋 <b>Ваши отслеживаемые кошельки (${results.length}/${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER}):</b>\n\n` +
      `Нажмите на кошелек для управления:\n\n` +
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

  const getPositionsKeyboard = (filterIndex?: number, filterNetwork?: LighterNetwork) => {
    const refreshCb = (filterIndex && filterNetwork)
      ? `refresh:${filterNetwork}:${filterIndex}`
      : (filterIndex ? `refresh_positions_${filterIndex}` : "refresh_positions");
    return new InlineKeyboard()
      .text("🔄 Обновить", refreshCb);
  };

  const handlePositions = async (
    ctx: any, 
    filterIndex?: number, 
    forceRefresh: boolean = false, 
    isEdit: boolean = false,
    filterNetwork?: LighterNetwork
  ) => {
    let trackedList: Array<{ network: LighterNetwork; account_index: number; alias: string | null }> = [];

    if (filterIndex) {
      if (filterNetwork) {
        const { results } = await env.DB.prepare(
          "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? AND network = ? AND account_index = ?"
        ).bind(ctx.from!.id, filterNetwork, filterIndex).all<{ network: LighterNetwork; account_index: number; alias: string | null }>();
        trackedList = (results && results.length > 0) ? results : [
          { network: filterNetwork, account_index: filterIndex, alias: null }
        ];
      } else {
        const { results } = await env.DB.prepare(
          "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? AND account_index = ?"
        ).bind(ctx.from!.id, filterIndex).all<{ network: LighterNetwork; account_index: number; alias: string | null }>();
        trackedList = results || [];
        if (trackedList.length === 0) {
          trackedList = [
            { network: 'rh', account_index: filterIndex, alias: null },
            { network: 'mainnet', account_index: filterIndex, alias: null }
          ];
        }
      }
    } else {
      const { results } = await env.DB.prepare(
        "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? ORDER BY network ASC, id ASC"
      ).bind(ctx.from!.id).all<{ network: LighterNetwork; account_index: number; alias: string | null }>();
      trackedList = results || [];
    }

    if (trackedList.length === 0) {
      if (filterIndex) {
        return ctx.reply(`Аккаунт #${filterIndex} не найден среди ваших отслеживаемых.`, { reply_markup: mainKeyboard });
      }
      const emptyText = 
        `👋 <b>Добро пожаловать в Lighter Monitor!</b>\n\n` +
        `Бот в реальном времени отслеживает ваши позиции на <b>Robinhood Lighter</b> и <b>Lighter Mainnet</b>, ` +
        `рассчитывает риски и защищает от ликвидации.\n\n` +
        `У вас пока нет подключенных кошельков. Давайте подключим первый:`;
      const emptyKb = new InlineKeyboard().text("➕ Подключить аккаунт", "wizard_start_add");
      if (isEdit) {
        return ctx.editMessageText(emptyText, { parse_mode: "HTML", reply_markup: emptyKb }).catch(() => {});
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
        `).bind(ctx.from!.id).all<any>();

        if (cachedRows) {
          for (const row of cachedRows) {
            cacheMap.set(`${row.network}:${row.account_index}`, row);
          }
        }
      } else {
        const rows = await Promise.all(
          trackedList.map(item =>
            env.DB.prepare("SELECT * FROM account_positions_cache WHERE network = ? AND account_index = ?")
              .bind(item.network, item.account_index)
              .first<any>()
          )
        );
        for (const row of rows) {
          if (row) {
            cacheMap.set(`${row.network}:${row.account_index}`, row);
          }
        }
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const toFetch = forceRefresh
      ? trackedList.filter(item => {
          const key = `${item.network}:${item.account_index}`;
          const c = cacheMap.get(key);
          if (c && c.last_updated_at && (nowSec - c.last_updated_at) < 15) {
            return false;
          }
          return true;
        })
      : trackedList.filter(item => {
          const key = `${item.network}:${item.account_index}`;
          const c = cacheMap.get(key);
          return !c || !c.l1_address || !c.last_updated_at || (nowSec - c.last_updated_at) >= 120;
        });

    const freshMap = new Map<string, any>();
    if (toFetch.length > 0) {
      const freshResults = await Promise.all(
        toFetch.map(item => fetchLighterAccount(item.network, item.account_index))
      );
      toFetch.forEach((item, i) => {
        if (freshResults[i]) {
          freshMap.set(`${item.network}:${item.account_index}`, freshResults[i]);
        }
      });

      if (freshMap.size > 0) {
        const updates: Array<{ network: LighterNetwork; account: any; cachedPositions: any[] }> = [];
        const syncPromises: Promise<any>[] = [];

        for (const item of toFetch) {
          const key = `${item.network}:${item.account_index}`;
          const acc = freshMap.get(key);
          if (acc) {
            updates.push({
              network: item.network,
              account: acc,
              cachedPositions: acc.positions.map(analyzePositionRisk).filter(Boolean)
            });
            syncPromises.push(
              syncAccountOpenPositions(env.DB, item.network, item.account_index, acc.positions).catch(e => console.error("syncAccountOpenPositions error:", e))
            );
          }
        }
        await Promise.all([
          ...syncPromises,
          batchUpdatePositionsCache(env.DB, updates).catch(e => console.error("Cache update error:", e))
        ]);
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
        accPositions = fresh.positions.map(analyzePositionRisk).filter(Boolean) as PositionRiskAnalysis[];
        accCollateral = parseFloat(fresh.collateral || "0");
        card = formatPositionsReport(
          item.network,
          item.account_index, 
          item.alias, 
          accCollateral, 
          accPositions, 
          userThreshold
        );
      } else if (cached && cached.l1_address && cached.positions_json) {
        const parsedPositions = JSON.parse(cached.positions_json) as any[];
        accPositions = parsedPositions.map((p: any) => {
          if (p.marketId !== undefined && p.tier !== undefined) {
            return p as PositionRiskAnalysis;
          }
          return analyzePositionRisk(p);
        }).filter(Boolean) as PositionRiskAnalysis[];
        accCollateral = parseFloat(String(cached.collateral || 0));

        card = formatPositionsReport(
          item.network,
          item.account_index, 
          item.alias, 
          accCollateral, 
          accPositions, 
          userThreshold
        );
      } else {
        if (filterIndex && !fresh && !cached) continue;
        const netBadge = CONFIG.NETWORKS[item.network]?.badge || `[${item.network.toUpperCase()}]`;
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
      const timeStr = now.toLocaleTimeString("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      combinedReport += `\n\n🕒 <i>Обновлено: ${timeStr} UTC</i>`;

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
        currentChunk += `${summaryBlock}\n\n🕒 <i>Обновлено: ${timeStr} UTC</i>`;
        await ctx.reply(currentChunk, { parse_mode: "HTML", reply_markup: posKeyboard });
        return;
      }

      if (isEdit) {
        try {
          await ctx.editMessageText(combinedReport, { parse_mode: "HTML", reply_markup: posKeyboard });
        } catch (err: any) {
          if (!err?.message?.includes("message is not modified")) {
            await ctx.reply(combinedReport, { parse_mode: "HTML", reply_markup: posKeyboard });
          }
        }
      } else {
        await ctx.reply(combinedReport, { parse_mode: "HTML", reply_markup: posKeyboard });
      }
    } else if (filterIndex) {
      await ctx.reply(`Аккаунт #${filterIndex} не найден ни в одной из поддерживаемых сетей.`, { reply_markup: mainKeyboard });
    }
  };

  bot.command("positions", async (ctx) => {
    const arg = ctx.match ? ctx.match.trim() : "";
    const filter = (arg && /^\d+$/.test(arg)) ? parseInt(arg, 10) : undefined;
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

  const getSettingsKeyboard = (threshold: number, mutedUntil: number) => {
    const presets = [0.3, 0.5, 0.8, 1.0, 1.5, 2.0];
    const kb = new InlineKeyboard();
    for (let i = 0; i < presets.length; i++) {
      const p = presets[i]!;
      const label = Math.abs(p - threshold) < 0.001 ? `✅ ${p}%` : `${p}%`;
      kb.text(label, `set_thresh_${p}`);
      if (i === 2) kb.row();
    }
    kb.row();
    const isCustom = !presets.some(p => Math.abs(p - threshold) < 0.001);
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
  };

  const handleSettings = async (ctx: any, isEdit: boolean = false) => {
    const settings = await getUserSettings(env.DB, ctx.from!.id);
    const nowSec = Math.floor(Date.now() / 1000);
    const isMuted = settings.mutedUntil > nowSec;

    let muteText = "🔔 <b>Уведомления:</b> Активны";
    if (isMuted) {
      const remainingMinutes = Math.ceil((settings.mutedUntil - nowSec) / 60);
      const muteUntilDate = new Date(settings.mutedUntil * 1000);
      const timeStr = muteUntilDate.toLocaleTimeString("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
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
          { parse_mode: "HTML" }
        );
      }
      await setUserThreshold(env.DB, ctx.from!.id, val);
      return ctx.reply(
        `Шаг цены для алертов установлен на <b>${val.toFixed(1)}%</b>.`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    }
    await handleSettings(ctx);
  });

  bot.command("settings", async (ctx) => {
    await handleSettings(ctx);
  });

  bot.callbackQuery("custom_threshold", async (ctx) => {
    await setUserWizardState(env.DB, ctx.from!.id, { step: "AWAIT_THRESHOLD" });
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text("❌ Отмена", "action_threshold");
    await ctx.editMessageText(
      `✏️ <b>Настройка шага цены для алертов</b>\n\n` +
      `Отправьте желаемый шаг цены числом в чат:\n` +
      `<i>(от <b>${CONFIG.MIN_ALERT_THRESHOLD}%</b> до <b>${CONFIG.MAX_ALERT_THRESHOLD}%</b>, например: <b>0.4</b> или <b>0.7</b>)</i>`,
      { parse_mode: "HTML", reply_markup: kb }
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

  bot.hears(["💼 Мои кошельки", "Мои кошельки", "📋 Аккаунты", "Аккаунты", "📋 Мои аккаунты"], async (ctx) => {
    await handleList(ctx);
  });

  bot.hears(["➕ Добавить кошелек", "➕ Добавить", "Добавить кошелек"], async (ctx) => {
    await startAddWizard(ctx);
  });

  bot.hears(["⚙️ Настройки", "Настройки", "⚙️ Порог алертов", "Порог алертов"], async (ctx) => {
    await handleSettings(ctx);
  });

  botInstance = bot;
  return bot;
}
