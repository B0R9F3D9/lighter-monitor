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
      expect(formatted).toContain("SPREAD TARGET: SPY");
      expect(formatted).toContain("🟢 <b>RH &lt; Core</b>");
      expect(formatted).toContain("601.18");
      expect(formatted).toContain("601.35");
      expect(formatted).toContain("-$0.170");
      expect(formatted).toContain("-2.83 bps");
      expect(formatted).toContain("$0.150");
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
      expect(formatted).toContain("SPREAD TARGET: SPY");
      expect(formatted).toContain("🔵 <b>RH &gt; Core</b>");
      expect(formatted).toContain("5.0 bps");
      expect(formatted).toContain("+5.82 bps");
      expect(formatted).not.toContain("по последней сделке");
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
});
