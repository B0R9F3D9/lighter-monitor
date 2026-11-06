import {
  BaselineSeries,
  ColorType,
  createChart,
  LineSeries,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BasisPoint } from "./types";
import { extrapolateTimeRange } from "./math";
import { getSavedFont, getFontStack } from "../shared";

export interface AnalyticsChartCallbacks {
  onCrosshairMove?: (point: BasisPoint | null) => void;
  onVisibleRangeChange?: (range: { fromSec: number; toSec: number }) => void;
}

export interface ChartSyncContext {
  priceChart: IChartApi;
  basisChart: IChartApi;
  rhSeries: ISeriesApi<"Line">;
  coreSeries: ISeriesApi<"Line">;
  rhPriceLine: IPriceLine;
  corePriceLine: IPriceLine;
  basisSeries: ISeriesApi<"Baseline">;
  basisPriceLine: IPriceLine;
  smaSeries: ISeriesApi<"Line">;
  upperBandSeries: ISeriesApi<"Line">;
  lowerBandSeries: ISeriesApi<"Line">;
  destroy: () => void;
  setData: (
    points: BasisPoint[],
    bands: Array<{ timeSec: number; sma: number; upper: number; lower: number }>,
    fitContent?: boolean,
    targetRange?: { fromSec: number; toSec: number },
    isRhLong?: boolean,
  ) => void;
  setShowBands: (visible: boolean) => void;
  updateRealtimePoint: (point: BasisPoint, updateSeries?: boolean) => void;
  isUserHovering: () => boolean;
  resize: () => void;
}

const CHART_PALETTE = {
  background: "#0B0C0E",
  textColor: "#8B949E",
  gridLine: "#16191D",
  crosshair: "#484F58",
  crosshairLabelBg: "#181B20",
  border: "#1F2328",
  borderSubtle: "#30363D",
  white: "#FFFFFF",
  accent: "#58A6FF",
  emerald: "#2EA043",
  neutralLine: "#21262D",
  bandOuter: "rgba(139, 148, 158, 0.35)",
  bandSma: "rgba(110, 118, 129, 0.45)",
} as const;

const SHORT_MONTHS = [
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
] as const;

function areLogicalRangesEqual(
  r1: { from: number; to: number } | null,
  r2: { from: number; to: number } | null,
  epsilon = 0.005,
): boolean {
  if (r1 === r2) return true;
  if (!r1 || !r2) return false;
  return Math.abs(r1.from - r2.from) < epsilon && Math.abs(r1.to - r2.to) < epsilon;
}

export function initAnalyticsCharts(
  priceContainer: HTMLElement,
  basisContainer: HTMLElement,
  callbacks?: AnalyticsChartCallbacks | ((point: BasisPoint | null) => void),
): ChartSyncContext {
  priceContainer.style.cursor = "crosshair";
  basisContainer.style.cursor = "crosshair";

  const commonOptions = {
    layout: {
      background: { type: ColorType.Solid, color: CHART_PALETTE.background },
      textColor: CHART_PALETTE.textColor,
      fontFamily: getFontStack(getSavedFont()),
      fontSize: 11,
    },
    localization: {
      timeFormatter: (time: Time) => {
        let d: Date;
        if (typeof time === "number") {
          d = new Date(time * 1000);
        } else if (typeof time === "object" && time !== null && "year" in time) {
          d = new Date(time.year, time.month - 1, time.day);
        } else {
          return String(time);
        }
        const month = SHORT_MONTHS[d.getMonth()] || "";
        const day = String(d.getDate()).padStart(2, "0");
        const hours = String(d.getHours()).padStart(2, "0");
        const minutes = String(d.getMinutes()).padStart(2, "0");
        return `${day} ${month}, ${hours}:${minutes}`;
      },
    },
    grid: {
      vertLines: { color: CHART_PALETTE.gridLine },
      horzLines: { color: CHART_PALETTE.gridLine },
    },
    crosshair: {
      vertLine: {
        color: CHART_PALETTE.crosshair,
        width: 1 as const,
        style: LineStyle.Dashed,
        labelBackgroundColor: CHART_PALETTE.crosshairLabelBg,
      },
      horzLine: {
        color: CHART_PALETTE.crosshair,
        width: 1 as const,
        style: LineStyle.Dashed,
        labelBackgroundColor: CHART_PALETTE.crosshairLabelBg,
      },
    },
    timeScale: {
      borderColor: CHART_PALETTE.border,
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => {
        let d: Date;
        if (typeof time === "number") {
          d = new Date(time * 1000);
        } else if (typeof time === "object" && time !== null && "year" in time) {
          d = new Date(time.year, time.month - 1, time.day);
        } else {
          return null;
        }

        const hours = String(d.getHours()).padStart(2, "0");
        const minutes = String(d.getMinutes()).padStart(2, "0");
        const month = SHORT_MONTHS[d.getMonth()] || "";
        const day = String(d.getDate()).padStart(2, "0");

        switch (tickMarkType) {
          case TickMarkType.Year:
            return String(d.getFullYear());
          case TickMarkType.Month:
            return month;
          case TickMarkType.DayOfMonth:
            return `${day} ${month}`;
          case TickMarkType.Time:
            return `${hours}:${minutes}`;
          case TickMarkType.TimeWithSeconds:
            return `${hours}:${minutes}:${String(d.getSeconds()).padStart(2, "0")}`;
          default:
            return `${hours}:${minutes}`;
        }
      },
    },
    rightPriceScale: {
      borderColor: CHART_PALETTE.border,
      minimumWidth: 72,
    },
  };

  const initialPriceWidth = priceContainer.clientWidth || 800;
  const initialPriceHeight = priceContainer.clientHeight || 340;
  const initialBasisWidth = basisContainer.clientWidth || 800;
  const initialBasisHeight = basisContainer.clientHeight || 220;

  // 1. Price Chart (Top)
  const priceChart = createChart(priceContainer, {
    ...commonOptions,
    width: initialPriceWidth,
    height: initialPriceHeight,
    crosshair: {
      ...commonOptions.crosshair,
      horzLine: {
        color: CHART_PALETTE.borderSubtle,
        width: 1 as const,
        style: LineStyle.Dashed,
        labelVisible: false, // The price scale badges are driven dynamically by RH & Core hovered prices
      },
    },
  });

  const rhSeries = priceChart.addSeries(LineSeries, {
    color: CHART_PALETTE.accent,
    lineWidth: 2,
    lastValueVisible: false,
    priceLineVisible: false,
    priceFormat: { type: "price", precision: 2, minMove: 0.01 },
  });

  const coreSeries = priceChart.addSeries(LineSeries, {
    color: CHART_PALETTE.textColor,
    lineWidth: 2,
    lastValueVisible: false,
    priceLineVisible: false,
    priceFormat: { type: "price", precision: 2, minMove: 0.01 },
  });

  // Dedicated dynamic price lines for RH and Core prices on the right price scale
  const rhPriceLine = rhSeries.createPriceLine({
    price: 0,
    color: CHART_PALETTE.accent,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    lineVisible: false,
    axisLabelVisible: false,
    title: "RH",
    axisLabelColor: CHART_PALETTE.accent,
    axisLabelTextColor: CHART_PALETTE.background,
  });

  const corePriceLine = coreSeries.createPriceLine({
    price: 0,
    color: CHART_PALETTE.textColor,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    lineVisible: false,
    axisLabelVisible: false,
    title: "Core",
    axisLabelColor: CHART_PALETTE.borderSubtle,
    axisLabelTextColor: CHART_PALETTE.white,
  });

  // 2. Basis & Spread Sub-Chart (Bottom)
  const basisChart = createChart(basisContainer, {
    ...commonOptions,
    width: initialBasisWidth,
    height: initialBasisHeight,
    crosshair: {
      ...commonOptions.crosshair,
      horzLine: {
        color: CHART_PALETTE.borderSubtle,
        width: 1 as const,
        style: LineStyle.Dashed,
        labelVisible: false, // The price scale badges are driven dynamically by hovered basis
      },
    },
  });

  // BaselineSeries: above 0 (RH expensive) is slate/accent, below 0 (RH discount) is emerald green
  const basisSeries = basisChart.addSeries(BaselineSeries, {
    baseValue: { type: "price", price: 0 },
    topLineColor: CHART_PALETTE.accent,
    topFillColor1: "rgba(0, 0, 0, 0)",
    topFillColor2: "rgba(0, 0, 0, 0)",
    bottomLineColor: CHART_PALETTE.emerald,
    bottomFillColor1: "rgba(0, 0, 0, 0)",
    bottomFillColor2: "rgba(0, 0, 0, 0)",
    lineWidth: 2,
    lastValueVisible: false,
    priceLineVisible: false,
    priceFormat: { type: "price", precision: 3, minMove: 0.001 },
  });

  // Dedicated dynamic price line for Basis on the right price scale (matches top chart hover badge)
  const basisPriceLine = basisSeries.createPriceLine({
    price: 0,
    color: CHART_PALETTE.accent,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    lineVisible: false,
    axisLabelVisible: false,
    title: "Basis",
    axisLabelColor: CHART_PALETTE.accent,
    axisLabelTextColor: CHART_PALETTE.background,
  });

  // Dispersion bands (clean, without titles that clutter canvas; hidden by default for maximum clarity)
  const upperBandSeries = basisChart.addSeries(LineSeries, {
    color: CHART_PALETTE.bandOuter,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    lastValueVisible: false,
    priceLineVisible: false,
    visible: false,
  });

  const smaSeries = basisChart.addSeries(LineSeries, {
    color: CHART_PALETTE.bandSma,
    lineWidth: 1,
    lineStyle: LineStyle.Solid,
    lastValueVisible: false,
    priceLineVisible: false,
    visible: false,
  });

  const lowerBandSeries = basisChart.addSeries(LineSeries, {
    color: CHART_PALETTE.bandOuter,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    lastValueVisible: false,
    priceLineVisible: false,
    visible: false,
  });

  // Zero Reference Line in Basis Sub-chart (clean Parity anchor)
  basisSeries.createPriceLine({
    price: 0,
    color: CHART_PALETTE.neutralLine,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: "0.00",
    axisLabelColor: CHART_PALETTE.neutralLine,
    axisLabelTextColor: CHART_PALETTE.textColor,
  });

  let isSyncingFromPrice = false;
  let isSyncingFromBasis = false;
  let isProgrammaticUpdate = false;
  let programmaticTimer: ReturnType<typeof setTimeout> | null = null;
  let isResizing = false;
  let resizeResetRafId: number | null = null;
  let isHovering = false;
  let lastHoveredTimeSec: number | null = null;
  let currentIsRhLong = true;
  let currentPointsList: BasisPoint[] = [];
  const currentPointsMap = new Map<number, BasisPoint>();

  let lastAppliedRhPrice: number | null = null;
  let lastAppliedCorePrice: number | null = null;
  let lastAppliedBasisPrice: number | null = null;
  let lastAppliedIsEdge: boolean | null = null;
  let lastAppliedLinesVisible = false;

  let lastPriceWidth = initialPriceWidth;
  let lastPriceHeight = initialPriceHeight;
  let lastBasisWidth = initialBasisWidth;
  let lastBasisHeight = initialBasisHeight;

  function markProgrammaticUpdate(durationMs = 250): void {
    isProgrammaticUpdate = true;
    if (programmaticTimer !== null) {
      clearTimeout(programmaticTimer);
    }
    programmaticTimer = setTimeout(() => {
      isProgrammaticUpdate = false;
      programmaticTimer = null;
    }, durationMs);
  }

  let syncWidthsRafId: number | null = null;

  function syncPriceScaleWidths(resetToBaseline = false): void {
    if (syncWidthsRafId !== null) {
      cancelAnimationFrame(syncWidthsRafId);
      syncWidthsRafId = null;
    }

    if (resetToBaseline) {
      try {
        priceChart.priceScale("right").applyOptions({ minimumWidth: 72 });
        basisChart.priceScale("right").applyOptions({ minimumWidth: 72 });
      } catch {}
    }

    syncWidthsRafId = requestAnimationFrame(() => {
      syncWidthsRafId = null;
      try {
        const pw = priceChart.priceScale("right").width();
        const bw = basisChart.priceScale("right").width();
        const maxW = Math.max(pw, bw, 72);
        if (maxW > 0) {
          priceChart.priceScale("right").applyOptions({ minimumWidth: maxW });
          basisChart.priceScale("right").applyOptions({ minimumWidth: maxW });
        }
      } catch {}
    });
  }

  syncPriceScaleWidths(true);

  function markResizing(): void {
    isResizing = true;
    if (resizeResetRafId !== null) {
      cancelAnimationFrame(resizeResetRafId);
    }
    resizeResetRafId = requestAnimationFrame(() => {
      isResizing = false;
      resizeResetRafId = null;
    });
  }

  function resetPriceLineCache() {
    lastAppliedRhPrice = null;
    lastAppliedCorePrice = null;
    lastAppliedBasisPrice = null;
    lastAppliedIsEdge = null;
    lastAppliedLinesVisible = true;
  }

  const onCrosshairMove = typeof callbacks === "function" ? callbacks : callbacks?.onCrosshairMove;
  const onVisibleRangeChange =
    typeof callbacks === "object" ? callbacks?.onVisibleRangeChange : undefined;

  function computeExtrapolatedRange(): { fromSec: number; toSec: number } | null {
    const logicalRange = priceChart.timeScale().getVisibleLogicalRange();
    const range = extrapolateTimeRange(logicalRange, currentPointsList);
    if (!range) return null;

    let { fromSec, toSec } = range;
    const vis = priceChart.timeScale().getVisibleRange();
    if (vis && typeof vis.from === "number" && typeof vis.to === "number") {
      if (logicalRange && logicalRange.from >= 0 && (vis.from as number) > 0) {
        fromSec = Math.min(fromSec, vis.from as number);
      }
      if (
        logicalRange &&
        logicalRange.to <= currentPointsList.length - 1 &&
        (vis.to as number) > 0
      ) {
        toSec = Math.max(toSec, vis.to as number);
      }
    }

    if (toSec <= fromSec) return null;
    return { fromSec, toSec };
  }

  function handleUserRangeChange() {
    if (isProgrammaticUpdate || isResizing || !onVisibleRangeChange) {
      return;
    }
    const range = computeExtrapolatedRange();
    if (range) {
      onVisibleRangeChange(range);
    }
  }

  // Synchronize TimeScales bidirectionally without feedback loops
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!range || isSyncingFromBasis) return;
    const basisLogical = basisChart.timeScale().getVisibleLogicalRange();
    if (!areLogicalRangesEqual(range, basisLogical)) {
      isSyncingFromPrice = true;
      try {
        basisChart.timeScale().setVisibleLogicalRange(range);
      } finally {
        requestAnimationFrame(() => {
          isSyncingFromPrice = false;
        });
      }
    }
    handleUserRangeChange();
  });

  basisChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!range || isSyncingFromPrice) return;
    const priceLogical = priceChart.timeScale().getVisibleLogicalRange();
    if (!areLogicalRangesEqual(range, priceLogical)) {
      isSyncingFromBasis = true;
      try {
        priceChart.timeScale().setVisibleLogicalRange(range);
      } finally {
        requestAnimationFrame(() => {
          isSyncingFromBasis = false;
        });
      }
    }
    handleUserRangeChange();
  });

  const onTimeScaleSizeChange = () => syncPriceScaleWidths(false);
  priceChart.timeScale().subscribeSizeChange(onTimeScaleSizeChange);
  basisChart.timeScale().subscribeSizeChange(onTimeScaleSizeChange);

  function updatePriceLines(point: BasisPoint | null) {
    let p = point;
    if (!p && currentPointsList.length > 0) {
      p = currentPointsList[currentPointsList.length - 1];
    }

    if (!p || typeof p.rhPrice !== "number" || typeof p.corePrice !== "number" || p.rhPrice <= 0) {
      if (lastAppliedLinesVisible) {
        rhPriceLine.applyOptions({ axisLabelVisible: false, lineVisible: false });
        corePriceLine.applyOptions({ axisLabelVisible: false, lineVisible: false });
        basisPriceLine.applyOptions({ axisLabelVisible: false, lineVisible: false });
        lastAppliedLinesVisible = false;
        lastAppliedRhPrice = null;
        lastAppliedCorePrice = null;
        lastAppliedBasisPrice = null;
        lastAppliedIsEdge = null;
      }
      return;
    }

    lastAppliedLinesVisible = true;

    if (lastAppliedRhPrice === null || Math.abs(p.rhPrice - lastAppliedRhPrice) >= 0.001) {
      rhPriceLine.applyOptions({
        price: p.rhPrice,
        axisLabelVisible: true,
        lineVisible: true,
      });
      lastAppliedRhPrice = p.rhPrice;
    }

    if (lastAppliedCorePrice === null || Math.abs(p.corePrice - lastAppliedCorePrice) >= 0.001) {
      corePriceLine.applyOptions({
        price: p.corePrice,
        axisLabelVisible: true,
        lineVisible: true,
      });
      lastAppliedCorePrice = p.corePrice;
    }

    if (typeof p.basisUsd === "number") {
      const isEdge = currentIsRhLong ? p.basisUsd <= 0 : p.basisUsd >= 0;
      if (
        lastAppliedBasisPrice === null ||
        Math.abs(p.basisUsd - lastAppliedBasisPrice) >= 0.0001 ||
        lastAppliedIsEdge !== isEdge
      ) {
        basisPriceLine.applyOptions({
          price: p.basisUsd,
          axisLabelVisible: true,
          lineVisible: false,
          axisLabelColor: isEdge ? CHART_PALETTE.emerald : CHART_PALETTE.accent,
          axisLabelTextColor: isEdge ? CHART_PALETTE.white : CHART_PALETTE.background,
        });
        lastAppliedBasisPrice = p.basisUsd;
        lastAppliedIsEdge = isEdge;
      }
    } else if (lastAppliedBasisPrice !== null) {
      basisPriceLine.applyOptions({ axisLabelVisible: false, lineVisible: false });
      lastAppliedBasisPrice = null;
      lastAppliedIsEdge = null;
    }
  }

  // Crosshair move handler (drives dynamic price scale labels on right and top legend)
  const handleMove = (param: { time?: Time; point?: { x: number; y: number } }) => {
    if (!param.time || !param.point) {
      if (lastHoveredTimeSec !== null || isHovering) {
        lastHoveredTimeSec = null;
        isHovering = false;
        updatePriceLines(null);
        if (onCrosshairMove) onCrosshairMove(null);
      }
      return;
    }

    const tSec = typeof param.time === "number" ? param.time : 0;
    if (tSec === lastHoveredTimeSec) {
      return;
    }

    lastHoveredTimeSec = tSec;
    isHovering = true;
    const pt = currentPointsMap.get(tSec) || null;
    updatePriceLines(pt);
    if (onCrosshairMove) onCrosshairMove(pt);
  };

  priceChart.subscribeCrosshairMove(handleMove);
  basisChart.subscribeCrosshairMove(handleMove);

  const handleMouseLeave = () => {
    if (lastHoveredTimeSec !== null || isHovering) {
      lastHoveredTimeSec = null;
      isHovering = false;
      updatePriceLines(null);
      if (onCrosshairMove) onCrosshairMove(null);
    }
  };

  priceContainer.addEventListener("mouseleave", handleMouseLeave);
  basisContainer.addEventListener("mouseleave", handleMouseLeave);

  // Responsive resize with change check and range suppression
  const resizeObserver = new ResizeObserver((entries) => {
    let priceResized = false;
    let basisResized = false;
    let newPw = 0;
    let newPh = 0;
    let newBw = 0;
    let newBh = 0;

    for (const entry of entries) {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width <= 0 || height <= 0) continue;

      if (entry.target === priceContainer) {
        if (width !== lastPriceWidth || height !== lastPriceHeight) {
          lastPriceWidth = width;
          lastPriceHeight = height;
          newPw = width;
          newPh = height;
          priceResized = true;
        }
      } else if (entry.target === basisContainer) {
        if (width !== lastBasisWidth || height !== lastBasisHeight) {
          lastBasisWidth = width;
          lastBasisHeight = height;
          newBw = width;
          newBh = height;
          basisResized = true;
        }
      }
    }

    if (priceResized || basisResized) {
      markResizing();
      if (priceResized) {
        priceChart.applyOptions({ width: newPw, height: newPh });
      }
      if (basisResized) {
        basisChart.applyOptions({ width: newBw, height: newBh });
      }
    }
  });

  resizeObserver.observe(priceContainer);
  resizeObserver.observe(basisContainer);

  const setData = (
    points: BasisPoint[],
    bands: Array<{ timeSec: number; sma: number; upper: number; lower: number }>,
    fitContent = true,
    targetRange?: { fromSec: number; toSec: number },
    isRhLong = true,
  ) => {
    markProgrammaticUpdate(300);
    lastHoveredTimeSec = null;
    isHovering = false;
    resetPriceLineCache();

    // Preserve logical visible range & timestamps BEFORE replacing currentPointsList
    const prevLogicalRange = priceChart.timeScale().getVisibleLogicalRange();
    const prevPointsCount = currentPointsList.length;
    const prevFirstTime = prevPointsCount > 0 ? currentPointsList[0]!.timeSec : null;
    const prevLastTime =
      prevPointsCount > 0 ? currentPointsList[prevPointsCount - 1]!.timeSec : null;
    const prevPointsRef = currentPointsList;

    currentIsRhLong = isRhLong;
    currentPointsList = points.slice();
    currentPointsMap.clear();
    for (const p of points) {
      currentPointsMap.set(p.timeSec, p);
    }

    basisSeries.applyOptions({
      topLineColor: currentIsRhLong ? CHART_PALETTE.accent : CHART_PALETTE.emerald,
      topFillColor1: "rgba(0, 0, 0, 0)",
      topFillColor2: "rgba(0, 0, 0, 0)",
      bottomLineColor: currentIsRhLong ? CHART_PALETTE.emerald : CHART_PALETTE.accent,
      bottomFillColor1: "rgba(0, 0, 0, 0)",
      bottomFillColor2: "rgba(0, 0, 0, 0)",
    });

    const pLen = points.length;
    const rhLineData: Array<{ time: UTCTimestamp; value: number }> = [];
    const coreLineData: Array<{ time: UTCTimestamp; value: number }> = [];
    const basisData: Array<{ time: UTCTimestamp; value: number }> = [];

    for (let i = 0; i < pLen; i++) {
      const p = points[i]!;
      const time = p.timeSec as UTCTimestamp;
      rhLineData.push({ time, value: p.rhPrice });
      coreLineData.push({ time, value: p.corePrice });
      basisData.push({ time, value: p.basisUsd });
    }

    const bLen = bands.length;
    const smaData: Array<{ time: UTCTimestamp; value: number }> = [];
    const upperData: Array<{ time: UTCTimestamp; value: number }> = [];
    const lowerData: Array<{ time: UTCTimestamp; value: number }> = [];

    for (let i = 0; i < bLen; i++) {
      const b = bands[i]!;
      const time = b.timeSec as UTCTimestamp;
      smaData.push({ time, value: b.sma });
      upperData.push({ time, value: b.upper });
      lowerData.push({ time, value: b.lower });
    }

    rhSeries.setData(rhLineData);
    coreSeries.setData(coreLineData);
    basisSeries.setData(basisData);
    smaSeries.setData(smaData);
    upperBandSeries.setData(upperData);
    lowerBandSeries.setData(lowerData);

    // Update dynamic price lines on right scale to latest prices
    updatePriceLines(null);

    if (fitContent) {
      priceChart.timeScale().fitContent();
      basisChart.timeScale().fitContent();
    } else if (points.length > 0) {
      const newCount = points.length;
      const newFirstTime = points[0]!.timeSec;
      const newLastTime = points[newCount - 1]!.timeSec;
      const newDt = newCount > 1 ? Math.max(1, (newLastTime - newFirstTime) / (newCount - 1)) : 60;

      const timeToLogical = (t: number): number => {
        if (t < newFirstTime) {
          return (t - newFirstTime) / newDt;
        }
        if (t > newLastTime) {
          return newCount - 1 + (t - newLastTime) / newDt;
        }
        let low = 0;
        let high = newCount - 1;
        while (low <= high) {
          const mid = (low + high) >> 1;
          if (points[mid]!.timeSec <= t) {
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        const idx = Math.max(0, high);
        if (idx >= newCount - 1) return newCount - 1;
        const p1 = points[idx]!;
        const p2 = points[idx + 1]!;
        const span = p2.timeSec - p1.timeSec;
        if (span <= 0) return idx;
        return idx + (t - p1.timeSec) / span;
      };

      let targetLogicalRange: { from: number; to: number } | null = null;

      if (
        prevLogicalRange &&
        prevPointsCount > 0 &&
        prevFirstTime !== null &&
        prevLastTime !== null
      ) {
        const prevDt =
          prevPointsCount > 1
            ? Math.max(1, (prevLastTime - prevFirstTime) / (prevPointsCount - 1))
            : 60;

        // If resolution is unchanged (same candle step dt)
        if (Math.abs(prevDt - newDt) < 1.0) {
          let offset = 0;
          if (newFirstTime < prevFirstTime) {
            const idx = points.findIndex((p) => p.timeSec === prevFirstTime);
            offset = idx > 0 ? idx : Math.round((prevFirstTime - newFirstTime) / newDt);
          } else if (newFirstTime > prevFirstTime) {
            const idx = prevPointsRef.findIndex((p) => p.timeSec === newFirstTime);
            offset = -(idx > 0 ? idx : Math.round((newFirstTime - prevFirstTime) / prevDt));
          }
          targetLogicalRange = {
            from: prevLogicalRange.from + offset,
            to: prevLogicalRange.to + offset,
          };
        } else {
          // Resolution changed (e.g. user zoomed in or out)
          // Extrapolate exact timestamp of left and right viewport edges from previous points
          const logicalToTime = (logicalIndex: number): number => {
            if (logicalIndex < 0) {
              return prevFirstTime + logicalIndex * prevDt;
            }
            if (logicalIndex > prevPointsCount - 1) {
              return prevLastTime + (logicalIndex - (prevPointsCount - 1)) * prevDt;
            }
            const baseIdx = Math.floor(logicalIndex);
            const frac = logicalIndex - baseIdx;
            const nextIdx = Math.min(prevPointsCount - 1, baseIdx + 1);
            const t1 = prevPointsRef[baseIdx]!.timeSec;
            const t2 = prevPointsRef[nextIdx]!.timeSec;
            return t1 + frac * (t2 - t1);
          };

          const tFrom = logicalToTime(prevLogicalRange.from);
          const tTo = logicalToTime(prevLogicalRange.to);

          targetLogicalRange = {
            from: timeToLogical(tFrom),
            to: timeToLogical(tTo),
          };
        }
      } else if (targetRange && targetRange.fromSec && targetRange.toSec) {
        targetLogicalRange = {
          from: timeToLogical(targetRange.fromSec),
          to: timeToLogical(targetRange.toSec),
        };
      }

      if (targetLogicalRange) {
        priceChart.timeScale().setVisibleLogicalRange(targetLogicalRange);
        basisChart.timeScale().setVisibleLogicalRange(targetLogicalRange);
      }
    }

    syncPriceScaleWidths(fitContent);
  };

  const destroy = () => {
    if (programmaticTimer !== null) {
      clearTimeout(programmaticTimer);
      programmaticTimer = null;
    }
    if (syncWidthsRafId !== null) {
      cancelAnimationFrame(syncWidthsRafId);
      syncWidthsRafId = null;
    }
    if (resizeResetRafId !== null) {
      cancelAnimationFrame(resizeResetRafId);
      resizeResetRafId = null;
    }
    resizeObserver.disconnect();
    priceContainer.removeEventListener("mouseleave", handleMouseLeave);
    basisContainer.removeEventListener("mouseleave", handleMouseLeave);
    try {
      priceChart.unsubscribeCrosshairMove(handleMove);
      basisChart.unsubscribeCrosshairMove(handleMove);
      priceChart.timeScale().unsubscribeSizeChange(onTimeScaleSizeChange);
      basisChart.timeScale().unsubscribeSizeChange(onTimeScaleSizeChange);
    } catch {}
    priceChart.remove();
    basisChart.remove();
  };

  const setShowBands = (visible: boolean) => {
    upperBandSeries.applyOptions({ visible });
    smaSeries.applyOptions({ visible });
    lowerBandSeries.applyOptions({ visible });
  };

  const updateRealtimePoint = (point: BasisPoint, updateSeries = true) => {
    if (!point) return;

    const lastIdx = currentPointsList.length - 1;
    const isNewBar = lastIdx < 0 || point.timeSec > currentPointsList[lastIdx]!.timeSec;

    if (updateSeries) {
      if (isNewBar) {
        markProgrammaticUpdate(50);
      }
      rhSeries.update({ time: point.timeSec as UTCTimestamp, value: point.rhPrice });
      coreSeries.update({ time: point.timeSec as UTCTimestamp, value: point.corePrice });
      basisSeries.update({ time: point.timeSec as UTCTimestamp, value: point.basisUsd });
    }

    if (lastIdx >= 0 && currentPointsList[lastIdx]!.timeSec === point.timeSec) {
      currentPointsList[lastIdx] = point;
    } else if (lastIdx >= 0 && point.timeSec > currentPointsList[lastIdx]!.timeSec) {
      currentPointsList.push(point);
    } else if (lastIdx < 0) {
      currentPointsList.push(point);
    }
    currentPointsMap.set(point.timeSec, point);

    if (!isHovering) {
      updatePriceLines(point);
    }
  };

  const isUserHovering = () => isHovering;

  const resize = () => {
    const pw = priceContainer.clientWidth;
    const ph = priceContainer.clientHeight;
    const bw = basisContainer.clientWidth;
    const bh = basisContainer.clientHeight;

    const priceChanged = pw > 0 && ph > 0 && (pw !== lastPriceWidth || ph !== lastPriceHeight);
    const basisChanged = bw > 0 && bh > 0 && (bw !== lastBasisWidth || bh !== lastBasisHeight);
    if (!priceChanged && !basisChanged) return;

    markResizing();

    if (priceChanged) {
      lastPriceWidth = pw;
      lastPriceHeight = ph;
      priceChart.applyOptions({ width: pw, height: ph });
    }
    if (basisChanged) {
      lastBasisWidth = bw;
      lastBasisHeight = bh;
      basisChart.applyOptions({ width: bw, height: bh });
    }
    syncPriceScaleWidths(false);
  };

  return {
    priceChart,
    basisChart,
    rhSeries,
    coreSeries,
    rhPriceLine,
    corePriceLine,
    basisSeries,
    basisPriceLine,
    smaSeries,
    upperBandSeries,
    lowerBandSeries,
    destroy,
    setData,
    setShowBands,
    updateRealtimePoint,
    isUserHovering,
    resize,
  };
}
