import { webhookCallback } from "grammy";
import { Env } from "./types";
import { getBot } from "./bot/bot";
import { runCronMonitor } from "./cron/monitor";
import { executionContextStorage } from "./utils/background";
import {
  APP_VERSION,
  HUB_HTML_HASH,
  SPREAD_HTML_HASH,
  ANALYTICS_HTML_HASH,
  CHECKER_SOLO_HTML_HASH,
  CHECKER_HEDGE_HTML_HASH,
  CHECKER_HTML_HASH,
  HEDGE_HTML_HASH,
} from "./version";

/**
 * Local Bun fallback to serve static assets from `./dist` during local development
 * (e.g. `bun run web` or `bun test`) when Cloudflare CDN / env.ASSETS is not available.
 */
async function serveLocalBunAsset(request: Request): Promise<Response | null> {
  const BunRef = (globalThis as any).Bun;
  if (!BunRef) return null;

  const url = new URL(request.url);
  let pathname = url.pathname;

  if (pathname === "/" || pathname === "") {
    pathname = "/index.html";
  } else if (pathname === "/spread" || pathname === "/spread/") {
    pathname = "/spread.html";
  } else if (pathname === "/analytics" || pathname === "/analytics/") {
    pathname = "/analytics.html";
  } else if (pathname === "/checker" || pathname === "/checker/") {
    return Response.redirect(new URL("/checker/solo", request.url).toString(), 302);
  } else if (pathname === "/hedge" || pathname === "/hedge/") {
    return Response.redirect(new URL("/checker/hedge", request.url).toString(), 302);
  } else if (pathname === "/checker/solo" || pathname === "/checker/solo/") {
    pathname = "/checker/solo.html";
  } else if (pathname === "/checker/hedge" || pathname === "/checker/hedge/") {
    pathname = "/checker/hedge.html";
  } else if (pathname.includes("/assets/")) {
    pathname = pathname.slice(pathname.indexOf("/assets/"));
  }

  const file = BunRef.file("./dist" + pathname);
  if (await file.exists()) {
    const isImmutable = pathname.includes("/assets/");
    return new Response(file, {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Cache-Control": isImmutable
          ? "public, max-age=31536000, immutable"
          : "public, max-age=60, stale-while-revalidate=300",
      },
    });
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", timestamp: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const isGetOrHead = request.method === "GET" || request.method === "HEAD";

    // Clean URL redirects for Checker sub-routes (/checker -> /checker/solo, /hedge -> /checker/hedge)
    if (isGetOrHead) {
      if (url.pathname === "/checker" || url.pathname === "/checker/") {
        return Response.redirect(new URL("/checker/solo", request.url).toString(), 302);
      }
      if (url.pathname === "/hedge" || url.pathname === "/hedge/") {
        return Response.redirect(new URL("/checker/hedge", request.url).toString(), 302);
      }
    }

    // Version check endpoint for automatic client updates
    if (isGetOrHead && (url.pathname === "/api/version" || url.pathname === "/api/version/")) {
      const clientEtag = request.headers.get("if-none-match");
      if (clientEtag && (clientEtag === APP_VERSION || clientEtag === `"${APP_VERSION}"`)) {
        return new Response(null, { status: 304 });
      }

      const body =
        request.method === "HEAD"
          ? null
          : JSON.stringify({
              version: APP_VERSION,
              spreadHash: SPREAD_HTML_HASH,
              analyticsHash: ANALYTICS_HTML_HASH,
              checkerSoloHash: CHECKER_SOLO_HTML_HASH,
              checkerHedgeHash: CHECKER_HEDGE_HTML_HASH,
              checkerHash: CHECKER_HTML_HASH,
              hedgeHash: HEDGE_HTML_HASH,
              hubHash: HUB_HTML_HASH,
              timestamp: Date.now(),
            });

      return new Response(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
          ETag: `"${APP_VERSION}"`,
        },
      });
    }

    // Telegram Bot API command registration (setMyCommands)
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

    // Telegram webhook handler (POST to "/" or "/webhook")
    if (
      request.method === "POST" &&
      (url.pathname === "/" ||
        url.pathname === "" ||
        url.pathname === "/webhook" ||
        url.pathname === "/webhook/")
    ) {
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
    }

    // Static Assets on Cloudflare via Workers Assets binding (GET / HEAD only)
    if (isGetOrHead && env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        return assetResponse;
      }
    }

    // Local Bun fallback for static assets when running standalone (bun run web / bun test)
    if (isGetOrHead && typeof (globalThis as any).Bun !== "undefined") {
      const localResponse = await serveLocalBunAsset(request);
      if (localResponse) {
        return localResponse;
      }
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCronMonitor(env, ctx));
  },
};
