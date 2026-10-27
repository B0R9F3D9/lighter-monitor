import { fetchHistoricalBasis, fetchMarketPairs, fetchRawCandles, TIMEFRAMES } from "./api";
import { type ChartSyncContext, initAnalyticsCharts } from "./charts";
import {
  alignCandlesToBasisPoints,
  calculateHourlyBuckets,
  calculateQuantStats,
  calculateRollingBands,
  chooseDateFilterResolution,
  chooseOptimalResolution,
  computeDateFilterIntervals,
  dedupeAndSortCandles,
  formatMarketPrice,
  getTokenIcon,
  getTokenImageUrl,
  splitIntervalsIntoApiChunks,
} from "./math";
import { highlightHeatmapHour, renderHourlyHeatmap } from "./heatmap";
import type {
  AnalyticsMarketPair,
  AnalyticsVenue,
  BasisPoint,
  DateFilterConfig,
  QuantStats,
  RawCandle,
  TimeframeId,
} from "./types";
import { CONFIG, matchesCategoryFilter, formatMoney, initFontSelector } from "../shared";

type SortField = "volume" | "oi" | "change" | "price" | "symbol";
type SortDirection = "asc" | "desc";

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
];

function formatLegendDate(timestampMs: number): string {
  const d = new Date(timestampMs);
  const mon = SHORT_MONTHS[d.getMonth()]!;
  const day = d.getDate();
  const h = d.getHours();
  const m = d.getMinutes();
  const hh = h < 10 ? `0${h}` : `${h}`;
  const mm = m < 10 ? `0${m}` : `${m}`;
  return `${mon} ${day}, ${hh}:${mm}`;
}

export function getSlugSymbolFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/analytics\/([a-zA-Z0-9_.-]+)\/?$/i);
  if (!match) return null;
  const slug = match[1].trim();
  if (
    slug.endsWith(".html") ||
    slug.endsWith(".js") ||
    slug.endsWith(".css") ||
    slug.endsWith(".json")
  ) {
    return null;
  }
  return slug.toUpperCase();
}

export class AnalyticsController {
  private pairs: AnalyticsMarketPair[] = [];
  private activeSymbol = "AAPL";
  private activeTimeframe: TimeframeId = "24h";
  private activeCategory: "all" | "stocks" | "pre_ipo" | "etf" | "crypto" | "favorites" = "all";
  private activeVenue: AnalyticsVenue = "rh";
  private currentSortField: SortField = "volume";
  private currentSortDirection: SortDirection = "desc";
  private searchQuery = "";
  private recents: string[] = ["AAPL", "NVDA", "BTC", "ETH", "SPY"];
  private favorites: Set<string> = new Set();
  private focusedModalRowIndex = 0;
  private fundingIntervalId: ReturnType<typeof setInterval> | null = null;

  private chartContext: ChartSyncContext | null = null;
  private activePoints: BasisPoint[] = [];

  private showBands = false;
  private dateFilter: DateFilterConfig = {
    isActive: false,
    fromDate: "",
    toDate: "",
    daysOfWeek: new Set([0, 1, 2, 3, 4, 5, 6]),
  };
  private modalSelectedDays: Set<number> = new Set([0, 6]);
  private modalSelectedPreset: string | null = null;

  private rangeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isFetchingRange = false;
  private pendingRange: { fromSec: number; toSec: number } | null = null;
  private lastRequestedRange: { fromSec: number; toSec: number; resolution: string } | null = null;

  private currentRequestId = 0;
  private lastHighlightedHeatmapHour: number | null = null;
  private legendElements: {
    rhVal: HTMLElement | null;
    coreVal: HTMLElement | null;
    basisVal: HTMLElement | null;
    bpsVal: HTMLElement | null;
    timeVal: HTMLElement | null;
  } | null = null;

  public async init(): Promise<void> {
    try {
      this.restoreSettings();
      this.updateInitialHeaderDisplay();
      this.initCharts();
      this.setupEventListeners();
      this.setLoading(true);
      await this.loadPairs();
      await this.loadData();
    } finally {
      this.setLoading(false);
    }
  }

  private updateInitialHeaderDisplay(): void {
    const symEl = document.getElementById("headerSymbol");
    if (symEl) symEl.textContent = this.activeSymbol;
    const imgEl = document.getElementById("tickerTokenImg") as HTMLImageElement | null;
    const iconEl = document.getElementById("tickerTokenIcon");
    if (imgEl) {
      imgEl.src = getTokenImageUrl(this.activeSymbol);
      imgEl.alt = this.activeSymbol;
      imgEl.style.display = "block";
    }
    if (iconEl) {
      iconEl.textContent = getTokenIcon(this.activeSymbol);
    }
    if (typeof document !== "undefined") {
      document.title = `${this.activeSymbol} Analytics | Lighter × Robinhood`;
    }
  }

  private restoreSettings(): void {
    try {
      let resolvedSymbol: string | null = null;
      if (typeof window !== "undefined") {
        resolvedSymbol = getSlugSymbolFromPath(window.location.pathname);
        if (!resolvedSymbol && window.location.search) {
          const params = new URLSearchParams(window.location.search);
          const q = params.get("token") || params.get("symbol");
          if (q && q.trim()) resolvedSymbol = q.trim().toUpperCase();
        }
        if (!resolvedSymbol && (window as any)["__INITIAL_ANALYTICS_SYMBOL__"]) {
          resolvedSymbol = (window as any)["__INITIAL_ANALYTICS_SYMBOL__"];
        }
      }

      if (resolvedSymbol) {
        this.activeSymbol = resolvedSymbol;
        try {
          localStorage.setItem("analytics_symbol", resolvedSymbol);
        } catch {}
      } else {
        const sym = localStorage.getItem("analytics_symbol");
        if (sym) this.activeSymbol = sym;
      }
      const tf = localStorage.getItem("analytics_timeframe") as TimeframeId;
      if (tf && TIMEFRAMES[tf]) this.activeTimeframe = tf;
      this.updateTimeframeButtons();

      const savedVenue = localStorage.getItem("analytics_venue") as AnalyticsVenue;
      if (savedVenue === "rh" || savedVenue === "core") {
        this.activeVenue = savedVenue;
      }
      this.updateVenueButtons();

      const savedSortField = localStorage.getItem("analytics_sort_field") as SortField;
      if (
        savedSortField &&
        ["volume", "oi", "change", "price", "symbol"].includes(savedSortField)
      ) {
        this.currentSortField = savedSortField;
      }
      const savedSortDir = localStorage.getItem("analytics_sort_dir") as SortDirection;
      if (savedSortDir && (savedSortDir === "asc" || savedSortDir === "desc")) {
        this.currentSortDirection = savedSortDir;
      }

      const savedRecents = localStorage.getItem("analytics_recent_symbols");
      if (savedRecents) {
        const parsed = JSON.parse(savedRecents);
        if (Array.isArray(parsed) && parsed.length > 0) this.recents = parsed;
      }

      const savedFavs = localStorage.getItem("analytics_favorite_symbols");
      if (savedFavs) {
        const parsed = JSON.parse(savedFavs);
        if (Array.isArray(parsed)) this.favorites = new Set(parsed);
      }

      const savedBands = localStorage.getItem("analytics_show_bands");
      if (savedBands === "true") this.showBands = true;
    } catch {}
  }

  private saveSettings(): void {
    try {
      localStorage.setItem("analytics_symbol", this.activeSymbol);
      localStorage.setItem("analytics_timeframe", this.activeTimeframe);
      localStorage.setItem("analytics_venue", this.activeVenue);
      localStorage.setItem("analytics_sort_field", this.currentSortField);
      localStorage.setItem("analytics_sort_dir", this.currentSortDirection);
      localStorage.setItem("analytics_recent_symbols", JSON.stringify(this.recents));
      localStorage.setItem(
        "analytics_favorite_symbols",
        JSON.stringify(Array.from(this.favorites)),
      );
      localStorage.setItem("analytics_show_bands", String(this.showBands));
    } catch {}
  }

  private async loadPairs(): Promise<void> {
    try {
      this.pairs = await fetchMarketPairs();
      this.applyVenueStats();
      this.updateVenueButtons();
      // If active symbol is not in pairs, pick first equity
      if (!this.pairs.some((p) => p.symbol === this.activeSymbol)) {
        const firstEquity = this.pairs.find((p) => p.isEquity) || this.pairs[0];
        if (firstEquity) this.activeSymbol = firstEquity.symbol;
      }
      this.updateUrl(false);
      const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
      if (pair) this.updateTopMarketStats(pair);
      this.updateSortIndicators();
      this.renderRecents();
      this.renderTickerSelector();
    } catch (err) {
      console.error("Failed to load pairs:", err);
    }
  }

  private updateUrl(push = true): void {
    if (typeof window === "undefined" || !window.history) return;
    const targetPath = `/analytics/${this.activeSymbol}`;
    if (window.location.pathname === targetPath) {
      if (typeof document !== "undefined") {
        document.title = `${this.activeSymbol} Analytics | Lighter × Robinhood`;
      }
      return;
    }

    const newUrl = `${targetPath}${window.location.search}${window.location.hash}`;
    if (push) {
      window.history.pushState(null, "", newUrl);
    } else {
      window.history.replaceState(null, "", newUrl);
    }
    if (typeof document !== "undefined") {
      document.title = `${this.activeSymbol} Analytics | Lighter × Robinhood`;
    }
  }

  private initCharts(): void {
    const priceContainer = document.getElementById("priceChartContainer");
    const basisContainer = document.getElementById("basisChartContainer");
    if (!priceContainer || !basisContainer) return;

    try {
      const savedPriceH = localStorage.getItem("analytics_price_chart_h");
      if (savedPriceH) {
        const ph = parseInt(savedPriceH, 10);
        if (!isNaN(ph) && ph >= 180 && ph <= 1200) {
          priceContainer.style.height = `${ph}px`;
          document.documentElement.style.setProperty("--price-chart-h", `${ph}px`);
        }
      }
      const savedBasisH = localStorage.getItem("analytics_basis_chart_h");
      if (savedBasisH) {
        const bh = parseInt(savedBasisH, 10);
        if (!isNaN(bh) && bh >= 120 && bh <= 800) {
          basisContainer.style.height = `${bh}px`;
          document.documentElement.style.setProperty("--basis-chart-h", `${bh}px`);
        }
      }
    } catch {}

    this.chartContext = initAnalyticsCharts(priceContainer, basisContainer, {
      onCrosshairMove: (point) => {
        this.updateLegend(point);
        this.updateHeatmapHover(point);
      },
      onVisibleRangeChange: (range) => {
        this.onVisibleTimeRangeChange(range);
      },
    });

    if (this.showBands) this.chartContext.setShowBands(true);
    this.updateBandsButton();

    this.setupChartResizers();
  }

  private async loadData(): Promise<void> {
    const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
    if (!pair) return;

    if (this.dateFilter.isActive) {
      await this.applyDateFilter(this.dateFilter);
      return;
    }

    if (this.rangeDebounceTimer) {
      clearTimeout(this.rangeDebounceTimer);
      this.rangeDebounceTimer = null;
    }
    this.pendingRange = null;
    this.lastRequestedRange = null;

    this.setLoading(true);
    const tf = TIMEFRAMES[this.activeTimeframe];
    const reqId = ++this.currentRequestId;
    const currentSymbol = pair.symbol;

    try {
      const { points, stats, bands } = await fetchHistoricalBasis(pair, tf);
      if (reqId !== this.currentRequestId || this.activeSymbol !== currentSymbol) {
        return;
      }
      this.activePoints = points;

      if (this.chartContext) {
        this.chartContext.setData(points, bands, true, undefined, pair.hedgeSideConfig.isRhLong);
      }

      this.updateQuantGauges(stats);
      this.renderHeatmap();
      this.updateTopMarketStats(pair);
      this.updateLegend(points[points.length - 1] || null);
    } catch (err) {
      if (reqId === this.currentRequestId) {
        console.error("Failed to fetch historical basis:", err);
      }
    } finally {
      if (reqId === this.currentRequestId) {
        this.setLoading(false);
      }
    }
  }

  private onVisibleTimeRangeChange(range: { fromSec: number; toSec: number }): void {
    if (this.dateFilter.isActive) return;

    if (this.rangeDebounceTimer) {
      clearTimeout(this.rangeDebounceTimer);
      this.rangeDebounceTimer = null;
    }

    this.rangeDebounceTimer = setTimeout(() => {
      this.fetchRangeDataDebounced(range.fromSec, range.toSec);
    }, 350);
  }

  private chooseResolution(spanSec: number): { resolution: string; stepSec: number } {
    return chooseOptimalResolution(spanSec);
  }

  private async fetchRangeDataDebounced(fromSec: number, toSec: number): Promise<void> {
    if (!fromSec || !toSec || toSec <= fromSec) return;

    if (this.isFetchingRange) {
      this.pendingRange = { fromSec, toSec };
      return;
    }

    const spanSec = toSec - fromSec;
    const { resolution, stepSec } = this.chooseResolution(spanSec);

    // If resolution is unchanged and viewport shifted by less than 10%, skip redundant fetch
    if (this.lastRequestedRange && this.lastRequestedRange.resolution === resolution) {
      const fromDiff = Math.abs(fromSec - this.lastRequestedRange.fromSec);
      const toDiff = Math.abs(toSec - this.lastRequestedRange.toSec);
      if (fromDiff < spanSec * 0.1 && toDiff < spanSec * 0.1) {
        return;
      }
    }

    const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
    if (!pair) return;

    this.isFetchingRange = true;
    this.lastRequestedRange = { fromSec, toSec, resolution };
    this.setRangeLoading(true);
    const reqId = ++this.currentRequestId;
    const currentSymbol = pair.symbol;

    try {
      const bufferSec = Math.floor(spanSec * 0.25);
      const queryStart = Math.max(0, fromSec - bufferSec);
      const queryEnd = Math.min(Math.floor(Date.now() / 1000), toSec + bufferSec);
      const expectedCount = Math.ceil((queryEnd - queryStart) / stepSec);
      const countBack = Math.min(500, Math.max(20, expectedCount + 20));

      const [rhCandles, coreCandles] = await Promise.all([
        fetchRawCandles(
          CONFIG.RH_API_URL,
          pair.rhMarketId,
          resolution,
          queryStart,
          queryEnd,
          countBack,
        ),
        fetchRawCandles(
          CONFIG.CORE_API_URL,
          pair.coreMarketId,
          resolution,
          queryStart,
          queryEnd,
          countBack,
        ),
      ]);

      if (reqId !== this.currentRequestId || this.activeSymbol !== currentSymbol) {
        return;
      }

      const points = alignCandlesToBasisPoints(rhCandles, coreCandles);
      if (points.length >= 2) {
        const stats = calculateQuantStats(points, pair.hedgeSideConfig.isRhLong);
        const bands = calculateRollingBands(points, 20);

        this.activePoints = points;

        if (this.chartContext) {
          this.chartContext.setData(
            points,
            bands,
            false,
            { fromSec, toSec },
            pair.hedgeSideConfig.isRhLong,
          );
        }

        this.updateQuantGauges(stats);
        this.renderHeatmap();
        this.updateLegend(points[points.length - 1] || null);
        this.clearActiveTimeframeButtons();
      }
    } catch (err) {
      if (reqId === this.currentRequestId) {
        console.warn("Failed to fetch viewport historical candles:", err);
      }
    } finally {
      this.isFetchingRange = false;
      this.setRangeLoading(false);

      if (this.pendingRange) {
        const next = this.pendingRange;
        this.pendingRange = null;
        this.fetchRangeDataDebounced(next.fromSec, next.toSec);
      }
    }
  }

  private setRangeLoading(isLoading: boolean): void {
    const el = document.getElementById("chartRangeLoading");
    if (!el) return;
    if (isLoading) {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }

  private clearActiveTimeframeButtons(): void {
    document.querySelectorAll(".tf-btn").forEach((btn) => {
      btn.className =
        "tf-btn px-2 py-0.5 rounded text-terminal-muted hover:text-white transition cursor-pointer whitespace-nowrap";
    });
  }

  private setLoading(isLoading: boolean, message?: string): void {
    const loader = document.getElementById("chartLoadingOverlay");
    if (loader) {
      if (isLoading) {
        loader.classList.remove("hidden");
        loader.classList.add("flex");
        const msgEl = document.getElementById("chartLoadingMessage");
        if (msgEl) {
          msgEl.textContent =
            message ||
            `Syncing ${this.activeSymbol} candles from Robinhood Chain & Lighter Core...`;
        }
      } else {
        loader.classList.add("hidden");
        loader.classList.remove("flex");
      }
    }
  }

  private updateTopMarketStats(pair: AnalyticsMarketPair): void {
    const symEl = document.getElementById("headerSymbol");
    const levEl = document.getElementById("headerLeverage");
    const iconEl = document.getElementById("tickerTokenIcon");
    const imgEl = document.getElementById("tickerTokenImg") as HTMLImageElement | null;
    if (symEl) symEl.textContent = pair.symbol;
    if (levEl) levEl.textContent = pair.leverage;
    if (iconEl) iconEl.textContent = getTokenIcon(pair.symbol);
    if (imgEl) {
      imgEl.style.display = "block";
      if (iconEl) iconEl.style.display = "none";
      imgEl.src = getTokenImageUrl(pair.symbol);
      imgEl.addEventListener(
        "error",
        () => {
          imgEl.style.display = "none";
          if (iconEl) iconEl.style.display = "flex";
        },
        { once: true },
      );
    }

    const markEl = document.getElementById("statMarkPrice");
    const indexEl = document.getElementById("statIndexPrice");
    const changeEl = document.getElementById("stat24hChange");
    const volEl = document.getElementById("stat24hVolume");
    const oiEl = document.getElementById("statOpenInterest");
    const fundingEl = document.getElementById("stat1hFunding");

    if (markEl) markEl.textContent = formatMarketPrice(pair.markPrice);
    if (indexEl) indexEl.textContent = formatMarketPrice(pair.indexPrice);

    if (changeEl) {
      const sign = pair.dailyPriceChange >= 0 ? "+" : "";
      changeEl.textContent = `${sign}${pair.dailyPriceChange.toFixed(2)}%`;
      changeEl.className =
        pair.dailyPriceChange >= 0
          ? "text-xs sm:text-sm font-bold tabular-nums text-terminal-emerald"
          : "text-xs sm:text-sm font-bold tabular-nums text-terminal-coral";
    }

    if (volEl) volEl.textContent = formatMoney(pair.totalVolume24h);
    if (oiEl) oiEl.textContent = formatMoney(pair.openInterestUsd);

    if (fundingEl) {
      const sign = pair.fundingRate1h >= 0 ? "+" : "";
      fundingEl.textContent = `${sign}${pair.fundingRate1h.toFixed(4)}%`;
      fundingEl.className =
        pair.fundingRate1h >= 0
          ? "text-xs sm:text-sm font-bold tabular-nums text-terminal-emerald"
          : "text-xs sm:text-sm font-bold tabular-nums text-terminal-coral";
    }

    this.startFundingCountdown();
  }

  private updateFundingCountdown(): void {
    const now = new Date();
    const minsLeft = 59 - now.getUTCMinutes();
    const secsLeft = 59 - now.getUTCSeconds();
    const el = document.getElementById("statNextFunding");
    if (el) {
      el.textContent = `${String(minsLeft).padStart(2, "0")}:${String(secsLeft).padStart(2, "0")}`;
    }
  }

  private startFundingCountdown(): void {
    this.updateFundingCountdown();
    if (!this.fundingIntervalId) {
      this.fundingIntervalId = setInterval(() => this.updateFundingCountdown(), 1000);
    }
  }

  private updateLegend(point: BasisPoint | null): void {
    if (!this.legendElements) {
      this.legendElements = {
        rhVal: document.getElementById("legendRhPrice"),
        coreVal: document.getElementById("legendCorePrice"),
        basisVal: document.getElementById("legendBasisUsd"),
        bpsVal: document.getElementById("legendBasisBps"),
        timeVal: document.getElementById("legendTimestamp"),
      };
    }

    if (!point) {
      if (this.activePoints.length > 0) {
        point = this.activePoints[this.activePoints.length - 1]!;
      } else {
        return;
      }
    }

    const { rhVal, coreVal, basisVal, bpsVal, timeVal } = this.legendElements;

    if (rhVal) rhVal.textContent = `$${point.rhPrice.toFixed(2)}`;
    if (coreVal) coreVal.textContent = `$${point.corePrice.toFixed(2)}`;

    const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
    const isRhLong = pair ? pair.hedgeSideConfig.isRhLong : true;
    const isEdge = isRhLong ? point.basisUsd <= 0 : point.basisUsd >= 0;

    const sign = point.basisUsd > 0 ? "+" : "";
    if (basisVal) {
      basisVal.textContent = `${sign}$${point.basisUsd.toFixed(3)}`;
      const targetClass = isEdge
        ? "font-bold tabular-nums text-terminal-emerald"
        : "font-bold tabular-nums text-terminal-accent";
      if (basisVal.className !== targetClass) {
        basisVal.className = targetClass;
      }
    }

    if (bpsVal) {
      bpsVal.textContent = `${sign}${point.basisBps.toFixed(2)} bps`;
      const targetClass = isEdge
        ? "font-bold tabular-nums text-terminal-emerald"
        : "font-bold tabular-nums text-terminal-accent";
      if (bpsVal.className !== targetClass) {
        bpsVal.className = targetClass;
      }
    }

    if (timeVal) {
      timeVal.textContent = formatLegendDate(point.timestampMs);
    }
  }

  private updateQuantGauges(stats: QuantStats | null): void {
    if (!stats) return;

    const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
    const isRhLong = stats.isRhLong ?? (pair ? pair.hedgeSideConfig.isRhLong : true);
    const isEdge = isRhLong ? stats.currentBasisUsd <= 0 : stats.currentBasisUsd >= 0;

    const sign = stats.currentBasisUsd > 0 ? "+" : "";
    const basisEl = document.getElementById("statCurrentBasis");
    const basisBpsEl = document.getElementById("statCurrentBasisBps");
    const meanEl = document.getElementById("statMeanBasis");
    const stdDevEl = document.getElementById("statStdDev");
    const zScoreEl = document.getElementById("statZScore");
    const percentileEl = document.getElementById("statPercentile");
    const verdictEl = document.getElementById("statVerdictBadge");
    const rangeEl = document.getElementById("statRange");

    if (basisEl) {
      basisEl.textContent = `${sign}$${stats.currentBasisUsd.toFixed(3)}`;
      basisEl.className = isEdge
        ? "text-sm font-bold tabular-nums text-terminal-emerald"
        : "text-sm font-bold tabular-nums text-white";
    }

    if (basisBpsEl) {
      basisBpsEl.textContent = `(${sign}${stats.currentBasisBps.toFixed(1)} bps)`;
      basisBpsEl.className = isEdge
        ? "text-[11px] tabular-nums text-terminal-emerald"
        : "text-[11px] tabular-nums text-terminal-muted";
    }

    if (meanEl) {
      const meanSign = stats.meanBasisUsd > 0 ? "+" : "";
      meanEl.textContent = `${meanSign}$${stats.meanBasisUsd.toFixed(3)} (${meanSign}${stats.meanBasisBps.toFixed(1)} bps)`;
    }

    if (stdDevEl) {
      stdDevEl.textContent = `±$${stats.stdDevUsd.toFixed(3)} (±${stats.stdDevBps.toFixed(1)} bps)`;
    }

    if (zScoreEl) {
      const zSign = stats.zScore > 0 ? "+" : "";
      zScoreEl.textContent = `${zSign}${stats.zScore.toFixed(2)}σ`;
      const effZ = stats.effectiveZScore ?? (isRhLong ? stats.zScore : -stats.zScore);
      zScoreEl.className =
        effZ <= 0
          ? "font-bold tabular-nums text-terminal-emerald"
          : effZ <= 1.0
            ? "font-bold tabular-nums text-terminal-primary"
            : effZ <= 2.0
              ? "font-bold tabular-nums text-terminal-amber"
              : "font-bold tabular-nums text-terminal-coral";
    }

    if (percentileEl) {
      percentileEl.textContent = `${stats.percentile.toFixed(1)}%`;
    }

    if (rangeEl) {
      rangeEl.textContent = `($${stats.minBasisUsd.toFixed(2)} .. $${stats.maxBasisUsd.toFixed(2)})`;
    }

    if (verdictEl) {
      const effZ = stats.effectiveZScore ?? (isRhLong ? stats.zScore : -stats.zScore);
      const zStr = effZ <= 0 ? `${effZ.toFixed(2)}σ` : `+${effZ.toFixed(2)}σ`;
      if (stats.signal === "EXCELLENT ENTRY") {
        verdictEl.textContent = `EXCELLENT (${zStr})`;
        verdictEl.className = "text-[11px] font-semibold text-terminal-emerald select-text";
      } else if (stats.signal === "FAIR") {
        verdictEl.textContent = `FAIR (${zStr})`;
        verdictEl.className = "text-[11px] font-semibold text-terminal-primary select-text";
      } else if (stats.signal === "CAUTION") {
        verdictEl.textContent = `CAUTION (${zStr})`;
        verdictEl.className = "text-[11px] font-semibold text-terminal-amber select-text";
      } else {
        verdictEl.textContent = `OVERHEATED (${zStr})`;
        verdictEl.className = "text-[11px] font-semibold text-terminal-coral select-text";
      }
    }
  }

  private updateHeatmapHover(point: BasisPoint | null): void {
    const container = document.getElementById("heatmapContainer");
    if (!container) return;

    const targetHour =
      point && point.timestampMs ? new Date(point.timestampMs).getHours() : new Date().getHours();

    if (targetHour === this.lastHighlightedHeatmapHour) return;
    this.lastHighlightedHeatmapHour = targetHour;

    highlightHeatmapHour(container, targetHour);
  }

  private renderHeatmap(): void {
    const container = document.getElementById("heatmapContainer");
    if (!container) return;

    const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
    const isRhLong = pair ? pair.hedgeSideConfig.isRhLong : true;

    const buckets = calculateHourlyBuckets(this.activePoints, undefined, isRhLong);
    const nowLocalHour = new Date().getHours();
    this.lastHighlightedHeatmapHour = nowLocalHour;

    renderHourlyHeatmap(container, buckets, nowLocalHour);
  }

  private getFilteredPairs(): AnalyticsMarketPair[] {
    const list = this.pairs.filter((p) => {
      if (this.activeCategory === "favorites") {
        if (!this.favorites.has(p.symbol)) return false;
      } else if (this.activeCategory !== "all") {
        if (!matchesCategoryFilter(p.symbol, this.activeCategory)) return false;
      }

      if (this.searchQuery) {
        const q = this.searchQuery.toUpperCase();
        if (!p.symbol.toUpperCase().includes(q)) return false;
      }
      return true;
    });

    list.sort((a, b) => {
      let diff = 0;
      if (this.currentSortField === "volume") {
        diff = (a.totalVolume24h || 0) - (b.totalVolume24h || 0);
      } else if (this.currentSortField === "oi") {
        diff = (a.openInterestUsd || 0) - (b.openInterestUsd || 0);
      } else if (this.currentSortField === "change") {
        diff = (a.dailyPriceChange || 0) - (b.dailyPriceChange || 0);
      } else if (this.currentSortField === "price") {
        diff = (a.markPrice || 0) - (b.markPrice || 0);
      } else if (this.currentSortField === "symbol") {
        diff = a.symbol.localeCompare(b.symbol);
      }

      return this.currentSortDirection === "asc" ? diff : -diff;
    });

    return list;
  }

  private updateSortIndicators(): void {
    const labelEl = document.getElementById("currentSortLabel");
    const arrowEl = document.getElementById("currentSortArrow");

    const labels: Record<SortField, string> = {
      volume: "Volume",
      oi: "Open Interest",
      change: "24h Change",
      price: "Last Price",
      symbol: "Market",
    };

    if (labelEl) labelEl.textContent = labels[this.currentSortField];
    if (arrowEl) arrowEl.textContent = this.currentSortDirection === "desc" ? "↓" : "↑";

    const icons: Record<SortField, HTMLElement | null> = {
      symbol: document.getElementById("sortIconSymbol"),
      price: document.getElementById("sortIconPrice"),
      change: document.getElementById("sortIconChange"),
      volume: document.getElementById("sortIconVolume"),
      oi: document.getElementById("sortIconOi"),
    };

    for (const [field, el] of Object.entries(icons) as Array<[SortField, HTMLElement | null]>) {
      if (!el) continue;
      if (field === this.currentSortField) {
        el.textContent = this.currentSortDirection === "desc" ? "↓" : "↑";
        el.className = "text-[9px] text-terminal-accent font-bold opacity-100";
      } else {
        el.textContent = "↕";
        el.className = "text-[9px] text-terminal-muted opacity-40";
      }
    }
  }

  public setSort(field: SortField, dir?: SortDirection): void {
    if (dir) {
      this.currentSortField = field;
      this.currentSortDirection = dir;
    } else if (this.currentSortField === field) {
      this.currentSortDirection = this.currentSortDirection === "asc" ? "desc" : "asc";
    } else {
      this.currentSortField = field;
      this.currentSortDirection = field === "symbol" ? "asc" : "desc";
    }

    this.saveSettings();
    this.updateSortIndicators();
    this.focusedModalRowIndex = 0;
    this.renderTickerSelector();
  }

  private applyVenueStats(): void {
    const venue = this.activeVenue;
    for (const p of this.pairs) {
      const s = venue === "core" ? p.core : p.rh;
      p.markPrice = s.markPrice;
      p.indexPrice = s.indexPrice;
      p.dailyPriceChange = s.dailyPriceChange;
      p.dailyVolumeUsd = s.dailyVolumeUsd;
      p.totalVolume24h = s.dailyVolumeUsd;
      p.openInterestUsd = s.openInterestUsd;
      p.fundingRate1h = s.fundingRate1h;
      p.leverage = s.leverage;
    }
  }

  private updateVenueButtons(): void {
    const rhBtn = document.getElementById("venueBtnRh");
    const coreBtn = document.getElementById("venueBtnCore");
    const tag = this.activeVenue === "core" ? "CORE" : "RH";

    if (rhBtn) {
      if (this.activeVenue === "rh") {
        rhBtn.className =
          "venue-btn px-2 py-0.5 rounded bg-terminal-accent text-terminal-bg font-bold cursor-pointer transition flex items-center gap-1";
        const dot = rhBtn.querySelector("span");
        if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-terminal-bg";
      } else {
        rhBtn.className =
          "venue-btn px-2 py-0.5 rounded text-terminal-muted hover:text-white cursor-pointer transition flex items-center gap-1";
        const dot = rhBtn.querySelector("span");
        if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-terminal-muted";
      }
    }

    if (coreBtn) {
      if (this.activeVenue === "core") {
        coreBtn.className =
          "venue-btn px-2 py-0.5 rounded bg-terminal-accent text-terminal-bg font-bold cursor-pointer transition flex items-center gap-1";
        const dot = coreBtn.querySelector("span");
        if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-terminal-bg";
      } else {
        coreBtn.className =
          "venue-btn px-2 py-0.5 rounded text-terminal-muted hover:text-white cursor-pointer transition flex items-center gap-1";
        const dot = coreBtn.querySelector("span");
        if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-terminal-muted";
      }
    }

    // Update modal column header tags
    const colPrice = document.getElementById("colVenueTagPrice");
    const colVol = document.getElementById("colVenueTagVol");
    const colOi = document.getElementById("colVenueTagOi");
    if (colPrice) colPrice.textContent = tag;
    if (colVol) colVol.textContent = tag;
    if (colOi) colOi.textContent = tag;

    // Update top strip tags
    const topMark = document.getElementById("topVenueTagMark");
    const topChange = document.getElementById("topVenueTagChange");
    const topVol = document.getElementById("topVenueTagVol");
    const topOi = document.getElementById("topVenueTagOi");
    if (topMark) topMark.textContent = tag;
    if (topChange) topChange.textContent = tag;
    if (topVol) topVol.textContent = tag;
    if (topOi) topOi.textContent = tag;
  }

  public setVenue(venue: AnalyticsVenue): void {
    if (this.activeVenue === venue) return;
    this.activeVenue = venue;
    this.applyVenueStats();
    this.saveSettings();
    this.updateVenueButtons();

    const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
    if (pair) this.updateTopMarketStats(pair);

    this.focusedModalRowIndex = 0;
    this.renderTickerSelector();
  }

  private renderRecents(): void {
    const container = document.getElementById("recentsRow");
    const listEl = document.getElementById("recentsList");
    if (!listEl) return;

    if (this.recents.length === 0) {
      if (container) container.classList.add("hidden");
      return;
    }
    if (container) container.classList.remove("hidden");

    listEl.innerHTML = "";
    for (const sym of this.recents) {
      const pair = this.pairs.find((p) => p.symbol === sym);
      const icon = getTokenIcon(sym);
      const imgUrl = getTokenImageUrl(sym);
      const chip = document.createElement("a");
      chip.href = `/analytics/${encodeURIComponent(sym)}`;
      const isSelected = sym === this.activeSymbol;
      chip.className = `inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-mono transition cursor-pointer shrink-0 no-underline ${
        isSelected
          ? "bg-terminal-border border-terminal-accent/50 text-white font-bold"
          : "bg-terminal-bg border-terminal-border hover:border-terminal-muted text-terminal-secondary hover:text-white"
      }`;

      chip.innerHTML = `
        <div class="w-3.5 h-3.5 rounded-full bg-terminal-surface border border-terminal-border flex items-center justify-center text-[8px] font-bold text-white shrink-0 overflow-hidden relative">
          <img src="${imgUrl}" alt="${sym}" class="w-full h-full object-contain rounded-full" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
          <span class="hidden absolute inset-0 items-center justify-center text-[8px] font-bold text-white bg-terminal-surface">${icon}</span>
        </div>
        <span>${sym}</span>
        ${pair ? `<span class="text-[9px] text-terminal-muted">${pair.leverage}</span>` : ""}
        <span class="text-terminal-muted hover:text-terminal-coral text-[10px] pl-0.5 cursor-pointer chip-remove-btn" title="Remove">✕</span>
      `;

      chip.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains("chip-remove-btn")) {
          e.preventDefault();
          this.removeFromRecents(sym, e);
          return;
        }
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        ) {
          return;
        }
        e.preventDefault();
        this.selectSymbol(sym);
        this.closeTickerModal();
      });

      listEl.appendChild(chip);
    }
  }

  private addToRecents(symbol: string): void {
    this.recents = [symbol, ...this.recents.filter((s) => s !== symbol)].slice(0, 6);
    this.saveSettings();
    this.renderRecents();
  }

  private removeFromRecents(symbol: string, e: Event): void {
    e.stopPropagation();
    e.preventDefault();
    this.recents = this.recents.filter((s) => s !== symbol);
    this.saveSettings();
    this.renderRecents();
  }

  private toggleFavorite(symbol: string, e: Event): void {
    e.stopPropagation();
    e.preventDefault();
    if (this.favorites.has(symbol)) {
      this.favorites.delete(symbol);
    } else {
      this.favorites.add(symbol);
    }
    this.saveSettings();
    this.renderTickerSelector();
  }

  private highlightFocusedRow(): void {
    const listEl = document.getElementById("tickerDropdownList");
    if (!listEl) return;
    const rows = listEl.querySelectorAll<HTMLElement>(".ticker-modal-row");
    rows.forEach((r, idx) => {
      if (idx === this.focusedModalRowIndex) {
        r.classList.add("bg-terminal-surfaceHover");
        r.scrollIntoView({ block: "nearest" });
      } else {
        r.classList.remove("bg-terminal-surfaceHover");
      }
    });
  }

  private renderTickerSelector(): void {
    const listEl = document.getElementById("tickerDropdownList");
    const countBadge = document.getElementById("marketCountBadge");
    if (!listEl) return;

    listEl.innerHTML = "";
    const filtered = this.getFilteredPairs();

    if (countBadge) {
      countBadge.textContent = `${filtered.length} MARKETS`;
    }

    if (filtered.length === 0) {
      listEl.innerHTML =
        '<div class="p-6 text-center text-terminal-muted text-xs">No matching markets found</div>';
      return;
    }

    if (this.focusedModalRowIndex >= filtered.length) {
      this.focusedModalRowIndex = 0;
    }

    filtered.forEach((p, idx) => {
      const isSelected = p.symbol === this.activeSymbol;
      const isFocused = idx === this.focusedModalRowIndex;
      const isFav = this.favorites.has(p.symbol);
      const icon = getTokenIcon(p.symbol);
      const imgUrl = getTokenImageUrl(p.symbol);

      const changeSign = p.dailyPriceChange >= 0 ? "+" : "";
      const changeColor = p.dailyPriceChange >= 0 ? "text-terminal-emerald" : "text-terminal-coral";

      const row = document.createElement("a");
      row.href = `/analytics/${encodeURIComponent(p.symbol)}`;
      row.className = `ticker-modal-row grid grid-cols-12 items-center px-3 py-2 text-xs font-mono transition cursor-pointer no-underline ${
        isFocused ? "bg-terminal-surfaceHover" : ""
      } ${
        isSelected
          ? "bg-terminal-border/40 text-white font-bold"
          : "hover:bg-terminal-surfaceHover text-terminal-secondary"
      }`;
      row.dataset.index = String(idx);
      row.dataset.symbol = p.symbol;

      row.innerHTML = `
        <div class="col-span-5 sm:col-span-4 flex items-center gap-2 overflow-hidden">
          <span class="text-xs cursor-pointer select-none fav-star-btn ${isFav ? "text-terminal-amber" : "text-terminal-muted hover:text-terminal-amber"}" title="${isFav ? "Remove Favorite" : "Add to Favorites"}">★</span>
          <div class="w-5 h-5 rounded-full bg-terminal-surface border border-terminal-border flex items-center justify-center text-[9px] font-bold text-white shrink-0 overflow-hidden relative">
            <img src="${imgUrl}" alt="${p.symbol}" class="w-full h-full object-contain rounded-full" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
            <span class="hidden absolute inset-0 items-center justify-center text-[9px] font-bold text-white bg-terminal-surface">${icon}</span>
          </div>
          <span class="${isSelected ? "text-white font-bold" : "text-terminal-primary font-semibold"} truncate">${p.symbol}</span>
          <span class="text-[10px] text-terminal-muted px-1 rounded bg-terminal-bg border border-terminal-border shrink-0">${p.leverage}</span>
        </div>
        <div class="col-span-4 sm:col-span-2 text-right tabular-nums text-white font-semibold">${formatMarketPrice(p.markPrice)}</div>
        <div class="col-span-3 sm:col-span-2 text-right tabular-nums font-bold ${changeColor}">${changeSign}${p.dailyPriceChange.toFixed(2)}%</div>
        <div class="hidden sm:block sm:col-span-2 text-right tabular-nums text-terminal-secondary">${formatMoney(p.totalVolume24h)}</div>
        <div class="hidden sm:block sm:col-span-2 text-right tabular-nums text-terminal-muted">${formatMoney(p.openInterestUsd)}</div>
      `;

      row.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains("fav-star-btn")) {
          e.preventDefault();
          this.toggleFavorite(p.symbol, e);
          return;
        }

        // Allow opening in new tab/window when Ctrl, Cmd (Mac), Shift, Alt or middle click is used
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        ) {
          return;
        }

        e.preventDefault();
        this.selectSymbol(p.symbol);
        this.addToRecents(p.symbol);
        this.closeTickerModal();
      });

      row.addEventListener("mouseenter", () => {
        this.focusedModalRowIndex = idx;
        this.highlightFocusedRow();
      });

      listEl.appendChild(row);
    });
  }

  public selectSymbol(symbol: string, pushHistory = true): void {
    if (this.activeSymbol === symbol) {
      if (pushHistory) this.updateUrl(false);
      return;
    }
    this.currentRequestId++;
    if (this.rangeDebounceTimer) {
      clearTimeout(this.rangeDebounceTimer);
      this.rangeDebounceTimer = null;
    }
    this.pendingRange = null;
    this.activeSymbol = symbol;
    this.saveSettings();
    this.addToRecents(symbol);
    if (pushHistory) {
      this.updateUrl(true);
    }
    this.renderRecents();
    this.renderTickerSelector();
    const pair = this.pairs.find((p) => p.symbol === symbol);
    if (pair) this.updateTopMarketStats(pair);
    this.loadData();
  }

  public setTimeframe(tf: TimeframeId): void {
    if (this.dateFilter.isActive) {
      this.dateFilter.isActive = false;
      this.updateDateFilterUI();
    }
    this.activeTimeframe = tf;
    this.saveSettings();
    this.updateTimeframeButtons();
    this.loadData();
  }

  private updateTimeframeButtons(): void {
    document.querySelectorAll(".tf-btn").forEach((btn) => {
      const id = (btn as HTMLElement).dataset.tf;
      if (id === this.activeTimeframe) {
        btn.className =
          "tf-btn px-2 py-0.5 rounded bg-terminal-border text-white font-bold transition cursor-pointer whitespace-nowrap";
      } else {
        btn.className =
          "tf-btn px-2 py-0.5 rounded text-terminal-muted hover:text-white transition cursor-pointer whitespace-nowrap";
      }
    });
  }

  // --- DISPERSION BANDS CONTROLS ---

  public toggleBands(): void {
    this.showBands = !this.showBands;
    this.saveSettings();
    this.updateBandsButton();
    if (this.chartContext) {
      this.chartContext.setShowBands(this.showBands);
    }
  }

  private updateBandsButton(): void {
    const btn = document.getElementById("toggleBandsBtn");
    if (!btn) return;
    if (this.showBands) {
      btn.className =
        "text-[9px] px-1.5 py-0.5 rounded border border-terminal-accent/50 bg-terminal-accent/15 text-terminal-accent font-bold transition cursor-pointer";
    } else {
      btn.className =
        "text-[9px] px-1.5 py-0.5 rounded border border-terminal-border hover:border-terminal-muted text-terminal-muted hover:text-white transition cursor-pointer";
    }
  }

  // --- DRAGGABLE CHART RESIZERS ---

  private setupChartResizers(): void {
    const setupHandle = (
      handleId: string,
      containerId: string,
      storageKey: string,
      defaultHeight: number,
      minHeight: number,
      maxHeight: number,
    ) => {
      const handle = document.getElementById(handleId);
      const container = document.getElementById(containerId);
      if (!handle || !container) return;

      // Double-click to reset to default height
      handle.addEventListener("dblclick", () => {
        container.style.height = `${defaultHeight}px`;
        const cssVar =
          containerId === "priceChartContainer" ? "--price-chart-h" : "--basis-chart-h";
        document.documentElement.style.setProperty(cssVar, `${defaultHeight}px`);
        try {
          localStorage.removeItem(storageKey);
        } catch {}
        this.chartContext?.resize();
      });

      let startY = 0;
      let startHeight = 0;
      let isDragging = false;

      const onPointerMove = (e: PointerEvent) => {
        if (!isDragging) return;
        const deltaY = e.clientY - startY;
        const newHeight = Math.max(
          minHeight,
          Math.min(maxHeight, Math.round(startHeight + deltaY)),
        );
        container.style.height = `${newHeight}px`;
        this.chartContext?.resize();
      };

      const onPointerUp = (e: PointerEvent) => {
        if (!isDragging) return;
        isDragging = false;
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {}
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");

        const finalHeight = container.clientHeight;
        if (finalHeight >= minHeight && finalHeight <= maxHeight) {
          const cssVar =
            containerId === "priceChartContainer" ? "--price-chart-h" : "--basis-chart-h";
          document.documentElement.style.setProperty(cssVar, `${finalHeight}px`);
          try {
            localStorage.setItem(storageKey, String(finalHeight));
          } catch {}
        }
        this.chartContext?.resize();
      };

      handle.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        isDragging = true;
        startY = e.clientY;
        startHeight = container.clientHeight;

        try {
          handle.setPointerCapture(e.pointerId);
        } catch {}

        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
      });

      handle.addEventListener("pointermove", onPointerMove);
      handle.addEventListener("pointerup", onPointerUp);
      handle.addEventListener("pointercancel", onPointerUp);
    };

    setupHandle(
      "priceChartResizeHandle",
      "priceChartContainer",
      "analytics_price_chart_h",
      340,
      180,
      1200,
    );

    setupHandle(
      "basisChartResizeHandle",
      "basisChartContainer",
      "analytics_basis_chart_h",
      220,
      120,
      800,
    );
  }

  // --- DATE & DAY-OF-WEEK FILTER ---

  private getLocalDateString(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private getDayStartTimestampSec(dateStr: string): number {
    const [y, m, d] = dateStr.split("-").map(Number);
    return Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
  }

  private getDayEndTimestampSec(dateStr: string): number {
    const [y, m, d] = dateStr.split("-").map(Number);
    return Math.floor(new Date(y, m - 1, d, 23, 59, 59, 999).getTime() / 1000);
  }

  public openDateFilterModal(): void {
    const modal = document.getElementById("dateFilterModal");
    if (!modal) return;

    const fromInput = document.getElementById("dateFilterFromInput") as HTMLInputElement | null;
    const toInput = document.getElementById("dateFilterToInput") as HTMLInputElement | null;
    const now = new Date();

    if (this.dateFilter.isActive && this.dateFilter.fromDate && this.dateFilter.toDate) {
      if (fromInput) fromInput.value = this.dateFilter.fromDate;
      if (toInput) toInput.value = this.dateFilter.toDate;
      this.modalSelectedDays = new Set(this.dateFilter.daysOfWeek);
      this.modalSelectedPreset = this.dateFilter.activePresetId || this.detectMatchingPreset();
    } else {
      if (fromInput && !fromInput.value) {
        const d30 = new Date(Date.now() - 30 * 86400000);
        fromInput.value = this.getLocalDateString(d30);
      }
      if (toInput && !toInput.value) {
        toInput.value = this.getLocalDateString(now);
      }
      // Default to weekends (Sat: 6, Sun: 0)
      this.modalSelectedDays = new Set([0, 6]);
      this.modalSelectedPreset = null;
    }

    this.updateModalDayPills();
    this.updateModalPresetUi();
    modal.classList.remove("hidden");
  }

  public closeDateFilterModal(): void {
    const modal = document.getElementById("dateFilterModal");
    modal?.classList.add("hidden");
  }

  private updateModalDayPills(): void {
    document.querySelectorAll(".dow-btn").forEach((btn) => {
      const d = parseInt((btn as HTMLElement).dataset.day || "", 10);
      if (this.modalSelectedDays.has(d)) {
        btn.className =
          "dow-btn py-1.5 rounded border border-terminal-accent/50 bg-terminal-accent text-terminal-bg text-[11px] font-bold text-center transition cursor-pointer";
      } else {
        btn.className =
          "dow-btn py-1.5 rounded border border-terminal-border bg-terminal-bg text-terminal-muted hover:text-white text-[11px] font-bold text-center transition cursor-pointer";
      }
    });
  }

  private handleDatePresetClick(preset: string): void {
    this.modalSelectedPreset = preset;
    const now = new Date();
    const todayStr = this.getLocalDateString(now);
    const fromInput = document.getElementById("dateFilterFromInput") as HTMLInputElement | null;
    const toInput = document.getElementById("dateFilterToInput") as HTMLInputElement | null;
    const day = now.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat

    switch (preset) {
      // Row 1: Weekends (Sat & Sun)
      case "weekends-30d": {
        const d30 = new Date(now.getTime() - 30 * 86400000);
        if (fromInput) fromInput.value = this.getLocalDateString(d30);
        if (toInput) toInput.value = todayStr;
        this.modalSelectedDays = new Set([0, 6]);
        break;
      }
      case "weekends-21d": {
        const d21 = new Date(now.getTime() - 21 * 86400000);
        if (fromInput) fromInput.value = this.getLocalDateString(d21);
        if (toInput) toInput.value = todayStr;
        this.modalSelectedDays = new Set([0, 6]);
        break;
      }
      case "weekends-14d": {
        const d14 = new Date(now.getTime() - 14 * 86400000);
        if (fromInput) fromInput.value = this.getLocalDateString(d14);
        if (toInput) toInput.value = todayStr;
        this.modalSelectedDays = new Set([0, 6]);
        break;
      }
      case "weekends-last": {
        // Most recent Saturday & Sunday
        let satDate: Date;
        let sunDate: Date;
        if (day === 0) {
          // Sunday: yesterday (Sat) & today (Sun)
          sunDate = now;
          satDate = new Date(now.getTime() - 86400000);
        } else if (day === 6) {
          // Saturday: today (Sat) & tomorrow (Sun)
          satDate = now;
          sunDate = new Date(now.getTime() + 86400000);
        } else {
          // Weekday (1..5): preceding Sunday and Saturday
          const diffToSun = day;
          sunDate = new Date(now.getTime() - diffToSun * 86400000);
          satDate = new Date(now.getTime() - (diffToSun + 1) * 86400000);
        }
        if (fromInput) fromInput.value = this.getLocalDateString(satDate);
        if (toInput) toInput.value = this.getLocalDateString(sunDate);
        this.modalSelectedDays = new Set([0, 6]);
        break;
      }

      // Row 2: Weekdays (Mon–Fri)
      case "weekdays-30d": {
        const d30 = new Date(now.getTime() - 30 * 86400000);
        if (fromInput) fromInput.value = this.getLocalDateString(d30);
        if (toInput) toInput.value = todayStr;
        this.modalSelectedDays = new Set([1, 2, 3, 4, 5]);
        break;
      }
      case "weekdays-21d": {
        const d21 = new Date(now.getTime() - 21 * 86400000);
        if (fromInput) fromInput.value = this.getLocalDateString(d21);
        if (toInput) toInput.value = todayStr;
        this.modalSelectedDays = new Set([1, 2, 3, 4, 5]);
        break;
      }
      case "weekdays-14d": {
        const d14 = new Date(now.getTime() - 14 * 86400000);
        if (fromInput) fromInput.value = this.getLocalDateString(d14);
        if (toInput) toInput.value = todayStr;
        this.modalSelectedDays = new Set([1, 2, 3, 4, 5]);
        break;
      }
      case "weekdays-last": {
        // Most recent completed or active business week (Mon..Fri)
        let fromDate: Date;
        let toDate: Date = now;
        if (day === 0) {
          // Sunday: preceding Mon..Fri (6 to 2 days ago)
          fromDate = new Date(now.getTime() - 6 * 86400000);
          toDate = new Date(now.getTime() - 2 * 86400000);
        } else if (day === 6) {
          // Saturday: preceding Mon..Fri (5 to 1 days ago)
          fromDate = new Date(now.getTime() - 5 * 86400000);
          toDate = new Date(now.getTime() - 1 * 86400000);
        } else if (day === 1) {
          // Monday: preceding full business week (7 to 3 days ago)
          fromDate = new Date(now.getTime() - 7 * 86400000);
          toDate = new Date(now.getTime() - 3 * 86400000);
        } else {
          // Tue..Fri: Monday of current week through today
          const diffToMon = day - 1;
          fromDate = new Date(now.getTime() - diffToMon * 86400000);
          toDate = now;
        }
        if (fromInput) fromInput.value = this.getLocalDateString(fromDate);
        if (toInput) toInput.value = this.getLocalDateString(toDate);
        this.modalSelectedDays = new Set([1, 2, 3, 4, 5]);
        break;
      }

      // Row 3: All Days
      case "all-30d": {
        const d30 = new Date(now.getTime() - 30 * 86400000);
        if (fromInput) fromInput.value = this.getLocalDateString(d30);
        if (toInput) toInput.value = todayStr;
        this.modalSelectedDays = new Set([0, 1, 2, 3, 4, 5, 6]);
        break;
      }
      case "all-21d": {
        const d21 = new Date(now.getTime() - 21 * 86400000);
        if (fromInput) fromInput.value = this.getLocalDateString(d21);
        if (toInput) toInput.value = todayStr;
        this.modalSelectedDays = new Set([0, 1, 2, 3, 4, 5, 6]);
        break;
      }
      case "all-14d": {
        const d14 = new Date(now.getTime() - 14 * 86400000);
        if (fromInput) fromInput.value = this.getLocalDateString(d14);
        if (toInput) toInput.value = todayStr;
        this.modalSelectedDays = new Set([0, 1, 2, 3, 4, 5, 6]);
        break;
      }
      case "all-7d": {
        const d7 = new Date(now.getTime() - 7 * 86400000);
        if (fromInput) fromInput.value = this.getLocalDateString(d7);
        if (toInput) toInput.value = todayStr;
        this.modalSelectedDays = new Set([0, 1, 2, 3, 4, 5, 6]);
        break;
      }
    }

    this.updateModalDayPills();
    this.updateModalPresetUi();
  }

  private detectMatchingPreset(): string | null {
    if (!this.dateFilter.isActive || !this.dateFilter.fromDate || !this.dateFilter.toDate) {
      return null;
    }
    const days = this.dateFilter.daysOfWeek;
    const isWeekends = days.size === 2 && days.has(0) && days.has(6);
    const isWeekdays = days.size === 5 && [1, 2, 3, 4, 5].every((d) => days.has(d));
    const isAll = days.size === 7;

    const from = this.dateFilter.fromDate;
    const to = this.dateFilter.toDate;
    const now = new Date();
    const todayStr = this.getLocalDateString(now);

    if (to === todayStr) {
      const fromTs = new Date(from).getTime();
      const toTs = new Date(to).getTime();
      const diffDays = Math.round((toTs - fromTs) / 86400000);

      if (isWeekends) {
        if (diffDays === 30) return "weekends-30d";
        if (diffDays === 21) return "weekends-21d";
        if (diffDays === 14) return "weekends-14d";
      } else if (isWeekdays) {
        if (diffDays === 30) return "weekdays-30d";
        if (diffDays === 21) return "weekdays-21d";
        if (diffDays === 14) return "weekdays-14d";
      } else if (isAll) {
        if (diffDays === 30) return "all-30d";
        if (diffDays === 21) return "all-21d";
        if (diffDays === 14) return "all-14d";
        if (diffDays === 7) return "all-7d";
      }
    }
    return null;
  }

  private updateModalPresetUi(): void {
    document.querySelectorAll(".date-preset-btn").forEach((btn) => {
      const el = btn as HTMLElement;
      const presetId = el.dataset.preset;
      const isSelected = presetId === this.modalSelectedPreset;

      const isWeekend = presetId?.startsWith("weekends");
      const isWeekday = presetId?.startsWith("weekdays");

      const titleEl = el.querySelector(".preset-title") as HTMLElement | null;
      const subEl = el.querySelector(".preset-sub") as HTMLElement | null;

      if (isSelected) {
        if (isWeekend) {
          el.className =
            "date-preset-btn date-preset-active px-2 py-1.5 rounded border-2 border-terminal-emerald bg-terminal-emerald/20 ring-1 ring-terminal-emerald text-center transition cursor-pointer select-none shadow-md";
          if (titleEl) titleEl.className = "preset-title text-white font-black text-xs";
          if (subEl) subEl.className = "preset-sub text-terminal-emerald font-bold text-[9px]";
        } else if (isWeekday) {
          el.className =
            "date-preset-btn date-preset-active px-2 py-1.5 rounded border-2 border-terminal-accent bg-terminal-accent/20 ring-1 ring-terminal-accent text-center transition cursor-pointer select-none shadow-md";
          if (titleEl) titleEl.className = "preset-title text-white font-black text-xs";
          if (subEl) subEl.className = "preset-sub text-terminal-accent font-bold text-[9px]";
        } else {
          el.className =
            "date-preset-btn date-preset-active px-2 py-1.5 rounded border-2 border-white/80 bg-white/20 ring-1 ring-white/60 text-center transition cursor-pointer select-none shadow-md";
          if (titleEl) titleEl.className = "preset-title text-white font-black text-xs";
          if (subEl) subEl.className = "preset-sub text-white font-bold text-[9px]";
        }
      } else {
        if (isWeekend) {
          el.className =
            "date-preset-btn px-2 py-1.5 rounded border border-terminal-border hover:border-terminal-emerald/60 bg-terminal-bg hover:bg-terminal-surface text-center transition cursor-pointer select-none";
          if (titleEl) titleEl.className = "preset-title text-terminal-emerald font-bold text-xs";
          if (subEl) subEl.className = "preset-sub text-[9px] text-terminal-muted";
        } else if (isWeekday) {
          el.className =
            "date-preset-btn px-2 py-1.5 rounded border border-terminal-border hover:border-terminal-accent/60 bg-terminal-bg hover:bg-terminal-surface text-center transition cursor-pointer select-none";
          if (titleEl) titleEl.className = "preset-title text-terminal-primary font-bold text-xs";
          if (subEl) subEl.className = "preset-sub text-[9px] text-terminal-muted";
        } else {
          el.className =
            "date-preset-btn px-2 py-1.5 rounded border border-terminal-border hover:border-terminal-muted text-center bg-terminal-bg hover:bg-terminal-surface transition cursor-pointer select-none";
          if (titleEl) titleEl.className = "preset-title text-white font-bold text-xs";
          if (subEl) subEl.className = "preset-sub text-[9px] text-terminal-muted";
        }
      }
    });
  }

  private updateDateFilterUI(): void {
    const banner = document.getElementById("activeFilterBanner");
    const summaryEl = document.getElementById("filterSummaryText");
    const countEl = document.getElementById("filterStatsCount");
    const activeDot = document.getElementById("dateFilterActiveDot");
    const btn = document.getElementById("openDateFilterBtn");

    if (this.dateFilter.isActive) {
      if (banner) banner.classList.remove("hidden");
      if (activeDot) activeDot.classList.remove("hidden");
      if (btn) {
        btn.className =
          "flex items-center gap-1.5 px-2.5 py-0.5 rounded border border-terminal-accent bg-terminal-accent/15 text-terminal-accent font-bold transition cursor-pointer text-xs font-mono select-none";
      }

      let daysLabel = "Custom Days";
      const isWeekends =
        this.dateFilter.daysOfWeek.size === 2 &&
        this.dateFilter.daysOfWeek.has(0) &&
        this.dateFilter.daysOfWeek.has(6);
      const isWeekdays =
        this.dateFilter.daysOfWeek.size === 5 &&
        [1, 2, 3, 4, 5].every((d) => this.dateFilter.daysOfWeek.has(d));
      const isAll = this.dateFilter.daysOfWeek.size === 7;

      if (isWeekends) daysLabel = "Weekends (Sat, Sun)";
      else if (isWeekdays) daysLabel = "Weekdays (Mon–Fri)";
      else if (isAll) daysLabel = "All Days";
      else {
        const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        daysLabel = Array.from(this.dateFilter.daysOfWeek)
          .toSorted((a, b) => a - b)
          .map((d) => names[d])
          .join(", ");
      }

      if (summaryEl) {
        summaryEl.textContent = `${daysLabel} · ${this.dateFilter.fromDate} .. ${this.dateFilter.toDate}`;
      }
      if (countEl) {
        const stepLabel = this.dateFilter.resolution ? ` · ${this.dateFilter.resolution} step` : "";
        countEl.textContent = `(${this.activePoints.length} points${stepLabel})`;
      }
    } else {
      if (banner) banner.classList.add("hidden");
      if (activeDot) activeDot.classList.add("hidden");
      if (btn) {
        btn.className =
          "flex items-center gap-1.5 px-2.5 py-0.5 rounded border border-terminal-border bg-terminal-bg hover:border-terminal-accent text-terminal-secondary hover:text-white transition cursor-pointer text-xs font-mono select-none";
      }
    }
  }

  public async applyDateFilter(config: DateFilterConfig): Promise<void> {
    const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
    if (!pair) return;

    if (!config.fromDate || !config.toDate) return;
    const fromSec = this.getDayStartTimestampSec(config.fromDate);
    const toSec = this.getDayEndTimestampSec(config.toDate);
    if (toSec <= fromSec) {
      alert("End date must be greater than or equal to Start date.");
      return;
    }

    if (this.rangeDebounceTimer) {
      clearTimeout(this.rangeDebounceTimer);
      this.rangeDebounceTimer = null;
    }

    this.setLoading(true);
    const reqId = ++this.currentRequestId;
    const currentSymbol = pair.symbol;

    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const { intervals, totalActiveDays } = computeDateFilterIntervals(
        config.fromDate,
        config.toDate,
        config.daysOfWeek,
        nowSec,
      );

      if (totalActiveDays === 0 || intervals.length === 0) {
        alert("No historical days match the selected date and day-of-week filter.");
        return;
      }

      // Compute optimal resolution and step strictly based on how many active days we parse
      const { resolution, stepSec } = chooseDateFilterResolution(totalActiveDays);

      // Split into parallel chunks respecting the exchange limit (max 400 candles per query)
      const chunks = splitIntervalsIntoApiChunks(intervals, stepSec, 400);

      const chunkResults = await Promise.all(
        chunks.map(async (chunk) => {
          try {
            const [rh, core] = await Promise.all([
              fetchRawCandles(
                CONFIG.RH_API_URL,
                pair.rhMarketId,
                resolution,
                chunk.startSec,
                chunk.endSec,
                chunk.countBack,
              ),
              fetchRawCandles(
                CONFIG.CORE_API_URL,
                pair.coreMarketId,
                resolution,
                chunk.startSec,
                chunk.endSec,
                chunk.countBack,
              ),
            ]);
            return { rh, core };
          } catch (err) {
            console.warn(
              `[Analytics] Chunk fetch failed (${chunk.startSec}..${chunk.endSec}):`,
              err,
            );
            return { rh: [] as RawCandle[], core: [] as RawCandle[] };
          }
        }),
      );

      if (reqId !== this.currentRequestId || this.activeSymbol !== currentSymbol) {
        return;
      }

      const rawRh: RawCandle[] = [];
      const rawCore: RawCandle[] = [];
      for (const res of chunkResults) {
        rawRh.push(...res.rh);
        rawCore.push(...res.core);
      }

      const uniqueRh = dedupeAndSortCandles(rawRh);
      const uniqueCore = dedupeAndSortCandles(rawCore);

      const allPoints = alignCandlesToBasisPoints(uniqueRh, uniqueCore);

      // Filter points: only include timestamps in range and matching selected days of week
      const filtered = allPoints.filter((pt) => {
        if (pt.timeSec < fromSec || pt.timeSec > toSec) return false;
        const d = new Date(pt.timestampMs);
        const dow = d.getDay(); // 0 = Sun, 6 = Sat
        return config.daysOfWeek.has(dow);
      });

      if (filtered.length === 0) {
        alert("No historical candles found matching the selected date and day-of-week filter.");
        return;
      }

      this.dateFilter = { ...config, isActive: true, resolution };
      this.activePoints = filtered;
      const stats = calculateQuantStats(filtered, pair.hedgeSideConfig.isRhLong);
      const bands = calculateRollingBands(filtered, 20);

      if (this.chartContext) {
        this.chartContext.setData(filtered, bands, true, undefined, pair.hedgeSideConfig.isRhLong);
      }

      this.updateQuantGauges(stats);
      this.renderHeatmap();
      this.updateTopMarketStats(pair);
      this.updateLegend(filtered[filtered.length - 1] || null);
      this.clearActiveTimeframeButtons();
      this.updateDateFilterUI();
      this.closeDateFilterModal();
    } catch (err) {
      if (reqId === this.currentRequestId) {
        console.error("Failed to apply date filter:", err);
      }
    } finally {
      if (reqId === this.currentRequestId) {
        this.setLoading(false);
      }
    }
  }

  public clearDateFilter(): void {
    this.dateFilter.isActive = false;
    this.updateDateFilterUI();
    this.setTimeframe(this.activeTimeframe);
  }

  private closeTickerModal(): void {
    const modal = document.getElementById("tickerModal");
    modal?.classList.add("hidden");
  }

  private openTickerModal(): void {
    const modal = document.getElementById("tickerModal");
    const input = document.getElementById("tickerSearchInput") as HTMLInputElement | null;
    modal?.classList.remove("hidden");
    input?.focus();
    input?.select();
    this.focusedModalRowIndex = 0;
    this.renderRecents();
    this.renderTickerSelector();
  }

  private setupEventListeners(): void {
    // Browser back/forward navigation support for /analytics/:ticker
    window.addEventListener("popstate", () => {
      const sym = getSlugSymbolFromPath(window.location.pathname);
      if (sym && sym !== this.activeSymbol) {
        this.selectSymbol(sym, false);
      }
    });

    // Font selector
    initFontSelector({
      onFontChange: (_font, stack) => {
        if (this.chartContext) {
          this.chartContext.priceChart.applyOptions({ layout: { fontFamily: stack } });
          this.chartContext.basisChart.applyOptions({ layout: { fontFamily: stack } });
        }
      },
    });

    // Ticker select button
    document.getElementById("tickerSelectBtn")?.addEventListener("click", () => {
      this.openTickerModal();
    });

    // Modal close buttons
    document.getElementById("closeTickerModalBtn")?.addEventListener("click", () => {
      this.closeTickerModal();
    });

    document.getElementById("tickerModalBackdrop")?.addEventListener("click", () => {
      this.closeTickerModal();
    });

    // Search input in modal
    const searchInput = document.getElementById("tickerSearchInput") as HTMLInputElement | null;
    const clearBtn = document.getElementById("clearSearchBtn");

    searchInput?.addEventListener("input", (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value.trim();
      if (clearBtn) {
        if (this.searchQuery) {
          clearBtn.classList.remove("hidden");
        } else {
          clearBtn.classList.add("hidden");
        }
      }
      this.focusedModalRowIndex = 0;
      this.renderTickerSelector();
    });

    clearBtn?.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      this.searchQuery = "";
      clearBtn.classList.add("hidden");
      this.focusedModalRowIndex = 0;
      this.renderTickerSelector();
      searchInput?.focus();
    });

    // Modal category tabs
    document.querySelectorAll(".cat-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const cat = (tab as HTMLElement).dataset.cat as
          | "all"
          | "stocks"
          | "pre_ipo"
          | "etf"
          | "crypto"
          | "favorites";
        if (cat) {
          this.activeCategory = cat;
          document.querySelectorAll(".cat-tab").forEach((t) => {
            if ((t as HTMLElement).dataset.cat === cat) {
              t.className =
                "cat-tab px-2.5 py-0.5 rounded bg-terminal-border text-white font-bold transition cursor-pointer text-[11px]";
            } else {
              t.className =
                "cat-tab px-2.5 py-0.5 rounded text-terminal-muted hover:text-white transition cursor-pointer text-[11px]";
            }
          });
          this.focusedModalRowIndex = 0;
          this.renderTickerSelector();
        }
      });
    });

    // Keyboard navigation in search input
    searchInput?.addEventListener("keydown", (e) => {
      const filtered = this.getFilteredPairs();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filtered.length > 0) {
          this.focusedModalRowIndex = (this.focusedModalRowIndex + 1) % filtered.length;
          this.highlightFocusedRow();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length > 0) {
          this.focusedModalRowIndex =
            (this.focusedModalRowIndex - 1 + filtered.length) % filtered.length;
          this.highlightFocusedRow();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[this.focusedModalRowIndex]) {
          const sym = filtered[this.focusedModalRowIndex].symbol;
          this.selectSymbol(sym);
          this.closeTickerModal();
        }
      } else if (e.key === "Escape") {
        this.closeTickerModal();
      }
    });

    // Timeframe buttons
    document.querySelectorAll(".tf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tf = (btn as HTMLElement).dataset.tf as TimeframeId;
        if (tf && TIMEFRAMES[tf]) {
          this.setTimeframe(tf);
        }
      });
    });

    // Refresh button
    document.getElementById("refreshBtn")?.addEventListener("click", () => {
      this.loadData();
    });

    // Column header sort buttons
    document.querySelectorAll(".sort-col-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sort = (btn as HTMLElement).dataset.sort as SortField;
        if (sort) {
          this.setSort(sort);
        }
      });
    });

    // Modal sort dropdown toggle
    const sortMenuBtn = document.getElementById("modalSortMenuBtn");
    const sortDropdown = document.getElementById("modalSortDropdown");

    sortMenuBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      sortDropdown?.classList.toggle("hidden");
    });

    // Modal sort options
    document.querySelectorAll(".sort-option").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        const sort = (opt as HTMLElement).dataset.sort as SortField;
        if (sort) {
          this.setSort(sort);
          sortDropdown?.classList.add("hidden");
        }
      });
    });

    // Close sort dropdown when clicking outside
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest("#modalSortMenuBtn") && !target.closest("#modalSortDropdown")) {
        sortDropdown?.classList.add("hidden");
      }
    });

    // Venue switcher toggle buttons
    document.getElementById("venueBtnRh")?.addEventListener("click", () => {
      this.setVenue("rh");
    });
    document.getElementById("venueBtnCore")?.addEventListener("click", () => {
      this.setVenue("core");
    });

    // Dispersion bands toggle button
    document.getElementById("toggleBandsBtn")?.addEventListener("click", () => {
      this.toggleBands();
    });

    // Date & Day-of-Week filter controls
    document.getElementById("openDateFilterBtn")?.addEventListener("click", () => {
      this.openDateFilterModal();
    });
    document.getElementById("closeDateFilterModalBtn")?.addEventListener("click", () => {
      this.closeDateFilterModal();
    });
    document.getElementById("cancelDateFilterModalBtn")?.addEventListener("click", () => {
      this.closeDateFilterModal();
    });
    document.getElementById("dateFilterModalBackdrop")?.addEventListener("click", () => {
      this.closeDateFilterModal();
    });
    document.getElementById("clearFilterBtn")?.addEventListener("click", () => {
      this.clearDateFilter();
    });
    document.getElementById("resetDateFilterModalBtn")?.addEventListener("click", () => {
      this.modalSelectedPreset = null;
      this.updateModalPresetUi();
      this.clearDateFilter();
      this.closeDateFilterModal();
    });

    document.getElementById("applyDateFilterModalBtn")?.addEventListener("click", () => {
      const fromInput = document.getElementById("dateFilterFromInput") as HTMLInputElement | null;
      const toInput = document.getElementById("dateFilterToInput") as HTMLInputElement | null;
      const fromDate = fromInput?.value || "";
      const toDate = toInput?.value || "";

      if (!fromDate || !toDate) {
        alert("Please select both From and To dates.");
        return;
      }

      if (this.modalSelectedDays.size === 0) {
        alert("Please select at least one day of the week.");
        return;
      }

      this.applyDateFilter({
        isActive: true,
        fromDate,
        toDate,
        daysOfWeek: new Set(this.modalSelectedDays),
        activePresetId: this.modalSelectedPreset || undefined,
      });
    });

    // Reset preset highlight when user manually modifies dates
    const onDateInputChange = () => {
      this.modalSelectedPreset = null;
      this.updateModalPresetUi();
    };
    document.getElementById("dateFilterFromInput")?.addEventListener("input", onDateInputChange);
    document.getElementById("dateFilterToInput")?.addEventListener("input", onDateInputChange);

    // Date presets
    document.querySelectorAll(".date-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = (btn as HTMLElement).dataset.preset;
        if (preset) {
          this.handleDatePresetClick(preset);
        }
      });
    });

    // Day of week quick filters
    document.getElementById("dayFilterQuickAll")?.addEventListener("click", () => {
      this.modalSelectedDays = new Set([0, 1, 2, 3, 4, 5, 6]);
      this.modalSelectedPreset = null;
      this.updateModalDayPills();
      this.updateModalPresetUi();
    });
    document.getElementById("dayFilterQuickWeekends")?.addEventListener("click", () => {
      this.modalSelectedDays = new Set([0, 6]);
      this.modalSelectedPreset = null;
      this.updateModalDayPills();
      this.updateModalPresetUi();
    });
    document.getElementById("dayFilterQuickWeekdays")?.addEventListener("click", () => {
      this.modalSelectedDays = new Set([1, 2, 3, 4, 5]);
      this.modalSelectedPreset = null;
      this.updateModalDayPills();
      this.updateModalPresetUi();
    });

    // Individual day pills
    document.querySelectorAll(".dow-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const d = parseInt((btn as HTMLElement).dataset.day || "", 10);
        if (!isNaN(d)) {
          if (this.modalSelectedDays.has(d)) {
            if (this.modalSelectedDays.size > 1) {
              this.modalSelectedDays.delete(d);
            }
          } else {
            this.modalSelectedDays.add(d);
          }
          this.modalSelectedPreset = null;
          this.updateModalDayPills();
          this.updateModalPresetUi();
        }
      });
    });

    // Global hotkey '/' to search ticker, Escape to close
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName || "")) {
        e.preventDefault();
        this.openTickerModal();
      } else if (e.key === "Escape") {
        this.closeTickerModal();
        this.closeDateFilterModal();
      }
    });
  }
}
