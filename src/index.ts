import { webhookCallback } from "grammy";
import { Env } from "./types";
import { getBot } from "./bot/bot";
import { runCronMonitor } from "./cron/monitor";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check эндпоинт
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", timestamp: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Регистрация команд в Telegram Bot API (setMyCommands)
    if (url.pathname === "/setup-commands") {
      const bot = getBot(env);
      await bot.api.setMyCommands([
        { command: "positions", description: "📊 Открытые сделки и риски" },
        { command: "list", description: "📋 Список ваших аккаунтов" },
        { command: "threshold", description: "⚙️ Настройка шага цены для алертов" },
        { command: "stats", description: "📊 Системный дашборд (админ)" },
        { command: "add_rh", description: "➕ Добавить аккаунт Robinhood Lighter" },
        { command: "add_mainnet", description: "➕ Добавить аккаунт Lighter Mainnet" },
        { command: "remove_rh", description: "➖ Удалить аккаунт Robinhood Lighter" },
        { command: "remove_mainnet", description: "➖ Удалить аккаунт Lighter Mainnet" },
        { command: "start", description: "🚀 Главное меню и справка" },
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
    return await cb(request as any);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCronMonitor(env));
  },
};
