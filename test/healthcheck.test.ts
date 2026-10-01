import { describe, it, expect, afterEach } from "bun:test";
import {
  getHealthcheckFailUrl,
  getHealthcheckSuccessUrl,
  pingHealthcheckSuccess,
  pingHealthcheckFail,
} from "../src/utils/healthcheck";
import { runCronMonitor } from "../src/cron/monitor";
import { Env } from "../src/types";

describe("Healthcheck Monitoring Utilities", () => {
  describe("getHealthcheckFailUrl", () => {
    it("appends /fail to clean URL", () => {
      expect(getHealthcheckFailUrl("https://hc-ping.com/12345")).toBe(
        "https://hc-ping.com/12345/fail",
      );
    });

    it("appends /fail to URL with trailing slash", () => {
      expect(getHealthcheckFailUrl("https://hc-ping.com/12345/")).toBe(
        "https://hc-ping.com/12345/fail",
      );
    });

    it("does not duplicate /fail if already present", () => {
      expect(getHealthcheckFailUrl("https://hc-ping.com/12345/fail")).toBe(
        "https://hc-ping.com/12345/fail",
      );
    });

    it("preserves query parameters while inserting /fail", () => {
      expect(getHealthcheckFailUrl("https://hc-ping.com/12345?tag=cron")).toBe(
        "https://hc-ping.com/12345/fail?tag=cron",
      );
    });

    it("works with self-hosted custom path endpoints", () => {
      expect(getHealthcheckFailUrl("https://healthcheck.corp.com/ping/my-uuid/")).toBe(
        "https://healthcheck.corp.com/ping/my-uuid/fail",
      );
    });
  });

  describe("getHealthcheckSuccessUrl", () => {
    it("strips trailing slash", () => {
      expect(getHealthcheckSuccessUrl("https://hc-ping.com/12345/")).toBe(
        "https://hc-ping.com/12345",
      );
    });

    it("strips accidental /fail suffix for success pings", () => {
      expect(getHealthcheckSuccessUrl("https://hc-ping.com/12345/fail")).toBe(
        "https://hc-ping.com/12345",
      );
    });

    it("strips accidental /start suffix for success pings", () => {
      expect(getHealthcheckSuccessUrl("https://hc-ping.com/12345/start")).toBe(
        "https://hc-ping.com/12345",
      );
    });
  });

  describe("pingHealthcheckSuccess", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("sends POST with JSON body when payload is provided", async () => {
      let calledUrl = "";
      let calledMethod = "";
      let calledBody = "";

      globalThis.fetch = (async (input: any, init?: any) => {
        calledUrl = String(input);
        calledMethod = init?.method || "GET";
        calledBody = init?.body ? String(init.body) : "";
        return new Response("OK", { status: 200 });
      }) as any;

      await pingHealthcheckSuccess("https://hc-ping.com/uuid-test", {
        event: "cron_completed",
        duration_ms: 120,
      });

      expect(calledUrl).toBe("https://hc-ping.com/uuid-test");
      expect(calledMethod).toBe("POST");
      expect(calledBody).toContain('"event": "cron_completed"');
    });

    it("falls back to GET if POST returns 405 Method Not Allowed", async () => {
      const calls: Array<{ url: string; method: string }> = [];

      globalThis.fetch = (async (input: any, init?: any) => {
        const method = init?.method || "GET";
        calls.push({ url: String(input), method });
        if (method === "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return new Response("OK", { status: 200 });
      }) as any;

      await pingHealthcheckSuccess("https://hc-ping.com/uuid-test", { ok: true });

      expect(calls.length).toBe(2);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[1]?.method).toBe("GET");
    });

    it("does not throw if network fetch fails", async () => {
      globalThis.fetch = (async () => {
        throw new Error("Network unreachable");
      }) as any;

      expect(pingHealthcheckSuccess("https://hc-ping.com/uuid-test")).resolves.toBeUndefined();
    });

    it("no-ops if url is empty or undefined", async () => {
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return new Response("OK");
      }) as any;

      await pingHealthcheckSuccess("");
      await pingHealthcheckSuccess(undefined);
      expect(called).toBe(false);
    });
  });

  describe("pingHealthcheckFail", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("sends POST to /fail endpoint with error diagnostic body", async () => {
      let calledUrl = "";
      let calledMethod = "";
      let calledBody = "";
      let contentType = "";

      globalThis.fetch = (async (input: any, init?: any) => {
        calledUrl = String(input);
        calledMethod = init?.method || "GET";
        calledBody = init?.body ? String(init.body) : "";
        contentType = init?.headers?.["Content-Type"] || "";
        return new Response("OK", { status: 200 });
      }) as any;

      const testError = new TypeError("D1 connection lost");
      await pingHealthcheckFail("https://hc-ping.com/my-uuid", testError, {
        duration_ms: 500,
        subrequests_used: 12,
      });

      expect(calledUrl).toBe("https://hc-ping.com/my-uuid/fail");
      expect(calledMethod).toBe("POST");
      expect(contentType).toContain("text/plain");
      expect(calledBody).toContain("CRON MONITOR EXECUTION FAILED");
      expect(calledBody).toContain("TypeError: D1 connection lost");
      expect(calledBody).toContain("Context:");
      expect(calledBody).toContain('"duration_ms": 500');
    });

    it("falls back to GET on /fail if POST receives 405", async () => {
      const calls: Array<{ url: string; method: string }> = [];

      globalThis.fetch = (async (input: any, init?: any) => {
        const method = init?.method || "GET";
        calls.push({ url: String(input), method });
        if (method === "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return new Response("OK", { status: 200 });
      }) as any;

      await pingHealthcheckFail("https://hc-ping.com/my-uuid", new Error("Boom"));

      expect(calls.length).toBe(2);
      expect(calls[0]?.url).toBe("https://hc-ping.com/my-uuid/fail");
      expect(calls[0]?.method).toBe("POST");
      expect(calls[1]?.url).toBe("https://hc-ping.com/my-uuid/fail");
      expect(calls[1]?.method).toBe("GET");
    });

    it("falls back to GET on /fail if POST throws a network error", async () => {
      const calls: Array<{ url: string; method: string }> = [];

      globalThis.fetch = (async (input: any, init?: any) => {
        const method = init?.method || "GET";
        calls.push({ url: String(input), method });
        if (method === "POST") {
          throw new Error("HTTP POST connection timeout");
        }
        return new Response("OK", { status: 200 });
      }) as any;

      await pingHealthcheckFail("https://hc-ping.com/my-uuid", new Error("Boom"));

      expect(calls.length).toBe(2);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[1]?.method).toBe("GET");
    });

    it("never throws even if all attempts fail", async () => {
      globalThis.fetch = (async () => {
        throw new Error("Internet completely down");
      }) as any;

      expect(
        pingHealthcheckFail("https://hc-ping.com/my-uuid", new Error("Fatal")),
      ).resolves.toBeUndefined();
    });
  });

  describe("runCronMonitor Failure Signal Integration", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("sends fail ping with diagnostic info and records error in D1 when cron fails", async () => {
      const failPings: Array<{ url: string; method: string; body: string }> = [];
      const d1ExecutedQueries: Array<{ query: string; params: any[] }> = [];

      globalThis.fetch = (async (input: any, init?: any) => {
        const urlStr = String(input);
        if (urlStr.includes("hc-ping.com")) {
          failPings.push({
            url: urlStr,
            method: init?.method || "GET",
            body: init?.body ? String(init.body) : "",
          });
          return new Response("OK", { status: 200 });
        }
        if (urlStr.includes("exchangeStats")) {
          return new Response(JSON.stringify({ code: 200, order_book_stats: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }) as any;

      const createStmt = (query: string, boundParams: any[] = []) => ({
        bind: (...params: any[]) => createStmt(query, params),
        run: async () => {
          d1ExecutedQueries.push({ query, params: boundParams });
          if (
            query.includes("bot_system_metrics") &&
            boundParams.some((p) => String(p).includes("cron_failed"))
          ) {
            return { success: true };
          }
          throw new Error("Database disk I/O failure");
        },
        first: async () => {
          throw new Error("Database disk I/O failure");
        },
        all: async () => {
          throw new Error("Database disk I/O failure");
        },
      });

      const mockDb: any = {
        prepare: (query: string) => createStmt(query),
      };

      const env: Env = {
        DB: mockDb,
        TELEGRAM_BOT_TOKEN: "mock_token",
        HEALTHCHECK_URL: "https://hc-ping.com/test-healthcheck-id",
      };

      // Проверяем, что runCronMonitor пробрасывает ошибку наружу...
      await expect(runCronMonitor(env)).rejects.toThrow("Database disk I/O failure");

      // ...но ПРИ ЭТОМ успел отправить запрос на /fail в healthcheck!
      expect(failPings.length).toBeGreaterThan(0);
      const ping = failPings[0]!;
      expect(ping.url).toBe("https://hc-ping.com/test-healthcheck-id/fail");
      expect(ping.method).toBe("POST");
      expect(ping.body).toContain("Database disk I/O failure");

      // ...и сохранил запись в bot_system_metrics с ключом last_cron_error
      const errorMetricQuery = d1ExecutedQueries.find((q) => q.query.includes("last_cron_error"));
      expect(errorMetricQuery).toBeDefined();
    });
  });
});
