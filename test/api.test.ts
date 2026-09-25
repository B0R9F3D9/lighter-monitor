import { describe, expect, it } from "bun:test";
import { fetchLighterAccount, fetchInChunks } from "../src/lighter/api";

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
