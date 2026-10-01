import { webhookCallback } from "grammy";
import { Env } from "./types";
import { getBot } from "./bot/bot";
import { runCronMonitor } from "./cron/monitor";
import { executionContextStorage } from "./utils/background";
import {
  HUB_HTML,
  HUB_HTML_HASH,
  SPREAD_HTML,
  SPREAD_HTML_HASH,
  ANALYTICS_HTML,
  ANALYTICS_HTML_HASH,
  SPREAD_ASSETS,
} from "./spread_assets";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check эндпоинт
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", timestamp: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const isGetOrHead = request.method === "GET" || request.method === "HEAD";

    // Static assets for Spread & Analytics Terminals (CSS, JS, Favicons, Logos)
    const filename = url.pathname.split("/").pop() || "";
    const asset = SPREAD_ASSETS[filename];

    if (
      isGetOrHead &&
      asset &&
      (url.pathname.startsWith("/assets/") ||
        url.pathname.startsWith("/spread/assets/") ||
        url.pathname.startsWith("/analytics/assets/") ||
        url.pathname.startsWith("/favicon") ||
        url.pathname.startsWith("/apple-touch-icon") ||
        url.pathname.startsWith("/lighter-logo"))
    ) {
      const clientEtag = request.headers.get("if-none-match");
      if (clientEtag && (clientEtag === asset.hash || clientEtag === `"${asset.hash}"`)) {
        return new Response(null, { status: 304 });
      }

      const isImmutable = url.pathname.includes("/assets/");
      const body = asset.isBase64
        ? Uint8Array.from(atob(asset.content), (c) => c.charCodeAt(0))
        : asset.content;

      return new Response(body, {
        headers: {
          "Content-Type": asset.contentType,
          "ETag": `"${asset.hash}"`,
          "Cache-Control": isImmutable ? "public, max-age=31536000, immutable" : "public, max-age=86400",
        },
      });
    }

    if (
      isGetOrHead &&
      (url.pathname.startsWith("/assets/") ||
        url.pathname.startsWith("/spread/assets/") ||
        url.pathname.startsWith("/analytics/assets/"))
    ) {
      return new Response("Asset Not Found", { status: 404 });
    }

    // Terminal Workspace Hub Router (только GET/HEAD; POST на "/" передается в Telegram webhook)
    if (isGetOrHead && (url.pathname === "/" || url.pathname === "")) {
      const clientEtag = request.headers.get("if-none-match");
      if (clientEtag && (clientEtag === HUB_HTML_HASH || clientEtag === `"${HUB_HTML_HASH}"`)) {
        return new Response(null, { status: 304 });
      }

      return new Response(HUB_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "ETag": `"${HUB_HTML_HASH}"`,
          "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        },
      });
    }

    // Spread & Arbitrage Terminal (только GET/HEAD)
    if (isGetOrHead && (url.pathname === "/spread" || url.pathname === "/spread/")) {
      const clientEtag = request.headers.get("if-none-match");
      if (clientEtag && (clientEtag === SPREAD_HTML_HASH || clientEtag === `"${SPREAD_HTML_HASH}"`)) {
        return new Response(null, { status: 304 });
      }

      return new Response(SPREAD_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "ETag": `"${SPREAD_HTML_HASH}"`,
          "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        },
      });
    }

    // Spread & Basis Analytics Terminal (только GET/HEAD)
    if (isGetOrHead && (url.pathname === "/analytics" || url.pathname === "/analytics/")) {
      const clientEtag = request.headers.get("if-none-match");
      if (clientEtag && (clientEtag === ANALYTICS_HTML_HASH || clientEtag === `"${ANALYTICS_HTML_HASH}"`)) {
        return new Response(null, { status: 304 });
      }

      return new Response(ANALYTICS_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "ETag": `"${ANALYTICS_HTML_HASH}"`,
          "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        },
      });
    }

    // Регистрация команд в Telegram Bot API (setMyCommands)
    if (url.pathname === "/setup-commands") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response(
          JSON.stringify({ ok: false, error: "TELEGRAM_BOT_TOKEN is not configured" }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
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

    // Для любых не-POST запросов Telegram логика никогда не вызывается
    if (request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    // Вебхук Telegram обрабатывается только на корневом эндпоинте "/"
    if (url.pathname !== "/") {
      return new Response("Not Found", { status: 404 });
    }

    // Проверка Secret Token для безопасности вебхука Telegram
    if (env.TELEGRAM_SECRET_TOKEN) {
      const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (headerSecret !== env.TELEGRAM_SECRET_TOKEN) {
        return new Response("Unauthorized", { status: 403 });
      }
    }

    if (!env.TELEGRAM_BOT_TOKEN) {
      return new Response("Bot token not configured", { status: 503 });
    }

    const bot = getBot(env);
    const cb = webhookCallback(bot, "cloudflare-mod");
    return await executionContextStorage.run(ctx, () => cb(request as any));
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCronMonitor(env, ctx));
  },
};
