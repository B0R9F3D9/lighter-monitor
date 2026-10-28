import { describe, expect, it } from "bun:test";
import {
  computeSpreadBasis,
  formatPriceFine,
  parseSpreadThresholdInput,
  isMuted,
  formatMuteStatus,
} from "../src/lighter/math";
import { CONFIG } from "../src/config";

describe("Spread Math & BPS Presets", () => {
  describe("computeSpreadBasis", () => {
    it("calculates positive basis when RH is more expensive than Core", () => {
      // RH: 601.35, Core: 601.18 -> Basis: +$0.17
      const { basisUsd, basisBps } = computeSpreadBasis(601.35, 601.18);
      expect(basisUsd).toBeCloseTo(0.17, 3);
      expect(basisBps).toBeCloseTo((0.17 / 601.18) * 10000, 2);
    });

    it("calculates negative basis when RH is cheaper than Core", () => {
      // RH: 601.01, Core: 601.18 -> Basis: -$0.17
      const { basisUsd, basisBps } = computeSpreadBasis(601.01, 601.18);
      expect(basisUsd).toBeCloseTo(-0.17, 3);
      expect(basisBps).toBeCloseTo((-0.17 / 601.18) * 10000, 2);
    });

    it("handles zero price safely without throwing", () => {
      const { basisUsd, basisBps } = computeSpreadBasis(100, 0);
      expect(basisUsd).toBe(100);
      expect(basisBps).toBe(0);
    });
  });

  describe("formatPriceFine", () => {
    it("formats SPY prices preserving cents up to 4 decimals", () => {
      expect(formatPriceFine(601.18)).toBe("601.18");
      expect(formatPriceFine(601.185)).toBe("601.185");
      expect(formatPriceFine(601.1854)).toBe("601.1854");
    });

    it("formats high value tokens like XAU and BTC with commas and precision", () => {
      expect(formatPriceFine(4282.65)).toBe("4,282.65");
      expect(formatPriceFine(95123.456)).toBe("95,123.456");
    });

    it("formats small price tokens with 6 decimals", () => {
      expect(formatPriceFine(0.023456)).toBe("0.023456");
    });
  });

  describe("parseSpreadThresholdInput", () => {
    it("parses dollars with and without dollar sign and commas", () => {
      expect(parseSpreadThresholdInput("0.15")).toEqual({ value: 0.15, unit: "usd" });
      expect(parseSpreadThresholdInput("$0.15")).toEqual({ value: 0.15, unit: "usd" });
      expect(parseSpreadThresholdInput("0,15")).toEqual({ value: 0.15, unit: "usd" });
      expect(parseSpreadThresholdInput("$1.50")).toEqual({ value: 1.5, unit: "usd" });
    });

    it("parses BPS inputs with 'bps' suffix", () => {
      expect(parseSpreadThresholdInput("5bps")).toEqual({ value: 5, unit: "bps" });
      expect(parseSpreadThresholdInput("5 bps")).toEqual({ value: 5, unit: "bps" });
      expect(parseSpreadThresholdInput("7.5bps")).toEqual({ value: 7.5, unit: "bps" });
      expect(parseSpreadThresholdInput("10 BPS")).toEqual({ value: 10, unit: "bps" });
    });

    it("parses percentage inputs and converts to BPS (0.05% = 5 bps)", () => {
      expect(parseSpreadThresholdInput("0.05%")).toEqual({ value: 5, unit: "bps" });
      expect(parseSpreadThresholdInput("0.1%")).toEqual({ value: 10, unit: "bps" });
    });

    it("rejects invalid, zero, or excessively large numbers", () => {
      expect(parseSpreadThresholdInput("")).toBeNull();
      expect(parseSpreadThresholdInput("abc")).toBeNull();
      expect(parseSpreadThresholdInput("0")).toBeNull();
      expect(parseSpreadThresholdInput("-0.15")).toEqual({ value: 0.15, unit: "usd" }); // converts abs
      // Extreme check with reference price: $400 threshold on $600 SPY is rejected
      expect(parseSpreadThresholdInput("400", 600)).toBeNull();
    });
  });

  describe("Dynamic Cent Calculation for BPS Presets", () => {
    it("calculates accurate cents for SPY ($600)", () => {
      const spyPrice = 600;
      const presets = CONFIG.SPREAD_DEFAULT_BPS_PRESETS; // [1, 2, 3, 5, 7, 10]

      const calculated = presets.map((bps) => {
        const cents = (spyPrice * bps) / 10000;
        return { bps, centsFormatted: cents >= 1 ? cents.toFixed(2) : cents.toFixed(3) };
      });

      expect(calculated[0]).toEqual({ bps: 1, centsFormatted: "0.060" });
      expect(calculated[1]).toEqual({ bps: 2, centsFormatted: "0.120" });
      expect(calculated[2]).toEqual({ bps: 3, centsFormatted: "0.180" });
      expect(calculated[3]).toEqual({ bps: 5, centsFormatted: "0.300" });
      expect(calculated[4]).toEqual({ bps: 7, centsFormatted: "0.420" });
      expect(calculated[5]).toEqual({ bps: 10, centsFormatted: "0.600" });
    });

    it("calculates accurate dollars for XAU ($4,200)", () => {
      const xauPrice = 4200;
      const presets = [2, 3, 5, 7, 10];

      const calculated = presets.map((bps) => {
        const dollars = (xauPrice * bps) / 10000;
        return { bps, dollarsFormatted: dollars.toFixed(2) };
      });

      expect(calculated[0]).toEqual({ bps: 2, dollarsFormatted: "0.84" });
      expect(calculated[1]).toEqual({ bps: 3, dollarsFormatted: "1.26" });
      expect(calculated[2]).toEqual({ bps: 5, dollarsFormatted: "2.10" });
      expect(calculated[3]).toEqual({ bps: 7, dollarsFormatted: "2.94" });
      expect(calculated[4]).toEqual({ bps: 10, dollarsFormatted: "4.20" });
    });
  });

  describe("Mute Helpers", () => {
    const now = 1000000;

    it("detects muted vs unmuted status", () => {
      expect(isMuted(now + 3600, now)).toBe(true);
      expect(isMuted(now - 10, now)).toBe(false);
      expect(isMuted(0, now)).toBe(false);
    });

    it("formats mute label for minutes, hours, and forever", () => {
      expect(formatMuteStatus(now - 10, now)).toBe("Активны 🔔");
      expect(formatMuteStatus(now + 1800, now)).toBe("Заглушены еще 30м 🔕");
      expect(formatMuteStatus(now + 7200, now)).toBe("Заглушены еще 2ч 🔕");
      expect(formatMuteStatus(CONFIG.MUTE_FOREVER_TIMESTAMP, now)).toBe(
        "Выключены (до включения) ⏸",
      );
    });
  });
});
