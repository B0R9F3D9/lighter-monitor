import { describe, it, expect } from "bun:test";
import { getSmartCooldownSeconds } from "../src/cron/monitor";
import { findMarketPrice, fetchExchangeStats } from "../src/lighter/api";
import { formatPriceStepAlert } from "../src/bot/formatters";
import { MarketPriceSnapshot, PriceStepAlertParams } from "../src/types";

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
  });

  describe("formatPriceStepAlert (3-Layer Alert)", () => {
    it("formats 3 layers correctly for LONG moving down into drawdown", () => {
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

      // Header
      expect(text).toContain("⚡️ <b>Движение XAU [RH]</b>");
      expect(text).toContain("💼 Аккаунт: <b>#31704 (Основной)</b>");
      expect(text).toContain("📊 Позиция: <b>🟢 LONG XAU</b> (Вход: $4,280.00)");

      // Layer 1: Impulse
      expect(text).toContain("1️⃣ <b>Локальный импульс:</b>");
      expect(text).toContain("• С прошлой засечки: <b>↘️ -0.47% ($4,280.00 ➔ $4,260.00)</b> 🔴 <i>В просадку</i>");

      // Layer 2: Global State
      expect(text).toContain("2️⃣ <b>Глобальное состояние позиции:</b>");
      expect(text).toContain("• Ход от точки входа: <b>-0.47%</b> (🔴 <i>В просадку</i>)");
      expect(text).toContain("• Текущий UnPnL: 📉 <b>-$115.00</b>");

      // Layer 3: Safety / Liquidation
      expect(text).toContain("3️⃣ <b>Запас прочности (безопасность):</b>");
      expect(text).toContain("• Цена ликвидации: <b>$4,168.30</b>");
      expect(text).toContain("• До ликвидации осталось: <b>2.15%</b> ⚠️ <b>[ОПАСНО]</b>");
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

      // Impulse shows upward step
      expect(text).toContain("• С прошлой засечки: <b>↗️ +0.47% ($4,260.00 ➔ $4,280.00)</b> 🟢 <i>В плюс</i>");

      // Global state shows break-even!
      expect(text).toContain("• Ход от точки входа: <b>0.00%</b> (⚪️ <i>Безубыток</i>)");
      expect(text).toContain("• Текущий UnPnL: 📈 <b>+$0.00</b>");
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
      expect(profitText).toContain("🔴 SHORT ETH");
      expect(profitText).toContain("🟢 <i>В плюс</i>");
      expect(profitText).toContain("+$250.00");

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
      expect(lossText).toContain("🔴 <i>В просадку</i>");
      expect(lossText).toContain("-$250.00");
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
});
