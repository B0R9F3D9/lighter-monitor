export interface DateRangePreset {
  id: string;
  label: string;
  shortLabel: string;
  group: "all" | "promo" | "quick" | "custom";
  startTimestampMs: number | null;
  endTimestampMs: number | null;
  weekNumber?: number;
  status?: "completed" | "current" | "upcoming";
  startDateFormatted?: string; // YYYY-MM-DD
  endDateFormatted?: string; // YYYY-MM-DD
}

export interface ActiveDateFilter {
  presetId: string;
  startTimestampMs: number | null;
  endTimestampMs: number | null;
  label: string;
  isCustom: boolean;
  weekNumber?: number;
}

export const ROBINHOOD_PROMO_START_UTC = "2026-08-10T00:00:00.000Z";
export const ROBINHOOD_PROMO_START_MS = Date.parse(ROBINHOOD_PROMO_START_UTC);
export const ROBINHOOD_PROMO_TOTAL_WEEKS = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatDateUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatShortMonthDay(d: Date): string {
  return `${MONTH_NAMES[d.getUTCMonth()]} ${pad2(d.getUTCDate())}`;
}

export function formatSlashMonthDay(d: Date): string {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}`;
}

/**
 * Generates all 20 weeks of the Lighter on Robinhood Chain points program.
 * - Program effective date: Monday, August 10, 2026
 * - First weekly snapshot & end of Week 1: Friday, August 21, 2026 at 00:00 UTC
 * - Subsequent snapshots: Every Friday at 00:00 UTC (weeks 2 through 20)
 * - Week 20 ends: Friday, January 1, 2027 at 00:00 UTC
 */
export function getRobinhoodPromoWeeks(nowMs = Date.now()): DateRangePreset[] {
  const weeks: DateRangePreset[] = [];

  // Week 1: Promo start (Mon Aug 10, 2026) -> First Friday snapshot (Fri Aug 21, 2026)
  const w1StartMs = ROBINHOOD_PROMO_START_MS;
  const w1EndMs = Date.parse("2026-08-21T00:00:00.000Z");

  let curStartMs = w1StartMs;
  let curEndMs = w1EndMs;

  for (let w = 1; w <= ROBINHOOD_PROMO_TOTAL_WEEKS; w++) {
    const startDate = new Date(curStartMs);
    const endDate = new Date(curEndMs);

    let status: "completed" | "current" | "upcoming" = "upcoming";
    if (nowMs >= curEndMs) {
      status = "completed";
    } else if (nowMs >= curStartMs && nowMs < curEndMs) {
      status = "current";
    }

    const startShort = formatShortMonthDay(startDate);
    const endShort = formatShortMonthDay(endDate);

    const statusBadge = status === "current" ? " [Current]" : "";
    const label = `Week ${w} (${startShort} – ${endShort})${statusBadge}`;

    weeks.push({
      id: `week-${w}`,
      label,
      shortLabel: `W${w}`,
      group: "promo",
      startTimestampMs: curStartMs,
      endTimestampMs: curEndMs,
      weekNumber: w,
      status,
      startDateFormatted: formatDateUtc(startDate),
      endDateFormatted: formatDateUtc(endDate),
    });

    // Advance to next 7-day interval (Friday to Friday)
    curStartMs = curEndMs;
    curEndMs = curStartMs + MS_PER_WEEK;
  }

  return weeks;
}

/**
 * Returns the currently active promo week (if today falls within weeks 1-20).
 */
export function getCurrentPromoWeek(nowMs = Date.now()): DateRangePreset | null {
  const promoWeeks = getRobinhoodPromoWeeks(nowMs);
  return promoWeeks.find((w) => w.status === "current") ?? null;
}

/**
 * Returns the previous completed promo week (or null if week 1 hasn't finished).
 */
export function getPreviousPromoWeek(nowMs = Date.now()): DateRangePreset | null {
  const promoWeeks = getRobinhoodPromoWeeks(nowMs);
  const current = promoWeeks.find((w) => w.status === "current");
  if (current && current.weekNumber && current.weekNumber > 1) {
    return promoWeeks[current.weekNumber - 2] ?? null;
  }
  // If promo is completed, return week 20
  if (nowMs >= (promoWeeks[promoWeeks.length - 1]?.endTimestampMs ?? 0)) {
    return promoWeeks[promoWeeks.length - 1] ?? null;
  }
  return null;
}

/**
 * Returns all available date presets, including All Time, Quick Ranges,
 * full 20-week Robinhood Campaign presets, and Custom.
 */
export function getAllDatePresets(nowMs = Date.now()): DateRangePreset[] {
  const promoWeeks = getRobinhoodPromoWeeks(nowMs);
  const currentWeek = promoWeeks.find((w) => w.status === "current");
  const prevWeek = getPreviousPromoWeek(nowMs);

  const presets: DateRangePreset[] = [
    {
      id: "all",
      label: "All Time",
      shortLabel: "All Time",
      group: "all",
      startTimestampMs: null,
      endTimestampMs: null,
    },
  ];

  // Quick relative ranges
  if (currentWeek) {
    presets.push({
      id: "quick-current-week",
      label: `Current Week (${currentWeek.shortLabel}: ${currentWeek.startDateFormatted?.slice(5)} – ${currentWeek.endDateFormatted?.slice(5)})`,
      shortLabel: `${currentWeek.shortLabel} Current`,
      group: "quick",
      startTimestampMs: currentWeek.startTimestampMs,
      endTimestampMs: currentWeek.endTimestampMs,
      weekNumber: currentWeek.weekNumber,
    });
  }

  if (prevWeek) {
    presets.push({
      id: "quick-prev-week",
      label: `Previous Week (${prevWeek.shortLabel}: ${prevWeek.startDateFormatted?.slice(5)} – ${prevWeek.endDateFormatted?.slice(5)})`,
      shortLabel: `${prevWeek.shortLabel} Prev`,
      group: "quick",
      startTimestampMs: prevWeek.startTimestampMs,
      endTimestampMs: prevWeek.endTimestampMs,
      weekNumber: prevWeek.weekNumber,
    });
  }

  presets.push(
    {
      id: "quick-24h",
      label: "Last 24 Hours",
      shortLabel: "24h",
      group: "quick",
      startTimestampMs: nowMs - MS_PER_DAY,
      endTimestampMs: nowMs,
    },
    {
      id: "quick-7d",
      label: "Last 7 Days",
      shortLabel: "7d",
      group: "quick",
      startTimestampMs: nowMs - 7 * MS_PER_DAY,
      endTimestampMs: nowMs,
    },
    {
      id: "quick-30d",
      label: "Last 30 Days",
      shortLabel: "30d",
      group: "quick",
      startTimestampMs: nowMs - 30 * MS_PER_DAY,
      endTimestampMs: nowMs,
    },
  );

  // Full Robinhood 20 Weeks campaign aggregate preset
  const promoEndMs = promoWeeks[promoWeeks.length - 1]?.endTimestampMs ?? 0;
  presets.push({
    id: "all-promo",
    label: "All Campaign (Weeks 1–20)",
    shortLabel: "W1–W20",
    group: "promo",
    startTimestampMs: ROBINHOOD_PROMO_START_MS,
    endTimestampMs: promoEndMs,
  });

  // Individual 20 promo weeks
  for (const w of promoWeeks) {
    presets.push(w);
  }

  return presets;
}

/**
 * Finds preset by its ID.
 */
export function findPresetById(presetId: string, nowMs = Date.now()): DateRangePreset | null {
  const presets = getAllDatePresets(nowMs);
  return presets.find((p) => p.id === presetId) ?? null;
}

/**
 * Creates an ActiveDateFilter from a DateRangePreset.
 */
export function createPresetDateFilter(preset: DateRangePreset): ActiveDateFilter {
  return {
    presetId: preset.id,
    startTimestampMs: preset.startTimestampMs,
    endTimestampMs: preset.endTimestampMs,
    label: preset.label,
    isCustom: preset.id === "custom",
    weekNumber: preset.weekNumber,
  };
}

/**
 * Creates an ActiveDateFilter from custom user-entered date strings (YYYY-MM-DD).
 * Time boundaries are parsed in UTC:
 * - fromDate: 00:00:00.000 UTC
 * - toDate: end of that day inclusive (23:59:59.999 UTC / next day 00:00 UTC)
 */
export function parseCustomDateRange(
  fromStr: string | null | undefined,
  toStr: string | null | undefined,
): ActiveDateFilter {
  const trimmedFrom = fromStr?.trim() || "";
  const trimmedTo = toStr?.trim() || "";

  let startMs: number | null = null;
  let endMs: number | null = null;

  if (trimmedFrom) {
    const parsedStart = Date.parse(`${trimmedFrom}T00:00:00.000Z`);
    if (!isNaN(parsedStart)) {
      startMs = parsedStart;
    }
  }

  if (trimmedTo) {
    // Add 1 day to make the chosen end date fully inclusive when filtering with `< endMs`
    const parsedEnd = Date.parse(`${trimmedTo}T00:00:00.000Z`);
    if (!isNaN(parsedEnd)) {
      endMs = parsedEnd + MS_PER_DAY;
    }
  }

  let label = "Custom Range";
  if (trimmedFrom && trimmedTo) {
    label = `${trimmedFrom} → ${trimmedTo} (UTC)`;
  } else if (trimmedFrom) {
    label = `From ${trimmedFrom} (UTC)`;
  } else if (trimmedTo) {
    label = `Up to ${trimmedTo} (UTC)`;
  } else {
    label = "All Time (All Trades)";
  }

  return {
    presetId: "custom",
    startTimestampMs: startMs,
    endTimestampMs: endMs,
    label,
    isCustom: true,
  };
}

/**
 * Evaluates whether a trade timestamp in milliseconds falls within the active date filter.
 */
export function isTradeInDateRange(
  timestampMs: number,
  filter: { startTimestampMs: number | null; endTimestampMs: number | null } | null,
): boolean {
  if (!filter) return true;
  if (!timestampMs || isNaN(timestampMs)) return false;

  if (filter.startTimestampMs !== null && timestampMs < filter.startTimestampMs) {
    return false;
  }
  if (filter.endTimestampMs !== null && timestampMs >= filter.endTimestampMs) {
    return false;
  }
  return true;
}

/**
 * Populates a select dropdown with formatted preset options and optgroups.
 */
export function populatePresetSelect(
  selectEl: HTMLSelectElement,
  selectedId = "all",
  nowMs = Date.now(),
): void {
  selectEl.innerHTML = "";

  const presets = getAllDatePresets(nowMs);

  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "All Time";
  optAll.className = "bg-terminal-surface text-white";
  selectEl.appendChild(optAll);

  const quickGroup = document.createElement("optgroup");
  quickGroup.label = "Quick Ranges";
  quickGroup.className = "bg-terminal-surface text-terminal-muted";
  for (const p of presets.filter((x) => x.group === "quick")) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    opt.className = "bg-terminal-surface text-white";
    quickGroup.appendChild(opt);
  }
  selectEl.appendChild(quickGroup);

  const promoGroup = document.createElement("optgroup");
  promoGroup.label = "Robinhood Campaign (20 Weeks)";
  promoGroup.className = "bg-terminal-surface text-terminal-muted";
  for (const p of presets.filter((x) => x.group === "promo")) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    opt.className = "bg-terminal-surface text-white";
    promoGroup.appendChild(opt);
  }
  selectEl.appendChild(promoGroup);

  const optCustom = document.createElement("option");
  optCustom.value = "custom";
  optCustom.textContent = "Custom Range...";
  optCustom.className = "bg-terminal-surface text-white";
  selectEl.appendChild(optCustom);

  selectEl.value = selectedId;
}
