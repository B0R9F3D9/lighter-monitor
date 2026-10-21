import type { Env } from "../apps/bot/src/types";
import { handleBotWebhook, setupBotCommands, runBotScheduled } from "../apps/bot/src";
import {
  APP_VERSION,
  HUB_HTML_HASH,
  SPREAD_HTML_HASH,
  ANALYTICS_HTML_HASH,
  CHECKER_HTML_HASH,
} from "../apps/web/src/version";

/**
 * Local Bun fallback to serve static assets from `./apps/web/dist` during local development
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
    pathname = "/checker.html";
  } else if (
    pathname === "/checker/solo" ||
    pathname === "/checker/solo/" ||
    pathname === "/checker/hedge" ||
    pathname === "/checker/hedge/"
  ) {
    return Response.redirect(new URL("/checker", request.url).toString(), 302);
  } else if (pathname.includes("/assets/")) {
    pathname = pathname.slice(pathname.indexOf("/assets/"));
  }

  let file = BunRef.file("./apps/web/dist" + pathname);
  if (!(await file.exists())) {
    file = BunRef.file("./dist" + pathname);
  }
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

    // Clean URL redirects for legacy Checker sub-routes (/checker/solo, /checker/hedge, /hedge -> /checker)
    if (isGetOrHead) {
      if (
        url.pathname === "/checker/solo" ||
        url.pathname === "/checker/solo/" ||
        url.pathname === "/checker/hedge" ||
        url.pathname === "/checker/hedge/"
      ) {
        return Response.redirect(new URL("/checker", request.url).toString(), 302);
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
              checkerHash: CHECKER_HTML_HASH,
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

    // Telegram Bot API command registration (setMyCommands) and Menu Button
    if (url.pathname === "/setup-commands") {
      try {
        const res = await setupBotCommands(env, url.protocol === "https:" ? url.origin : undefined);
        return new Response(JSON.stringify(res), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Telegram webhook handler (POST to "/" or "/webhook")
    if (
      request.method === "POST" &&
      (url.pathname === "/" ||
        url.pathname === "" ||
        url.pathname === "/webhook" ||
        url.pathname === "/webhook/")
    ) {
      return await handleBotWebhook(request, env, ctx);
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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await runBotScheduled(event, env, ctx);
  },
};
