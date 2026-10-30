import { describe, expect, it } from "bun:test";
import { formatTicksWord, formatSpreadAlert } from "../src/bot/formatters";
import { getUserSettings, setUserTargetHitsThreshold } from "../src/db/queries";
import { SpreadAlertParams, SPREAD_DIRECTIONS, SPREAD_UNITS } from "../src/types";

describe("Target Hits Threshold Feature", () => {
  describe("formatTicksWord Helper", () => {
    it("correctly inflects Russian tick words", () => {
      expect(formatTicksWord(1)).toBe("тик");
      expect(formatTicksWord(2)).toBe("тика");
      expect(formatTicksWord(3)).toBe("тика");
      expect(formatTicksWord(4)).toBe("тика");
      expect(formatTicksWord(5)).toBe("тиков");
      expect(formatTicksWord(10)).toBe("тиков");
      expect(formatTicksWord(11)).toBe("тиков");
      expect(formatTicksWord(12)).toBe("тиков");
      expect(formatTicksWord(14)).toBe("тиков");
      expect(formatTicksWord(20)).toBe("тиков");
      expect(formatTicksWord(21)).toBe("тик");
      expect(formatTicksWord(22)).toBe("тика");
      expect(formatTicksWord(25)).toBe("тиков");
    });
  });

  describe("formatSpreadAlert with Consecutive Hits Footnote", () => {
    const baseParams: SpreadAlertParams = {
      targetId: 10,
      symbol: "SPY",
      direction: SPREAD_DIRECTIONS.RH_CHEAPER,
      targetDelta: 0.25,
      unit: SPREAD_UNITS.USD,
      rhPrice: 600.1,
      corePrice: 600.4,
      actualDiff: 0.3,
      basisSigned: -0.3,
      basisBps: -5.0,
    };

    it("formats 1 tick as instant alert with once-per-minute cron explanation", () => {
      const text = formatSpreadAlert({
        ...baseParams,
        confirmedTicks: 1,
        minTicks: 1,
      });
      expect(text).toContain("Моментальный алерт (1 тик, крон 1 раз/мин)");
    });

    it("formats 3 ticks as confirmed with inflection and cron note", () => {
      const text = formatSpreadAlert({
        ...baseParams,
        confirmedTicks: 3,
        minTicks: 3,
      });
      expect(text).toContain("Подтверждено: 3 тика подряд (крон 1 раз/мин)");
    });

    it("formats 5 ticks as confirmed with inflection and cron note", () => {
      const text = formatSpreadAlert({
        ...baseParams,
        confirmedTicks: 5,
        minTicks: 5,
      });
      expect(text).toContain("Подтверждено: 5 тиков подряд (крон 1 раз/мин)");
    });
  });

  describe("DB User Settings Target Hits Threshold", () => {
    it("getUserSettings defaults targetHitsThreshold to 3 when null in DB", async () => {
      const mockDb: any = {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              alert_threshold: 0.5,
              muted_until: 0,
              spread_muted_until: 0,
              updates_muted_until: 0,
              target_hits_threshold: null,
            }),
          }),
        }),
      };

      const settings = await getUserSettings(mockDb, 123456);
      expect(settings.targetHitsThreshold).toBe(3);
    });

    it("getUserSettings returns custom targetHitsThreshold when set in DB", async () => {
      const mockDb: any = {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              alert_threshold: 0.5,
              muted_until: 0,
              spread_muted_until: 0,
              updates_muted_until: 0,
              target_hits_threshold: 5,
            }),
          }),
        }),
      };

      const settings = await getUserSettings(mockDb, 123456);
      expect(settings.targetHitsThreshold).toBe(5);
    });

    it("setUserTargetHitsThreshold updates target_hits_threshold in DB", async () => {
      let executedSql = "";
      let boundParams: any[] = [];

      const mockDb: any = {
        prepare: (sql: string) => ({
          bind: (...params: any[]) => {
            executedSql = sql;
            boundParams = params;
            return {
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        }),
      };

      await setUserTargetHitsThreshold(mockDb, 999888, 2);
      expect(executedSql).toContain(
        "UPDATE users SET target_hits_threshold = ? WHERE telegram_id = ?",
      );
      expect(boundParams).toEqual([2, 999888]);
    });
  });
});
