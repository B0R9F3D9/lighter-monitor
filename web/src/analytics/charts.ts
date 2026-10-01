import {
  BaselineSeries,
  ColorType,
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BasisPoint } from "./types";
import { extrapolateTimeRange } from "./math";

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
  smaSeries: ISeriesApi<"Line">;
  upperBandSeries: ISeriesApi<"Line">;
  lowerBandSeries: ISeriesApi<"Line">;
  destroy: () => void;
  setData: (
    points: BasisPoint[],
    bands: Array<{ timeSec: number; sma: number; upper: number; lower: number }>,
    fitContent?: boolean,
    targetRange?: { fromSec: number; toSec: number },
  ) => void;
}

export function initAnalyticsCharts(
  priceContainer: HTMLElement,
  basisContainer: HTMLElement,
  callbacks?: AnalyticsChartCallbacks | ((point: BasisPoint | null) => void),
): ChartSyncContext {
  const commonOptions = {
    layout: {
      background: { type: ColorType.Solid, color: "#0B0C0E" },
      textColor: "#8B949E",
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: "#16191D" },
      horzLines: { color: "#16191D" },
    },
    crosshair: {
      vertLine: {
        color: "#484F58",
        width: 1 as const,
        style: LineStyle.Dashed,
        labelBackgroundColor: "#181B20",
      },
      horzLine: {
        color: "#484F58",
        width: 1 as const,
        style: LineStyle.Dashed,
        labelBackgroundColor: "#181B20",
      },
    },
    timeScale: {
      borderColor: "#1F2328",
      timeVisible: true,
      secondsVisible: false,
    },
    rightPriceScale: {
      borderColor: "#1F2328",
    },
  };

  // 1. Price Chart (Top)
  const priceChart = createChart(priceContainer, {
    ...commonOptions,
    width: priceContainer.clientWidth || 800,
    height: 340,
    crosshair: {
      ...commonOptions.crosshair,
      horzLine: {
        color: "#30363D",
        width: 1 as const,
        style: LineStyle.Dashed,
        labelVisible: false, // The price scale badges are driven dynamically by RH & Core hovered prices
      },
    },
  });

  const rhSeries = priceChart.addSeries(LineSeries, {
    color: "#58A6FF",
    lineWidth: 2,
    lastValueVisible: false,
    priceLineVisible: false,
    priceFormat: { type: "price", precision: 2, minMove: 0.01 },
  });

  const coreSeries = priceChart.addSeries(LineSeries, {
    color: "#8B949E",
    lineWidth: 2,
    lastValueVisible: false,
    priceLineVisible: false,
    priceFormat: { type: "price", precision: 2, minMove: 0.01 },
  });

  // Dedicated dynamic price lines for RH and Core prices on the right price scale
  const rhPriceLine = rhSeries.createPriceLine({
    price: 0,
    color: "#58A6FF",
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    lineVisible: true,
    axisLabelVisible: true,
    title: "RH",
    axisLabelColor: "#58A6FF",
    axisLabelTextColor: "#0B0C0E",
  });

  const corePriceLine = coreSeries.createPriceLine({
    price: 0,
    color: "#8B949E",
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    lineVisible: true,
    axisLabelVisible: true,
    title: "Core",
    axisLabelColor: "#30363D",
    axisLabelTextColor: "#FFFFFF",
  });

  // 2. Basis & Spread Sub-Chart (Bottom)
  const basisChart = createChart(basisContainer, {
    ...commonOptions,
    width: basisContainer.clientWidth || 800,
    height: 220,
  });

  // BaselineSeries: above 0 (RH expensive) is slate/accent, below 0 (RH discount) is emerald green
  const basisSeries = basisChart.addSeries(BaselineSeries, {
    baseValue: { type: "price", price: 0 },
    topLineColor: "#58A6FF",
    topFillColor1: "rgba(88, 166, 255, 0.10)",
    topFillColor2: "rgba(88, 166, 255, 0.01)",
    bottomLineColor: "#2EA043",
    bottomFillColor1: "rgba(46, 160, 67, 0.01)",
    bottomFillColor2: "rgba(46, 160, 67, 0.10)",
    lineWidth: 2,
    priceFormat: { type: "price", precision: 3, minMove: 0.001 },
  });

  const upperBandSeries = basisChart.addSeries(LineSeries, {
    color: "rgba(139, 148, 158, 0.40)",
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    title: "Upper (+2σ)",
    lastValueVisible: false,
    priceLineVisible: false,
  });

  const smaSeries = basisChart.addSeries(LineSeries, {
    color: "rgba(110, 118, 129, 0.55)",
    lineWidth: 1,
    lineStyle: LineStyle.Solid,
    title: "SMA (Mean)",
    lastValueVisible: false,
    priceLineVisible: false,
  });

  const lowerBandSeries = basisChart.addSeries(LineSeries, {
    color: "rgba(139, 148, 158, 0.40)",
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    title: "Lower (-2σ)",
    lastValueVisible: false,
    priceLineVisible: false,
  });

  // Zero Reference Line in Basis Sub-chart
  basisSeries.createPriceLine({
    price: 0,
    color: "#30363D",
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: "0.00",
  });

  let isSyncing = false;
  let isProgrammaticUpdate = false;
  let currentPointsList: BasisPoint[] = [];
  const currentPointsMap = new Map<number, BasisPoint>();

  const onCrosshairMove =
    typeof callbacks === "function" ? callbacks : callbacks?.onCrosshairMove;
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
      if (logicalRange && logicalRange.to <= currentPointsList.length - 1 && (vis.to as number) > 0) {
        toSec = Math.max(toSec, vis.to as number);
      }
    }

    if (toSec <= fromSec) return null;
    return { fromSec, toSec };
  }

  function handleUserRangeChange() {
    if (isProgrammaticUpdate || isSyncing || !onVisibleRangeChange) return;
    const range = computeExtrapolatedRange();
    if (range) {
      onVisibleRangeChange(range);
    }
  }

  // Synchronize TimeScales (scroll & zoom together)
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!range) return;
    if (!isSyncing) {
      isSyncing = true;
      basisChart.timeScale().setVisibleLogicalRange(range);
      isSyncing = false;
    }
    handleUserRangeChange();
  });

  basisChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!range) return;
    if (!isSyncing) {
      isSyncing = true;
      priceChart.timeScale().setVisibleLogicalRange(range);
      isSyncing = false;
    }
    handleUserRangeChange();
  });

  function updatePriceLines(point: BasisPoint | null) {
    let p = point;
    if (!p && currentPointsList.length > 0) {
      p = currentPointsList[currentPointsList.length - 1];
    }

    if (!p || typeof p.rhPrice !== "number" || typeof p.corePrice !== "number" || p.rhPrice <= 0) {
      rhPriceLine.applyOptions({ axisLabelVisible: false, lineVisible: false });
      corePriceLine.applyOptions({ axisLabelVisible: false, lineVisible: false });
      return;
    }

    rhPriceLine.applyOptions({
      price: p.rhPrice,
      axisLabelVisible: true,
      lineVisible: true,
    });
    corePriceLine.applyOptions({
      price: p.corePrice,
      axisLabelVisible: true,
      lineVisible: true,
    });
  }

  // Crosshair move handler (drives dynamic price scale labels on right)
  const handleMove = (param: { time?: Time; point?: { x: number; y: number } }) => {
    if (!param.time || !param.point) {
      updatePriceLines(null);
      if (onCrosshairMove) onCrosshairMove(null);
      return;
    }
    const tSec = typeof param.time === "number" ? param.time : 0;
    const pt = currentPointsMap.get(tSec) || null;
    updatePriceLines(pt);
    if (onCrosshairMove) onCrosshairMove(pt);
  };

  priceChart.subscribeCrosshairMove(handleMove);
  basisChart.subscribeCrosshairMove(handleMove);

  const handleMouseLeave = () => {
    updatePriceLines(null);
    if (onCrosshairMove) onCrosshairMove(null);
  };

  priceContainer.addEventListener("mouseleave", handleMouseLeave);
  basisContainer.addEventListener("mouseleave", handleMouseLeave);

  // Responsive resize
  const resizeObserver = new ResizeObserver(() => {
    if (priceContainer.clientWidth > 0) {
      priceChart.applyOptions({ width: priceContainer.clientWidth });
      basisChart.applyOptions({ width: basisContainer.clientWidth });
    }
  });

  resizeObserver.observe(priceContainer);

  const setData = (
    points: BasisPoint[],
    bands: Array<{ timeSec: number; sma: number; upper: number; lower: number }>,
    fitContent = true,
    targetRange?: { fromSec: number; toSec: number },
  ) => {
    isProgrammaticUpdate = true;
    currentPointsList = points;
    currentPointsMap.clear();
    for (const p of points) {
      currentPointsMap.set(p.timeSec, p);
    }

    const rhLineData = points.map((p) => ({ time: p.timeSec as UTCTimestamp, value: p.rhPrice }));
    const coreLineData = points.map((p) => ({
      time: p.timeSec as UTCTimestamp,
      value: p.corePrice,
    }));
    const basisData = points.map((p) => ({ time: p.timeSec as UTCTimestamp, value: p.basisUsd }));

    const smaData = bands.map((b) => ({ time: b.timeSec as UTCTimestamp, value: b.sma }));
    const upperData = bands.map((b) => ({ time: b.timeSec as UTCTimestamp, value: b.upper }));
    const lowerData = bands.map((b) => ({ time: b.timeSec as UTCTimestamp, value: b.lower }));

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
    } else if (targetRange && targetRange.fromSec && targetRange.toSec) {
      const range = {
        from: targetRange.fromSec as UTCTimestamp,
        to: targetRange.toSec as UTCTimestamp,
      };
      priceChart.timeScale().setVisibleRange(range);
      basisChart.timeScale().setVisibleRange(range);
    } else {
      const savedRange = priceChart.timeScale().getVisibleRange();
      if (savedRange) {
        priceChart.timeScale().setVisibleRange(savedRange);
        basisChart.timeScale().setVisibleRange(savedRange);
      }
    }

    setTimeout(() => {
      isProgrammaticUpdate = false;
    }, 60);
  };

  const destroy = () => {
    resizeObserver.disconnect();
    priceContainer.removeEventListener("mouseleave", handleMouseLeave);
    basisContainer.removeEventListener("mouseleave", handleMouseLeave);
    priceChart.remove();
    basisChart.remove();
  };

  return {
    priceChart,
    basisChart,
    rhSeries,
    coreSeries,
    rhPriceLine,
    corePriceLine,
    basisSeries,
    smaSeries,
    upperBandSeries,
    lowerBandSeries,
    destroy,
    setData,
  };
}
