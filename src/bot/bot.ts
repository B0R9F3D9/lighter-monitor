import { Bot, InlineKeyboard, Keyboard } from "grammy";
import { Env, PositionRiskAnalysis, LighterNetwork } from "../types";
import { CONFIG } from "../config";
import { fetchLighterAccount, fetchLighterAccountWithStatus } from "../lighter/api";
import { analyzePositionRisk } from "../lighter/math";
import { batchUpdatePositionsCache, getUserThreshold, setUserThreshold, syncAccountOpenPositions } from "../db/queries";
import { formatPositionsReport } from "./formatters";

let botInstance: Bot | null = null;
const knownUsers = new Set<number>();

export function getBot(env: Env): Bot {
  if (botInstance) return botInstance;

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Основная нижняя клавиатура пользователя (Reply Keyboard)
  const replyKeyboard = new Keyboard()
    .text("📊 Позиции")
    .text("📋 Аккаунты")
    .row()
    .text("⚙️ Порог алертов")
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
      await syncAccountOpenPositions(env.DB, network, accountIndex, account.positions);

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

  const listKeyboard = new InlineKeyboard().text("🔄 Обновить", "refresh_list");

  // Функция вывода /list
  const handleList = async (ctx: any, isEdit: boolean = false) => {
    const { results } = await env.DB.prepare(`
      SELECT network, account_index, alias 
      FROM user_tracked_accounts 
      WHERE telegram_id = ? 
      ORDER BY network ASC, id ASC
    `).bind(ctx.from!.id).all<{ network: LighterNetwork; account_index: number; alias: string | null }>();

    if (!results || results.length === 0) {
      const emptyMsg = "У вас нет отслеживаемых аккаунтов.\n" +
        "Добавьте: <code>/add_rh &lt;index&gt;</code> или <code>/add_mainnet &lt;index&gt;</code>.";
      if (isEdit) {
        return ctx.editMessageText(emptyMsg, { parse_mode: "HTML", reply_markup: listKeyboard }).catch(() => {});
      }
      return ctx.reply(emptyMsg, { parse_mode: "HTML", reply_markup: mainKeyboard });
    }

    let msg = `📋 <b>Отслеживаемые аккаунты (${results.length}/${CONFIG.MAX_TRACKED_ACCOUNTS_PER_USER}):</b>\n\n`;
    for (const r of results) {
      const badge = CONFIG.NETWORKS[r.network]?.badge || `[${r.network.toUpperCase()}]`;
      const aliasStr = r.alias ? ` (${r.alias})` : "";
      msg += `• <code>${badge}</code> <b>#${r.account_index}</b>${aliasStr}\n`;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    msg += `\n🕒 <i>Обновлено: ${timeStr} UTC</i>`;

    if (isEdit) {
      try {
        await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: listKeyboard });
      } catch (err: any) {
        if (!err?.message?.includes("message is not modified")) {
          await ctx.reply(msg, { parse_mode: "HTML", reply_markup: listKeyboard });
        }
      }
    } else {
      await ctx.reply(msg, { parse_mode: "HTML", reply_markup: listKeyboard });
    }
  };

  bot.command("list", (ctx) => handleList(ctx));
  bot.callbackQuery("refresh_list", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "🔄 Обновляем список..." });
    await handleList(ctx, true);
  });
  bot.callbackQuery("action_list", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleList(ctx);
  });

  const getPositionsKeyboard = (filterIndex?: number, filterNetwork?: LighterNetwork) => {
    const refreshCb = (filterIndex && filterNetwork)
      ? `refresh:${filterNetwork}:${filterIndex}`
      : (filterIndex ? `refresh_positions_${filterIndex}` : "refresh_positions");
    return new InlineKeyboard()
      .text("🔄 Обновить", refreshCb);
  };

  // Функция вывода /positions с параллельным чтением кэша для всех сетей
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
          // Если аккаунт не отслеживается, все равно попробуем опросить обе сети
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
      return ctx.reply(
        "У вас нет добавленных аккаунтов. Используйте <code>/add_rh &lt;index&gt;</code> или <code>/add_mainnet &lt;index&gt;</code>.", 
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    }

    // ВСЕГДА загружаем кэш из D1 для всех аккаунтов (гарантия быстрого ответа и 100% надежного fallback)
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
    // Определяем, для каких аккаунтов запрашиваем API
    const toFetch = forceRefresh
      ? trackedList.filter(item => {
          const key = `${item.network}:${item.account_index}`;
          const c = cacheMap.get(key);
          // Если кэш свежий (обновлен менее 15 секунд назад), отдаем сразу без задержек
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

      // Сохраняем свежие результаты в кэш D1 и синхронизируем открытые позиции параллельно
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
          fresh.l1_address, 
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
          cached.l1_address, 
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

      // ИТОГО (Суммарный UnPnL и Маржа по всем отображенным счетам)
      const pnlSign = totalUnPnl >= 0 ? "📈 +" : "📉 -";
      const totalPnlStr = `${pnlSign}$${Math.abs(totalUnPnl).toFixed(2)}`;
      combinedReport += `${separator}📊 <b>ИТОГО:</b> 💵 UnPnL: <b>${totalPnlStr}</b> • Маржа: <b>$${totalCollateral.toFixed(2)}</b>`;

      const now = new Date();
      const timeStr = now.toLocaleTimeString("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      combinedReport += `\n\n🕒 <i>Обновлено: ${timeStr} UTC</i>`;

      if (combinedReport.length > 3800) {
        // Защита от переполнения лимита сообщения Telegram
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
        currentChunk += `${separator}📊 <b>ИТОГО:</b> 💵 UnPnL: <b>${totalPnlStr}</b> • Маржа: <b>$${totalCollateral.toFixed(2)}</b>\n\n🕒 <i>Обновлено: ${timeStr} UTC</i>`;
        await ctx.reply(currentChunk, { parse_mode: "HTML", reply_markup: posKeyboard });
        return;
      }

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

  bot.callbackQuery(/^refresh:([a-z0-9_-]+):(\d+)$/, async (ctx) => {
    const network = ctx.match[1] as LighterNetwork;
    const accountIndex = parseInt(ctx.match[2]!, 10);
    await ctx.answerCallbackQuery({ text: "🔄 Обновляем позиции..." });
    await handlePositions(ctx, accountIndex, true, true, network);
  });

  bot.callbackQuery(/^refresh_positions(?:_(\d+))?$/, async (ctx) => {
    const filter = ctx.match[1] ? parseInt(ctx.match[1], 10) : undefined;
    await ctx.answerCallbackQuery({ text: "🔄 Обновляем позиции..." });
    await handlePositions(ctx, filter, true, true);
  });

  // Клавиатура выбора порога (адаптирована под XAU и плечо 15x–25x)
  const getThresholdKeyboard = (current: number) => {
    const presets = [0.3, 0.5, 0.8, 1.0, 1.5, 2.0];
    const kb = new InlineKeyboard();
    for (let i = 0; i < presets.length; i++) {
      const p = presets[i]!;
      const label = p === current ? `• ${p}% •` : `${p}%`;
      kb.text(label, `set_thresh_${p}`);
      if (i === 2) kb.row();
    }
    return kb;
  };

  // Обработчик настройки шага цены
  const handleThreshold = async (ctx: any, newValStr?: string) => {
    if (newValStr) {
      const cleaned = newValStr.replace(",", ".");
      const val = parseFloat(cleaned);
      if (isNaN(val) || val < CONFIG.MIN_ALERT_THRESHOLD || val > CONFIG.MAX_ALERT_THRESHOLD) {
        return ctx.reply(
          `Укажите процент от ${CONFIG.MIN_ALERT_THRESHOLD}% до ${CONFIG.MAX_ALERT_THRESHOLD}%.\n` +
          `Пример: <code>/threshold 0.5</code>`,
          { parse_mode: "HTML" }
        );
      }
      await setUserThreshold(env.DB, ctx.from.id, val);
      return ctx.reply(
        `Шаг цены для алертов установлен на <b>${val.toFixed(1)}%</b>.\n` +
        `Уведомления будут приходить при каждом смещении цены на ${val.toFixed(1)}% от предыдущей засечки.`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    }

    const current = await getUserThreshold(env.DB, ctx.from.id);
    await ctx.reply(
      `⚙️ <b>Настройка шага цены для алертов</b>\n\n` +
      `Текущий шаг: <b>${current.toFixed(1)}%</b>\n` +
      `<i>(Для золота XAU на плече 15-25x рекомендуется 0.4% - 0.5%)</i>\n\n` +
      `Выберите значение кнопкой или введите:\n` +
      `<code>/threshold &lt;число&gt;</code> (напр. <code>/threshold 0.5</code>)`,
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
    await ctx.answerCallbackQuery({ text: `Шаг установлен: ${val}%` });
    await ctx.editMessageText(
      `Шаг цены для алертов установлен на <b>${val.toFixed(1)}%</b>.\n` +
      `Уведомления будут приходить при каждом смещении цены на ${val.toFixed(1)}% от предыдущей засечки.`,
      { parse_mode: "HTML" }
    );
  });

  // Обработка текстовых кнопок нижней клавиатуры (Reply Keyboard)
  bot.hears(["📊 Позиции", "Позиции"], async (ctx) => {
    await handlePositions(ctx);
  });

  bot.hears(["📋 Аккаунты", "Аккаунты", "📋 Мои аккаунты"], async (ctx) => {
    await handleList(ctx);
  });

  bot.hears(["⚙️ Порог алертов", "Порог алертов"], async (ctx) => {
    await handleThreshold(ctx);
  });

  botInstance = bot;
  return bot;
}
