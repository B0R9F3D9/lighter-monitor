import { describe, expect, it } from "bun:test";
import {
  removeTrackedAccount,
  removeBlockedUser,
  cleanOrphanData,
  getDistinctActiveSymbols,
  getSystemStats,
} from "../src/db/queries";
import { setMemoryAccount, getMemoryAccount } from "../src/cache/memory";

describe("Account Deletion & Orphan Data Cleanup", () => {
  it("removeTrackedAccount deletes open positions, cache, and token alerts if no other user tracks account", async () => {
    const executedQueries: Array<{ sql: string; params: any[] }> = [];

    setMemoryAccount({
      network: "mainnet",
      accountIndex: 749329,
      alias: "Test",
      collateral: 100,
      lastUpdated: 1000,
      fingerprint: 111,
      positions: [],
    });

    const mockDb: any = {
      prepare: (sql: string) => ({
        bind: (...params: any[]) => ({
          sql,
          params,
          run: async () => {
            executedQueries.push({ sql, params });
            return { meta: { changes: 1 } };
          },
          first: async () => {
            executedQueries.push({ sql, params });
            // Simulate NO remaining users tracking this account
            return null;
          },
        }),
      }),
      batch: async (stmts: any[]) => {
        const res: any[] = [];
        for (const s of stmts) {
          if (s && s.sql && s.sql.includes("SELECT 1 FROM user_tracked_accounts")) {
            const row = s.first ? await s.first() : null;
            res.push({ results: row ? [row] : [] });
          } else if (s && s.run) {
            const r = await s.run();
            res.push(r);
          } else {
            res.push({ meta: { changes: 1 } });
          }
        }
        return res;
      },
    };

    const removed = await removeTrackedAccount(mockDb, 846510794, "mainnet", 749329);
    expect(removed).toBe(true);

    // Verify memory cache is cleared
    expect(getMemoryAccount("mainnet", 749329)).toBeUndefined();

    // Verify SQL statements executed
    const sqlList = executedQueries.map((q) => q.sql);
    expect(sqlList.some((s) => s.includes("DELETE FROM user_tracked_accounts"))).toBe(true);
    expect(sqlList.some((s) => s.includes("DELETE FROM user_token_alerts"))).toBe(true);
    expect(sqlList.some((s) => s.includes("SELECT 1 FROM user_tracked_accounts"))).toBe(true);
    expect(sqlList.some((s) => s.includes("DELETE FROM account_open_positions"))).toBe(true);
    expect(sqlList.some((s) => s.includes("DELETE FROM account_positions_cache"))).toBe(true);
  });

  it("removeTrackedAccount does NOT delete positions or cache if another user is tracking the account", async () => {
    const executedQueries: Array<{ sql: string; params: any[] }> = [];

    setMemoryAccount({
      network: "rh",
      accountIndex: 31886,
      alias: "Shared",
      collateral: 500,
      lastUpdated: 2000,
      fingerprint: 222,
      positions: [],
    });

    const mockDb: any = {
      prepare: (sql: string) => ({
        bind: (...params: any[]) => ({
          sql,
          params,
          run: async () => {
            executedQueries.push({ sql, params });
            return { meta: { changes: 1 } };
          },
          first: async () => {
            executedQueries.push({ sql, params });
            // Simulate that another user IS tracking this account
            return { "1": 1 };
          },
        }),
      }),
      batch: async (stmts: any[]) => {
        const res: any[] = [];
        for (const s of stmts) {
          if (s && s.sql && s.sql.includes("SELECT 1 FROM user_tracked_accounts")) {
            const row = s.first ? await s.first() : { "1": 1 };
            res.push({ results: row ? [row] : [] });
          } else if (s && s.run) {
            const r = await s.run();
            res.push(r);
          } else {
            res.push({ meta: { changes: 1 } });
          }
        }
        return res;
      },
    };

    const removed = await removeTrackedAccount(mockDb, 846510794, "rh", 31886);
    expect(removed).toBe(true);

    // Memory cache should still remain because the account is shared
    expect(getMemoryAccount("rh", 31886)).toBeDefined();

    const sqlList = executedQueries.map((q) => q.sql);
    expect(sqlList.some((s) => s.includes("DELETE FROM user_tracked_accounts"))).toBe(true);
    expect(sqlList.some((s) => s.includes("DELETE FROM account_open_positions"))).toBe(false);
    expect(sqlList.some((s) => s.includes("DELETE FROM account_positions_cache"))).toBe(false);
  });

  it("removeBlockedUser executes batch including orphan cleanup for open positions and cache", async () => {
    let batchSqls: string[] = [];
    const mockDb: any = {
      prepare: (sql: string) => ({
        sql,
        bind: (...params: any[]) => ({
          sql,
          params,
        }),
      }),
      batch: async (stmts: any[]) => {
        batchSqls = stmts.map((s) => s.sql || String(s));
        return [];
      },
    };

    await removeBlockedUser(mockDb, 999888);
    expect(batchSqls.some((s) => s.includes("DELETE FROM user_tracked_accounts"))).toBe(true);
    expect(batchSqls.some((s) => s.includes("DELETE FROM account_open_positions"))).toBe(true);
    expect(batchSqls.some((s) => s.includes("DELETE FROM account_positions_cache"))).toBe(true);
    expect(batchSqls.some((s) => s.includes("user_tracked_accounts uta"))).toBe(true);
  });

  it("cleanOrphanData cleans up orphaned positions, cache, and token alerts", async () => {
    let batchSqls: string[] = [];
    const mockDb: any = {
      prepare: (sql: string) => sql,
      batch: async (stmts: any[]) => {
        batchSqls = stmts;
        return [];
      },
    };

    await cleanOrphanData(mockDb);
    expect(batchSqls.length).toBe(3);
    expect(batchSqls[0]).toContain("DELETE FROM account_open_positions");
    expect(batchSqls[0]).toContain("NOT EXISTS");
    expect(batchSqls[1]).toContain("DELETE FROM account_positions_cache");
    expect(batchSqls[1]).toContain("NOT EXISTS");
    expect(batchSqls[2]).toContain("DELETE FROM user_token_alerts");
  });

  it("getDistinctActiveSymbols joins user_tracked_accounts to ignore untracked symbols", async () => {
    let executedSql = "";
    const mockDb: any = {
      prepare: (sql: string) => {
        executedSql = sql;
        return {
          all: async () => ({ results: [{ symbol: "SPY" }] }),
        };
      },
    };

    const symbols = await getDistinctActiveSymbols(mockDb);
    expect(symbols).toEqual(["SPY"]);
    expect(executedSql).toContain("user_tracked_accounts uta");
    expect(executedSql).toContain("aop.network = uta.network");
  });

  it("getSystemStats filters active_accounts_count, positions, collateral, and topTokens by user_tracked_accounts", async () => {
    let batchSqls: string[] = [];
    const mockDb: any = {
      batch: async (stmts: any[]) => {
        batchSqls = stmts.map((s) => s?.sql || String(s));
        return [
          {
            results: [
              {
                total_users: 3,
                users_24h: 1,
                active_users_24h: 1,
                muted_users: 0,
                total_tracked: 2,
                tracked_rh: 1,
                tracked_mainnet: 1,
                total_collateral: 6.1,
                avg_collateral: 3.05,
                oldest_cache: 100,
                newest_cache: 200,
                avg_cache: 150,
              },
            ],
          },
          {
            results: [
              {
                total_targets: 3,
                active_targets: 3,
                armed_targets: 3,
                hitting_now_targets: 0,
                spread_users: 2,
                rh_cheaper_count: 1,
                rh_expensive_count: 2,
                spread_alerts_24h: 0,
              },
            ],
          },
          {
            results: [{ symbol: "SPY", count: 2 }],
          },
          {
            results: [
              {
                symbol: "SPY",
                network: "rh",
                account_index: 31886,
                is_long: 1,
                entry_price: 755.64,
                size: 29.2,
                liquidation_price: 727.92,
                notional: 22000,
              },
              {
                symbol: "SPY",
                network: "mainnet",
                account_index: 749329,
                is_long: 1,
                entry_price: 755.64,
                size: 29.2,
                liquidation_price: 727.92,
                notional: 22000,
              },
            ],
          },
          {
            results: [],
          },
        ];
      },
      prepare: (sql: string) => ({
        sql,
        bind: () => ({ sql }),
      }),
    };

    const stats = await getSystemStats(mockDb);
    expect(stats.activeAccountsCount).toBe(2);
    expect(stats.activePositionsCount).toBe(2);
    expect(stats.totalCollateralUsd).toBe(6.1);
    expect(stats.topTokens).toEqual([{ symbol: "SPY", count: 2, notionalUsd: 44000 }]);

    const summarySql = batchSqls[0]!;
    expect(summarySql).toContain("user_tracked_accounts) uta");
    expect(summarySql).toContain("total_collateral");

    const positionsSql = batchSqls.find((s) => s.includes("FROM account_open_positions aop"))!;
    expect(positionsSql).toBeDefined();
    expect(positionsSql).toContain("user_tracked_accounts) uta");
  });
});
