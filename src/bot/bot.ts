import { Bot, InlineKeyboard } from "grammy";
import { Env, PositionRiskAnalysis } from "../types";
import { CONFIG } from "../config";
import { fetchLighterAccount } from "../lighter/api";
import { analyzePositionRisk } from "../lighter/math";
import { formatPositionsReport } from "./formatters";

let botInstance: Bot | null = null;

export function getBot(env: Env): Bot {
  if (botInstance) return botInstance;

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  const mainKeyboard = new InlineKeyboard()
    .text("📊 Позиции", "action_positions")
    .text("📋 Мои аккаунты", "action_list");

  // Сохранение пользователя в БД при любом взаимодействии
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      await env.DB.prepare(`
        INSERT INTO users (telegram_id, username, first_name, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(telegram_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name
      `).bind(
        ctx.from.id,
        ctx.from.username || null,
        ctx.from.first_name || null,
        Math.floor(Date.now() / 1000)
      ).run();
    }
    return next();
  });

  // /start
  bot.command("start", async (ctx) => {
    await ctx.reply(
      `<b>Lighter Monitor Bot</b>\n\n` +
      `Мониторинг открытых позиций и рисков ликвидации на Robinhood Lighter.\n\n` +
      `<b>Команды:</b>\n` +
      `• <code>/add &lt;index&gt; [alias]</code> — начать следить за аккаунтом (макс. 10)\n` +
      `• <code>/remove &lt;index&gt;</code> — удалить аккаунт из отслеживания\n` +
      `• <code>/list</code> — список ваших отслеживаемых аккаунтов\n` +
      `• <code>/positions [index]</code> — текущие сделки и дистанция до ликвидации\n\n` +
      `<i>Пример:</i> <code>/add 31704 Основной</code>`,
      { parse_mode: "HTML", reply_markup: mainKeyboard }
    );
  });

  // /add <index> [alias] (только числовые индексы)
  bot.command("add", async (ctx) => {
    const rawMatch = ctx.match ? ctx.match.trim() : "";
    const args = rawMatch.split(/\s+/).filter(Boolean);
    const indexStr = args[0];
    const alias = args.slice(1).join(" ") || null;

    if (!indexStr || !/^\d+$/.test(indexStr)) {
      return ctx.reply(
        "Укажите числовой индекс аккаунта.\nПример: <code>/add 31704 Основной</code>", 
        { parse_mode: "HTML" }
      );
    }

    const accountIndex = parseInt(indexStr, 10);

    // Проверка лимита 10 кошельков
    const countRes = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_tracked_accounts WHERE telegram_id = ?"
    ).bind(ctx.from!.id).first<{ cnt: number }>();

    if (countRes && countRes.cnt >= CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER) {
      return ctx.reply(
        `Достигнут лимит: нельзя отслеживать более ${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER} аккаунтов.`,
        { reply_markup: mainKeyboard }
      );
    }

    // Проверка существования в Lighter API
    await ctx.reply("Проверяем аккаунт в Robinhood Lighter API...");
    const account = await fetchLighterAccount(accountIndex);
    if (!account) {
      return ctx.reply(
        `Аккаунт #${accountIndex} не найден в Robinhood Lighter.`,
        { reply_markup: mainKeyboard }
      );
    }

    try {
      await env.DB.prepare(`
        INSERT INTO user_tracked_accounts (telegram_id, account_index, alias, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(
        ctx.from!.id, 
        accountIndex, 
        alias, 
        Math.floor(Date.now() / 1000)
      ).run();

      await ctx.reply(
        `Аккаунт <b>#${accountIndex}</b> добавлен.\n` +
        `Алиас: ${alias ? `<b>${alias}</b>` : "<i>нет</i>"}\n` +
        `Кошелек: <code>${account.l1_address}</code>\n\n` +
        `Мониторинг активен. Проверка рисков выполняется каждую минуту.`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    } catch (e: any) {
      if (e?.message && e.message.includes("UNIQUE")) {
        return ctx.reply(
          `Вы уже отслеживаете аккаунт #${accountIndex}.`,
          { reply_markup: mainKeyboard }
        );
      }
      throw e;
    }
  });

  // /remove <index>
  bot.command("remove", async (ctx) => {
    const indexStr = ctx.match ? ctx.match.trim() : "";
    if (!indexStr || !/^\d+$/.test(indexStr)) {
      return ctx.reply(
        "Укажите числовой индекс для удаления: <code>/remove 31704</code>", 
        { parse_mode: "HTML" }
      );
    }
    const accountIndex = parseInt(indexStr, 10);
    await env.DB.prepare(
      "DELETE FROM user_tracked_accounts WHERE telegram_id = ? AND account_index = ?"
    ).bind(ctx.from!.id, accountIndex).run();

    await ctx.reply(`Аккаунт #${accountIndex} удален из отслеживания.`, { reply_markup: mainKeyboard });
  });

  // Функция вывода /list
  const handleList = async (ctx: any) => {
    const { results } = await env.DB.prepare(`
      SELECT account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? ORDER BY id ASC
    `).bind(ctx.from!.id).all<{ account_index: number; alias: string | null }>();

    if (!results || results.length === 0) {
      return ctx.reply(
        "У вас нет отслеживаемых аккаунтов. Добавьте: <code>/add &lt;index&gt;</code>.", 
        { parse_mode: "HTML" }
      );
    }

    let msg = `<b>Отслеживаемые аккаунты (${results.length}/${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER}):</b>\n\n`;
    for (const r of results) {
      msg += `• <b>#${r.account_index}</b> ${r.alias ? `(${r.alias})` : ""}\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML", reply_markup: mainKeyboard });
  };

  bot.command("list", handleList);
  bot.callbackQuery("action_list", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleList(ctx);
  });

  // Функция вывода /positions с параллельным чтением неразогретого кэша
  const handlePositions = async (ctx: any, filterIndex?: number) => {
    let accountIndices: number[] = [];

    if (filterIndex) {
      accountIndices = [filterIndex];
    } else {
      const { results } = await env.DB.prepare(
        "SELECT account_index FROM user_tracked_accounts WHERE telegram_id = ?"
      ).bind(ctx.from!.id).all<{ account_index: number }>();
      accountIndices = results ? results.map(r => r.account_index) : [];
    }

    if (accountIndices.length === 0) {
      return ctx.reply(
        "У вас нет добавленных аккаунтов. Используйте <code>/add &lt;index&gt;</code>.", 
        { parse_mode: "HTML" }
      );
    }

    const placeholders = accountIndices.map(() => "?").join(",");

    // Читаем кэш
    const { results: cachedRows } = await env.DB.prepare(
      `SELECT * FROM account_positions_cache WHERE account_index IN (${placeholders})`
    ).bind(...accountIndices).all<any>();
    const cacheMap = new Map((cachedRows || []).map(r => [r.account_index, r]));

    // Читаем алиасы пользователя
    const { results: aliasRows } = await env.DB.prepare(
      `SELECT account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? AND account_index IN (${placeholders})`
    ).bind(ctx.from!.id, ...accountIndices).all<{ account_index: number; alias: string | null }>();
    const aliasMap = new Map((aliasRows || []).map(r => [r.account_index, r.alias]));

    // Параллельный запрос к API для тех аккаунтов, которых еще нет в кэше
    const uncachedIndices = accountIndices.filter(idx => !cacheMap.has(idx));
    const freshResults = await Promise.all(uncachedIndices.map(idx => fetchLighterAccount(idx)));
    const freshMap = new Map<number, any>();
    uncachedIndices.forEach((idx, i) => {
      if (freshResults[i]) freshMap.set(idx, freshResults[i]);
    });

    let combinedReport = "";

    for (const accIndex of accountIndices) {
      const cached = cacheMap.get(accIndex);
      const alias = aliasMap.get(accIndex) || null;
      let card = "";

      if (cached && cached.positions_json) {
        const parsedPositions = JSON.parse(cached.positions_json) as any[];
        // Если позиции уже были проанализированы или в сыром формате
        const positions: PositionRiskAnalysis[] = parsedPositions.map((p: any) => {
          if (p.marketId !== undefined && p.tier !== undefined) {
            return p as PositionRiskAnalysis;
          }
          return analyzePositionRisk(p);
        }).filter(Boolean) as PositionRiskAnalysis[];

        card = formatPositionsReport(accIndex, alias, cached.l1_address, cached.collateral, positions);
      } else if (freshMap.has(accIndex)) {
        const fresh = freshMap.get(accIndex);
        const positions = fresh.positions.map(analyzePositionRisk).filter(Boolean) as PositionRiskAnalysis[];
        card = formatPositionsReport(accIndex, alias, fresh.l1_address, parseFloat(fresh.collateral || "0"), positions);
      } else {
        card = `Аккаунт #${accIndex}: данные временно недоступны.\n`;
      }

      if ((combinedReport + card).length > 3800) {
        await ctx.reply(combinedReport, { parse_mode: "HTML" });
        combinedReport = "";
      }
      combinedReport += card + "\n────────────────\n";
    }

    if (combinedReport.trim()) {
      await ctx.reply(combinedReport, { parse_mode: "HTML", reply_markup: mainKeyboard });
    }
  };

  bot.command("positions", async (ctx) => {
    const arg = ctx.match ? ctx.match.trim() : "";
    const filter = (arg && /^\d+$/.test(arg)) ? parseInt(arg, 10) : undefined;
    await handlePositions(ctx, filter);
  });

  bot.callbackQuery("action_positions", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handlePositions(ctx);
  });

  botInstance = bot;
  return bot;
}
