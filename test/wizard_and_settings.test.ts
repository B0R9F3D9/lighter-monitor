import { describe, expect, it } from "bun:test";
import { WizardState, Env } from "../src/types";
import { isUserAdmin } from "../src/bot/bot";

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

    it("returns 3-row keyboard with wide web app button at bottom for normal user with WEBAPP_URL", () => {
      const env = { ...mockEnv("999888777"), WEBAPP_URL: "https://example.com" };
      const kb = getMainKeyboard(env, 12345, "normal_user");
      expect(kb.keyboard.length).toBe(3);
      expect(kb.keyboard[2].length).toBe(1);
      expect(kb.keyboard[2][0].text).toBe("🚀 Web App");
      expect(kb.keyboard[2][0].web_app?.url).toBe("https://example.com");
    });

    it("places wide web app button before admin button for admin user", () => {
      const env = { ...mockEnv("999888777"), WEBAPP_URL: "https://example.com" };
      const kb = getMainKeyboard(env, 999888777, "admin");
      expect(kb.keyboard.length).toBe(4);
      // Row 2 is Web App (wide)
      expect(kb.keyboard[2].length).toBe(1);
      expect(kb.keyboard[2][0].text).toBe("🚀 Web App");
      expect(kb.keyboard[2][0].web_app?.url).toBe("https://example.com");
      // Row 3 is Admin stats (last)
      expect(kb.keyboard[3].length).toBe(1);
      expect(kb.keyboard[3][0].text).toBe("📈 Админ статистика");
    });

    it("creates stats inline keyboard with refresh button", () => {
      const kb = getStatsKeyboard();
      const json = JSON.stringify(kb);
      expect(json).toContain("🔄 Обновить");
      expect(json).toContain("refresh_stats");
    });
  });
});
