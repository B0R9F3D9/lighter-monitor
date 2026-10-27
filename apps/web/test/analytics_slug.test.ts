import { describe, expect, it } from "bun:test";
import { getSlugSymbolFromPath } from "../src/analytics/controller";

describe("Analytics URL Slug Resolution", () => {
  it("extracts uppercase symbol from /analytics/:ticker", () => {
    expect(getSlugSymbolFromPath("/analytics/XAU")).toBe("XAU");
    expect(getSlugSymbolFromPath("/analytics/BTC")).toBe("BTC");
    expect(getSlugSymbolFromPath("/analytics/AAPL")).toBe("AAPL");
    expect(getSlugSymbolFromPath("/analytics/NVDA")).toBe("NVDA");
  });

  it("normalizes lowercase ticker to uppercase", () => {
    expect(getSlugSymbolFromPath("/analytics/xau")).toBe("XAU");
    expect(getSlugSymbolFromPath("/analytics/btc")).toBe("BTC");
    expect(getSlugSymbolFromPath("/analytics/eth")).toBe("ETH");
  });

  it("handles optional trailing slash correctly", () => {
    expect(getSlugSymbolFromPath("/analytics/XAU/")).toBe("XAU");
    expect(getSlugSymbolFromPath("/analytics/sol/")).toBe("SOL");
  });

  it("supports numeric and alphanumeric tokens like 1000PEPE", () => {
    expect(getSlugSymbolFromPath("/analytics/1000PEPE")).toBe("1000PEPE");
    expect(getSlugSymbolFromPath("/analytics/1000BONK")).toBe("1000BONK");
    expect(getSlugSymbolFromPath("/analytics/US500")).toBe("US500");
  });

  it("returns null for base /analytics and /analytics/", () => {
    expect(getSlugSymbolFromPath("/analytics")).toBeNull();
    expect(getSlugSymbolFromPath("/analytics/")).toBeNull();
  });

  it("returns null for static asset files under /analytics", () => {
    expect(getSlugSymbolFromPath("/analytics/main.js")).toBeNull();
    expect(getSlugSymbolFromPath("/analytics/style.css")).toBeNull();
    expect(getSlugSymbolFromPath("/analytics/analytics.html")).toBeNull();
    expect(getSlugSymbolFromPath("/analytics/version.json")).toBeNull();
  });

  it("returns null for unrelated paths", () => {
    expect(getSlugSymbolFromPath("/")).toBeNull();
    expect(getSlugSymbolFromPath("/spread")).toBeNull();
    expect(getSlugSymbolFromPath("/checker")).toBeNull();
    expect(getSlugSymbolFromPath("")).toBeNull();
  });

  it("resolves slug from encoded ticker link paths correctly", () => {
    const symbols = ["AAPL", "BTC", "ETH", "1000PEPE", "XAU", "BRK.B"];
    for (const sym of symbols) {
      const linkPath = `/analytics/${encodeURIComponent(sym)}`;
      expect(getSlugSymbolFromPath(linkPath)).toBe(sym.toUpperCase());
    }
  });
});
