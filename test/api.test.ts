import { describe, expect, it } from "bun:test";
import { fetchLighterAccount, fetchInChunks } from "../src/lighter/api";

describe("fetchLighterAccount", () => {
  it("should successfully fetch real account 31704 from Robinhood Lighter API", async () => {
    const account = await fetchLighterAccount(31704);
    expect(account).not.toBeNull();
    expect(account?.index).toBe(31704);
    expect(account?.l1_address).toBeDefined();
    expect(account?.l1_address.startsWith("0x")).toBe(true);
    expect(Array.isArray(account?.positions)).toBe(true);
  });

  it("should return null for non-existent account index", async () => {
    // Large non-existent index
    const account = await fetchLighterAccount(999999999);
    expect(account).toBeNull();
  });
});

describe("fetchInChunks", () => {
  it("should process items in chunks concurrently", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const results = await fetchInChunks(items, 3, async (n) => n * 10);
    
    expect(results.length).toBe(7);
    const values = results.map(r => r.status === "fulfilled" ? r.value : null);
    expect(values).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });
});
