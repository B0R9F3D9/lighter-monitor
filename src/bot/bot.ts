import { Bot, InlineKeyboard } from "grammy";
import { Env, PositionRiskAnalysis, LighterNetwork } from "../types";
import { CONFIG } from "../config";
import { fetchLighterAccount, fetchLighterAccountWithStatus } from "../lighter/api";
import { analyzePositionRisk } from "../lighter/math";
import { batchUpdatePositionsCache, getUserThreshold, setUserThreshold } from "../db/queries";
import { formatPositionsReport } from "./formatters";

let botInstance: Bot | null = null;

export function getBot(env: Env): Bot {
  if (botInstance) return botInstance;

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  const mainKeyboard = new InlineKeyboard()
    .text("📊 Позиции", "action_positions")
    .text("📋 Мои аккаунты", "action_list")
    .row()
    .text("⚙️ Порог алертов", "action_threshold");

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
      `Мониторинг открытых позиций и рисков ликвидации на <b>Robinhood Lighter</b> и <b>Lighter Mainnet</b>.\n\n` +
      `<b>Команды добавления:</b>\n` +
      `• <code>/add_rh &lt;index&gt; [alias]</code> — аккаунт Robinhood Lighter\n` +
      `• <code>/add_mainnet &lt;index&gt; [alias]</code> — аккаунт Lighter Mainnet\n\n` +
      `<b>Команды удаления:</b>\n` +
      `• <code>/remove_rh &lt;index&gt;</code> — удалить из Robinhood\n` +
      `• <code>/remove_mainnet &lt;index&gt;</code> — удалить из Mainnet\n\n` +
      `<b>Сводка и настройки:</b>\n` +
      `• <code>/list</code> — список всех ваших отслеживаемых аккаунтов\n` +
      `• <code>/positions</code> — текущие открытые сделки и риски ликвидации\n` +
      `• <code>/threshold [значение]</code> — настроить порог алертов (дефолт: 1.5%)\n\n` +
      `<i>Примеры:</i>\n` +
      `<code>/add_rh 31704 Основной</code>\n` +
      `<code>/add_mainnet 749329 Кит</code>`,
      { parse_mode: "HTML", reply_markup: mainKeyboard }
    );
  });

  // Обработчик добавления аккаунта
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

    // Проверка лимита кошельков на пользователя
    const countRes = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_tracked_accounts WHERE telegram_id = ?"
    ).bind(ctx.from!.id).first<{ cnt: number }>();

    if (countRes && countRes.cnt >= CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER) {
      return ctx.reply(
        `Достигнут лимит: нельзя отслеживать более ${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER} аккаунтов суммарно.`,
        { reply_markup: mainKeyboard }
      );
    }

    // Проверка существования в Lighter API соответствующей сети
    await ctx.reply(`Проверяем аккаунт в ${netConfig.name} API...`);
    const result = await fetchLighterAccountWithStatus(network, accountIndex);

    if (result.status === 'RATE_LIMIT') {
      return ctx.reply(
        `⚠️ API ${netConfig.name} временно ограничивает запросы (Rate Limit 429).\n\n` +
        `Пожалуйста, повторите команду через 30–60 секунд.`,
        { reply_markup: mainKeyboard }
      );
    }

    if (!result.account) {
      const explorerLink = network === 'mainnet'
        ? `\n\nПроверьте индекс в эксплорере:\nhttps://app.lighter.xyz/explorer/accounts/${accountIndex}`
        : '';
      return ctx.reply(
        `Аккаунт #${accountIndex} не найден в ${netConfig.name}.${explorerLink}`,
        { reply_markup: mainKeyboard }
      );
    }

    const account = result.account;

    try {
      await env.DB.prepare(`
        INSERT INTO user_tracked_accounts (telegram_id, network, account_index, alias, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        ctx.from!.id,
        network,
        accountIndex, 
        alias, 
        Math.floor(Date.now() / 1000)
      ).run();

      // Сразу кэшируем аккаунт, чтобы /positions отдавал данные мгновенно
      const activePositions = account.positions.filter(p => Math.abs(parseFloat(p.position || "0")) > 0);
      const risks = activePositions.map(analyzePositionRisk).filter(Boolean);
      await batchUpdatePositionsCache(env.DB, [{
        network,
        account,
        cachedPositions: risks as any
      }]);

      await ctx.reply(
        `Аккаунт <b>#${accountIndex}</b> добавлен в <b>${netConfig.name}</b> <code>${netConfig.badge}</code>.\n` +
        `Алиас: ${alias ? `<b>${alias}</b>` : "<i>нет</i>"}\n` +
        `Кошелек: <code>${account.l1_address}</code>\n\n` +
        `Мониторинг активен. Проверка рисков выполняется каждую минуту.`,
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

  // Команды добавления
  bot.command("add_rh", async (ctx) => {
    await handleAdd(ctx, 'rh', ctx.match);
  });

  bot.command("add_mainnet", async (ctx) => {
    await handleAdd(ctx, 'mainnet', ctx.match);
  });

  // Универсальный /add [network] <index> [alias] (для гибкости)
  bot.command("add", async (ctx) => {
    const rawMatch = ctx.match ? ctx.match.trim() : "";
    const args = rawMatch.split(/\s+/).filter(Boolean);
    const firstArg = args[0]?.toLowerCase();

    if (firstArg === "rh" || firstArg === "robinhood") {
      await handleAdd(ctx, 'rh', args.slice(1).join(" "));
    } else if (firstArg === "mainnet" || firstArg === "main") {
      await handleAdd(ctx, 'mainnet', args.slice(1).join(" "));
    } else if (firstArg && /^\d+$/.test(firstArg)) {
      // Если передали сразу число, по умолчанию считаем RH и информируем о /add_mainnet
      await handleAdd(ctx, 'rh', rawMatch);
    } else {
      await ctx.reply(
        `Выберите сеть для добавления аккаунта:\n\n` +
        `• <b>Robinhood Lighter:</b> <code>/add_rh &lt;индекс&gt; [алиас]</code>\n` +
        `• <b>Lighter Mainnet:</b> <code>/add_mainnet &lt;индекс&gt; [алиас]</code>`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    }
  });

  // Обработчик удаления аккаунта
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
    const result = await env.DB.prepare(
      "DELETE FROM user_tracked_accounts WHERE telegram_id = ? AND network = ? AND account_index = ?"
    ).bind(ctx.from!.id, network, accountIndex).run();

    if (result.meta.changes === 0) {
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
    } else if (firstArg && /^\d+$/.test(firstArg)) {
      const accountIndex = parseInt(firstArg, 10);
      // Проверим, в каких сетях у пользователя этот индекс
      const { results } = await env.DB.prepare(
        "SELECT network FROM user_tracked_accounts WHERE telegram_id = ? AND account_index = ?"
      ).bind(ctx.from!.id, accountIndex).all<{ network: LighterNetwork }>();

      if (!results || results.length === 0) {
        return ctx.reply(`Аккаунт #${accountIndex} не найден в вашем списке.`, { reply_markup: mainKeyboard });
      }

      if (results.length === 1) {
        await handleRemove(ctx, results[0]!.network, String(accountIndex));
      } else {
        return ctx.reply(
          `У вас отслеживается #${accountIndex} в обеих сетях. Уточните команду:\n` +
          `• <code>/remove_rh ${accountIndex}</code>\n` +
          `• <code>/remove_mainnet ${accountIndex}</code>`,
          { parse_mode: "HTML" }
        );
      }
    } else {
      return ctx.reply(
        `Укажите команду удаления:\n` +
        `• <code>/remove_rh &lt;индекс&gt;</code>\n` +
        `• <code>/remove_mainnet &lt;индекс&gt;</code>`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    }
  });

  // Функция вывода /list
  const handleList = async (ctx: any) => {
    const { results } = await env.DB.prepare(`
      SELECT network, account_index, alias 
      FROM user_tracked_accounts 
      WHERE telegram_id = ? 
      ORDER BY network ASC, id ASC
    `).bind(ctx.from!.id).all<{ network: LighterNetwork; account_index: number; alias: string | null }>();

    if (!results || results.length === 0) {
      return ctx.reply(
        "У вас нет отслеживаемых аккаунтов.\n" +
        "Добавьте: <code>/add_rh &lt;index&gt;</code> или <code>/add_mainnet &lt;index&gt;</code>.", 
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    }

    let msg = `📋 <b>Отслеживаемые аккаунты (${results.length}/${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER}):</b>\n\n`;
    for (const r of results) {
      const badge = CONFIG.NETWORKS[r.network]?.badge || `[${r.network.toUpperCase()}]`;
      const aliasStr = r.alias ? ` (${r.alias})` : "";
      msg += `• <code>${badge}</code> <b>#${r.account_index}</b>${aliasStr}\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML", reply_markup: mainKeyboard });
  };

  bot.command("list", handleList);
  bot.callbackQuery("action_list", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleList(ctx);
  });

  const getPositionsKeyboard = (filterIndex?: number) => {
    const refreshCb = filterIndex ? `refresh_positions_${filterIndex}` : "refresh_positions";
    return new InlineKeyboard()
      .text("🔄 Обновить", refreshCb)
      .row()
      .text("📋 Мои аккаунты", "action_list")
      .text("⚙️ Порог алертов", "action_threshold");
  };

  // Функция вывода /positions с параллельным чтением кэша для всех сетей
  const handlePositions = async (
    ctx: any, 
    filterIndex?: number, 
    forceRefresh: boolean = false, 
    isEdit: boolean = false
  ) => {
    let trackedList: Array<{ network: LighterNetwork; account_index: number; alias: string | null }> = [];

    if (filterIndex) {
      const { results } = await env.DB.prepare(
        "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? AND account_index = ?"
      ).bind(ctx.from!.id, filterIndex).all<{ network: LighterNetwork; account_index: number; alias: string | null }>();
      trackedList = results || [];
      if (trackedList.length === 0) {
        // Если аккаунт не отслеживается, все равно попробуем опросить обе сети
        trackedList = [
          { network: 'rh', account_index: filterIndex, alias: null },
          { network: 'mainnet', account_index: filterIndex, alias: null }
        ];
      }
    } else {
      const { results } = await env.DB.prepare(
        "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? ORDER BY network ASC, id ASC"
      ).bind(ctx.from!.id).all<{ network: LighterNetwork; account_index: number; alias: string | null }>();
      trackedList = results || [];
    }

    if (trackedList.length === 0) {
      return ctx.reply(
        "У вас нет добавленных аккаунтов. Используйте <code>/add_rh &lt;index&gt;</code> или <code>/add_mainnet &lt;index&gt;</code>.", 
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    }

    // Собираем кэш для всех пар (network, account_index), если не принудительный рефетч
    const cacheMap = new Map<string, any>();
    if (!forceRefresh) {
      for (const item of trackedList) {
        const cached = await env.DB.prepare(
          "SELECT * FROM account_positions_cache WHERE network = ? AND account_index = ?"
        ).bind(item.network, item.account_index).first<any>();
        if (cached) {
          cacheMap.set(`${item.network}:${item.account_index}`, cached);
        }
      }
    }

    // Определяем, для каких аккаунтов запрашиваем API
    const toFetch = forceRefresh
      ? trackedList
      : trackedList.filter(item => {
          const key = `${item.network}:${item.account_index}`;
          const c = cacheMap.get(key);
          return !c || !c.l1_address;
        });

    // Параллельно запрашиваем свежие данные из API
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

      // Сохраняем свежие результаты в кэш D1
      if (freshMap.size > 0) {
        const updates: Array<{ network: LighterNetwork; account: any; cachedPositions: any[] }> = [];
        for (const item of toFetch) {
          const key = `${item.network}:${item.account_index}`;
          const acc = freshMap.get(key);
          if (acc) {
            updates.push({
              network: item.network,
              account: acc,
              cachedPositions: acc.positions.map(analyzePositionRisk).filter(Boolean)
            });
          }
        }
        await batchUpdatePositionsCache(env.DB, updates).catch(e => console.error("Cache update error:", e));
      }
    }

    const userThreshold = await getUserThreshold(env.DB, ctx.from.id);
    let combinedReport = "";

    for (const item of trackedList) {
      const key = `${item.network}:${item.account_index}`;
      const fresh = freshMap.get(key);
      const cached = cacheMap.get(key);
      let card = "";

      if (fresh) {
        const positions = fresh.positions.map(analyzePositionRisk).filter(Boolean) as PositionRiskAnalysis[];
        card = formatPositionsReport(
          item.network,
          item.account_index, 
          item.alias, 
          fresh.l1_address, 
          parseFloat(fresh.collateral || "0"), 
          positions, 
          userThreshold
        );
      } else if (cached && cached.l1_address && cached.positions_json) {
        const parsedPositions = JSON.parse(cached.positions_json) as any[];
        const positions: PositionRiskAnalysis[] = parsedPositions.map((p: any) => {
          if (p.marketId !== undefined && p.tier !== undefined) {
            return p as PositionRiskAnalysis;
          }
          return analyzePositionRisk(p);
        }).filter(Boolean) as PositionRiskAnalysis[];

        card = formatPositionsReport(
          item.network,
          item.account_index, 
          item.alias, 
          cached.l1_address, 
          parseFloat(String(cached.collateral || 0)), 
          positions, 
          userThreshold
        );
      } else {
        if (filterIndex && !fresh && !cached) continue;
        const netBadge = CONFIG.NETWORKS[item.network]?.badge || `[${item.network.toUpperCase()}]`;
        card = `Аккаунт #${item.account_index} ${netBadge}: данные временно недоступны.\n`;
      }

      const trimmedCard = card.trim();
      if (!trimmedCard) continue;

      if (combinedReport && (combinedReport + "\n\n" + trimmedCard).length > 3800) {
        await ctx.reply(combinedReport, { parse_mode: "HTML" });
        combinedReport = "";
      }
      combinedReport = combinedReport ? `${combinedReport}\n\n${trimmedCard}` : trimmedCard;
    }

    const posKeyboard = getPositionsKeyboard(filterIndex);

    if (combinedReport.trim()) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      combinedReport += `\n\n🕒 <i>Обновлено: ${timeStr} UTC</i>`;

      if (isEdit) {
        try {
          await ctx.editMessageText(combinedReport, { parse_mode: "HTML", reply_markup: posKeyboard });
        } catch (err: any) {
          if (err?.message && err.message.includes("message is not modified")) {
            // Игнорируем
          } else {
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

  bot.callbackQuery("action_positions", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handlePositions(ctx);
  });

  bot.callbackQuery(/^refresh_positions(?:_(\d+))?$/, async (ctx) => {
    const filter = ctx.match[1] ? parseInt(ctx.match[1], 10) : undefined;
    await ctx.answerCallbackQuery({ text: "🔄 Обновляем позиции..." });
    await handlePositions(ctx, filter, true, true);
  });

  // Клавиатура выбора порога
  const getThresholdKeyboard = (current: number) => {
    const presets = [0.8, 1.0, 1.5, 2.0, 2.5, 3.0];
    const kb = new InlineKeyboard();
    for (let i = 0; i < presets.length; i++) {
      const p = presets[i]!;
      const label = p === current ? `• ${p}% •` : `${p}%`;
      kb.text(label, `set_thresh_${p}`);
      if (i === 2) kb.row();
    }
    return kb;
  };

  // Обработчик настройки порога
  const handleThreshold = async (ctx: any, newValStr?: string) => {
    if (newValStr) {
      const cleaned = newValStr.replace(",", ".");
      const val = parseFloat(cleaned);
      if (isNaN(val) || val < CONFIG.MIN_ALERT_THRESHOLD || val > CONFIG.MAX_ALERT_THRESHOLD) {
        return ctx.reply(
          `Укажите процент от ${CONFIG.MIN_ALERT_THRESHOLD}% до ${CONFIG.MAX_ALERT_THRESHOLD}%.\n` +
          `Пример: <code>/threshold 1.5</code>`,
          { parse_mode: "HTML" }
        );
      }
      await setUserThreshold(env.DB, ctx.from.id, val);
      return ctx.reply(
        `Порог ликвидации установлен на <b>${val.toFixed(1)}%</b>.\n` +
        `Алерты будут приходить при сближении с ликвидацией ближе чем на ${val.toFixed(1)}%.`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    }

    const current = await getUserThreshold(env.DB, ctx.from.id);
    await ctx.reply(
      `⚙️ <b>Настройка порога алертов</b>\n\n` +
      `Текущий порог: <b>${current.toFixed(1)}%</b>\n` +
      `<i>(Для плеча 15-25x рекомендуется 1.5%)</i>\n\n` +
      `Выберите значение кнопкой или введите:\n` +
      `<code>/threshold &lt;число&gt;</code> (напр. <code>/threshold 1.2</code>)`,
      { parse_mode: "HTML", reply_markup: getThresholdKeyboard(current) }
    );
  };

  bot.command("threshold", async (ctx) => {
    const arg = ctx.match ? ctx.match.trim() : "";
    await handleThreshold(ctx, arg || undefined);
  });

  bot.command("settings", async (ctx) => {
    await handleThreshold(ctx);
  });

  bot.callbackQuery("action_threshold", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleThreshold(ctx);
  });

  bot.callbackQuery(/^set_thresh_(\d+(\.\d+)?)$/, async (ctx) => {
    const val = parseFloat(ctx.match[1]);
    await setUserThreshold(env.DB, ctx.from.id, val);
    await ctx.answerCallbackQuery({ text: `Порог установлен: ${val}%` });
    await ctx.editMessageText(
      `Порог ликвидации установлен на <b>${val.toFixed(1)}%</b>.\n` +
      `Алерты будут приходить при сближении с ликвидацией ближе чем на ${val.toFixed(1)}%.`,
      { parse_mode: "HTML", reply_markup: mainKeyboard }
    );
  });

  botInstance = bot;
  return bot;
}
