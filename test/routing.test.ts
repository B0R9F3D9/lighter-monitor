import { describe, expect, it } from "bun:test";
import worker from "../src/index";
import type { Env } from "../src/types";

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

  it("serves solo trade history checker HTML on GET /checker/solo", async () => {
    const req = new Request("https://worker.dev/checker/solo", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Checker | Lighter");
    expect(html).toContain("modeBtnSolo");
  });

  it("serves solo trade history checker HTML on GET /checker/solo/", async () => {
    const req = new Request("https://worker.dev/checker/solo/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves hedge matcher HTML on GET /checker/hedge", async () => {
    const req = new Request("https://worker.dev/checker/hedge", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Checker | Lighter");
    expect(html).toContain("modeBtnHedge");
  });

  it("serves hedge matcher HTML on GET /checker/hedge/", async () => {
    const req = new Request("https://worker.dev/checker/hedge/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("redirects GET /checker to /checker/solo", async () => {
    const req = new Request("https://worker.dev/checker", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://worker.dev/checker/solo");
  });

  it("redirects GET /checker/ to /checker/solo", async () => {
    const req = new Request("https://worker.dev/checker/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://worker.dev/checker/solo");
  });

  it("redirects legacy GET /hedge to /checker/hedge", async () => {
    const req = new Request("https://worker.dev/hedge", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://worker.dev/checker/hedge");
  });

  it("redirects legacy GET /hedge/ to /checker/hedge", async () => {
    const req = new Request("https://worker.dev/hedge/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://worker.dev/checker/hedge");
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
});
