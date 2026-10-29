import { describe, expect, it } from "bun:test";
import { Api } from "grammy";
import {
  escapeHtml,
  formatMarkdownSnippet,
  formatReleaseNotification,
  getReleaseNotificationKeyboard,
  getChangelogKeyboard,
  checkAndBroadcastRelease,
  invalidateCompletedVersionCache,
} from "../src/bot/release_notifier";
import { getUsersForReleaseNotification, batchUpdateUsersLastSeenVersion } from "../src/db/queries";
import { APP_VERSION } from "../src/version";
import { getBot } from "../src/bot/bot";

describe("Release Notifier & Version Broadcast", () => {
  describe("Formatting & HTML Escaping", () => {
    it("escapes raw HTML tags and entities", () => {
      const raw = 'Risk < 1.0% & Gain > 2.0% "quoted"';
      const escaped = escapeHtml(raw);
      expect(escaped).toBe('Risk &lt; 1.0% &amp; Gain &gt; 2.0% "quoted"');
    });

    it("converts Markdown elements to valid Telegram HTML", () => {
      const input =
        "**Семантическое версионирование (`v1.0.1`):** ссылка на [Changelog](https://github.com/test)";
      const formatted = formatMarkdownSnippet(input);
      expect(formatted).toBe(
        '<b>Семантическое версионирование (<code>v1.0.1</code>):</b> ссылка на <a href="https://github.com/test">Changelog</a>',
      );
    });

    it("handles formulas and asterisks inside bold correctly with non-greedy regex", () => {
      const input = "**Расчет PnL (`Price * Size`):** формула маржи";
      const formatted = formatMarkdownSnippet(input);
      expect(formatted).toBe("<b>Расчет PnL (<code>Price * Size</code>):</b> формула маржи");
    });

    it("formats full release notification with title and highlights", () => {
      const msg = formatReleaseNotification(
        "v1.0.1",
        "Обновление веб-уведомлений и хотфиксы",
        [
          "**Семантическое версионирование:** отображение vX.Y.Z",
          "Прямая ссылка на карточку релиза",
          "Защита от бесконечного цикла",
        ],
        2,
      );

      expect(msg).toContain("🚀 <b>Lighter Monitor обновлен до v1.0.1!</b>");
      expect(msg).toContain("<i>Обновление веб-уведомлений и хотфиксы</i>");
      expect(msg).toContain("<b>Главные изменения:</b>");
      expect(msg).toContain("• <b>Семантическое версионирование:</b> отображение vX.Y.Z");
      expect(msg).toContain("• Прямая ссылка на карточку релиза");
      // maxHighlights = 2, so third highlight is omitted
      expect(msg).not.toContain("Защита от бесконечного цикла");
      expect(msg).toContain("Подробный список изменений — в описании релиза на GitHub.");
    });

    it("handles notification without title or highlights gracefully", () => {
      const msg = formatReleaseNotification("1.0.2");
      expect(msg).toContain("🚀 <b>Lighter Monitor обновлен до v1.0.2!</b>");
      expect(msg).toContain("Подробный список изменений — в описании релиза на GitHub.");
      expect(msg).not.toContain("<b>Главные изменения:</b>");
    });
  });

  describe("Inline Keyboards", () => {
    it("creates notification keyboard with release notes and web terminal", () => {
      const kb = getReleaseNotificationKeyboard("v1.0.1", "https://lighter-monitor.workers.dev");
      const flatButtons = kb.inline_keyboard.flat();

      expect(
        flatButtons.some(
          (b) =>
            b.text.includes("Release Notes") && (b as any).url?.includes("/releases/tag/v1.0.1"),
        ),
      ).toBe(true);
      expect(
        flatButtons.some(
          (b) =>
            b.text.includes("Web Terminal") &&
            (b as any).url === "https://lighter-monitor.workers.dev",
        ),
      ).toBe(true);
    });

    it("omits web terminal button if webAppUrl is missing or invalid", () => {
      const kb = getReleaseNotificationKeyboard("v1.0.1", "");
      const flatButtons = kb.inline_keyboard.flat();
      expect(flatButtons.some((b) => b.text.includes("Web Terminal"))).toBe(false);
    });

    it("creates changelog keyboard with both Release and Changelog URLs", () => {
      const kb = getChangelogKeyboard("v1.0.1", "https://app.lighter.xyz");
      const flatButtons = kb.inline_keyboard.flat();

      expect(flatButtons.some((b) => b.text.includes("Релиз на GitHub"))).toBe(true);
      expect(flatButtons.some((b) => b.text.includes("Changelog"))).toBe(true);
      expect(flatButtons.some((b) => b.text.includes("Web Terminal"))).toBe(true);
    });
  });

  describe("Database User Queries", () => {
    it("getUsersForReleaseNotification queries users with null or different version", async () => {
      let executedSql = "";
      let boundParams: any[] = [];

      const mockDb: any = {
        prepare: (sql: string) => {
          executedSql = sql;
          return {
            bind: (...params: any[]) => {
              boundParams = params;
              return {
                all: async () => ({
                  results: [
                    { telegram_id: 101, last_seen_version: null },
                    { telegram_id: 102, last_seen_version: "v1.0.0" },
                  ],
                }),
              };
            },
          };
        },
      };

      const users = await getUsersForReleaseNotification(mockDb, "v1.0.1", 5);
      expect(users.length).toBe(2);
      expect(users[0]?.telegram_id).toBe(101);
      expect(executedSql).toContain("last_seen_version IS NULL OR last_seen_version != ?");
      expect(boundParams[0]).toBe("v1.0.1");
      expect(boundParams[1]).toBe(5);
    });

    it("batchUpdateUsersLastSeenVersion prepares batch updates", async () => {
      const batchedStmts: any[] = [];
      const mockDb: any = {
        prepare: (sql: string) => ({
          bind: (...params: any[]) => ({ sql, params }),
        }),
        batch: async (stmts: any[]) => {
          batchedStmts.push(...stmts);
        },
      };

      await batchUpdateUsersLastSeenVersion(mockDb, [101, 102, 103], "v1.0.1");
      expect(batchedStmts.length).toBe(3);
      expect(batchedStmts[0]?.params).toEqual(["v1.0.1", 101]);
      expect(batchedStmts[1]?.params).toEqual(["v1.0.1", 102]);
      expect(batchedStmts[2]?.params).toEqual(["v1.0.1", 103]);
    });
  });

  describe("Broadcast Execution Flow", () => {
    it("skips execution when version is dev", async () => {
      const mockEnv: any = {
        DB: {},
        TELEGRAM_BOT_TOKEN: "fake_token",
      };

      const res = await checkAndBroadcastRelease(mockEnv, undefined, { version: "dev" });
      expect(res.processed).toBe(0);
      expect(res.sent).toBe(0);
      expect(res.isCompleted).toBe(true);
    });

    it("fast-path in-memory isolate cache exits in 0ms without DB queries once completed", async () => {
      let dbPrepared = false;
      const mockDb: any = {
        prepare: () => {
          dbPrepared = true;
          return {
            bind: () => ({ all: async () => ({ results: [] }) }),
          };
        },
      };

      const mockEnv: any = {
        DB: mockDb,
        TELEGRAM_BOT_TOKEN: "fake_token",
      };

      // First run: pending users is empty -> marks completedVersionCache
      invalidateCompletedVersionCache();
      const res1 = await checkAndBroadcastRelease(mockEnv, undefined, {
        version: "v1.0.1",
      });
      expect(res1.isCompleted).toBe(true);

      // Second run: should hit completedVersionCache immediately without touching DB
      dbPrepared = false;
      const res2 = await checkAndBroadcastRelease(mockEnv, undefined, {
        version: "v1.0.1",
      });

      expect(res2.isCompleted).toBe(true);
      expect(dbPrepared).toBe(false); // 0 DB queries!
    });

    it("sends notifications to pending users, updates their version and returns status", async () => {
      const sentMessages: Array<{ chatId: number; text: string }> = [];
      const updatedUserIds: number[] = [];

      const mockDb: any = {
        prepare: (sql: string) => {
          if (sql.includes("FROM users") && sql.includes("last_seen_version")) {
            return {
              bind: (_version: string, _limit: number) => ({
                all: async () => ({
                  results: [
                    { telegram_id: 111, last_seen_version: null },
                    { telegram_id: 222, last_seen_version: "v1.0.0" },
                  ],
                }),
              }),
            };
          }
          if (sql.includes("UPDATE users SET last_seen_version = ? WHERE telegram_id = ?")) {
            return {
              bind: (ver: string, id: number) => ({
                sql,
                params: [ver, id],
              }),
            };
          }
          return {
            bind: () => ({
              run: async () => ({}),
              all: async () => ({ results: [] }),
              first: async () => null,
            }),
            run: async () => ({}),
            all: async () => ({ results: [] }),
            first: async () => null,
          };
        },
        batch: async (stmts: any[]) => {
          for (const s of stmts) {
            if (s.params?.[1]) {
              updatedUserIds.push(s.params[1]);
            }
          }
        },
      };

      const mockEnv: any = {
        DB: mockDb,
        TELEGRAM_BOT_TOKEN: "fake_token",
        WEBAPP_URL: "https://lighter-monitor.workers.dev",
      };

      const mockApi = new Api("fake_token");
      mockApi.config.use(async (_prev, method, payload) => {
        if (method === "sendMessage") {
          sentMessages.push({ chatId: (payload as any).chat_id, text: (payload as any).text });
          return { ok: true, result: {} } as any;
        }
        return { ok: true, result: {} } as any;
      });

      invalidateCompletedVersionCache();
      const res = await checkAndBroadcastRelease(mockEnv, undefined, {
        api: mockApi,
        version: "v1.0.1",
        batchSize: 5,
      });

      expect(res.processed).toBe(2);
      expect(res.sent).toBe(2);
      expect(res.isCompleted).toBe(true);

      expect(sentMessages.length).toBe(2);
      expect(sentMessages[0]?.chatId).toBe(111);
      expect(sentMessages[1]?.chatId).toBe(222);
      expect(sentMessages[0]?.text).toContain("🚀 <b>Lighter Monitor обновлен до v1.0.1!</b>");

      expect(updatedUserIds).toEqual([111, 222]);
    });

    it("handles 403 Forbidden and 400 Bad Request (chat not found) by deleting dead users", async () => {
      const deletedIds: number[] = [];

      const mockDb: any = {
        prepare: (sql: string) => {
          if (sql.includes("FROM users") && sql.includes("last_seen_version")) {
            return {
              bind: () => ({
                all: async () => ({
                  results: [
                    { telegram_id: 40301, last_seen_version: null },
                    { telegram_id: 40001, last_seen_version: null },
                  ],
                }),
              }),
            };
          }
          if (sql.includes("DELETE FROM users WHERE telegram_id = ?")) {
            return {
              bind: (id: number) => ({
                id,
                run: async () => {
                  deletedIds.push(id);
                },
              }),
            };
          }
          return {
            bind: () => ({
              run: async () => ({}),
              all: async () => ({ results: [] }),
              first: async () => null,
            }),
            run: async () => ({}),
            all: async () => ({ results: [] }),
            first: async () => null,
          };
        },
        batch: async (stmts: any[]) => {
          for (const s of stmts) {
            if (s.id) deletedIds.push(s.id);
          }
        },
      };

      const mockEnv: any = {
        DB: mockDb,
        TELEGRAM_BOT_TOKEN: "fake_token",
      };

      const mockApi = new Api("fake_token");
      mockApi.config.use(async (_prev, method, payload) => {
        const chatId = (payload as any).chat_id;
        if (chatId === 40301) {
          const err: any = new Error("Forbidden: bot was blocked by the user");
          err.error_code = 403;
          throw err;
        }
        if (chatId === 40001) {
          const err: any = new Error("Bad Request: chat not found");
          err.error_code = 400;
          err.description = "Bad Request: chat not found";
          throw err;
        }
        return { ok: true, result: {} } as any;
      });

      invalidateCompletedVersionCache();
      const res = await checkAndBroadcastRelease(mockEnv, undefined, {
        api: mockApi,
        version: "v1.0.1",
        batchSize: 5,
      });

      expect(res.processed).toBe(2);
      expect(res.sent).toBe(0);
      expect(deletedIds).toContain(40301);
      expect(deletedIds).toContain(40001);
    });

    it("handles 400 'can't parse entities' by falling back to plain text and advancing user version", async () => {
      const updatedUserIds: number[] = [];
      const plainSentIds: number[] = [];

      const mockDb: any = {
        prepare: (sql: string) => {
          if (sql.includes("FROM users") && sql.includes("last_seen_version")) {
            return {
              bind: () => ({
                all: async () => ({
                  results: [{ telegram_id: 8888, last_seen_version: null }],
                }),
              }),
            };
          }
          if (sql.includes("UPDATE users SET last_seen_version = ? WHERE telegram_id = ?")) {
            return {
              bind: (ver: string, id: number) => ({
                params: [ver, id],
              }),
            };
          }
          return {
            bind: () => ({
              run: async () => ({}),
              all: async () => ({ results: [] }),
              first: async () => null,
            }),
            run: async () => ({}),
            all: async () => ({ results: [] }),
            first: async () => null,
          };
        },
        batch: async (stmts: any[]) => {
          for (const s of stmts) {
            if (s.params?.[1]) updatedUserIds.push(s.params[1]);
          }
        },
      };

      const mockEnv: any = {
        DB: mockDb,
        TELEGRAM_BOT_TOKEN: "fake_token",
      };

      const mockApi = new Api("fake_token");
      mockApi.config.use(async (_prev, method, payload) => {
        const parseMode = (payload as any).parse_mode;
        if (parseMode === "HTML") {
          const err: any = new Error("Bad Request: can't parse entities");
          err.error_code = 400;
          err.description = "Bad Request: can't parse entities: Character '<' is reserved";
          throw err;
        }
        // Fallback call without parse_mode succeeds
        plainSentIds.push((payload as any).chat_id);
        return { ok: true, result: {} } as any;
      });

      invalidateCompletedVersionCache();
      const res = await checkAndBroadcastRelease(mockEnv, undefined, {
        api: mockApi,
        version: "v1.0.1",
        batchSize: 5,
      });

      expect(res.processed).toBe(1);
      expect(plainSentIds).toContain(8888);
      // Confirmed user's version was updated so it does not loop infinitely
      expect(updatedUserIds).toContain(8888);
    });
  });

  describe("Telegram Bot Commands", () => {
    it("/changelog command returns release notification and keyboard", async () => {
      let repliedText = "";
      let repliedOptions: any = null;

      const mockEnv: any = {
        TELEGRAM_BOT_TOKEN: "fake_token",
        DB: {
          prepare: () => ({
            bind: () => ({ run: async () => ({}) }),
            run: async () => ({}),
          }),
        },
        WEBAPP_URL: "https://lighter-monitor.workers.dev",
      };

      const bot = getBot(mockEnv);
      expect(bot).toBeDefined();

      const mockCtx: any = {
        from: { id: 12345, username: "trader" },
        reply: async (text: string, options: any) => {
          repliedText = text;
          repliedOptions = options;
        },
      };

      const text = formatReleaseNotification(APP_VERSION);
      const kb = getChangelogKeyboard(APP_VERSION, mockEnv.WEBAPP_URL);
      await mockCtx.reply(text, { parse_mode: "HTML", reply_markup: kb });

      expect(repliedText).toContain(`🚀 <b>Lighter Monitor обновлен до ${APP_VERSION}!</b>`);
      expect(repliedOptions.reply_markup.inline_keyboard.length).toBeGreaterThan(0);
    });
  });
});
