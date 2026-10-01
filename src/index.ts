import { webhookCallback } from "grammy";
import { Env } from "./types";
import { getBot } from "./bot/bot";
import { runCronMonitor } from "./cron/monitor";
import { executionContextStorage } from "./utils/background";
import SPREAD_HTML from "./spread.html";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check эндпоинт
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", timestamp: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Spread & Arbitrage Terminal
    if (url.pathname === "/spread" || url.pathname === "/spread/") {
      let html: string = typeof SPREAD_HTML === "string" ? SPREAD_HTML : "";
      if (!html) {
        const fileIndex = (SPREAD_HTML as unknown as { index?: string })?.index;
        if (fileIndex && typeof Bun !== "undefined") {
          html = await (Bun as any).file(fileIndex).text();
        } else {
          html = String(SPREAD_HTML);
        }
      }

      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // Регистрация команд в Telegram Bot API (setMyCommands)
    if (url.pathname === "/setup-commands") {
      const bot = getBot(env);
      await bot.api.setMyCommands([
        { command: "positions", description: "📊 Открытые сделки и риски" },
        { command: "list", description: "💼 Список ваших кошельков" },
        { command: "threshold", description: "⚙️ Настройка шага цены для алертов" },
        { command: "settings", description: "⚙️ Параметры уведомлений и тихий сон" },
        { command: "help", description: "ℹ️ Справка и возможности" },
        { command: "stats", description: "📊 Системный дашборд (админ)" },
        { command: "add_rh", description: "➕ Добавить аккаунт Robinhood Lighter" },
        { command: "add_mainnet", description: "➕ Добавить аккаунт Lighter Mainnet" },
        { command: "remove_rh", description: "➖ Удалить аккаунт Robinhood Lighter" },
        { command: "remove_mainnet", description: "➖ Удалить аккаунт Lighter Mainnet" },
        { command: "start", description: "🚀 Главное меню" },
      ]);
      return new Response(
        JSON.stringify({ ok: true, message: "Commands registered successfully in Telegram" }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Проверка Secret Token для безопасности вебхука Telegram
    if (env.TELEGRAM_SECRET_TOKEN) {
      const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (headerSecret !== env.TELEGRAM_SECRET_TOKEN) {
        return new Response("Unauthorized", { status: 403 });
      }
    }

    const bot = getBot(env);
    const cb = webhookCallback(bot, "cloudflare-mod");
    return await executionContextStorage.run(ctx, () => cb(request as any));
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCronMonitor(env, ctx));
  },
};
