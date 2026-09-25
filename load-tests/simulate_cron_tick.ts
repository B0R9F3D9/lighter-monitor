/**
 * End-to-End Simulation of runCronMonitor on Loaded Database
 * Simulates a full cron tick with 50 users, 200 accounts, 500 positions.
 * Tests Phase B: JIT updates, Zombie cleanup, Telegram throttling (850ms), and D1 chunked batching.
 */

import { Database } from "bun:sqlite";
import { runCronMonitor } from "../src/cron/monitor";
import { getBot } from "../src/bot/bot";
import { Env } from "../src/types";

const DB_PATH =
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/7dc3c3c2353934a02643923dba71eefabac45c14426071301f9f69937ef44baa.sqlite";
const sqlite = new Database(DB_PATH);

// Создаем D1Database адаптер для bun:sqlite
function createD1Adapter(db: Database): any {
  return {
    prepare(query: string) {
      return {
        sqlQuery: query,
        sqlParams: [] as any[],
        bind(...params: any[]) {
          this.sqlParams = params;
          return this;
        },
        async first<T = any>(colName?: string): Promise<T | null> {
          const stmt = db.query(this.sqlQuery);
          const row = (this.sqlParams.length > 0 ? stmt.get(...this.sqlParams) : stmt.get()) as any;
          if (!row) return null;
          if (colName) return row[colName] ?? null;
          return row as T;
        },
        async all<T = any>(): Promise<{ results: T[]; meta?: any }> {
          const stmt = db.query(this.sqlQuery);
          const results = (
            this.sqlParams.length > 0 ? stmt.all(...this.sqlParams) : stmt.all()
          ) as T[];
          return { results };
        },
        async run(): Promise<{ meta: { changes: number } }> {
          const stmt = db.query(this.sqlQuery);
          if (this.sqlParams.length > 0) stmt.run(...this.sqlParams);
          else stmt.run();
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(stmts: any[]): Promise<any[]> {
      const results: any[] = [];
      const tx = db.transaction(() => {
        for (const s of stmts) {
          const stmt = db.query(s.sqlQuery);
          if (s.sqlParams.length > 0) stmt.run(...s.sqlParams);
          else stmt.run();
          results.push({ results: [] });
        }
      });
      tx();
      return results;
    },
  };
}

// ============================================================================
// МОКИРОВАНИЕ СЕТЕВОГО СЛОЯ И ТЕЛЕМЕТРИИ
// ============================================================================

interface TelegramAlertRecord {
  userId: number;
  time: number;
  intervalFromLastMs: number | null;
  snippet: string;
  text: string;
}

const telegramRecords: TelegramAlertRecord[] = [];
const lastTelegramTimeByUser = new Map<number, number>();

let exchangeStatsCalls = 0;
let accountApiCalls = 0;
let telegramSends = 0;
let simulatedZombiePositionsReturned = 0;
let simulatedActivePositionsReturned = 0;

const originalFetch = globalThis.fetch;

globalThis.fetch = async (input: string | URL | Request, init?: any): Promise<Response> => {
  const urlStr =
    typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

  // 1. МОК /exchangeStats (срез цен биржи)
  if (urlStr.includes("/exchangeStats")) {
    exchangeStatsCalls++;
    // 50ms сетевая задержка
    await new Promise((r) => setTimeout(r, 50));

    return new Response(
      JSON.stringify({
        code: 200,
        order_book_stats: [
          { symbol: "XAU", last_trade_price: "4280.0" },
          { symbol: "BTC", last_trade_price: "83850.0" },
          { symbol: "ETH", last_trade_price: "2670.0" },
          { symbol: "SOL", last_trade_price: "116.0" },
          { symbol: "DOGE", last_trade_price: "0.095" },
          { symbol: "AVAX", last_trade_price: "10.1" },
          { symbol: "LINK", last_trade_price: "13.4" },
          { symbol: "PEPE", last_trade_price: "0.00001234" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // 2. МОК /account?by=index (запрос позиций кошелька биржи)
  if (urlStr.includes("/account?by=index") || urlStr.includes("/account")) {
    accountApiCalls++;
    // 100ms сетевая задержка к бирже
    await new Promise((r) => setTimeout(r, 100));

    // Извлекаем accountIndex из query параметра
    const match = urlStr.match(/value=(\d+)/);
    const accountIndex = match ? parseInt(match[1]!, 10) : 200001;

    // Читаем из базы, какие позиции числятся за этим аккаунтом
    const dbPositions = sqlite
      .query(
        "SELECT market_id, symbol, is_long, entry_price, size FROM account_open_positions WHERE account_index = ?",
      )
      .all(accountIndex) as any[];

    const positionsResponse: any[] = [];

    for (const pos of dbPositions) {
      // 25% позиций симулируем как ЗОМБИ (закрытые или ликвидированные на бирже)
      // Позиции с market_id 1 (BTC) и 4 (DOGE) объявляем закрытыми
      const isZombie = pos.market_id === 1 || pos.market_id === 4;

      if (isZombie) {
        simulatedZombiePositionsReturned++;
        // Закрытая сделка на бирже: либо размер 0, либо не отдается вовсе
        positionsResponse.push({
          market_id: pos.market_id,
          symbol: pos.symbol,
          sign: pos.is_long,
          position: "0.0000",
          avg_entry_price: pos.entry_price.toString(),
          position_value: "0.00",
          unrealized_pnl: "0.00",
          realized_pnl: "0.00",
          liquidation_price: "0",
        });
      } else {
        simulatedActivePositionsReturned++;

        // Для части позиций симулируем спот / liquidation_price = 0 (нет риска)
        const isZeroLiq = pos.market_id % 3 === 0;
        const liqPrice = isZeroLiq
          ? "0"
          : (pos.is_long === 1 ? pos.entry_price * 0.97 : pos.entry_price * 1.03).toFixed(4);

        positionsResponse.push({
          market_id: pos.market_id,
          symbol: pos.symbol,
          sign: pos.is_long,
          position: pos.size.toString(),
          avg_entry_price: pos.entry_price.toString(),
          position_value: (pos.size * pos.entry_price).toFixed(2),
          unrealized_pnl: "-25.50",
          realized_pnl: "0.00",
          liquidation_price: liqPrice,
        });
      }
    }

    return new Response(
      JSON.stringify({
        code: 200,
        accounts: [
          {
            index: accountIndex,
            account_index: accountIndex,
            l1_address: `0x${accountIndex.toString(16).padStart(40, "a")}`,
            collateral: "1500.00",
            total_asset_value: "1500.00",
            positions: positionsResponse,
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  return originalFetch(input, init);
};

const mockDb = createD1Adapter(sqlite);

const mockEnv: Env = {
  DB: mockDb,
  TELEGRAM_BOT_TOKEN: "mock_token_123",
  ADMIN_TELEGRAM_ID: "10001",
};

// ============================================================================
// ПЕРЕХВАТ GRAMMY BOT API ДЛЯ ТОЧНОГО ЗАМЕРА ТРОТТЛИНГА И СКОРОСТИ
// ============================================================================
const bot = getBot(mockEnv);

bot.api.config.use(async (prev, method, payload, signal) => {
  if (method === "sendMessage") {
    telegramSends++;
    // Симулируем сетевую задержку Telegram Bot API (30 мс)
    await new Promise((r) => setTimeout(r, 30));

    const p = payload as any;
    const userId = Number(p.chat_id);
    const text = String(p.text || "");
    const nowTime = Date.now();
    const lastTime = lastTelegramTimeByUser.get(userId) || null;
    const intervalFromLast = lastTime !== null ? nowTime - lastTime : null;

    lastTelegramTimeByUser.set(userId, nowTime);
    telegramRecords.push({
      userId,
      time: nowTime,
      intervalFromLastMs: intervalFromLast,
      snippet: text.slice(0, 65).replace(/\n/g, " "),
      text,
    });

    return {
      ok: true,
      result: {
        message_id: Math.floor(Math.random() * 100000),
        date: Math.floor(nowTime / 1000),
        chat: { id: userId, type: "private" },
        text,
      },
    } as any;
  }
  return prev(method, payload, signal);
});

console.log("==========================================================");
console.log("🚀 СТАРТ ПОЛНОГО СКВОЗНОГО СТРЕСС-ТЕСТА (END-TO-END CRON)");
console.log("==========================================================\n");

// Фиксируем состояние открытых позиций в базе ДО теста
const zombiesBefore = sqlite.query("SELECT COUNT(*) as c FROM account_open_positions").get() as any;

const start = performance.now();
await runCronMonitor(mockEnv);
const duration = performance.now() - start;

// Фиксируем состояние открытых позиций в базе ПОСЛЕ теста
const zombiesAfter = sqlite.query("SELECT COUNT(*) as c FROM account_open_positions").get() as any;

console.log("\n==========================================================");
console.log("📊 РЕЗУЛЬТАТЫ СКВОЗНОЙ СИМУЛЯЦИИ И ТЕЛЕМЕТРИЯ");
console.log("==========================================================");
console.log(
  `⏱ Общее время работы крона: ${duration.toFixed(2)} ms (${(duration / 1000).toFixed(2)} сек)`,
);
console.log(`📡 Сетевые вызовы биржи:`);
console.log(`   • /exchangeStats: ${exchangeStatsCalls} вызовов`);
console.log(`   • /account (JIT + Round-Robin): ${accountApiCalls} вызовов`);
console.log(`   • Живых сделок проверено: ${simulatedActivePositionsReturned}`);
console.log(`   • Закрытых сделок обнаружено (зомби): ${simulatedZombiePositionsReturned}`);

console.log(`\n🧹 Очистка зомби-позиций в D1:`);
console.log(`   • Открытых позиций в базе ДО теста: ${zombiesBefore.c}`);
console.log(`   • Открытых позиций в базе ПОСЛЕ теста: ${zombiesAfter.c}`);
console.log(`   • Успешно удалено зомби из базы: ${zombiesBefore.c - zombiesAfter.c}`);

console.log(`\n💬 Доставка уведомлений Telegram:`);
console.log(`   • Всего алертов отправлено: ${telegramSends}`);

// Анализ консолидации алертов по пользователям
console.log(
  "\n📦 ПРОВЕРКА КОНСОЛИДАЦИИ АЛЕРТОВ (1 объединенное сообщение на пользователя, 0 мс сна):",
);
const user10001Alerts = telegramRecords.filter((r) => r.userId === 10001);
console.log(`   • Сообщений для пользователя 10001 (мульти-позиция): ${user10001Alerts.length}`);

if (user10001Alerts.length === 1) {
  const msg = user10001Alerts[0]!;
  const hasDivider = msg.text.includes("───────────────────");
  console.log(`     1. Объединенный дайджест доставлен | Длина: ${msg.text.length} символов`);
  if (hasDivider) {
    console.log("   ✅ Мульти-алерты успешно объединены разделителем в одно сообщение!");
  } else {
    console.log("   ℹ️ Одиночный алерт в сообщении.");
  }
  console.log("   ✅ 0 мс искусственных пауз: лимит 1 сообщ/сек на чат гарантирован архитектурно!");
} else if (user10001Alerts.length > 1) {
  console.log(
    "   ❌ ОШИБКА: Пользователь получил несколько раздельных сообщений вместо одного дайджеста!",
  );
} else {
  console.log("   ℹ️ Для 10001 не было сработавших алертов на этом тике.");
}

console.log("\n🛡 ПРОВЕРКА БЮДЖЕТОВ CLOUDFLARE WORKERS:");
const subrequestsTotal = exchangeStatsCalls + accountApiCalls + telegramSends;
console.log(`   • Использовано subrequests: ${subrequestsTotal} / 50 (Лимит CF Free: 50)`);
console.log(
  `   • Wall-clock time: ${(duration / 1000).toFixed(2)} с / 20 с (Лимит CF Cron: 20-30 с)`,
);
console.log(
  subrequestsTotal <= 45 && duration < 20000
    ? "   ✅ Все лимиты Cloudflare Free соблюдены с запасом!"
    : "   ⚠️ ВНИМАНИЕ: Превышение лимитов!",
);
console.log("==========================================================\n");
