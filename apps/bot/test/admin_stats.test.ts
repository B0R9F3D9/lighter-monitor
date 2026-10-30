import { describe, expect, it } from "bun:test";
import { getSystemStats, updateUserActivity } from "../src/db/queries";
import {
  recordMemoryCronRun,
  getMemoryCron24hStats,
  setMemoryPrice,
  clearMemoryCache,
} from "../src/cache/memory";
import { getStatsKeyboard } from "../src/bot/bot";

describe("Admin Stats & Business Intelligence", () => {
  it("updateUserActivity updates last_active_at in DB", async () => {
    let executedSql = "";
    let boundParams: any[] = [];
    const mockDb: any = {
      prepare: (sql: string) => ({
        bind: (...params: any[]) => {
          executedSql = sql;
          boundParams = params;
          return {
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      }),
    };

    await updateUserActivity(mockDb, 999888);
    expect(executedSql).toContain("UPDATE users SET last_active_at = ? WHERE telegram_id = ?");
    expect(boundParams[1]).toBe(999888);
    expect(boundParams[0]).toBeGreaterThan(0);
  });

  it("recordMemoryCronRun tracks rolling 24h uptime, average duration, and subrequests", () => {
    clearMemoryCache();
    const now = 1700000000;

    // First run (success, 450ms, 4 subrequests)
    recordMemoryCronRun(450, 4, false, now, 0);
    let stats = getMemoryCron24hStats()!;
    expect(stats.totalRuns).toBe(1);
    expect(stats.failedRuns).toBe(0);
    expect(stats.totalDurationMs).toBe(450);
    expect(stats.maxDurationMs).toBe(450);
    expect(stats.maxSubrequests).toBe(4);

    // Second run (success, 550ms, 8 subrequests)
    recordMemoryCronRun(550, 8, false, now + 60, 2);
    stats = getMemoryCron24hStats()!;
    expect(stats.totalRuns).toBe(2);
    expect(stats.failedRuns).toBe(0);
    expect(stats.totalDurationMs).toBe(1000);
    expect(stats.maxDurationMs).toBe(550);
    expect(stats.maxSubrequests).toBe(8);
    expect(stats.lastZombiesCleaned).toBe(2);

    // Third run (failed, 200ms, 2 subrequests)
    recordMemoryCronRun(200, 2, true, now + 120, 0);
    stats = getMemoryCron24hStats()!;
    expect(stats.totalRuns).toBe(3);
    expect(stats.failedRuns).toBe(1);
    expect(stats.maxDurationMs).toBe(550);
  });

  it("getSystemStats calculates empty state gracefully without division by zero or NaN", async () => {
    const mockDb: any = {
      batch: async () => [
        { results: [{}] }, // empty summary
        { results: [{}] }, // empty spreadSummary
        { results: [] }, // empty topSpreadSymbols
        { results: [] }, // empty positionsDetail
        { results: [] }, // empty metrics
      ],
      prepare: (sql: string) => ({
        bind: () => ({ sql }),
      }),
    };

    const stats = await getSystemStats(mockDb);
    expect(stats.totalUsers).toBe(0);
    expect(stats.totalTracked).toBe(0);
    expect(stats.activeUsers24h).toBe(0);
    expect(stats.avgAccountsPerUser).toBe(0);
    expect(stats.totalOpenInterestUsd).toBe(0);
    expect(stats.longOiUsd).toBe(0);
    expect(stats.shortOiUsd).toBe(0);
    expect(stats.netDeltaUsd).toBe(0);
    expect(stats.effectiveLeverage).toBe(0);
    expect(stats.riskDistribution).toEqual({
      critical: 0,
      danger: 0,
      warning: 0,
      safe: 0,
    });
    expect(stats.closestLiquidation).toBeNull();
    expect(stats.spreadStats.totalTargets).toBe(0);
  });

  it("getSystemStats computes detailed risk distribution, closest liquidation, and net delta", async () => {
    const mockDb: any = {
      batch: async () => [
        // 1. summaryRes
        {
          results: [
            {
              total_users: 5,
              users_24h: 2,
              active_users_24h: 4,
              muted_users: 1,
              total_tracked: 6,
              tracked_rh: 3,
              tracked_mainnet: 3,
              total_collateral: 20000,
              avg_collateral: 6666.67,
              oldest_cache: 1000,
              newest_cache: 1100,
              avg_cache: 1050,
            },
          ],
        },
        // 2. spreadSummaryRes
        {
          results: [
            {
              total_targets: 10,
              active_targets: 8,
              armed_targets: 6,
              hitting_now_targets: 2,
              spread_users: 4,
              rh_cheaper_count: 5,
              rh_expensive_count: 5,
              spread_alerts_24h: 3,
            },
          ],
        },
        // 3. topSpreadSymbolsRes
        {
          results: [
            { symbol: "SPY", count: 5 },
            { symbol: "QQQ", count: 3 },
          ],
        },
        // 4. positionsDetailRes (4 positions testing 4 risk tiers)
        {
          results: [
            // Pos 1: SPY Long entry 100, liq 98.5 -> dist 1.5% -> CRITICAL (< 2%)
            {
              symbol: "SPY",
              network: "rh",
              account_index: 101,
              is_long: 1,
              entry_price: 100,
              size: 500,
              liquidation_price: 98.5,
              notional: 50000,
            },
            // Pos 2: BTC Long entry 60000, liq 58000 -> dist 3.33% -> DANGER (< 5%)
            {
              symbol: "BTC",
              network: "mainnet",
              account_index: 202,
              is_long: 1,
              entry_price: 60000,
              size: 0.5,
              liquidation_price: 58000,
              notional: 30000,
            },
            // Pos 3: ETH Long entry 3000, liq 2750 -> dist 8.33% -> WARNING (< 10%)
            {
              symbol: "ETH",
              network: "rh",
              account_index: 303,
              is_long: 1,
              entry_price: 3000,
              size: 3.33,
              liquidation_price: 2750,
              notional: 10000,
            },
            // Pos 4: SOL Short entry 150, liq 180 -> dist 20% -> SAFE (>= 10%)
            {
              symbol: "SOL",
              network: "mainnet",
              account_index: 404,
              is_long: 0,
              entry_price: 150,
              size: 66.6,
              liquidation_price: 180,
              notional: 10000,
            },
          ],
        },
        // 5. metricsRes
        {
          results: [
            {
              key: "cron_stats_24h",
              value_json: JSON.stringify({
                windowStart: 1700000000,
                totalRuns: 1440,
                failedRuns: 2,
                totalDurationMs: 720000,
                maxDurationMs: 1250,
                maxSubrequests: 12,
                lastZombiesCleaned: 5,
              }),
              updated_at: 1700000000,
            },
          ],
        },
      ],
      prepare: (sql: string) => ({
        bind: () => ({ sql }),
      }),
    };

    const stats = await getSystemStats(mockDb);

    // Пользователи
    expect(stats.totalUsers).toBe(5);
    expect(stats.activeUsers24h).toBe(4);
    expect(stats.avgAccountsPerUser).toBe(1.2);
    expect(stats.mutedUsersCount).toBe(1);

    // Дельта и плечо
    expect(stats.totalOpenInterestUsd).toBe(100000);
    expect(stats.longOiUsd).toBe(90000);
    expect(stats.shortOiUsd).toBe(10000);
    expect(stats.netDeltaUsd).toBe(80000);
    expect(stats.effectiveLeverage).toBe(5.0); // 100000 / 20000

    // Размеры сделок
    expect(stats.avgPositionSizeUsd).toBe(25000);
    expect(stats.maxPositionSizeUsd).toBe(50000);
    expect(stats.maxPositionSymbol).toBe("SPY");

    // Зоны риска
    expect(stats.riskDistribution).toEqual({
      critical: 1,
      danger: 1,
      warning: 1,
      safe: 1,
    });
    expect(stats.closestLiquidation).toEqual({
      symbol: "SPY",
      network: "rh",
      accountIndex: 101,
      distancePercent: 1.5,
      isLong: true,
    });

    // Таргеты спреда
    expect(stats.spreadStats.totalTargets).toBe(10);
    expect(stats.spreadStats.activeTargets).toBe(8);
    expect(stats.spreadStats.armedTargets).toBe(6);
    expect(stats.spreadStats.hittingNowTargets).toBe(2);
    expect(stats.spreadStats.uniqueUsersCount).toBe(4);
    expect(stats.spreadStats.alertsSent24h).toBe(3);
    expect(stats.spreadStats.topSymbols).toHaveLength(2);

    // Крон 24ч
    expect(stats.cron24hStats).toBeDefined();
    expect(stats.cron24hStats?.uptimePercent).toBe(99.86);
    expect(stats.cron24hStats?.avgDurationMs).toBe(500);
    expect(stats.cron24hStats?.maxDurationMs).toBe(1250);
    expect(stats.cron24hStats?.maxSubrequests).toBe(12);
  });

  it("calculates liquidation distance from current market price (getMemoryPrice) and position direction", async () => {
    clearMemoryCache();
    // User opened SPY Long at 100 with liquidation at 85.
    // Static difference from entry is 15% (Safe tier).
    // Market dropped to 85.50 -> remaining distance is (85.50 - 85) / 85.50 = 0.58% (Critical tier < 2%).
    setMemoryPrice("rh", "SPY", 85.5);

    // User opened SOL Short at 100 with liquidation at 102.
    // Market pumped to 101.50 -> remaining distance is (102 - 101.50) / 101.50 = 0.49% (Critical tier < 2%).
    setMemoryPrice("mainnet", "SOL", 101.5);

    const mockDb: any = {
      batch: async () => [
        { results: [{}] }, // summary
        { results: [{}] }, // spreadSummary
        { results: [] }, // topSpreadSymbols
        {
          results: [
            {
              symbol: "SPY",
              network: "rh",
              account_index: 31886,
              is_long: 1,
              entry_price: 100,
              size: 10,
              liquidation_price: 85,
              notional: 1000,
            },
            {
              symbol: "SOL",
              network: "mainnet",
              account_index: 749329,
              is_long: 0,
              entry_price: 100,
              size: 10,
              liquidation_price: 102,
              notional: 1000,
            },
          ],
        },
        { results: [] }, // metrics
      ],
      prepare: (sql: string) => ({
        bind: () => ({ sql }),
      }),
    };

    const stats = await getSystemStats(mockDb);

    // Both positions are in CRITICAL (< 2%) zone due to current market prices
    expect(stats.riskDistribution.critical).toBe(2);
    expect(stats.riskDistribution.safe).toBe(0);
    expect(stats.closestLiquidation).toBeDefined();
    // SOL has 0.49% distance vs SPY's 0.58% distance
    expect(stats.closestLiquidation?.symbol).toBe("SOL");
    expect(stats.closestLiquidation?.distancePercent).toBe(0.49);
    expect(stats.closestLiquidation?.isLong).toBe(false);
  });

  it("getSystemStats queries eliminate fan-out with JOIN (SELECT DISTINCT network, account_index FROM user_tracked_accounts)", async () => {
    let capturedBatchSqls: string[] = [];
    const mockDb: any = {
      batch: async (stmts: any[]) => {
        capturedBatchSqls = stmts.map((s) => s.sql);
        return [
          { results: [{ total_collateral: 500 }] },
          { results: [{}] },
          { results: [] },
          { results: [] },
          { results: [] },
        ];
      },
      prepare: (sql: string) => ({
        sql,
        bind: () => ({ sql }),
      }),
    };

    await getSystemStats(mockDb);

    // Check summaryRes query protects collateral from fan-out
    const summarySql = capturedBatchSqls[0];
    expect(summarySql).toContain(
      "JOIN (SELECT DISTINCT network, account_index FROM user_tracked_accounts) uta",
    );

    // Check positionsDetail query protects positions from fan-out
    const positionsSql = capturedBatchSqls[3];
    expect(positionsSql).toContain(
      "JOIN (SELECT DISTINCT network, account_index FROM user_tracked_accounts) uta",
    );
  });

  it("getStatsKeyboard returns a single button with only '🔄 Обновить'", () => {
    const kb = getStatsKeyboard();
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0]).toHaveLength(1);
    expect(kb.inline_keyboard[0][0].text).toBe("🔄 Обновить");
    expect((kb.inline_keyboard[0][0] as any).callback_data).toBe("refresh_stats");
  });

  it("merges 24h cron stats between D1 row and memory without resetting count on isolate restart", async () => {
    clearMemoryCache();
    const nowSec = Math.floor(Date.now() / 1000);
    // Simulate D1 having 1440 runs from past day
    const dbJson = JSON.stringify({
      windowStart: nowSec - 3600,
      totalRuns: 1440,
      failedRuns: 1,
      totalDurationMs: 720000,
      maxDurationMs: 900,
      maxSubrequests: 8,
      lastZombiesCleaned: 0,
    });

    const mockDb: any = {
      batch: async () => [
        { results: [{}] },
        { results: [{}] },
        { results: [] },
        { results: [] },
        {
          results: [
            {
              key: "cron_stats_24h",
              value_json: dbJson,
              updated_at: nowSec - 60,
            },
          ],
        },
      ],
      prepare: (sql: string) => ({
        bind: () => ({ sql }),
      }),
    };

    // Before calling getSystemStats, in-memory stats are null (cold start)
    expect(getMemoryCron24hStats()).toBeNull();

    const stats = await getSystemStats(mockDb);

    // Should hydrate and return the 1440 runs
    expect(stats.cron24hStats?.totalRuns).toBe(1440);
    expect(stats.cron24hStats?.failedRuns).toBe(1);

    // And memory is hydrated so subsequent runs won't start from 1
    const hydratedMem = getMemoryCron24hStats();
    expect(hydratedMem).not.toBeNull();
    expect(hydratedMem?.totalRuns).toBe(1440);
  });
});
