import { describe, expect, it } from "bun:test";
import {
  getUserSpreadTargets,
  addSpreadTarget,
  deleteSpreadTarget,
  deleteSpreadTargetsBySymbol,
  toggleSpreadTargetActive,
  updateSpreadTarget,
  updateSpreadTargetThreshold,
  updateSpreadTargetDirection,
  setSpreadTargetMute,
  setSpreadSymbolMute,
  setUserSpreadMute,
  getDistinctActiveSymbols,
  getActiveSpreadTargetsForMonitoring,
  ensureDatabaseSchema,
  resetSchemaEnsured,
} from "../src/db/queries";

describe("Spread DB Queries & UNION Filtering", () => {
  it("getDistinctActiveSymbols queries UNION of open positions and active spread targets", async () => {
    let executedSql = "";
    const mockDb: any = {
      prepare: (sql: string) => {
        executedSql = sql;
        return {
          all: async () => ({
            results: [{ symbol: "SPY" }, { symbol: "XAU" }, { symbol: "BTC" }],
          }),
        };
      },
    };

    const symbols = await getDistinctActiveSymbols(mockDb);
    expect(symbols).toEqual(["SPY", "XAU", "BTC"]);
    expect(executedSql).toContain("account_open_positions");
    expect(executedSql).toContain("UNION");
    expect(executedSql).toContain("user_spread_targets");
  });

  it("addSpreadTarget binds parameters with normalized uppercase symbol and defaults", async () => {
    let boundParams: any[] = [];
    const mockDb: any = {
      prepare: () => ({
        bind: (...params: any[]) => {
          boundParams = params;
          return {
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      }),
    };

    const success = await addSpreadTarget(
      mockDb,
      123456,
      "spy",
      "rh_cheaper",
      0.15,
      "usd",
      1,
      1700000000,
    );

    expect(success).toBe(true);
    expect(boundParams[0]).toBe(123456);
    expect(boundParams[1]).toBe("SPY"); // Normalized to uppercase
    expect(boundParams[2]).toBe("rh_cheaper");
    expect(boundParams[3]).toBe(0.15);
    expect(boundParams[4]).toBe("usd");
    expect(boundParams[5]).toBe(1); // armed
    expect(boundParams[6]).toBe(1700000000);
  });

  it("deleteSpreadTarget safely checks telegram_id and target id", async () => {
    let boundParams: any[] = [];
    let executedSql = "";
    const mockDb: any = {
      prepare: (sql: string) => {
        executedSql = sql;
        return {
          bind: (...params: any[]) => {
            boundParams = params;
            return {
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      },
    };

    const success = await deleteSpreadTarget(mockDb, 999, 42);
    expect(success).toBe(true);
    expect(executedSql).toContain("WHERE id = ? AND telegram_id = ?");
    expect(boundParams).toEqual([42, 999]);
  });

  it("deleteSpreadTargetsBySymbol deletes all targets for specified symbol", async () => {
    let boundParams: any[] = [];
    let executedSql = "";
    const mockDb: any = {
      prepare: (sql: string) => {
        executedSql = sql;
        return {
          bind: (...params: any[]) => {
            boundParams = params;
            return {
              run: async () => ({ meta: { changes: 3 } }),
            };
          },
        };
      },
    };

    const count = await deleteSpreadTargetsBySymbol(mockDb, 999, "spy");
    expect(count).toBe(3);
    expect(executedSql).toContain(
      "DELETE FROM user_spread_targets WHERE telegram_id = ? AND symbol = ?",
    );
    expect(boundParams).toEqual([999, "SPY"]);
  });

  it("toggleSpreadTargetActive toggles is_active flag", async () => {
    let boundParams: any[] = [];
    const mockDb: any = {
      prepare: () => ({
        bind: (...params: any[]) => {
          boundParams = params;
          return {
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      }),
    };

    const success = await toggleSpreadTargetActive(mockDb, 999, 42, 0);
    expect(success).toBe(true);
    expect(boundParams).toEqual([0, 42, 999]);
  });

  it("setSpreadTargetMute sets muted_until for specific target", async () => {
    let boundParams: any[] = [];
    const mockDb: any = {
      prepare: () => ({
        bind: (...params: any[]) => {
          boundParams = params;
          return {
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      }),
    };

    const success = await setSpreadTargetMute(mockDb, 999, 42, 1700003600);
    expect(success).toBe(true);
    expect(boundParams).toEqual([1700003600, 42, 999]);
  });

  it("setSpreadSymbolMute inserts or updates symbol mute in spread_symbol_mutes", async () => {
    let boundParams: any[] = [];
    const mockDb: any = {
      prepare: () => ({
        bind: (...params: any[]) => {
          boundParams = params;
          return {
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      }),
    };

    await setSpreadSymbolMute(mockDb, 999, "spy", 1700014400);
    expect(boundParams).toEqual([999, "SPY", 1700014400]);
  });

  it("setUserSpreadMute updates global spread_muted_until on users table", async () => {
    let boundParams: any[] = [];
    let executedSql = "";
    const mockDb: any = {
      prepare: (sql: string) => {
        executedSql = sql;
        return {
          bind: (...params: any[]) => {
            boundParams = params;
            return {
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      },
    };

    await setUserSpreadMute(mockDb, 999, 1700014400);
    expect(executedSql).toContain("UPDATE users SET spread_muted_until = ? WHERE telegram_id = ?");
    expect(boundParams).toEqual([1700014400, 999]);
  });

  it("getDistinctActiveSymbols falls back to account_open_positions if user_spread_targets does not exist", async () => {
    let callCount = 0;
    const mockDb: any = {
      prepare: (sql: string) => {
        callCount++;
        if (sql.includes("user_spread_targets")) {
          throw new Error("D1_ERROR: no such table: user_spread_targets: SQLITE_ERROR");
        }
        return {
          all: async () => ({
            results: [{ symbol: "ETH" }, { symbol: "SOL" }],
          }),
        };
      },
    };

    const symbols = await getDistinctActiveSymbols(mockDb);
    expect(symbols).toEqual(["ETH", "SOL"]);
    expect(callCount).toBe(2); // First failed, second fell back to account_open_positions
  });

  it("getActiveSpreadTargetsForMonitoring safely catches missing table and returns empty array", async () => {
    const mockDb: any = {
      prepare: () => {
        throw new Error("no such table: user_spread_targets");
      },
    };

    const targets = await getActiveSpreadTargetsForMonitoring(mockDb);
    expect(targets).toEqual([]);
  });

  it("getUserSpreadTargets joins spread_symbol_mutes to fetch symbol_muted_until", async () => {
    let executedSql = "";
    let boundId: any = null;
    const mockDb: any = {
      prepare: (sql: string) => {
        executedSql = sql;
        return {
          bind: (id: any) => {
            boundId = id;
            return {
              all: async () => ({
                results: [
                  {
                    id: 1,
                    symbol: "SPY",
                    symbol_muted_until: 1700014400,
                  },
                ],
              }),
            };
          },
        };
      },
    };

    const targets = await getUserSpreadTargets(mockDb, 12345);
    expect(targets.length).toBe(1);
    expect(targets[0]!.symbol_muted_until).toBe(1700014400);
    expect(executedSql).toContain("LEFT JOIN spread_symbol_mutes");
    expect(boundId).toBe(12345);
  });

  it("updateSpreadTarget uses UPDATE OR REPLACE and updates direction, threshold and armed atomically", async () => {
    let executedSql = "";
    let boundParams: any[] = [];
    const mockDb: any = {
      prepare: (sql: string) => {
        executedSql = sql;
        return {
          bind: (...params: any[]) => {
            boundParams = params;
            return {
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      },
    };

    const success = await updateSpreadTarget(mockDb, 12345, 10, "rh_expensive", 3.5, "bps", 1);

    expect(success).toBe(true);
    expect(executedSql).toContain("UPDATE OR REPLACE user_spread_targets");
    expect(boundParams).toEqual(["rh_expensive", 3.5, "bps", 1, 10, 12345]);

    await updateSpreadTargetThreshold(mockDb, 12345, 10, 4.0, "bps", 1);
    expect(executedSql).toContain("UPDATE OR REPLACE user_spread_targets");
    expect(boundParams).toEqual([4.0, "bps", 1, 10, 12345]);

    await updateSpreadTargetDirection(mockDb, 12345, 10, "rh_cheaper", 1);
    expect(executedSql).toContain("UPDATE OR REPLACE user_spread_targets");
    expect(boundParams).toEqual(["rh_cheaper", 1, 10, 12345]);
  });

  it("setUserSpreadMute with 0 deletes symbol mutes from spread_symbol_mutes", async () => {
    const executedStmts: { sql: string; params: any[] }[] = [];
    const mockDb: any = {
      prepare: (sql: string) => ({
        bind: (...params: any[]) => {
          const stmtObj = { sql, params };
          return {
            ...stmtObj,
            run: async () => {
              executedStmts.push(stmtObj);
              return { meta: { changes: 1 } };
            },
          };
        },
      }),
      batch: async (stmts: any[]) => {
        for (const s of stmts) {
          executedStmts.push({ sql: s.sql, params: s.params });
        }
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    };

    await setUserSpreadMute(mockDb, 999, 0);

    expect(
      executedStmts.some((s) => s.sql.includes("UPDATE users SET spread_muted_until = ?")),
    ).toBe(true);
    expect(
      executedStmts.some((s) =>
        s.sql.includes("DELETE FROM spread_symbol_mutes WHERE telegram_id = ?"),
      ),
    ).toBe(true);
  });

  it("toggleSpreadTargetActive with 1 un-mutes target and deletes symbol mute", async () => {
    const executedStmts: { sql: string; params: any[] }[] = [];
    const mockDb: any = {
      prepare: (sql: string) => ({
        bind: (...params: any[]) => {
          const stmtObj = { sql, params };
          return {
            ...stmtObj,
            first: async () => ({ symbol: "SPY" }),
            run: async () => {
              executedStmts.push(stmtObj);
              return { meta: { changes: 1 } };
            },
          };
        },
      }),
      batch: async (stmts: any[]) => {
        for (const s of stmts) {
          executedStmts.push({ sql: s.sql, params: s.params });
        }
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    };

    const success = await toggleSpreadTargetActive(mockDb, 999, 42, 1);
    expect(success).toBe(true);
    expect(
      executedStmts.some((s) =>
        s.sql.includes("UPDATE user_spread_targets SET is_active = 1, muted_until = 0"),
      ),
    ).toBe(true);
    expect(
      executedStmts.some((s) =>
        s.sql.includes("DELETE FROM spread_symbol_mutes WHERE telegram_id = ? AND symbol = ?"),
      ),
    ).toBe(true);
  });

  it("getActiveSpreadTargetsForMonitoring binds nowSec and filters armed=1 mutes while retaining armed=0", async () => {
    let executedSql = "";
    let boundParams: any[] = [];
    const mockDb: any = {
      prepare: (sql: string) => {
        executedSql = sql;
        return {
          bind: (...params: any[]) => {
            boundParams = params;
            return {
              all: async () => ({ results: [] }),
            };
          },
        };
      },
    };

    const nowSec = 1700000000;
    await getActiveSpreadTargetsForMonitoring(mockDb, nowSec);

    expect(executedSql).toContain("t.armed = 0");
    expect(executedSql).toContain("t.muted_until <= ?");
    expect(executedSql).toContain("COALESCE(u.spread_muted_until, 0) <= ?");
    expect(executedSql).toContain("COALESCE(sm.muted_until, 0) <= ?");
    expect(executedSql).toContain("ORDER BY COALESCE(t.last_alerted_at, 0) ASC, t.id ASC");
    expect(boundParams).toEqual([nowSec, nowSec, nowSec]);
  });

  it("ensureDatabaseSchema executes all DDL queries without throwing", async () => {
    resetSchemaEnsured();
    const executedStatements: string[] = [];
    const mockDb: any = {
      prepare: (sql: string) => {
        executedStatements.push(sql);
        return {
          run: async () => ({ meta: {} }),
        };
      },
    };

    await ensureDatabaseSchema(mockDb);
    expect(executedStatements.some((s) => s.includes("user_spread_targets"))).toBe(true);
    expect(executedStatements.some((s) => s.includes("spread_symbol_mutes"))).toBe(true);
    expect(executedStatements.some((s) => s.includes("spread_muted_until"))).toBe(true);
    expect(executedStatements.some((s) => s.includes("updates_muted_until"))).toBe(true);
  });
});
