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

  it("serves spread HTML on GET /", async () => {
    const req = new Request("https://worker.dev/", { method: "GET" });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves spread HTML on GET /spread", async () => {
    const req = new Request("https://worker.dev/spread", { method: "GET" });
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
});
