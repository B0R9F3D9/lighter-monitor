import { describe, expect, it, beforeEach } from "bun:test";
import {
  clearAccount,
  clearAccountRecords,
  getAccountFunding,
  getAccountMeta,
  getAccountTrades,
  getAccountWithdrawals,
  normalizeTimestampMs,
  saveAccountMeta,
  upsertFunding,
  upsertTrades,
  upsertWithdrawals,
} from "../src/checker/db";
import {
  assertApiOk,
  AuthExpiredError,
  LighterSyncService,
  maskToken,
  parseLighterToken,
} from "../src/checker/sync";
import type {
  AccountMetaRecord,
  LighterTrade,
  PositionFundingRecord,
  WithdrawalRecord,
} from "../src/checker/types";

// ============================================================================
// Lightweight In-Memory IndexedDB Mock for Bun Test Runner
// ============================================================================
class MockIDBKeyRange {
  constructor(
    public lower: any,
    public upper: any,
    public lowerOpen = false,
    public upperOpen = false,
  ) {}

  static bound(lower: any, upper: any, lowerOpen = false, upperOpen = false) {
    return new MockIDBKeyRange(lower, upper, lowerOpen, upperOpen);
  }

  includes(key: any): boolean {
    const lowerOk = this.lowerOpen ? key > this.lower : key >= this.lower;
    const upperOk = this.upperOpen ? key < this.upper : key <= this.upper;
    return lowerOk && upperOk;
  }
}

class MockIDBStore {
  public data = new Map<string, any>();

  constructor(
    public name: string,
    public keyPath: string,
  ) {}

  put(item: any) {
    const key = item[this.keyPath];
    this.data.set(key, JSON.parse(JSON.stringify(item)));
    return {
      onsuccess: null as any,
      onerror: null as any,
    };
  }

  get(key: string) {
    const req = {
      result: this.data.get(key) ? JSON.parse(JSON.stringify(this.data.get(key))) : undefined,
      onsuccess: null as any,
      onerror: null as any,
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  delete(keyOrRange: any) {
    if (keyOrRange && typeof keyOrRange.includes === "function") {
      for (const k of Array.from(this.data.keys())) {
        if (keyOrRange.includes(k)) {
          this.data.delete(k);
        }
      }
    } else {
      this.data.delete(keyOrRange);
    }
    const req = {
      onsuccess: null as any,
      onerror: null as any,
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  getAll(range?: MockIDBKeyRange) {
    let items: any[] = [];
    const sortedKeys = Array.from(this.data.keys()).toSorted();
    for (const k of sortedKeys) {
      if (!range || range.includes(k)) {
        items.push(JSON.parse(JSON.stringify(this.data.get(k))));
      }
    }
    const req = {
      result: items,
      onsuccess: null as any,
      onerror: null as any,
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  openCursor(range?: MockIDBKeyRange) {
    const keys = Array.from(this.data.keys()).filter((k) => !range || range.includes(k));
    let idx = 0;
    const req = {
      result: null as any,
      onsuccess: null as any,
      onerror: null as any,
    };

    const advance = () => {
      if (idx < keys.length) {
        const k = keys[idx];
        req.result = {
          primaryKey: k,
          value: this.data.get(k),
          delete: () => this.data.delete(k),
          continue: () => {
            idx++;
            advance();
          },
        };
      } else {
        req.result = null;
      }
      req.onsuccess?.({ target: req });
    };

    queueMicrotask(() => advance());
    return req;
  }
}

class MockIDBDatabase {
  public stores = new Map<string, MockIDBStore>();
  public objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  constructor() {
    this.stores.set("accounts_meta", new MockIDBStore("accounts_meta", "accountKey"));
    this.stores.set("trades", new MockIDBStore("trades", "uid"));
    this.stores.set("funding_history", new MockIDBStore("funding_history", "uid"));
    this.stores.set("withdrawals", new MockIDBStore("withdrawals", "uid"));
  }

  createObjectStore(name: string, options: { keyPath: string }) {
    const store = new MockIDBStore(name, options.keyPath);
    this.stores.set(name, store);
    return store;
  }

  transaction(storeNames: string | string[], mode: "readonly" | "readwrite" = "readonly") {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    for (const name of names) {
      if (!this.stores.has(name)) {
        throw new Error(`NotFoundError: Store "${name}" not found in mock database`);
      }
    }
    const tx = {
      mode,
      objectStore: (name: string) => this.stores.get(name)!,
      oncomplete: null as any,
      onerror: null as any,
    };
    queueMicrotask(() => tx.oncomplete?.());
    return tx;
  }
}

let mockDbInstance: MockIDBDatabase;

function setupMockIndexedDB() {
  mockDbInstance = new MockIDBDatabase();
  (globalThis as any).IDBKeyRange = MockIDBKeyRange;
  (globalThis as any).indexedDB = {
    open: () => {
      const req = {
        result: mockDbInstance,
        onsuccess: null as any,
        onerror: null as any,
        onupgradeneeded: null as any,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
}

// ============================================================================
// Test Suites
// ============================================================================

describe("Lighter Token Architecture: Parsing & Masking", () => {
  it("parses canonical Read-Only token with second-based expiry correctly", () => {
    const futureSec = Math.floor(Date.now() / 1000) + 7200;
    const token = `ro:31704:readonly:${futureSec}:0x72a9bf8134cd93e4`;
    const info = parseLighterToken(token, "rh");

    expect(info.accountIndex).toBe(31704);
    expect(info.network).toBe("rh");
    expect(info.scope).toBe("readonly");
    expect(info.expiryMs).toBe(futureSec * 1000);
    expect(info.rawToken).toBe(token);
  });

  it("parses canonical Read-Only token with millisecond-based expiry correctly", () => {
    const futureMs = Date.now() + 3600000;
    const token = `ro:749329:readonly:${futureMs}:0xabcdef`;
    const info = parseLighterToken(token, "mainnet");

    expect(info.accountIndex).toBe(749329);
    expect(info.network).toBe("mainnet");
    expect(info.expiryMs).toBe(futureMs);
  });

  it("parses standard 4-part Lighter API token correctly", () => {
    const futureSec = Math.floor(Date.now() / 1000) + 1800;
    const token = `45000:0:${futureSec}:0xfeedbeef12345678`;
    const info = parseLighterToken(token, "rh");

    expect(info.accountIndex).toBe(45000);
    expect(info.keyIndex).toBe(0);
    expect(info.expiryMs).toBe(futureSec * 1000);
  });

  it("throws descriptive errors on empty, whitespace, or invalid token", () => {
    expect(() => parseLighterToken("")).toThrow("Token string is empty");
    expect(() => parseLighterToken("   ")).toThrow("Token string is empty");
    expect(() => parseLighterToken("random_invalid_string")).toThrow(
      "Unable to determine account_index",
    );
  });

  it("masks credentials safely while exposing only non-sensitive account identifier and last 4 characters", () => {
    const roToken = "ro:31704:readonly:1790000000:0xabcdef1234567890deadbeef";
    const masked = maskToken(roToken);

    expect(masked).toBe("ro:31704:••••••••••••beef");
    expect(masked).not.toContain("0xabcdef1234567890");
    expect(masked).not.toContain("readonly");

    const stdToken = "749329:0:1790000000:0x1234567890abcdef";
    const maskedStd = maskToken(stdToken);
    expect(maskedStd).toBe("749329:••••••••••••cdef");
    expect(maskedStd).not.toContain("0x1234567890");

    // Short strings masked completely
    expect(maskToken("short")).toBe("••••••••");
    expect(maskToken("")).toBe("");
  });
});

describe("Native IndexedDB (LighterCheckerDB) Storage Operations", () => {
  beforeEach(() => {
    setupMockIndexedDB();
  });

  it("normalizes timestamp formats accurately", () => {
    expect(normalizeTimestampMs(1700000000)).toBe(1700000000000);
    expect(normalizeTimestampMs(1700000000000)).toBe(1700000000000);
    expect(normalizeTimestampMs(0)).toBe(0);
  });

  it("saves and retrieves account metadata correctly", async () => {
    const meta: AccountMetaRecord = {
      accountKey: "rh:31704",
      network: "rh",
      accountIndex: 31704,
      authToken: "ro:31704:readonly:1800000000:0xsig",
      lastSyncedAt: 1700000000000,
      syncState: {
        latestTradeId: 105,
        latestTradeTs: 1700000005000,
        latestFundingTs: 1700000000000,
        hasFullHistory: true,
      },
    };

    await saveAccountMeta(meta);
    const retrieved = await getAccountMeta("rh:31704");

    expect(retrieved).not.toBeNull();
    expect(retrieved?.accountKey).toBe("rh:31704");
    expect(retrieved?.syncState?.latestTradeId).toBe(105);
  });

  it("batch upserts trades with zero secondary indexes and returns them in descending chronological order", async () => {
    const trades: LighterTrade[] = [
      {
        trade_id: 101,
        trade_id_str: "101",
        market_id: 1,
        timestamp: 1700000001000,
        size: "1.0",
        price: "100",
        usd_amount: "100",
        ask_account_id: 31704,
        bid_account_id: 9999,
        is_maker_ask: false,
      } as any,
      {
        trade_id: 103,
        trade_id_str: "103",
        market_id: 1,
        timestamp: 1700000003000, // newest
        size: "3.0",
        price: "100",
        usd_amount: "300",
        ask_account_id: 31704,
        bid_account_id: 9999,
        is_maker_ask: false,
      } as any,
      {
        trade_id: 102,
        trade_id_str: "102",
        market_id: 1,
        timestamp: 1700000002000,
        size: "2.0",
        price: "100",
        usd_amount: "200",
        ask_account_id: 31704,
        bid_account_id: 9999,
        is_maker_ask: false,
      } as any,
    ];

    const inserted = await upsertTrades("rh:31704", trades);
    expect(inserted).toBe(3);

    // Primary-key range scan naturally reads ascending from LevelDB B-Tree,
    // and .reverse() outputs strictly newest-first (descending)
    const stored = await getAccountTrades("rh:31704");
    expect(stored.length).toBe(3);
    expect(stored.map((t) => t.trade_id)).toEqual([103, 102, 101]);
  });

  it("batch upserts and retrieves funding history sorted descending", async () => {
    const funding: PositionFundingRecord[] = [
      {
        funding_id: 1,
        market_id: 1,
        timestamp: 1700000000000,
        change: "-2.50",
        rate: "0.0001",
      },
      {
        funding_id: 2,
        market_id: 1,
        timestamp: 1700003600000, // 1 hour later
        change: "-1.50",
        rate: "0.0001",
      },
    ];

    await upsertFunding("rh:31704", funding);
    const stored = await getAccountFunding("rh:31704");

    expect(stored.length).toBe(2);
    expect(stored[0].funding_id).toBe(2);
    expect(stored[1].funding_id).toBe(1);
  });

  it("batch upserts and retrieves withdrawals sorted descending", async () => {
    const withdrawals: WithdrawalRecord[] = [
      {
        id: "w-old",
        amount: "100",
        amountUsd: 100,
        timestamp: 1700000000,
        timestampMs: 1700000000000,
        status: "completed",
        type: "fast",
        asset_id: 1,
        symbol: "USDG",
      },
      {
        id: "w-new",
        amount: "500",
        amountUsd: 500,
        timestamp: 1700005000,
        timestampMs: 1700005000000,
        status: "completed",
        type: "fast",
        asset_id: 1,
        symbol: "USDG",
      },
    ];

    await upsertWithdrawals("rh:31704", withdrawals);
    const stored = await getAccountWithdrawals("rh:31704");

    expect(stored.length).toBe(2);
    expect(stored[0].id).toBe("w-new");
    expect(stored[1].id).toBe("w-old");
  });

  it("clearAccountRecords purges trades, funding, and withdrawals while keeping accounts_meta", async () => {
    await saveAccountMeta({
      accountKey: "rh:31704",
      network: "rh",
      accountIndex: 31704,
      authToken: "ro:31704:readonly:1800000000:0xsig",
      lastSyncedAt: 1700000000000,
    });

    await upsertTrades("rh:31704", [{ trade_id: 1, timestamp: 1700000000000 } as any]);
    await upsertFunding("rh:31704", [
      { funding_id: 1, market_id: 1, timestamp: 1700000000000, change: "0" },
    ]);
    await upsertWithdrawals("rh:31704", [
      {
        id: "w1",
        amount: "100",
        amountUsd: 100,
        timestamp: 1700000000,
        timestampMs: 1700000000000,
        status: "completed",
        type: "fast",
        asset_id: 1,
        symbol: "USDG",
      },
    ]);

    await clearAccountRecords("rh:31704");

    const meta = await getAccountMeta("rh:31704");
    const trades = await getAccountTrades("rh:31704");
    const funding = await getAccountFunding("rh:31704");
    const withdrawals = await getAccountWithdrawals("rh:31704");

    expect(meta).not.toBeNull();
    expect(meta?.accountIndex).toBe(31704);
    expect(trades.length).toBe(0);
    expect(funding.length).toBe(0);
    expect(withdrawals.length).toBe(0);
  });

  it("clears account data across all stores cleanly", async () => {
    await saveAccountMeta({
      accountKey: "rh:31704",
      network: "rh",
      accountIndex: 31704,
      authToken: "ro:31704:readonly:1800000000:0xsig",
      lastSyncedAt: 1700000000000,
    });

    await upsertTrades("rh:31704", [{ trade_id: 1, timestamp: 1700000000000 } as any]);

    await clearAccount("rh:31704");

    const meta = await getAccountMeta("rh:31704");
    const trades = await getAccountTrades("rh:31704");

    expect(meta).toBeNull();
    expect(trades.length).toBe(0);
  });
});

describe("Delta Sync Cutoff & Gap Safety Verification", () => {
  beforeEach(() => {
    setupMockIndexedDB();
  });

  it("stops delta loop when latestTradeId is encountered", async () => {
    // Setup pre-existing account meta with latestTradeId = 200
    const meta: AccountMetaRecord = {
      accountKey: "rh:31704",
      network: "rh",
      accountIndex: 31704,
      authToken: "ro:31704:readonly:1800000000:0xsig",
      lastSyncedAt: 1700000000000,
      syncState: {
        latestTradeId: 200,
        latestTradeTs: 1700000020000,
        hasFullHistory: true,
      },
    };
    await saveAccountMeta(meta);

    // Mock API returning Page 1 with trades [202, 201, 200 (cutoff), 199]
    const pageTrades: LighterTrade[] = [
      {
        trade_id: 202,
        trade_id_str: "202",
        market_id: 1,
        timestamp: 1700000022000,
        ask_account_id: 31704,
        bid_account_id: 9999,
        size: "1",
        price: "100",
        usd_amount: "100",
      } as any,
      {
        trade_id: 201,
        trade_id_str: "201",
        market_id: 1,
        timestamp: 1700000021000,
        ask_account_id: 31704,
        bid_account_id: 9999,
        size: "1",
        price: "100",
        usd_amount: "100",
      } as any,
      {
        trade_id: 200, // matches latestTradeId!
        trade_id_str: "200",
        market_id: 1,
        timestamp: 1700000020000,
        ask_account_id: 31704,
        bid_account_id: 9999,
        size: "1",
        price: "100",
        usd_amount: "100",
      } as any,
      {
        trade_id: 199, // Should NOT be included
        trade_id_str: "199",
        market_id: 1,
        timestamp: 1700000019000,
        ask_account_id: 31704,
        bid_account_id: 9999,
        size: "1",
        price: "100",
        usd_amount: "100",
      } as any,
    ];

    // Mock fetch
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes("/trades")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 200, trades: pageTrades }),
        };
      }
      if (url.includes("/account")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 200, accounts: [{ account_index: 31704, positions: [] }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, data: [] }),
      };
    };

    try {
      const service = new LighterSyncService();
      const result = await service.syncAccount(meta, { forceFullSync: false });

      // Only trades 202 and 201 are new
      expect(result.newTrades.length).toBe(2);
      expect(result.newTrades.map((t) => t.trade_id)).toEqual([202, 201]);

      // Atomic cursor advancement updated to 202
      const updatedMeta = await getAccountMeta("rh:31704");
      expect(updatedMeta?.syncState?.latestTradeId).toBe(202);
      expect(updatedMeta?.syncState?.latestTradeTs).toBe(1700000022000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves cursor when delta sync aborts or fails before reaching cutoff", async () => {
    const meta: AccountMetaRecord = {
      accountKey: "rh:31704",
      network: "rh",
      accountIndex: 31704,
      authToken: "ro:31704:readonly:1800000000:0xsig",
      lastSyncedAt: 1700000000000,
      syncState: {
        latestTradeId: 100,
        latestTradeTs: 1700000010000,
        hasFullHistory: true,
      },
    };
    await saveAccountMeta(meta);

    const originalFetch = globalThis.fetch;
    // Simulate non-retriable error on /trades
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes("/trades")) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () => "Invalid query parameter",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200 }),
      };
    };

    try {
      const service = new LighterSyncService();
      await expect(service.syncAccount(meta)).rejects.toThrow("HTTP 400");

      // Verify cursor was NOT advanced or corrupted
      const unchangedMeta = await getAccountMeta("rh:31704");
      expect(unchangedMeta?.syncState?.latestTradeId).toBe(100);
      expect(unchangedMeta?.syncState?.latestTradeTs).toBe(1700000010000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles AuthExpiredError on HTTP 401 and HTTP 403", async () => {
    const meta: AccountMetaRecord = {
      accountKey: "rh:31704",
      network: "rh",
      accountIndex: 31704,
      authToken: "ro:31704:readonly:1000000000:0xexpired",
      lastSyncedAt: 1700000000000,
    };

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      };
    };

    try {
      const service = new LighterSyncService();
      await expect(service.syncAccount(meta)).rejects.toBeInstanceOf(AuthExpiredError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("assertApiOk validates payloads and throws AuthExpiredError or API Error appropriately", () => {
    // Normal successful codes
    expect(() => assertApiOk({ code: 200 }, "rh")).not.toThrow();
    expect(() => assertApiOk({ code: 0 }, "rh")).not.toThrow();
    expect(() => assertApiOk({}, "rh")).not.toThrow();

    // Embedded 401 / 403 / auth expired within HTTP 200 OK
    expect(() => assertApiOk({ code: 401, message: "invalid auth token" }, "rh")).toThrow(
      AuthExpiredError,
    );
    expect(() => assertApiOk({ code: 403, message: "forbidden" }, "mainnet")).toThrow(
      AuthExpiredError,
    );
    expect(() => assertApiOk({ code: 200, message: "token expired" }, "rh")).toThrow(
      AuthExpiredError,
    );

    // Other API errors
    expect(() => assertApiOk({ code: 21100, message: "internal engine fault" }, "rh")).toThrow(
      "internal engine fault",
    );
  });

  it("throws AuthExpiredError if API returns HTTP 200 with embedded code: 401", async () => {
    const meta: AccountMetaRecord = {
      accountKey: "rh:31704",
      network: "rh",
      accountIndex: 31704,
      authToken: "ro:31704:readonly:1000000000:0xsig",
      lastSyncedAt: 1700000000000,
    };

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 401, message: "invalid auth token" }),
      };
    };

    try {
      const service = new LighterSyncService();
      await expect(service.syncAccount(meta)).rejects.toBeInstanceOf(AuthExpiredError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not advance latestFundingTs if pagination breaks with an error on page 2", async () => {
    const meta: AccountMetaRecord = {
      accountKey: "rh:31704",
      network: "rh",
      accountIndex: 31704,
      authToken: "ro:31704:readonly:1800000000:0xsig",
      lastSyncedAt: 1700000000000,
      syncState: {
        latestTradeId: 100,
        latestTradeTs: 1700000000000,
        latestFundingTs: 1699990000000,
        hasFullHistory: true,
      },
    };
    await saveAccountMeta(meta);

    let fundingCallCount = 0;
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes("/trades")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 200, trades: [] }),
        };
      }
      if (url.includes("/account")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 200, accounts: [{ account_index: 31704, positions: [] }] }),
        };
      }
      if (url.includes("/positionFunding")) {
        fundingCallCount++;
        if (fundingCallCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: 200,
              next_cursor: "page2cursor",
              position_fundings: [
                { funding_id: 5, market_id: 1, timestamp: 1700000050000, change: "1.0" },
              ],
            }),
          };
        } else {
          // Page 2 API error
          return {
            ok: true,
            status: 200,
            json: async () => ({ code: 500, message: "Server error" }),
          };
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, data: [] }),
      };
    };

    try {
      const service = new LighterSyncService();
      const result = await service.syncAccount(meta);

      // Verify that 1 item was ingested
      expect(result.newFunding.length).toBe(1);

      // Verify cursor was NOT advanced because funding did not complete cleanly
      const updatedMeta = await getAccountMeta("rh:31704");
      expect(updatedMeta?.syncState?.latestFundingTs).toBe(1699990000000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
