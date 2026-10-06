import { describe, expect, it } from "bun:test";
import {
  ROBINHOOD_PROMO_START_MS,
  ROBINHOOD_PROMO_TOTAL_WEEKS,
  findPresetById,
  getAllDatePresets,
  getCurrentPromoWeek,
  getPreviousPromoWeek,
  getRobinhoodPromoWeeks,
  isTradeInDateRange,
  parseCustomDateRange,
} from "../web/src/checker/date_filter";

describe("DateFilter: Robinhood Points Campaign & Custom Ranges", () => {
  it("generates exactly 20 campaign weeks starting Aug 10, 2026", () => {
    const weeks = getRobinhoodPromoWeeks();
    expect(weeks.length).toBe(ROBINHOOD_PROMO_TOTAL_WEEKS);
    expect(weeks.length).toBe(20);

    // Week 1 starts on campaign launch: Aug 10, 2026 00:00 UTC
    expect(weeks[0].startTimestampMs).toBe(ROBINHOOD_PROMO_START_MS);
    expect(weeks[0].startDateFormatted).toBe("2026-08-10");
    // Week 1 ends on first Thursday snapshot: Aug 20, 2026 00:00 UTC
    expect(weeks[0].endDateFormatted).toBe("2026-08-20");
    expect(weeks[0].weekNumber).toBe(1);

    // Week 2 starts Aug 20 and ends Aug 27 (Thursday to Thursday)
    expect(weeks[1].startDateFormatted).toBe("2026-08-20");
    expect(weeks[1].endDateFormatted).toBe("2026-08-27");
    expect(weeks[1].weekNumber).toBe(2);

    // Week 20 ends on Dec 31, 2026 00:00 UTC
    expect(weeks[19].startDateFormatted).toBe("2026-12-24");
    expect(weeks[19].endDateFormatted).toBe("2026-12-31");
    expect(weeks[19].weekNumber).toBe(20);
  });

  it("ensures all subsequent weeks are seamless and non-overlapping Thursday-to-Thursday", () => {
    const weeks = getRobinhoodPromoWeeks();
    for (let i = 1; i < weeks.length; i++) {
      const prev = weeks[i - 1];
      const curr = weeks[i];
      // End of previous week is exactly the start of the current week
      expect(curr.startTimestampMs).toBe(prev.endTimestampMs);

      // Verify that every week from week 2 onward is exactly 7 days (604,800,000 ms)
      const durationMs = curr.endTimestampMs! - curr.startTimestampMs!;
      expect(durationMs).toBe(7 * 24 * 3600 * 1000);

      // Verify start and end day of week in UTC is Thursday (day 4)
      const startDate = new Date(curr.startTimestampMs!);
      const endDate = new Date(curr.endTimestampMs!);
      expect(startDate.getUTCDay()).toBe(4); // Thursday
      expect(endDate.getUTCDay()).toBe(4); // Thursday
      expect(startDate.getUTCHours()).toBe(0);
      expect(startDate.getUTCMinutes()).toBe(0);
      expect(endDate.getUTCHours()).toBe(0);
      expect(endDate.getUTCMinutes()).toBe(0);
    }
  });

  it("correctly identifies active week as Week 8 for current date (Oct 6, 2026)", () => {
    // Current date: 2026-10-06T20:57:17Z
    const mockNow = Date.parse("2026-10-06T20:57:17.000Z");
    const currentWeek = getCurrentPromoWeek(mockNow);

    expect(currentWeek).not.toBeNull();
    expect(currentWeek!.weekNumber).toBe(8);
    expect(currentWeek!.id).toBe("week-8");
    expect(currentWeek!.startDateFormatted).toBe("2026-10-01");
    expect(currentWeek!.endDateFormatted).toBe("2026-10-08");

    const prevWeek = getPreviousPromoWeek(mockNow);
    expect(prevWeek).not.toBeNull();
    expect(prevWeek!.weekNumber).toBe(7);
    expect(prevWeek!.id).toBe("week-7");
  });

  it("correctly filters trades with isTradeInDateRange", () => {
    const w1 = findPresetById("week-1")!;
    const w2 = findPresetById("week-2")!;

    // Trade on Aug 12 (during Week 1)
    const tAug12 = Date.parse("2026-08-12T14:30:00.000Z");
    expect(isTradeInDateRange(tAug12, w1)).toBe(true);
    expect(isTradeInDateRange(tAug12, w2)).toBe(false);

    // Exact boundary at Thursday 00:00 UTC (Aug 20) belongs to Week 2
    const tSnapshot = Date.parse("2026-08-20T00:00:00.000Z");
    expect(isTradeInDateRange(tSnapshot, w1)).toBe(false);
    expect(isTradeInDateRange(tSnapshot, w2)).toBe(true);

    // Trade 1 millisecond before boundary belongs to Week 1
    const tBeforeSnapshot = tSnapshot - 1;
    expect(isTradeInDateRange(tBeforeSnapshot, w1)).toBe(true);
    expect(isTradeInDateRange(tBeforeSnapshot, w2)).toBe(false);

    // Null filter matches everything
    expect(isTradeInDateRange(tAug12, null)).toBe(true);
    expect(isTradeInDateRange(tSnapshot, { startTimestampMs: null, endTimestampMs: null })).toBe(
      true,
    );
  });

  it("parses custom date range with inclusive end-of-day boundary", () => {
    const custom = parseCustomDateRange("2026-09-01", "2026-09-05");

    expect(custom.isCustom).toBe(true);
    expect(custom.startTimestampMs).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
    // End date + 1 day = 2026-09-06 00:00 UTC, so trades on Sep 5 at 23:59:59 are included
    expect(custom.endTimestampMs).toBe(Date.parse("2026-09-06T00:00:00.000Z"));

    const tSep5Evening = Date.parse("2026-09-05T23:55:00.000Z");
    expect(isTradeInDateRange(tSep5Evening, custom)).toBe(true);

    const tSep6Morning = Date.parse("2026-09-06T00:01:00.000Z");
    expect(isTradeInDateRange(tSep6Morning, custom)).toBe(false);
  });

  it("handles open-ended custom date ranges", () => {
    const fromOnly = parseCustomDateRange("2026-09-10", "");
    expect(fromOnly.startTimestampMs).toBe(Date.parse("2026-09-10T00:00:00.000Z"));
    expect(fromOnly.endTimestampMs).toBeNull();
    expect(isTradeInDateRange(Date.parse("2026-10-01T00:00:00.000Z"), fromOnly)).toBe(true);
    expect(isTradeInDateRange(Date.parse("2026-09-01T00:00:00.000Z"), fromOnly)).toBe(false);

    const toOnly = parseCustomDateRange("", "2026-09-10");
    expect(toOnly.startTimestampMs).toBeNull();
    expect(toOnly.endTimestampMs).toBe(Date.parse("2026-09-11T00:00:00.000Z"));
    expect(isTradeInDateRange(Date.parse("2026-09-10T12:00:00.000Z"), toOnly)).toBe(true);
    expect(isTradeInDateRange(Date.parse("2026-09-15T00:00:00.000Z"), toOnly)).toBe(false);
  });

  it("provides all presets with quick ranges and all 20 campaign weeks", () => {
    const presets = getAllDatePresets(Date.parse("2026-10-06T20:57:17.000Z"));
    const allPromo = presets.find((p) => p.id === "all-promo");
    expect(allPromo).toBeDefined();
    expect(allPromo!.startTimestampMs).toBe(ROBINHOOD_PROMO_START_MS);

    const promoWeeks = presets.filter((p) => p.group === "promo" && p.weekNumber);
    expect(promoWeeks.length).toBe(20);
  });
});
