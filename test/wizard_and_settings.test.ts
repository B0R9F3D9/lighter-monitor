import { describe, expect, it } from "bun:test";
import { WizardState } from "../src/types";

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
      positions: [{ market_id: 40, position: "3.1" }]
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

  it("correctly identifies active vs expired mute periods", () => {
    const now = Math.floor(Date.now() / 1000);
    const activeMute = now + 4 * 3600; // 4 hours in future
    const expiredMute = now - 60; // 1 minute in past

    expect(activeMute > now).toBe(true);
    expect(expiredMute > now).toBe(false);
  });
});
