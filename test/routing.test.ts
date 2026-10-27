import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Env } from "../apps/bot/src/types";

const versionFile = path.resolve(import.meta.dirname, "../apps/web/src/version.ts");
if (!fs.existsSync(versionFile)) {
  execSync("bun run --cwd apps/web build", { stdio: "ignore" });
}

const { default: worker } = await import("../src/index");

function createSuccessMockDb(): any {
  const stmt = {
    bind: () => stmt,
    run: async () => ({ success: true, meta: { changes: 0 } }),
    all: async () => ({ results: [] }),
    first: async () => null,
  };
  return {
    prepare: () => stmt,
    batch: async () => [],
  };
}

describe("Worker HTTP Routing", () => {
  const mockEnv: Env = {
    DB: {} as any,
    TELEGRAM_BOT_TOKEN: "mock_token",
    TELEGRAM_SECRET_TOKEN: "secret_123",
  };

  const mockCtx: ExecutionContext = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  it("serves health check on GET /health", async () => {
    const req = new Request("https://worker.dev/health", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("ok");
  });

  it("serves terminal hub router HTML on GET /", async () => {
    const req = new Request("https://worker.dev/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Select Terminal Workspace");
    expect(html).toContain("Hub | Lighter");
  });

  it("serves spread monitor HTML on GET /spread", async () => {
    const req = new Request("https://worker.dev/spread", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Spread | Lighter");
  });

  it("serves spread monitor HTML on GET /spread/", async () => {
    const req = new Request("https://worker.dev/spread/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves analytics HTML on GET /analytics", async () => {
    const req = new Request("https://worker.dev/analytics", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Analytics | Lighter");
  });

  it("serves analytics HTML on GET /analytics/", async () => {
    const req = new Request("https://worker.dev/analytics/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves analytics HTML on GET /analytics/XAU", async () => {
    const req = new Request("https://worker.dev/analytics/XAU", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Analytics | Lighter");
  });

  it("serves analytics HTML on GET /analytics/BTC/", async () => {
    const req = new Request("https://worker.dev/analytics/BTC/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves analytics HTML on GET /analytics/XAU via env.ASSETS (Cloudflare Workers simulation)", async () => {
    const assetReqs: string[] = [];
    const envWithAssets: Env = {
      ...mockEnv,
      ASSETS: {
        fetch: async (r: Request | string) => {
          const u = typeof r === "string" ? r : r.url;
          assetReqs.push(u);
          return new Response(
            "<!doctype html><html><head><title>Analytics | Lighter</title></head></html>",
            {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            },
          );
        },
      } as any,
    };
    const req = new Request("https://worker.dev/analytics/XAU", { method: "GET" });
    const res = await worker.fetch(req, envWithAssets, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(assetReqs.length).toBe(1);
    expect(assetReqs[0]).toContain("/analytics.html");
  });

  it("serves hedge trade checker HTML on GET /checker", async () => {
    const req = new Request("https://worker.dev/checker", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Checker | Lighter");
    expect(html).toContain("hedgeViewWrapper");
  });

  it("serves hedge trade checker HTML on GET /checker/", async () => {
    const req = new Request("https://worker.dev/checker/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("redirects GET /checker/solo to /checker", async () => {
    const req = new Request("https://worker.dev/checker/solo", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://worker.dev/checker");
  });

  it("redirects GET /checker/solo/ to /checker", async () => {
    const req = new Request("https://worker.dev/checker/solo/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://worker.dev/checker");
  });

  it("redirects GET /checker/hedge to /checker", async () => {
    const req = new Request("https://worker.dev/checker/hedge", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://worker.dev/checker");
  });

  it("redirects GET /checker/hedge/ to /checker", async () => {
    const req = new Request("https://worker.dev/checker/hedge/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://worker.dev/checker");
  });

  it("does NOT intercept POST / with HTML; passes through to Telegram webhook", async () => {
    // A Telegram webhook POST to "/" without the secret token should be rejected with 403, NOT return HTML 200
    const req = new Request("https://worker.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toBe("Unauthorized");
  });

  it("does NOT allow env.ASSETS to intercept POST / or return 405 for Telegram webhooks", async () => {
    const envWithAssets: Env = {
      ...mockEnv,
      ASSETS: {
        fetch: async () => new Response(null, { status: 405 }),
      } as any,
    };
    const req = new Request("https://worker.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    const res = await worker.fetch(req, envWithAssets, mockCtx);
    // Should NOT be 405 from ASSETS, must be handled by telegram webhook handler (403 without secret token)
    expect(res.status).toBe(403);
  });

  it("supports POST /webhook for Telegram webhook updates", async () => {
    const req = new Request("https://worker.dev/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(403);
  });

  it("never invokes Telegram bot logic on unknown GET requests even if TELEGRAM_BOT_TOKEN is empty", async () => {
    const emptyEnv: Env = {
      DB: {} as any,
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_SECRET_TOKEN: "",
    };
    const req = new Request("https://worker.dev/some-unknown-route", { method: "GET" });
    const res = await worker.fetch(req, emptyEnv, mockCtx);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toBe("Not Found");
  });

  it("serves app version on GET /api/version", async () => {
    const req = new Request("https://worker.dev/api/version", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("ETag")).toBeDefined();

    const data = (await res.json()) as {
      version: string;
      spreadHash: string;
      analyticsHash: string;
    };
    expect(typeof data.version).toBe("string");
    expect(data.version.length).toBeGreaterThan(0);
    expect(typeof data.spreadHash).toBe("string");
  });

  it("handles 304 Not Modified on /api/version when ETag matches", async () => {
    const req1 = new Request("https://worker.dev/api/version", { method: "GET" });
    const res1 = await worker.fetch(req1, mockEnv, mockCtx);
    const etag = res1.headers.get("ETag");
    expect(etag).not.toBeNull();

    const req2 = new Request("https://worker.dev/api/version", {
      method: "GET",
      headers: { "If-None-Match": etag! },
    });
    const res2 = await worker.fetch(req2, mockEnv, mockCtx);
    expect(res2.status).toBe(304);
  });

  it("serves app version on HEAD /api/version without body", async () => {
    const req = new Request("https://worker.dev/api/version", { method: "HEAD" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeDefined();
    const text = await res.text();
    expect(text).toBe("");
  });

  it("returns 404 on POST to non-root paths", async () => {
    const req = new Request("https://worker.dev/spread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(404);
  });

  describe("External Cron Trigger Endpoint (/api/cron)", () => {
    const cronEnv: Env = {
      DB: createSuccessMockDb(),
      TELEGRAM_BOT_TOKEN: "mock_token",
      CRON_SECRET: "my_super_secret_token_123",
    };

    it("executes cron via GET /api/cron when CRON_SECRET is not configured", async () => {
      const envWithoutSecret: Env = {
        DB: createSuccessMockDb(),
        TELEGRAM_BOT_TOKEN: "mock_token",
      };
      const req = new Request("https://worker.dev/api/cron", { method: "GET" });
      const res = await worker.fetch(req, envWithoutSecret, mockCtx);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.trigger).toBe("http");
      expect(typeof data.duration_ms).toBe("number");
    });

    it("rejects unauthorized request with 401 when CRON_SECRET is set but missing in request", async () => {
      const req = new Request("https://worker.dev/api/cron", { method: "GET" });
      const res = await worker.fetch(req, cronEnv, mockCtx);
      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(false);
      expect(data.error).toBe("Unauthorized");
    });

    it("rejects unauthorized request with 401 when token is invalid", async () => {
      const req = new Request("https://worker.dev/api/cron?key=wrong_key", { method: "GET" });
      const res = await worker.fetch(req, cronEnv, mockCtx);
      expect(res.status).toBe(401);
    });

    it("authorizes and executes cron via query parameter (?key=...)", async () => {
      const req = new Request("https://worker.dev/api/cron?key=my_super_secret_token_123", {
        method: "GET",
      });
      const res = await worker.fetch(req, cronEnv, mockCtx);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.trigger).toBe("http");
    });

    it("authorizes and executes cron via Authorization Bearer header", async () => {
      const req = new Request("https://worker.dev/api/cron", {
        method: "POST",
        headers: { Authorization: "Bearer my_super_secret_token_123" },
      });
      const res = await worker.fetch(req, cronEnv, mockCtx);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
    });

    it("authorizes and executes cron via x-cron-secret header", async () => {
      const req = new Request("https://worker.dev/api/cron", {
        method: "GET",
        headers: { "x-cron-secret": "my_super_secret_token_123" },
      });
      const res = await worker.fetch(req, cronEnv, mockCtx);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
    });

    it("handles HEAD /api/cron without executing cron", async () => {
      const req = new Request("https://worker.dev/api/cron?key=my_super_secret_token_123", {
        method: "HEAD",
      });
      const res = await worker.fetch(req, cronEnv, mockCtx);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    });

    it("returns 405 Method Not Allowed for unsupported methods (PUT, DELETE)", async () => {
      const req = new Request("https://worker.dev/api/cron?key=my_super_secret_token_123", {
        method: "DELETE",
      });
      const res = await worker.fetch(req, cronEnv, mockCtx);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, POST, HEAD");
    });

    it("returns 500 when cron execution throws an error", async () => {
      const failingDb: any = {
        prepare: () => {
          throw new Error("D1 connection lost");
        },
      };
      const failingEnv: Env = {
        DB: failingDb,
        TELEGRAM_BOT_TOKEN: "mock_token",
        CRON_SECRET: "secret",
      };
      const req = new Request("https://worker.dev/api/cron?key=secret", { method: "GET" });
      const res = await worker.fetch(req, failingEnv, mockCtx);
      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(false);
      expect(data.error).toContain("D1 connection lost");
    });
  });
});
