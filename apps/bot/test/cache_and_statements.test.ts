import { describe, expect, it } from "bun:test";
import {
  MEMORY_ACCOUNTS,
  MEMORY_PRICES,
  clearMemoryCache,
  getMemoryAccount,
  getMemoryAccountKey,
  getMemoryPrice,
  setMemoryAccount,
  setMemoryPrice,
} from "../src/cache/memory";
import { getCronStatements, resetCachedStatements } from "../src/db/statements";
import { fetchTargetedMarketPrices } from "../src/lighter/api";
import { buildBatchUpdatePositionsCacheStmts } from "../src/db/queries";

describe("In-Memory State & Statements", () => {
  it("manages account memory state correctly", () => {
    clearMemoryCache();
    expect(getMemoryAccount("rh", 31704)).toBeUndefined();

    setMemoryAccount({
      network: "rh",
      accountIndex: 31704,
      alias: "Main",
      collateral: 500,
      lastUpdated: 1000,
      fingerprint: 12345,
      positions: [
        {
          marketId: 40,
          symbol: "XAU",
          isLong: true,
          entryPrice: 4200,
          size: 1.5,
          liqPrice: 4100,
        },
      ],
    });

    const acc = getMemoryAccount("rh", 31704);
    expect(acc).toBeDefined();
    expect(acc?.alias).toBe("Main");
    expect(acc?.positions.length).toBe(1);
    expect(acc?.fingerprint).toBe(12345);
    expect(getMemoryAccountKey("rh", 31704)).toBe("rh:31704");

    expect(MEMORY_ACCOUNTS.size).toBe(1);
    clearMemoryCache();
    expect(getMemoryAccount("rh", 31704)).toBeUndefined();
    expect(MEMORY_ACCOUNTS.size).toBe(0);
  });

  it("manages price memory state and strips suffixes correctly", () => {
    clearMemoryCache();
    setMemoryPrice("BTC-PERP", 65000);

    expect(MEMORY_PRICES.size).toBe(2);
    expect(getMemoryPrice("BTC-PERP")).toBe(65000);
    expect(getMemoryPrice("BTC")).toBe(65000);
    expect(getMemoryPrice("ETH")).toBeUndefined();
  });

  it("isolates prices across networks (rh vs mainnet)", () => {
    clearMemoryCache();
    setMemoryPrice("rh", "NVDA", 230.07);
    setMemoryPrice("mainnet", "NVDA", 229.88);

    expect(getMemoryPrice("rh", "NVDA")).toBe(230.07);
    expect(getMemoryPrice("mainnet", "NVDA")).toBe(229.88);
  });

  it("fetchTargetedMarketPrices returns price map for requested active symbols", async () => {
    const prices = await fetchTargetedMarketPrices("rh", new Set(["XAU"]));
    expect(prices instanceof Map).toBe(true);
    expect(prices.has("XAU")).toBe(true);
    expect(prices.get("XAU")!).toBeGreaterThan(1000);
  }, 10000);

  it("caches D1 statements for same DB and resets when requested", () => {
    let prepareCount = 0;
    const mockDb: any = {
      prepare: (sql: string) => {
        prepareCount++;
        return { sql, bind: () => ({}) };
      },
    };

    resetCachedStatements();
    const stmts1 = getCronStatements(mockDb);
    expect(prepareCount).toBe(10);

    // Second call with same DB should return cached without preparing again
    const stmts2 = getCronStatements(mockDb);
    expect(stmts1).toBe(stmts2);
    expect(prepareCount).toBe(10);

    // Resetting cached statements causes re-prepare
    resetCachedStatements();
    getCronStatements(mockDb);
    expect(prepareCount).toBe(20);
  });

  it("buildBatchUpdatePositionsCacheStmts preserves user alias in memory", () => {
    clearMemoryCache();
    setMemoryAccount({
      network: "rh",
      accountIndex: 12345,
      alias: "MyCustomAlias",
      collateral: 1000,
      lastUpdated: 500,
      fingerprint: 1,
      positions: [],
    });

    const mockDb: any = {
      prepare: (sql: string) => ({
        sql,
        bind: () => ({}),
      }),
    };

    buildBatchUpdatePositionsCacheStmts(mockDb, [
      {
        network: "rh",
        account: {
          index: 12345,
          l1_address: "0x123",
          collateral: "1200",
          total_asset_value: "1200",
          available_balance: "1200",
          positions: [],
        },
        cachedPositions: [],
      },
    ]);

    const updated = getMemoryAccount("rh", 12345);
    expect(updated).toBeDefined();
    expect(updated?.alias).toBe("MyCustomAlias");
    expect(updated?.collateral).toBe(1200);
  });
});
