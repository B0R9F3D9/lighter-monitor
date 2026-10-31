import { describe, expect, it } from "bun:test";
import { fetchLighterAccount, fetchInChunks, shuffleArray, fetchExchangeStats } from "../src/lighter/api";

describe("fetchLighterAccount", () => {
  it("should successfully fetch real account 31704 from Robinhood Lighter API", async () => {
    const account = await fetchLighterAccount("rh", 31704);
    expect(account).not.toBeNull();
    expect(account?.index).toBe(31704);
    expect(account?.l1_address).toBeDefined();
    expect(account?.l1_address.startsWith("0x")).toBe(true);
    expect(Array.isArray(account?.positions)).toBe(true);
  });

  it("should successfully fetch real account 749329 from Mainnet Lighter API", async () => {
    const account = await fetchLighterAccount("mainnet", 749329);
    expect(account).not.toBeNull();
    expect(account?.index).toBe(749329);
    expect(account?.l1_address).toBeDefined();
    expect(account?.l1_address.startsWith("0x")).toBe(true);
    expect(Array.isArray(account?.positions)).toBe(true);
    // Verified that 749329 has an active XAU position
    const xauPos = account?.positions.find((p) => p.symbol === "XAU");
    expect(xauPos).toBeDefined();
  });

  it("should return null for non-existent account index", async () => {
    const account = await fetchLighterAccount("rh", 999999999);
    expect(account).toBeNull();
  });
});

describe("fetchInChunks", () => {
  it("should process items in chunks concurrently", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const results = await fetchInChunks(items, 3, async (n) => n * 10);

    expect(results.length).toBe(7);
    const values = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    expect(values).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });
});

describe("shuffleArray (Anti-Sybil Fisher-Yates)", () => {
  it("preserves array elements and length without mutating original", () => {
    const original = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const copy = [...original];
    const shuffled = shuffleArray(original);

    expect(original).toEqual(copy); // original is not mutated
    expect(shuffled.length).toBe(original.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(original);
  });

  it("handles empty and single-element arrays gracefully", () => {
    expect(shuffleArray([])).toEqual([]);
    expect(shuffleArray([42])).toEqual([42]);
  });

  it("randomizes order across multiple executions", () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let identicalCount = 0;
    const trials = 20;

    for (let t = 0; t < trials; t++) {
      const shuffled = shuffleArray(original);
      if (shuffled.every((v, idx) => v === original[idx])) {
        identicalCount++;
      }
    }

    // Probability of 10-element array staying in exact same order 20 times in a row is (1/10!)^20 ≈ 0
    expect(identicalCount).toBeLessThan(trials);
  });
});

describe("getLighterAuthToken", () => {
  const { getLighterAuthToken } = require("../src/config");

  it("should return undefined when no env is provided", () => {
    expect(getLighterAuthToken(undefined)).toBeUndefined();
    expect(getLighterAuthToken({})).toBeUndefined();
  });

  it("should return global LIGHTER_API_KEY when specific is not set", () => {
    const env = { LIGHTER_API_KEY: "global_token_123" };
    expect(getLighterAuthToken(env, "rh")).toBe("global_token_123");
    expect(getLighterAuthToken(env, "mainnet")).toBe("global_token_123");
    expect(getLighterAuthToken(env)).toBe("global_token_123");
  });

  it("should prioritize network-specific token over global token", () => {
    const env = {
      LIGHTER_API_KEY: "global_token_123",
      LIGHTER_API_KEY_MAINNET: "mainnet_token_456",
      LIGHTER_API_KEY_RH: "rh_token_789",
    };
    expect(getLighterAuthToken(env, "mainnet")).toBe("mainnet_token_456");
    expect(getLighterAuthToken(env, "rh")).toBe("rh_token_789");
    expect(getLighterAuthToken(env)).toBe("global_token_123");
  });

  it("should trim whitespace and ignore empty strings", () => {
    const env = {
      LIGHTER_API_KEY: "   ",
      LIGHTER_API_KEY_MAINNET: "  mainnet_token  ",
    };
    expect(getLighterAuthToken(env, "mainnet")).toBe("mainnet_token");
    expect(getLighterAuthToken(env, "rh")).toBeUndefined();
  });
});

describe("fetchExchangeStats argument parsing (Bug #2 fix)", () => {
  it("passes authToken correctly when activeSymbols is undefined", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: any;
    try {
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedHeaders = opts?.headers;
        return new Response(JSON.stringify({ code: 200, order_book_stats: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as any;

      await fetchExchangeStats("rh", undefined, "my-auth-token");
      expect(capturedHeaders?.Authorization).toBe("my-auth-token");

      // 2-argument signature
      await fetchExchangeStats("rh", "direct-token");
      expect(capturedHeaders?.Authorization).toBe("direct-token");

      // 3-argument signature with Set
      await fetchExchangeStats("rh", new Set(["BTC"]), "set-token");
      expect(capturedHeaders?.Authorization).toBe("set-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
