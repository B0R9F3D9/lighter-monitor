import { fetchHistoricalBasis, fetchMarketPairs, fetchRawCandles, TIMEFRAMES } from "./api";
import { type ChartSyncContext, initAnalyticsCharts } from "./charts";
import {
  alignCandlesToBasisPoints,
  calculateHourlyBuckets,
  calculateQuantStats,
  calculateRollingBands,
  chooseOptimalResolution,
  formatMarketPrice,
  getTokenIcon,
  getTokenImageUrl,
} from "./math";
import { renderHourlyHeatmap } from "./heatmap";
import { ticksStorage } from "./storage";
import type {
  AnalyticsMarketPair,
  AnalyticsVenue,
  BasisPoint,
  LiveSpreadTick,
  QuantStats,
  TimeframeId,
} from "./types";
import { CONFIG, CRYPTO_SYMBOLS, formatMoney, initFontSelector, WebSocketManager } from "../shared";

export type SortField = "volume" | "oi" | "change" | "price" | "symbol";
export type SortDirection = "asc" | "desc";

export class AnalyticsController {
  private pairs: AnalyticsMarketPair[] = [];
  private activeSymbol = "AAPL";
  private activeTimeframe: TimeframeId = "24h";
  private activeCategory: "all" | "equities" | "crypto" | "favorites" = "all";
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
  private activeStats: QuantStats | null = null;

  private rangeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isFetchingRange = false;
  private pendingRange: { fromSec: number; toSec: number } | null = null;
  private lastRequestedRange: { fromSec: number; toSec: number; resolution: string } | null = null;

  private wsManager: WebSocketManager | null = null;
  private lastLiveTickTs = 0;
  private liveRhBook = { bestAsk: 0, bestBid: 0, mid: 0 };
  private liveCoreBook = { bestAsk: 0, bestBid: 0, mid: 0 };

  public async init(): Promise<void> {
    this.restoreSettings();
    this.setupEventListeners();
    await this.loadPairs();
    this.initCharts();
    await this.loadData();
    this.initWebSocket();
  }

  private restoreSettings(): void {
    try {
      const sym = localStorage.getItem("analytics_symbol");
      if (sym) this.activeSymbol = sym;
      const tf = localStorage.getItem("analytics_timeframe") as TimeframeId;
      if (tf && TIMEFRAMES[tf]) this.activeTimeframe = tf;

      const savedVenue = localStorage.getItem("analytics_venue") as AnalyticsVenue;
      if (savedVenue === "rh" || savedVenue === "core") {
        this.activeVenue = savedVenue;
      }

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
      const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
      if (pair) this.updateTopMarketStats(pair);
      this.updateSortIndicators();
      this.renderRecents();
      this.renderTickerSelector();
    } catch (err) {
      console.error("Failed to load pairs:", err);
    }
  }

  private initCharts(): void {
    const priceContainer = document.getElementById("priceChartContainer");
    const basisContainer = document.getElementById("basisChartContainer");
    if (!priceContainer || !basisContainer) return;

    this.chartContext = initAnalyticsCharts(priceContainer, basisContainer, {
      onCrosshairMove: (point) => {
        this.updateLegend(point);
      },
      onVisibleRangeChange: (range) => {
        this.onVisibleTimeRangeChange(range);
      },
    });
  }

  private async loadData(): Promise<void> {
    const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
    if (!pair) return;

    if (this.rangeDebounceTimer) {
      clearTimeout(this.rangeDebounceTimer);
      this.rangeDebounceTimer = null;
    }
    this.pendingRange = null;
    this.lastRequestedRange = null;

    this.setLoading(true);
    const tf = TIMEFRAMES[this.activeTimeframe];

    try {
      const { points, stats, bands } = await fetchHistoricalBasis(pair, tf);
      this.activePoints = points;
      this.activeStats = stats;

      if (this.chartContext) {
        this.chartContext.setData(points, bands, true);
      }

      this.updateQuantGauges(stats);
      this.renderHeatmap();
      this.updateTopMarketStats(pair);
      this.updateLegend(points[points.length - 1] || null);
    } catch (err) {
      console.error("Failed to fetch historical basis:", err);
    } finally {
      this.setLoading(false);
    }
  }

  private onVisibleTimeRangeChange(range: { fromSec: number; toSec: number }): void {
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

      const points = alignCandlesToBasisPoints(rhCandles, coreCandles);
      if (points.length >= 2) {
        const stats = calculateQuantStats(points);
        const bands = calculateRollingBands(points, 20);

        this.activePoints = points;
        this.activeStats = stats;

        if (this.chartContext) {
          this.chartContext.setData(points, bands, false, { fromSec, toSec });
        }

        this.updateQuantGauges(stats);
        this.renderHeatmap();
        this.updateLegend(points[points.length - 1] || null);
        this.clearActiveTimeframeButtons();
      }
    } catch (err) {
      console.warn("Failed to fetch viewport historical candles:", err);
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

  private setLoading(isLoading: boolean): void {
    const loader = document.getElementById("chartLoadingOverlay");
    if (loader) {
      loader.className = isLoading
        ? "absolute inset-0 bg-terminal-bg/70 backdrop-blur-xs flex items-center justify-center z-20 pointer-events-auto"
        : "hidden";
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
          ? "text-xs sm:text-[13px] font-bold tabular-nums text-terminal-emerald"
          : "text-xs sm:text-[13px] font-bold tabular-nums text-terminal-coral";
    }

    if (volEl) volEl.textContent = formatMoney(pair.totalVolume24h);
    if (oiEl) oiEl.textContent = formatMoney(pair.openInterestUsd);

    if (fundingEl) {
      const sign = pair.fundingRate1h >= 0 ? "+" : "";
      fundingEl.textContent = `${sign}${pair.fundingRate1h.toFixed(4)}%`;
      fundingEl.className =
        pair.fundingRate1h >= 0
          ? "text-xs sm:text-[13px] font-bold tabular-nums text-terminal-emerald"
          : "text-xs sm:text-[13px] font-bold tabular-nums text-terminal-coral";
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
    const rhVal = document.getElementById("legendRhPrice");
    const coreVal = document.getElementById("legendCorePrice");
    const basisVal = document.getElementById("legendBasisUsd");
    const bpsVal = document.getElementById("legendBasisBps");
    const timeVal = document.getElementById("legendTimestamp");

    if (!point) {
      if (this.activePoints.length > 0) {
        point = this.activePoints[this.activePoints.length - 1];
      } else {
        return;
      }
    }

    if (rhVal) rhVal.textContent = `$${point.rhPrice.toFixed(2)}`;
    if (coreVal) coreVal.textContent = `$${point.corePrice.toFixed(2)}`;

    const sign = point.basisUsd > 0 ? "+" : "";
    if (basisVal) {
      basisVal.textContent = `${sign}$${point.basisUsd.toFixed(3)}`;
      basisVal.className =
        point.basisUsd <= 0
          ? "font-bold tabular-nums text-terminal-emerald"
          : "font-bold tabular-nums text-terminal-accent";
    }

    if (bpsVal) {
      bpsVal.textContent = `${sign}${point.basisBps.toFixed(2)} bps`;
      bpsVal.className =
        point.basisBps <= 0
          ? "font-bold tabular-nums text-terminal-emerald"
          : "font-bold tabular-nums text-terminal-accent";
    }

    if (timeVal) {
      const d = new Date(point.timestampMs);
      timeVal.textContent = d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }

  private updateQuantGauges(stats: QuantStats | null): void {
    if (!stats) return;

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
      basisEl.className =
        stats.currentBasisUsd <= 0
          ? "text-sm font-bold tabular-nums text-terminal-emerald"
          : "text-sm font-bold tabular-nums text-white";
    }

    if (basisBpsEl) {
      basisBpsEl.textContent = `(${sign}${stats.currentBasisBps.toFixed(1)} bps)`;
      basisBpsEl.className =
        stats.currentBasisBps <= 0
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
      zScoreEl.className =
        stats.zScore <= 0
          ? "font-bold tabular-nums text-terminal-emerald"
          : stats.zScore <= 1.0
            ? "font-bold tabular-nums text-terminal-primary"
            : stats.zScore <= 2.0
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
      const zStr =
        stats.zScore <= 0 ? `${stats.zScore.toFixed(2)}σ` : `+${stats.zScore.toFixed(2)}σ`;
      if (stats.signal === "EXCELLENT ENTRY") {
        verdictEl.textContent = `● EXCELLENT (${zStr})`;
        verdictEl.className = "text-[11px] font-semibold text-terminal-emerald select-text";
      } else if (stats.signal === "FAIR") {
        verdictEl.textContent = `● FAIR (${zStr})`;
        verdictEl.className = "text-[11px] font-semibold text-terminal-primary select-text";
      } else if (stats.signal === "CAUTION") {
        verdictEl.textContent = `● CAUTION (${zStr})`;
        verdictEl.className = "text-[11px] font-semibold text-terminal-amber select-text";
      } else {
        verdictEl.textContent = `● OVERHEATED (${zStr})`;
        verdictEl.className = "text-[11px] font-semibold text-terminal-coral select-text";
      }
    }
  }

  private renderHeatmap(): void {
    const container = document.getElementById("heatmapContainer");
    if (!container) return;

    // Detect user timezone offset in hours
    const userOffsetHours = -new Date().getTimezoneOffset() / 60;
    const buckets = calculateHourlyBuckets(this.activePoints, userOffsetHours);
    const nowLocalHour = new Date().getHours();

    renderHourlyHeatmap(container, buckets, nowLocalHour);
  }

  private getFilteredPairs(): AnalyticsMarketPair[] {
    const list = this.pairs.filter((p) => {
      if (this.activeCategory === "equities" && !p.isEquity) return false;
      if (this.activeCategory === "crypto" && !CRYPTO_SYMBOLS.has(p.symbol)) return false;
      if (this.activeCategory === "favorites" && !this.favorites.has(p.symbol)) return false;

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
      const chip = document.createElement("button");
      chip.type = "button";
      const isSelected = sym === this.activeSymbol;
      chip.className = `inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-mono transition cursor-pointer shrink-0 ${
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
          this.removeFromRecents(sym, e);
          return;
        }
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
    this.recents = this.recents.filter((s) => s !== symbol);
    this.saveSettings();
    this.renderRecents();
  }

  private toggleFavorite(symbol: string, e: Event): void {
    e.stopPropagation();
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

      const row = document.createElement("div");
      row.className = `ticker-modal-row grid grid-cols-12 items-center px-3 py-2 text-xs font-mono transition cursor-pointer ${
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
          this.toggleFavorite(p.symbol, e);
          return;
        }
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

  public selectSymbol(symbol: string): void {
    if (this.activeSymbol === symbol) return;
    this.activeSymbol = symbol;
    this.saveSettings();
    this.addToRecents(symbol);
    this.renderTickerSelector();
    const pair = this.pairs.find((p) => p.symbol === symbol);
    if (pair) this.updateTopMarketStats(pair);
    this.loadData();
    this.switchWsSubscription();
  }

  public setTimeframe(tf: TimeframeId): void {
    this.activeTimeframe = tf;
    this.saveSettings();

    document.querySelectorAll(".tf-btn").forEach((btn) => {
      const id = (btn as HTMLElement).dataset.tf;
      if (id === tf) {
        btn.className =
          "tf-btn px-2 py-0.5 rounded bg-terminal-border text-white font-bold transition cursor-pointer whitespace-nowrap";
      } else {
        btn.className =
          "tf-btn px-2 py-0.5 rounded text-terminal-muted hover:text-white transition cursor-pointer whitespace-nowrap";
      }
    });

    this.loadData();
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
        const cat = (tab as HTMLElement).dataset.cat as "all" | "equities" | "crypto" | "favorites";
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

    // Global hotkey '/' to search ticker, Escape to close
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName || "")) {
        e.preventDefault();
        this.openTickerModal();
      } else if (e.key === "Escape") {
        this.closeTickerModal();
      }
    });
  }

  private initWebSocket(): void {
    this.wsManager = new WebSocketManager({
      onCoreOpen: () => this.switchWsSubscription(),
      onRhOpen: () => this.switchWsSubscription(),
      onCoreBookUpdate: (marketId, data) => {
        const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
        if (!pair || marketId !== pair.coreMarketId) return;

        if (data.bids?.length) this.liveCoreBook.bestBid = parseFloat(String(data.bids[0].price));
        if (data.asks?.length) this.liveCoreBook.bestAsk = parseFloat(String(data.asks[0].price));
        if (this.liveCoreBook.bestBid > 0 && this.liveCoreBook.bestAsk > 0) {
          this.liveCoreBook.mid = (this.liveCoreBook.bestBid + this.liveCoreBook.bestAsk) / 2;
        }
        this.checkRecordLiveTick(pair);
      },
      onRhBookUpdate: (marketId, data) => {
        const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
        if (!pair || marketId !== pair.rhMarketId) return;

        if (data.bids?.length) this.liveRhBook.bestBid = parseFloat(String(data.bids[0].price));
        if (data.asks?.length) this.liveRhBook.bestAsk = parseFloat(String(data.asks[0].price));
        if (this.liveRhBook.bestBid > 0 && this.liveRhBook.bestAsk > 0) {
          this.liveRhBook.mid = (this.liveRhBook.bestBid + this.liveRhBook.bestAsk) / 2;
        }
        this.checkRecordLiveTick(pair);
      },
    });

    this.wsManager.connectAll();
  }

  private switchWsSubscription(): void {
    if (!this.wsManager) return;
    const pair = this.pairs.find((p) => p.symbol === this.activeSymbol);
    if (!pair) return;

    this.wsManager.subscribeCore(pair.coreMarketId);
    this.wsManager.subscribeRh(pair.rhMarketId);
  }

  private checkRecordLiveTick(pair: AnalyticsMarketPair): void {
    const now = Date.now();
    // Record at most once every 5 seconds to throttle writes
    if (now - this.lastLiveTickTs < 5000) return;
    if (this.liveRhBook.mid <= 0 || this.liveCoreBook.mid <= 0) return;

    this.lastLiveTickTs = now;
    const basisMid = this.liveRhBook.mid - this.liveCoreBook.mid;
    const entryDrag = this.liveRhBook.bestAsk - this.liveCoreBook.bestBid;
    const exitDrag = this.liveCoreBook.bestAsk - this.liveRhBook.bestBid;
    const mid = (this.liveRhBook.mid + this.liveCoreBook.mid) / 2;

    const tick: LiveSpreadTick = {
      symbol: pair.symbol,
      timestampMs: now,
      rhAsk: this.liveRhBook.bestAsk,
      rhBid: this.liveRhBook.bestBid,
      coreAsk: this.liveCoreBook.bestAsk,
      coreBid: this.liveCoreBook.bestBid,
      rhMid: this.liveRhBook.mid,
      coreMid: this.liveCoreBook.mid,
      basisMidUsd: basisMid,
      entryDragUsd: entryDrag,
      exitDragUsd: exitDrag,
      entryDragBps: mid > 0 ? (entryDrag / mid) * 10000 : 0,
      exitDragBps: mid > 0 ? (exitDrag / mid) * 10000 : 0,
    };

    ticksStorage.saveTick(tick);
  }
}
