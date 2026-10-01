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
