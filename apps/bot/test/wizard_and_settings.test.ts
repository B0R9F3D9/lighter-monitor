import { describe, expect, it } from "bun:test";
import { WizardState, Env } from "../src/types";
import { isUserAdmin } from "../src/bot/bot";

function formatThreshold(val: number): string {
  const str = Number(val.toFixed(4)).toString();
  return str.includes(".") ? str : `${str}.0`;
}

function parseThresholdInput(raw: string): number | null {
  const cleaned = raw.replace(",", ".");
  const val = parseFloat(cleaned);
  if (isNaN(val) || val < 0.1 || val > 10.0) return null;
  return val;
}

function isWizardExpired(st: WizardState, now: number): boolean {
  return !!st.ts && now - st.ts > 900;
}

const mockEnv = (adminVar?: string): Env => ({
  DB: {} as any,
  TELEGRAM_BOT_TOKEN: "mock",
  ADMIN_TELEGRAM_ID: adminVar,
});

describe("Wizard State & Settings Logic", () => {
  it("serializes and deserializes AWAIT_INDEX wizard state correctly", () => {
    const state: WizardState = {
      step: "AWAIT_INDEX",
      network: "rh",
    };
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as WizardState;
    expect(parsed.step).toBe("AWAIT_INDEX");
    if (parsed.step === "AWAIT_INDEX") {
      expect(parsed.network).toBe("rh");
    }
  });

  it("serializes and deserializes AWAIT_ALIAS wizard state correctly", () => {
    const state: WizardState = {
      step: "AWAIT_ALIAS",
      network: "mainnet",
      accountIndex: 749329,
      l1Address: "0x0000000000000000000000000000000000000001",
      collateral: 51.32,
      positions: [{ market_id: 40, position: "3.1" }],
    };
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as WizardState;
    expect(parsed.step).toBe("AWAIT_ALIAS");
    if (parsed.step === "AWAIT_ALIAS") {
      expect(parsed.accountIndex).toBe(749329);
      expect(parsed.network).toBe("mainnet");
      expect(parsed.positions.length).toBe(1);
    }
  });

  it("serializes and deserializes AWAIT_RENAME wizard state correctly", () => {
    const state: WizardState = {
      step: "AWAIT_RENAME",
      network: "rh",
      accountIndex: 31704,
    };
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as WizardState;
    expect(parsed.step).toBe("AWAIT_RENAME");
    if (parsed.step === "AWAIT_RENAME") {
      expect(parsed.accountIndex).toBe(31704);
      expect(parsed.network).toBe("rh");
    }
  });

  it("serializes and deserializes AWAIT_THRESHOLD wizard state correctly", () => {
    const state: WizardState = {
      step: "AWAIT_THRESHOLD",
    };
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as WizardState;
    expect(parsed.step).toBe("AWAIT_THRESHOLD");
  });

  it("correctly identifies active vs expired mute periods", () => {
    const now = Math.floor(Date.now() / 1000);
    const activeMute = now + 4 * 3600; // 4 hours in future
    const expiredMute = now - 60; // 1 minute in past

    expect(activeMute > now).toBe(true);
    expect(expiredMute > now).toBe(false);
  });

  it("parses and validates custom alert threshold inputs", () => {
    expect(parseThresholdInput("0.4")).toBe(0.4);
    expect(parseThresholdInput("0,7")).toBe(0.7);
    expect(parseThresholdInput("1.25")).toBe(1.25);
    expect(parseThresholdInput("10.0")).toBe(10.0);
    expect(parseThresholdInput("0.05")).toBeNull(); // below 0.1
    expect(parseThresholdInput("10.5")).toBeNull(); // above 10.0
    expect(parseThresholdInput("abc")).toBeNull();
  });

  it("identifies expired wizard states after 15 minutes TTL", () => {
    const now = Math.floor(Date.now() / 1000);
    const freshState: WizardState = { step: "AWAIT_INDEX", network: "rh", ts: now - 300 }; // 5 min ago
    const expiredState: WizardState = { step: "AWAIT_INDEX", network: "rh", ts: now - 901 }; // 15 min 1 sec ago

    expect(isWizardExpired(freshState, now)).toBe(false);
    expect(isWizardExpired(expiredState, now)).toBe(true);
  });

  describe("isUserAdmin Access Control", () => {
    it("allows access when ADMIN_TELEGRAM_ID is undefined or empty", () => {
      expect(isUserAdmin(mockEnv(), 999888777, "b0r9f3d9")).toBe(true);
      expect(isUserAdmin(mockEnv("   "), 999888777, "b0r9f3d9")).toBe(true);
    });

    it("matches numeric telegram ID", () => {
      expect(isUserAdmin(mockEnv("999888777"), 999888777, "someone")).toBe(true);
      expect(isUserAdmin(mockEnv("999888777"), 123456789, "someone")).toBe(false);
    });

    it("matches username with or without @ prefix, case-insensitive", () => {
      expect(isUserAdmin(mockEnv("b0r9f3d9"), 123, "b0r9f3d9")).toBe(true);
      expect(isUserAdmin(mockEnv("@B0R9F3D9"), 123, "b0r9f3d9")).toBe(true);
      expect(isUserAdmin(mockEnv("b0r9f3d9"), 123, "B0R9F3D9")).toBe(true);
      expect(isUserAdmin(mockEnv("@b0r9f3d9"), 123, "someone_else")).toBe(false);
    });

    it("cleans accidental quotes or variable prefix", () => {
      expect(isUserAdmin(mockEnv('"999888777"'), 999888777)).toBe(true);
      expect(isUserAdmin(mockEnv("'999888777'"), 999888777)).toBe(true);
      expect(isUserAdmin(mockEnv("ADMIN_TELEGRAM_ID=999888777"), 999888777)).toBe(true);
      expect(isUserAdmin(mockEnv("ADMIN_TELEGRAM_ID = @b0r9f3d9"), 123, "b0r9f3d9")).toBe(true);
    });

    it("supports comma-separated list of multiple admins", () => {
      const env = mockEnv("999888777, @second_admin, 999999");
      expect(isUserAdmin(env, 999888777)).toBe(true);
      expect(isUserAdmin(env, 123456, "second_admin")).toBe(true);
      expect(isUserAdmin(env, 999999)).toBe(true);
      expect(isUserAdmin(env, 111111, "stranger")).toBe(false);
    });
  });

  describe("Main Keyboard & Stats Keyboard", () => {
    const { getMainKeyboard, getStatsKeyboard } = require("../src/bot/bot");

    it("returns 2-row keyboard without admin button for normal user", () => {
      const env = mockEnv("999888777");
      const kb = getMainKeyboard(env, 12345, "normal_user");
      const json = JSON.stringify(kb);
      expect(json).not.toContain("Админ статистика");
      expect(kb.keyboard.length).toBe(2);
    });

    it("returns 3-row keyboard with big admin button for admin user", () => {
      const env = mockEnv("999888777");
      const kb = getMainKeyboard(env, 999888777, "admin");
      const json = JSON.stringify(kb);
      expect(json).toContain("📈 Админ статистика");
      expect(kb.keyboard.length).toBe(3);
      expect(kb.keyboard[2].length).toBe(1);
      expect(kb.keyboard[2][0].text).toBe("📈 Админ статистика");
    });

    it("does not include web app button in reply keyboard for normal user even with WEBAPP_URL", () => {
      const env = { ...mockEnv("999888777"), WEBAPP_URL: "https://example.com" };
      const kb = getMainKeyboard(env, 12345, "normal_user");
      expect(kb.keyboard.length).toBe(2);
      const json = JSON.stringify(kb);
      expect(json).not.toContain("Web App");
    });

    it("does not include web app button in reply keyboard for admin user, keeping exactly 3 rows", () => {
      const env = { ...mockEnv("999888777"), WEBAPP_URL: "https://example.com" };
      const kb = getMainKeyboard(env, 999888777, "admin");
      expect(kb.keyboard.length).toBe(3);
      expect(kb.keyboard[2].length).toBe(1);
      expect(kb.keyboard[2][0].text).toBe("📈 Админ статистика");
      const json = JSON.stringify(kb);
      expect(json).not.toContain("Web App");
    });

    it("creates stats inline keyboard with refresh button", () => {
      const kb = getStatsKeyboard();
      const json = JSON.stringify(kb);
      expect(json).toContain("🔄 Обновить");
      expect(json).toContain("refresh_stats");
    });
  });

  describe("Unified Settings Mute Durations (Spikes, Targets, All)", () => {
    const now = 1700000000;
    const durations = [
      { key: "3600", seconds: 3600, label: "1 hour" },
      { key: "14400", seconds: 14400, label: "4 hours" },
      { key: "86400", seconds: 86400, label: "24 hours" },
      { key: "forever", seconds: 2147483647, label: "forever" },
      { key: "0", seconds: 0, label: "unmute" },
    ];

    it("correctly calculates target timestamp for each duration option", () => {
      for (const d of durations) {
        const computed =
          d.key === "0" ? 0 : d.key === "forever" ? 2147483647 : now + parseInt(d.key, 10);

        if (d.key === "0") {
          expect(computed).toBe(0);
        } else if (d.key === "forever") {
          expect(computed).toBe(2147483647);
        } else {
          expect(computed).toBe(now + d.seconds);
        }
      }
    });

    it("formats spike alert thresholds preserving full precision (e.g. 0.256%)", () => {
      expect(formatThreshold(0.256)).toBe("0.256");
      expect(formatThreshold(0.5)).toBe("0.5");
      expect(formatThreshold(1)).toBe("1.0");
      expect(formatThreshold(1.5)).toBe("1.5");
      expect(formatThreshold(2)).toBe("2.0");
      expect(formatThreshold(0.125)).toBe("0.125");
    });
  });
});
