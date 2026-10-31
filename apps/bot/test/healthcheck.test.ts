import { describe, it, expect, afterEach } from "bun:test";
import {
  getHealthcheckFailUrl,
  getHealthcheckSuccessUrl,
  pingHealthcheckSuccess,
  pingHealthcheckFail,
  resolveAdminTelegramIds,
  checkAndNotifyAdminOutage,
  checkAndNotifyAdminRecovery,
  OUTAGE_ALERT_COOLDOWN_SEC,
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
      expect(JSON.parse(calledBody).event).toBe("cron_completed");
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

  describe("resolveAdminTelegramIds", () => {
    it("parses single numeric ID from env.ADMIN_TELEGRAM_ID", async () => {
      const ids = await resolveAdminTelegramIds(undefined, {
        ADMIN_TELEGRAM_ID: "123456789",
      } as any);
      expect(ids).toEqual([123456789]);
    });

    it("parses multiple comma-separated IDs and negative supergroup IDs", async () => {
      const ids = await resolveAdminTelegramIds(undefined, {
        ADMIN_TELEGRAM_ID: "12345, -100987654321, 67890",
      } as any);
      expect(ids).toEqual([12345, -100987654321, 67890]);
    });

    it("looks up username from users table in DB", async () => {
      const mockDb: any = {
        prepare: (_q: string) => ({
          bind: (username: string) => ({
            first: async () => (username === "superadmin" ? { telegram_id: 555000 } : null),
          }),
        }),
      };
      const ids = await resolveAdminTelegramIds(mockDb, {
        ADMIN_TELEGRAM_ID: "@SuperAdmin",
      } as any);
      expect(ids).toEqual([555000]);
    });

    it("falls back to the first user in DB when env.ADMIN_TELEGRAM_ID is empty", async () => {
      const mockDb: any = {
        prepare: (_q: string) => ({
          first: async () => ({ telegram_id: 777111 }),
        }),
      };
      const ids = await resolveAdminTelegramIds(mockDb, {} as any);
      expect(ids).toEqual([777111]);
    });
  });

  describe("Admin Outage & Recovery Notifications", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("sends outage message to admin on first detection and enforces 15-minute cooldown", async () => {
      const telegramCalls: Array<{ url: string; body: string }> = [];
      const dbState = new Map<string, string>();

      globalThis.fetch = (async (input: any, init?: any) => {
        const urlStr = typeof input === "string" ? input : input?.url || String(input);
        const bodyStr = init?.body
          ? String(init.body)
          : input instanceof Request
            ? await input.clone().text()
            : "";
        if (urlStr.includes("api.telegram.org")) {
          telegramCalls.push({
            url: urlStr,
            body: bodyStr,
          });
          return new Response(JSON.stringify({ ok: true, result: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK");
      }) as any;

      const createStmtHandler = (q: string, boundParams: any[] = []) => ({
        bind: (...params: any[]) => createStmtHandler(q, params),
        first: async () => {
          if (q.includes("admin_outage_state")) {
            const val = dbState.get("admin_outage_state");
            return val ? { value_json: val } : null;
          }
          return null;
        },
        run: async () => {
          if (q.includes("admin_outage_state") && boundParams[0]) {
            dbState.set("admin_outage_state", boundParams[0]);
          }
          return { success: true };
        },
      });

      const mockDb: any = {
        prepare: (q: string) => createStmtHandler(q),
      };

      const env: Env = {
        DB: mockDb,
        TELEGRAM_BOT_TOKEN: "mock_tg_token",
        ADMIN_TELEGRAM_ID: "999000",
      };

      const now = 1700000000;

      // 1. Первая фиксация сбоя: должно отправиться сообщение в Telegram
      await checkAndNotifyAdminOutage(
        env,
        "Биржа Lighter вернула 429 Too Many Requests на все запросы счетов",
        5,
        now,
      );

      expect(telegramCalls.length).toBe(1);
      expect(telegramCalls[0]?.body).toContain("999000");
      expect(telegramCalls[0]?.body).toContain("Сбой API биржи Lighter");
      expect(telegramCalls[0]?.body).toContain("429");

      // Проверяем, что состояние сохранилось в БД
      const stateObj = JSON.parse(dbState.get("admin_outage_state")!);
      expect(stateObj.is_outage).toBe(true);
      expect(stateObj.rate_limits_count).toBe(5);

      // 2. Повторная фиксация через 1 минуту (< 15 мин): сообщение НЕ должно отправляться повторно
      await checkAndNotifyAdminOutage(
        env,
        "Биржа Lighter вернула 429 Too Many Requests на все запросы счетов",
        5,
        now + 60,
      );
      expect(telegramCalls.length).toBe(1); // Количество сообщений не изменилось

      // 3. Повторная фиксация через 16 минут (>= 15 мин): должно отправиться напоминание
      await checkAndNotifyAdminOutage(
        env,
        "Биржа Lighter вернула 429 Too Many Requests на все запросы счетов",
        12,
        now + OUTAGE_ALERT_COOLDOWN_SEC + 60,
      );
      expect(telegramCalls.length).toBe(2);
      expect(telegramCalls[1]?.body).toContain("Сбой продолжается");

      // 4. Восстановление: должно отправиться уведомление о восстановлении и очиститься статус
      await checkAndNotifyAdminRecovery(env, now + OUTAGE_ALERT_COOLDOWN_SEC + 120);
      expect(telegramCalls.length).toBe(3);
      expect(telegramCalls[2]?.body).toContain("Связь с биржей восстановлена");

      const recoveredState = JSON.parse(dbState.get("admin_outage_state")!);
      expect(recoveredState.is_outage).toBe(false);
      expect(recoveredState.recovered_at).toBeGreaterThan(0);

      // 5. Повторный вызов recovery: не должен слать повторных сообщений, так как сбой уже закрыт
      await checkAndNotifyAdminRecovery(env, now + OUTAGE_ALERT_COOLDOWN_SEC + 200);
      expect(telegramCalls.length).toBe(3);
    });
  });

  describe("runCronMonitor Degradation Handling (429 Rate Limits)", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("sends /fail ping to healthcheck and notifies admin when Lighter returns 429", async () => {
      const pings: Array<{ url: string; method: string; body: string }> = [];
      const tgMessages: Array<{ body: string }> = [];
      const d1ExecutedQueries: Array<{ query: string; params: any[] }> = [];

      globalThis.fetch = (async (input: any, init?: any) => {
        const urlStr = typeof input === "string" ? input : input?.url || String(input);
        const bodyStr = init?.body
          ? String(init.body)
          : input instanceof Request
            ? await input.clone().text()
            : "";
        if (urlStr.includes("hc-ping.com")) {
          pings.push({
            url: urlStr,
            method: init?.method || "GET",
            body: bodyStr,
          });
          return new Response("OK", { status: 200 });
        }
        if (urlStr.includes("api.telegram.org")) {
          tgMessages.push({
            body: bodyStr,
          });
          return new Response(JSON.stringify({ ok: true, result: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("exchangeStats")) {
          return new Response(JSON.stringify({ code: 200, order_book_stats: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("account?by=index")) {
          // Имитируем ответ Lighter API 429 Too Many Requests
          return new Response(JSON.stringify({ code: 23000, message: "Too Many Requests!" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }) as any;

      const createStmt = (query: string, boundParams: any[] = []) => ({
        bind: (...params: any[]) => createStmt(query, params),
        run: async () => {
          d1ExecutedQueries.push({ query, params: boundParams });
          return { success: true };
        },
        first: async () => {
          d1ExecutedQueries.push({ query, params: boundParams });
          if (query.includes("admin_outage_state")) {
            return null;
          }
          return null;
        },
        all: async () => {
          d1ExecutedQueries.push({ query, params: boundParams });
          if (
            query.includes("account_positions_cache") ||
            query.includes("getNextAccountsForSync")
          ) {
            return {
              results: [{ network: "rh", account_index: 31704, last_updated_at: 0 }],
            };
          }
          if (query.includes("account_open_positions")) {
            return { results: [] };
          }
          if (query.includes("user_spread_targets")) {
            return { results: [] };
          }
          return { results: [] };
        },
      });

      const mockDb: any = {
        prepare: (query: string) => createStmt(query),
        batch: async (stmts: any[]) => {
          for (const s of stmts) {
            await s.run();
          }
          return [];
        },
      };

      const env: Env = {
        DB: mockDb,
        TELEGRAM_BOT_TOKEN: "mock_tg_token",
        ADMIN_TELEGRAM_ID: "999111",
        HEALTHCHECK_URL: "https://hc-ping.com/my-cron-check",
      };

      // Выполняем тик мониторинга
      await runCronMonitor(env);

      // Проверяем, что Healthchecks.io получил /fail (а не успех!)
      expect(pings.length).toBeGreaterThan(0);
      const failPing = pings.find((p) => p.url.endsWith("/fail"));
      expect(failPing).toBeDefined();
      expect(failPing?.body).toContain("429 Too Many Requests");

      // Проверяем, что админу пришло уведомление в Telegram о блокировке
      expect(tgMessages.length).toBeGreaterThan(0);
      expect(tgMessages[0]?.body).toContain("999111");
      expect(tgMessages[0]?.body).toContain("Сбой API биржи Lighter");
      expect(tgMessages[0]?.body).toContain("Рейт-лимиты (429)");

      // Проверяем, что в D1 записалась ошибка cron_degraded
      const errorSave = d1ExecutedQueries.find(
        (q) =>
          q.query.includes("last_cron_error") && JSON.stringify(q.params).includes("cron_degraded"),
      );
      expect(errorSave).toBeDefined();
    });
  });
});
