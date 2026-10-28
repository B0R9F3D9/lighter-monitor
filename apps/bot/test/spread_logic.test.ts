import { describe, expect, it } from "bun:test";
import {
  formatSpreadAlert,
  getSpreadAlertKeyboard,
  formatSpreadHubView,
} from "../src/bot/formatters";
import { SpreadAlertParams, SpreadTargetRow } from "../src/types";
import { CONFIG } from "../src/config";

describe("Spread Alert Logic & State Machine", () => {
  describe("Direction Calculations", () => {
    it("evaluates rh_cheaper (Core > RH) correctly", () => {
      const corePrice = 601.35;
      const rhPrice = 601.18;
      const actualDiffUsd = corePrice - rhPrice; // 0.17
      const targetDelta = 0.15;

      expect(actualDiffUsd).toBeGreaterThanOrEqual(targetDelta);
    });

    it("evaluates rh_expensive (RH > Core) correctly", () => {
      const corePrice = 601.18;
      const rhPrice = 601.35;
      const actualDiffUsd = rhPrice - corePrice; // 0.17
      const targetDelta = 0.15;

      expect(actualDiffUsd).toBeGreaterThanOrEqual(targetDelta);
    });
  });

  describe("Hysteresis State Machine (Armed / Re-arm)", () => {
    it("triggers alert when armed=1 and metric >= target", () => {
      const target: Partial<SpreadTargetRow> = {
        target_delta: 0.15,
        unit: "usd",
        armed: 1,
        is_active: 1,
      };

      const metric = 0.17; // спред пробил 0.15
      const shouldFire = target.armed === 1 && metric >= target.target_delta!;
      expect(shouldFire).toBe(true);
    });

    it("does NOT trigger when already triggered (armed=0) and spread stays wide", () => {
      const target: Partial<SpreadTargetRow> = {
        target_delta: 0.15,
        unit: "usd",
        armed: 0, // уже сработал
        is_active: 1,
      };

      const metric = 0.16; // спред все еще выше 0.15
      const shouldFire = target.armed === 1 && metric >= target.target_delta!;
      expect(shouldFire).toBe(false);

      // Проверяем, взводится ли он при 0.16 (порог re-arm: 0.15 * 0.8 = 0.12)
      const shouldRearm = metric <= target.target_delta! * CONFIG.SPREAD_REARM_RATIO;
      expect(shouldRearm).toBe(false);
    });

    it("re-arms when spread retracts below 80% of threshold", () => {
      const target: Partial<SpreadTargetRow> = {
        target_delta: 0.15,
        unit: "usd",
        armed: 0,
        is_active: 1,
      };

      const metric = 0.11; // спред упал до $0.11 (ниже 0.15 * 0.8 = 0.12)
      const shouldRearm = metric <= target.target_delta! * CONFIG.SPREAD_REARM_RATIO;
      expect(shouldRearm).toBe(true);
    });
  });

  describe("formatSpreadAlert", () => {
    it("formats rh_cheaper alert with clear visual distinction", () => {
      const params: SpreadAlertParams = {
        targetId: 1,
        symbol: "SPY",
        direction: "rh_cheaper",
        targetDelta: 0.15,
        unit: "usd",
        rhPrice: 601.18,
        corePrice: 601.35,
        actualDiff: 0.17,
        basisSigned: -0.17,
        basisBps: -2.83,
      };

      const formatted = formatSpreadAlert(params);
      expect(formatted).toContain("🎯 <b>SPY • Таргет достигнут!</b>");
      expect(formatted).not.toContain("SPREAD TARGET");
      expect(formatted).toContain("🟢 <b>Условие:</b> RH &lt; Core на ≥$0.150");
      expect(formatted).toContain("601.18");
      expect(formatted).toContain("601.35");
      expect(formatted).toContain("-$0.170");
      expect(formatted).toContain("-2.83 bps");
      expect(formatted).not.toContain("по последней сделке");
    });

    it("formats rh_expensive alert with clear visual distinction", () => {
      const params: SpreadAlertParams = {
        targetId: 2,
        symbol: "SPY",
        direction: "rh_expensive",
        targetDelta: 5.0,
        unit: "bps",
        rhPrice: 601.55,
        corePrice: 601.2,
        actualDiff: 0.35,
        basisSigned: 0.35,
        basisBps: 5.82,
      };

      const formatted = formatSpreadAlert(params);
      expect(formatted).toContain("🎯 <b>SPY • Таргет достигнут!</b>");
      expect(formatted).not.toContain("SPREAD TARGET");
      expect(formatted).toContain("🔵 <b>Условие:</b> RH &gt; Core на ≥5.0 bps");
      expect(formatted).toContain("601.55");
      expect(formatted).toContain("601.20");
      expect(formatted).toContain("+5.82 bps");
      expect(formatted).not.toContain("по последней сделке");
    });

    it("formats alert with executable orderbook legs and compact mobile numbers", () => {
      const params: SpreadAlertParams = {
        targetId: 3,
        symbol: "SPY",
        direction: "rh_cheaper",
        targetDelta: 1.0,
        unit: "bps",
        rhPrice: 774.36,
        corePrice: 774.26,
        actualDiff: 0.1,
        basisSigned: -0.1,
        basisBps: -1.25,
        confirmedTicks: 3,
        minTicks: 3,
        orderBook: {
          rhPrice: 774.36,
          rhSize: 1.9,
          rhType: "Ask",
          corePrice: 774.26,
          coreSize: 45.3,
          coreType: "Bid",
          execBps: -1.25,
          execUsd: -0.097,
        },
      };

      const formatted = formatSpreadAlert(params);
      expect(formatted).toContain("🎯 <b>SPY • Таргет достигнут!</b>");
      expect(formatted).not.toContain("Подтверждён");
      expect(formatted).toContain("🟢 <b>Условие:</b> RH &lt; Core на ≥1.0 bps");
      expect(formatted).toContain(
        "📊 <b>Исполняемый спред стакана:</b> <code>-1.25 bps</code> (<code>-$0.097</code>)",
      );
      expect(formatted).toContain("• 🟠 RH Ask: $774.36 (объём: 1.9 SPY / $1.5K)");
      expect(formatted).toContain("• ⚡️ Core Bid: $774.26 (объём: 45.3 SPY / $35K)");
      expect(formatted).not.toContain("SPREAD TARGET");
    });
  });

  describe("getSpreadAlertKeyboard", () => {
    it("generates 2x2 inline keyboard with token-level mute buttons", () => {
      const kb = getSpreadAlertKeyboard(42, "SPY");
      expect(kb.inline_keyboard.length).toBe(2);

      const row1 = kb.inline_keyboard[0]!;
      expect(row1.length).toBe(2);
      expect(row1[0]!.text).toBe("🔕 1ч");
      expect((row1[0] as any).callback_data).toBe("sp_sym_mute:SPY:3600");
      expect(row1[1]!.text).toBe("🔕 4ч");
      expect((row1[1] as any).callback_data).toBe("sp_sym_mute:SPY:14400");

      const row2 = kb.inline_keyboard[1]!;
      expect(row2.length).toBe(2);
      expect(row2[0]!.text).toBe("🔕 24ч");
      expect((row2[0] as any).callback_data).toBe("sp_sym_mute:SPY:86400");
      expect(row2[1]!.text).toBe("⏸ Выкл");
      expect((row2[1] as any).callback_data).toBe("sp_sym_mute:SPY:off");
    });
  });

  describe("formatSpreadHubView", () => {
    it("formats targets with calculated cents in parentheses and clean status", () => {
      const targets: SpreadTargetRow[] = [
        {
          id: 1,
          telegram_id: 12345,
          symbol: "SPY",
          direction: "rh_cheaper",
          target_delta: 2.0,
          unit: "bps",
          is_active: 1,
          armed: 1,
          muted_until: 0,
          last_alerted_at: 0,
          last_spread: null,
          created_at: 0,
        },
        {
          id: 2,
          telegram_id: 12345,
          symbol: "SPY",
          direction: "rh_expensive",
          target_delta: 3.0,
          unit: "bps",
          is_active: 1,
          armed: 1,
          muted_until: 0,
          last_alerted_at: 0,
          last_spread: null,
          created_at: 0,
        },
        {
          id: 3,
          telegram_id: 12345,
          symbol: "SPY",
          direction: "rh_cheaper",
          target_delta: 5.0,
          unit: "bps",
          is_active: 0,
          armed: 1,
          muted_until: 0,
          last_alerted_at: 0,
          last_spread: null,
          created_at: 0,
        },
      ];

      const quotes = new Map<string, { rhPrice: number; corePrice: number }>();
      quotes.set("SPY", { rhPrice: 772.1, corePrice: 772.23 });

      const text = formatSpreadHubView(targets, quotes, false, 1700000000);

      // Verify cents formatting in parentheses with directional sign
      expect(text).toContain("≥2.0 bps (-$0.154)");
      expect(text).toContain("≥3.0 bps (+$0.232)");

      // Active targets do NOT show [Активен], stopped targets show [⏸ Выключен]
      expect(text).not.toContain("Активен");
      expect(text).toContain("[⏸ Выключен]");

      // Verify no summary totals or caps lock
      expect(text).not.toContain("ИТОГО");
      expect(text).not.toContain("ДЕШЕВЛЕ");
      expect(text).not.toContain("ДОРОЖЕ");

      // Verify symbol and prices
      expect(text).toContain("<b>SPY</b> • Базис:");
      expect(text).not.toContain("RH ↔ Core");
      expect(text).not.toContain("📐 SPY");
      expect(text).toContain("• 🟠 RH: $772.10\n• ⚡️ Core: $772.23");
      expect(text).not.toContain("Цены:");
      expect(text).toContain("Обновлено:");
    });

    it("displays global mute notice when _isMutedAll is true", () => {
      const targets: SpreadTargetRow[] = [
        {
          id: 1,
          telegram_id: 12345,
          symbol: "SPY",
          direction: "rh_cheaper",
          target_delta: 2.0,
          unit: "bps",
          is_active: 1,
          armed: 1,
          muted_until: 0,
          last_alerted_at: 0,
          last_spread: null,
          created_at: 0,
        },
      ];
      const quotes = new Map<string, { rhPrice: number; corePrice: number }>();
      quotes.set("SPY", { rhPrice: 772.1, corePrice: 772.23 });

      const text = formatSpreadHubView(targets, quotes, true, 1700000000);
      expect(text).toContain("🔕 <i>Все таргеты спреда заглушены в настройках.</i>");
    });

    it("displays symbol-level mute badges correctly", () => {
      const targets: SpreadTargetRow[] = [
        {
          id: 1,
          telegram_id: 12345,
          symbol: "SPY",
          direction: "rh_cheaper",
          target_delta: 2.0,
          unit: "bps",
          is_active: 1,
          armed: 1,
          muted_until: 0,
          symbol_muted_until: 1700003600, // muted for 1 hour
          last_alerted_at: 0,
          last_spread: null,
          created_at: 0,
        },
        {
          id: 2,
          telegram_id: 12345,
          symbol: "QQQ",
          direction: "rh_cheaper",
          target_delta: 3.0,
          unit: "bps",
          is_active: 1,
          armed: 1,
          muted_until: 0,
          symbol_muted_until: 2147483647, // muted forever
          last_alerted_at: 0,
          last_spread: null,
          created_at: 0,
        },
      ];
      const quotes = new Map<string, { rhPrice: number; corePrice: number }>();
      quotes.set("SPY", { rhPrice: 772.1, corePrice: 772.23 });
      quotes.set("QQQ", { rhPrice: 722.5, corePrice: 722.5 });

      const text = formatSpreadHubView(targets, quotes, false, 1700000000);
      expect(text).toContain("[🔕 еще 60м]");
      expect(text).toContain("[⏸ Выключен]");
    });
  });

  describe("Multi-Target Deduplication & Subrequest Protection", () => {
    it("deduplicates multiple triggered targets for the same user, symbol, and direction", () => {
      // User set targets at 2 bps, 5 bps, and 10 bps. Market jumped to 12 bps.
      const candidates: Array<{
        target: any;
        corePrice: number;
        metric: number;
        shadowed?: any[];
      }> = [
        {
          target: {
            id: 101,
            telegram_id: 111,
            symbol: "SPY",
            direction: "rh_cheaper",
            target_delta: 2.0,
            unit: "bps",
          },
          corePrice: 770.0,
          metric: 12.0,
        },
        {
          target: {
            id: 102,
            telegram_id: 111,
            symbol: "SPY",
            direction: "rh_cheaper",
            target_delta: 10.0,
            unit: "bps",
          },
          corePrice: 770.0,
          metric: 12.0,
        },
        {
          target: {
            id: 103,
            telegram_id: 111,
            symbol: "SPY",
            direction: "rh_cheaper",
            target_delta: 5.0,
            unit: "bps",
          },
          corePrice: 770.0,
          metric: 12.0,
        },
        // Different user is preserved
        {
          target: {
            id: 104,
            telegram_id: 222,
            symbol: "SPY",
            direction: "rh_cheaper",
            target_delta: 4.0,
            unit: "bps",
          },
          corePrice: 770.0,
          metric: 12.0,
        },
      ];

      const bestBySymbolDir = new Map<string, any>();

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        const key = `${c.target.telegram_id}:${c.target.symbol}:${c.target.direction}`;
        const existing = bestBySymbolDir.get(key);
        if (!existing) {
          c.shadowed = [];
          bestBySymbolDir.set(key, c);
        } else {
          const cBps =
            c.target.unit === "bps"
              ? c.target.target_delta
              : (c.target.target_delta / c.corePrice) * 10000;
          const exBps =
            existing.target.unit === "bps"
              ? existing.target.target_delta
              : (existing.target.target_delta / existing.corePrice) * 10000;
          if (cBps >= exBps) {
            const prevShadowed = existing.shadowed || [];
            existing.shadowed = undefined;
            c.shadowed = [existing, ...prevShadowed];
            bestBySymbolDir.set(key, c);
          } else {
            existing.shadowed = existing.shadowed || [];
            existing.shadowed.push(c);
          }
        }
      }

      const deduplicated = Array.from(bestBySymbolDir.values());

      // Only 2 alerts to send (1 for user 111 @ 10 bps, 1 for user 222 @ 4 bps)
      expect(deduplicated.length).toBe(2);
      const user111Winner = deduplicated.find((c) => c.target.telegram_id === 111);
      expect(user111Winner?.target.id).toBe(102);
      expect(deduplicated.find((c) => c.target.telegram_id === 222)?.target.id).toBe(104);

      // Shadowed targets contains 2 bps and 5 bps attached to winner for disarming only on send success
      expect(user111Winner?.shadowed?.length).toBe(2);
      expect(user111Winner?.shadowed?.map((s: any) => s.target.id).toSorted()).toEqual([101, 103]);
    });
  });
});
