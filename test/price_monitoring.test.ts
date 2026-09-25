import { describe, it, expect } from "bun:test";
import {
  getSmartCooldownSeconds,
  getMovedSymbols,
  resetPriceReferenceCache,
} from "../src/cron/monitor";
import { findMarketPrice, fetchExchangeStats } from "../src/lighter/api";
import { formatPriceStepAlert } from "../src/bot/formatters";
import { MarketPriceSnapshot, PriceStepAlertParams, LighterNetwork } from "../src/types";
import { getActivePositionsForMonitoring } from "../src/db/queries";

describe("Price-Driven Monitoring Unit Tests", () => {
  describe("getSmartCooldownSeconds", () => {
    it("returns 180s (3m) for thresholds <= 0.5%", () => {
      expect(getSmartCooldownSeconds(0.3)).toBe(180);
      expect(getSmartCooldownSeconds(0.4)).toBe(180);
      expect(getSmartCooldownSeconds(0.5)).toBe(180);
    });

    it("returns 300s (5m) for thresholds between 0.5% and 1.0%", () => {
      expect(getSmartCooldownSeconds(0.8)).toBe(300);
      expect(getSmartCooldownSeconds(1.0)).toBe(300);
    });

    it("returns 480s (8m) for thresholds > 1.0%", () => {
      expect(getSmartCooldownSeconds(1.5)).toBe(480);
      expect(getSmartCooldownSeconds(2.0)).toBe(480);
      expect(getSmartCooldownSeconds(3.0)).toBe(480);
    });
  });

  describe("findMarketPrice", () => {
    const mockMap = new Map<string, MarketPriceSnapshot>([
      ["XAU", { symbol: "XAU", price: 4278.5, dailyChange: -0.5 }],
      ["ETH", { symbol: "ETH", price: 3500.0, dailyChange: 1.2 }],
      ["SOL-PERP", { symbol: "SOL-PERP", price: 180.0, dailyChange: 2.5 }],
      ["GOOGL/USDG", { symbol: "GOOGL/USDG", price: 175.0, dailyChange: 0.1 }],
    ]);

    it("finds exact uppercase symbol", () => {
      const res = findMarketPrice(mockMap, "XAU");
      expect(res).toBeDefined();
      expect(res?.price).toBe(4278.5);
    });

    it("finds lowercase symbol case-insensitively", () => {
      const res = findMarketPrice(mockMap, "xau");
      expect(res).toBeDefined();
      expect(res?.price).toBe(4278.5);
    });

    it("finds symbol when map has -PERP suffix", () => {
      const res = findMarketPrice(mockMap, "SOL");
      expect(res).toBeDefined();
      expect(res?.price).toBe(180.0);
    });

    it("finds symbol when map has /USDG suffix", () => {
      const res = findMarketPrice(mockMap, "GOOGL");
      expect(res).toBeDefined();
      expect(res?.price).toBe(175.0);
    });

    it("prefers perp when resolving symbol", () => {
      const perpMap = new Map<string, MarketPriceSnapshot>([
        ["ETH/USDC", { symbol: "ETH/USDC", price: 3490.0, dailyChange: 0.5 }],
        ["ETH", { symbol: "ETH-PERP", price: 3505.0, dailyChange: 0.6 }],
      ]);
      const res = findMarketPrice(perpMap, "ETH");
      expect(res?.price).toBe(3505.0);
    });
  });

  describe("formatPriceStepAlert (3-Layer Alert)", () => {
    it("formats alert correctly for LONG moving down into drawdown", () => {
      const params: PriceStepAlertParams = {
        network: "rh",
        accountIndex: 31704,
        alias: "Основной",
        symbol: "XAU",
        isLong: true,
        entryPrice: 4280.0,
        currentPrice: 4260.0,
        baselinePrice: 4280.0,
        priceDeltaPercent: -0.47,
        unrealizedPnl: -115.0,
        liqPrice: 4168.3,
        distancePercent: 2.15,
      };

      const text = formatPriceStepAlert(params);

      // Header & Account
      expect(text).toContain("⚡️ <b>XAU [RH] — $4,260.00</b>");
      expect(text).toContain("💼 <b>#31704 (Основной)</b> • 🟢 LONG");

      // Impulse & Position & Liq
      expect(text).toContain("• Импульс: <b>↘️ -0.47%</b> (с $4,280.00)");
      expect(text).toContain("• Позиция: <b>📉 -$115.00</b> (-0.47% от $4,280.00)");
      expect(text).toContain(
        "• Ликвидация: <b>$4,168.30</b> (до неё <b>2.15%</b> ⚠️ <b>[ОПАСНО]</b>)",
      );
    });

    it("formats break-even correctly when bouncing back to entry price", () => {
      const params: PriceStepAlertParams = {
        network: "rh",
        accountIndex: 31704,
        alias: null,
        symbol: "XAU",
        isLong: true,
        entryPrice: 4280.0,
        currentPrice: 4280.0,
        baselinePrice: 4260.0,
        priceDeltaPercent: 0.47,
        unrealizedPnl: 0.0,
        liqPrice: 4168.3,
        distancePercent: 2.61,
      };

      const text = formatPriceStepAlert(params);

      expect(text).toContain("⚡️ <b>XAU [RH] — $4,280.00</b>");
      expect(text).toContain("💼 <b>#31704</b> • 🟢 LONG");
      expect(text).toContain("• Импульс: <b>↗️ +0.47%</b> (с $4,260.00)");
      expect(text).toContain("• Позиция: <b>📈 +$0.00</b> (0.00% от $4,280.00)");
      expect(text).toContain("• Ликвидация: <b>$4,168.30</b> (до неё <b>2.61%</b>)");
    });

    it("formats SHORT position correctly: price drop is profit, price rise is drawdown", () => {
      // Short moving down -> profit
      const profitShort: PriceStepAlertParams = {
        network: "mainnet",
        accountIndex: 749329,
        alias: "Кит",
        symbol: "ETH",
        isLong: false,
        entryPrice: 3500.0,
        currentPrice: 3450.0,
        baselinePrice: 3500.0,
        priceDeltaPercent: -1.43,
        unrealizedPnl: 250.0,
        liqPrice: 3800.0,
        distancePercent: 10.14,
      };

      const profitText = formatPriceStepAlert(profitShort);
      expect(profitText).toContain("🔴 SHORT");
      expect(profitText).toContain("📈 +$250.00");

      // Short moving up -> drawdown
      const lossShort: PriceStepAlertParams = {
        network: "mainnet",
        accountIndex: 749329,
        alias: "Кит",
        symbol: "ETH",
        isLong: false,
        entryPrice: 3500.0,
        currentPrice: 3550.0,
        baselinePrice: 3500.0,
        priceDeltaPercent: 1.43,
        unrealizedPnl: -250.0,
        liqPrice: 3600.0,
        distancePercent: 1.41,
      };

      const lossText = formatPriceStepAlert(lossShort);
      expect(lossText).toContain("📉 -$250.00");
      expect(lossText).toContain("1.41%</b> ⚠️ <b>[ОПАСНО]</b>");
    });

    it("shows critical liquidation badge when distance <= 1.0%", () => {
      const critParams: PriceStepAlertParams = {
        network: "rh",
        accountIndex: 12345,
        alias: null,
        symbol: "XAU",
        isLong: true,
        entryPrice: 4280.0,
        currentPrice: 4180.0,
        baselinePrice: 4200.0,
        priceDeltaPercent: -0.48,
        unrealizedPnl: -500.0,
        liqPrice: 4150.0,
        distancePercent: 0.72,
      };

      const text = formatPriceStepAlert(critParams);
      expect(text).toContain("0.72%</b> 🚨 <b>[КРИТИЧНО]</b>");
    });
  });

  describe("Live exchangeStats API", () => {
    it("successfully fetches real prices from Robinhood Lighter", async () => {
      const prices = await fetchExchangeStats("rh");
      expect(prices.size).toBeGreaterThan(50);
      const xau = prices.get("XAU");
      expect(xau).toBeDefined();
      expect(xau!.price).toBeGreaterThan(1000);
    }, 10000);

    it("successfully fetches real prices from Mainnet Lighter", async () => {
      const prices = await fetchExchangeStats("mainnet");
      expect(prices.size).toBeGreaterThan(50);
      const eth = prices.get("ETH");
      expect(eth).toBeDefined();
      expect(eth!.price).toBeGreaterThan(1000);
    }, 10000);
  });

  describe("Scaling Optimizations", () => {
    it("findMarketPrice strips separators (- / _) without RegExp", () => {
      const map = new Map<string, MarketPriceSnapshot>([
        ["ETH", { symbol: "ETH", price: 3500, dailyChange: 0 }],
        ["BTC", { symbol: "BTC", price: 65000, dailyChange: 0 }],
      ]);
      expect(findMarketPrice(map, "ETH-PERP")?.price).toBe(3500);
      expect(findMarketPrice(map, "BTC/USDC")?.price).toBe(65000);
      expect(findMarketPrice(map, "ETH_USDC")?.price).toBe(3500);
    });

    it("correctly sorts candidate alerts by urgency ratio descending", () => {
      const candidates = [
        { symbol: "BTC", absDelta: 0.6, threshold: 0.5, urgency: 0.6 / 0.5 }, // 1.2
        { symbol: "SOL", absDelta: 2.5, threshold: 1.0, urgency: 2.5 / 1.0 }, // 2.5 (highest)
        { symbol: "XAU", absDelta: 0.8, threshold: 0.4, urgency: 0.8 / 0.4 }, // 2.0
      ];

      candidates.sort((a, b) => b.urgency - a.urgency);

      expect(candidates[0].symbol).toBe("SOL");
      expect(candidates[1].symbol).toBe("XAU");
      expect(candidates[2].symbol).toBe("BTC");
    });

    describe("Reverse Indexing (getMovedSymbols)", () => {
      it("warms up reference cache on cold start without full sweep", () => {
        resetPriceReferenceCache();
        const snapshots = new Map<LighterNetwork, Map<string, MarketPriceSnapshot>>([
          ["rh", new Map([["XAU", { symbol: "XAU", price: 4200.0, dailyChange: 0 }]])],
          ["mainnet", new Map([["BTC", { symbol: "BTC", price: 60000.0, dailyChange: 0 }]])],
        ]);

        const res = getMovedSymbols(snapshots, 1000);
        expect(res.isFullSweep).toBe(false);
        expect(res.movedSymbols.length).toBe(0);
      });

      it("filters out stationary assets and only detects assets with move >= 0.05%", () => {
        // Reference prices are XAU = 4200, BTC = 60000 at t = 1000
        const snapshots = new Map<LighterNetwork, Map<string, MarketPriceSnapshot>>([
          ["rh", new Map([["XAU", { symbol: "XAU", price: 4201.0, dailyChange: 0 }]])], // +0.0238% (< 0.05%)
          ["mainnet", new Map([["BTC", { symbol: "BTC", price: 60060.0, dailyChange: 0 }]])], // +0.10% (>= 0.05%)
        ]);

        const res = getMovedSymbols(snapshots, 1060); // 1 minute later
        expect(res.isFullSweep).toBe(false);
        expect(res.movedSymbols).toContain("BTC");
        expect(res.movedSymbols).not.toContain("XAU");
      });

      it("triggers symbol recheck when maxAgeSeconds (10m) is exceeded", () => {
        // XAU has been stationary for 601 seconds (at t = 1601)
        const snapshots = new Map<LighterNetwork, Map<string, MarketPriceSnapshot>>([
          ["rh", new Map([["XAU", { symbol: "XAU", price: 4202.0, dailyChange: 0 }]])], // unchanged from previous
        ]);

        const res = getMovedSymbols(snapshots, 1601);
        expect(res.isFullSweep).toBe(false);
        expect(res.movedSymbols).toContain("XAU");
      });

      it("safely handles filterSymbols with > 50 symbols without exceeding SQLite parameter limits", async () => {
        let preparedSql = "";
        let boundParams: any[] = [];
        const mockDb: any = {
          prepare: (sql: string) => {
            preparedSql = sql;
            return {
              bind: (...args: any[]) => {
                boundParams = args;
                return {
                  all: async () => ({ results: [] }),
                };
              },
              all: async () => ({
                results: [
                  { symbol: "BTC", last_price: 60000 },
                  { symbol: "DOGE", last_price: 0.1 },
                  { symbol: "NEW", last_price: null },
                ],
              }),
            };
          },
        };

        const bigList = Array.from({ length: 250 }, (_, i) => `TOKEN_${i}`);
        bigList.push("BTC");

        const res = await getActivePositionsForMonitoring(mockDb, bigList);
        expect(preparedSql.includes("WHERE aop.symbol IN")).toBe(false);
        expect(boundParams.length).toBe(0);
        expect(res.map((r) => r.symbol)).toEqual(["BTC", "NEW"]);
      });
    });
  });
});
