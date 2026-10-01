import type { MarketInfo, MarketMetrics, RowDomCache, SimFillResult, TerminalState } from "./types";
import { CONFIG, NON_EQUITY_SYMBOLS, STORAGE_KEYS } from "./config";
import { getMetrics } from "./metrics";
import { getOrCreateBook, updateBookFromWs, type WsOrderBookData } from "./orderbook";
import { WebSocketManager } from "./ws";
import { initFontSelector } from "../shared";
import {
  createRowElement,
  applyRowMetricsToDom,
  applyNullMetricsToDom,
  createDetailRowElement,
  updateDetailRow,
  updateExecutiveSummary,
} from "./dom";

export class TerminalController {
  public state: TerminalState = {
    markets: new Map(),
    coreBooks: new Map(),
    rhBooks: new Map(),
    targetSizeUsd: 10000,
    isDynamicSize: false,
    dynamicMode: "none",
    maxCapUsd: 20000,
    filterEquities: true,
    filterReadyOnly: false,
    minLeverageFilter: 0,
    searchQuery: "",
    sortColumn: "costUsd",
    sortDirection: "asc",
    isAutoSortEnabled: true,
    displayedSymbolsOrder: [],
    rerankTimerRemaining: CONFIG.RERANK_INTERVAL_SEC,
    emaMap: new Map(),
    expandedSymbol: null,
    isCoreConnected: false,
    isRhConnected: false,
  };

  private marketIdToSymbol = {
    core: new Map<number, string>(),
    rh: new Map<number, string>(),
  };

  private dirtySymbols = new Set<string>();
  private rowDomCache = new Map<string, RowDomCache>();
  private detailRowDom: HTMLTableRowElement | null = null;

  private wsManager: WebSocketManager;
  private isWsInitialized = false;
  private fetchInFlight = false;
  private nextFetchTimer: ReturnType<typeof setTimeout> | null = null;

  private updateScheduled = false;
  private lastRenderTime = 0;
  private isWarmupActive = true;
  private hasInitialRenderHappened = false;
  private warmupDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private resetHysteresisTimerCallback: (() => void) | null = null;

  constructor() {
    this.wsManager = new WebSocketManager({
      onCoreOpen: () => {
        this.state.isCoreConnected = true;
        this.updateDotStatus("coreWsDot", "bg-terminal-emerald");
        for (const m of this.state.markets.values()) {
          this.wsManager.subscribeCore(m.coreMarketId);
        }
      },
      onCoreClose: () => {
        this.state.isCoreConnected = false;
        for (const b of this.state.coreBooks.values()) {
          b.isSnapshotReceived = false;
        }
        this.updateDotStatus("coreWsDot", "bg-terminal-coral animate-pulse");
      },
      onRhOpen: () => {
        this.state.isRhConnected = true;
        this.updateDotStatus("rhWsDot", "bg-terminal-emerald");
        for (const m of this.state.markets.values()) {
          this.wsManager.subscribeRh(m.rhMarketId);
        }
      },
      onRhClose: () => {
        this.state.isRhConnected = false;
        for (const b of this.state.rhBooks.values()) {
          b.isSnapshotReceived = false;
        }
        this.updateDotStatus("rhWsDot", "bg-terminal-coral animate-pulse");
      },
      onCoreBookUpdate: (marketId, data, isSnapshot, offset) => {
        this.handleCoreBookUpdate(marketId, data, isSnapshot, offset);
      },
      onRhBookUpdate: (marketId, data, isSnapshot, offset) => {
        this.handleRhBookUpdate(marketId, data, isSnapshot, offset);
      },
    });

    setTimeout(() => {
      this.isWarmupActive = false;
    }, 3500);
  }

  public init(): void {
    this.restoreFilterSettings();
    this.setupEventListeners();
    this.setupHysteresisTimer();
    this.fetchMarkets();
  }

  private updateDotStatus(id: string, className: string): void {
    const el = document.getElementById(id);
    if (el) el.className = `w-1.5 h-1.5 rounded-full ${className}`;
  }

  private handleCoreBookUpdate(
    marketId: number,
    data: WsOrderBookData,
    isSnapshot: boolean,
    offset: number,
  ): void {
    const symbol = this.marketIdToSymbol.core.get(marketId);
    const book = getOrCreateBook(this.state.coreBooks, marketId);
    updateBookFromWs(book, data, isSnapshot, offset);
    if (symbol) this.dirtySymbols.add(symbol);
    this.scheduleInPlaceUpdate();
  }

  private handleRhBookUpdate(
    marketId: number,
    data: WsOrderBookData,
    isSnapshot: boolean,
    offset: number,
  ): void {
    const symbol = this.marketIdToSymbol.rh.get(marketId);
    const book = getOrCreateBook(this.state.rhBooks, marketId);
    updateBookFromWs(book, data, isSnapshot, offset);
    if (symbol) this.dirtySymbols.add(symbol);
    this.scheduleInPlaceUpdate();
  }

  private triggerWarmupSync(): void {
    if (this.warmupDebounceTimer) return;
    this.warmupDebounceTimer = setTimeout(() => {
      this.warmupDebounceTimer = null;
      this.rerank();
    }, 350);
  }

  private scheduleInPlaceUpdate(): void {
    if (!this.hasInitialRenderHappened || this.isWarmupActive) {
      this.triggerWarmupSync();
    }

    if (this.updateScheduled) return;
    this.updateScheduled = true;

    const now = performance.now();
    const elapsed = now - this.lastRenderTime;
    const wait = Math.max(0, CONFIG.THROTTLE_MS - elapsed);

    setTimeout(() => {
      requestAnimationFrame(() => {
        this.lastRenderTime = performance.now();
        this.updateScheduled = false;
        this.updateCellsInPlace(false);
      });
    }, wait);
  }

  public updateCellsInPlace(forceAll = false): void {
    const symbols = forceAll
      ? this.state.displayedSymbolsOrder
      : this.state.displayedSymbolsOrder.filter((sym) => this.dirtySymbols.has(sym));

    if (symbols.length === 0 && !forceAll) return;

    const now = performance.now();

    for (const symbol of symbols) {
      this.dirtySymbols.delete(symbol);
      const m = this.state.markets.get(symbol);
      if (!m) continue;

      const row = getMetrics(
        m,
        this.state,
        this.wsManager.lastCoreMsgAt,
        this.wsManager.lastRhMsgAt,
        now,
      );

      const cache = this.rowDomCache.get(symbol);
      if (!row) {
        if (cache) applyNullMetricsToDom(cache, m);
        continue;
      }
      if (!cache) continue;

      applyRowMetricsToDom(cache, row);
      if (this.state.expandedSymbol === symbol && this.detailRowDom) {
        updateDetailRow(row, this.state.targetSizeUsd);
      }
    }

    let topRow: MarketMetrics | null = null;
    let bestCost = Infinity;
    const nowTime = performance.now();
    for (const sym of this.state.displayedSymbolsOrder) {
      const m = this.state.markets.get(sym);
      const r = m?.latestMetrics;
      if (
        r &&
        r.status === "READY" &&
        r.allFilled &&
        !r.isStale &&
        r.costUsd > -50 &&
        r.costUsd < 1000 &&
        nowTime - (r.computedAt || 0) < CONFIG.LEADER_FRESHNESS_WINDOW_MS
      ) {
        const rankMetric = this.state.isDynamicSize ? r.pointCostUsd : r.costUsd;
        if (rankMetric < bestCost) {
          bestCost = rankMetric;
          topRow = r;
        }
      }
    }
    updateExecutiveSummary(topRow, this.state.dynamicMode);
  }

  private createFallbackMetrics(m: MarketInfo): MarketMetrics {
    const isDynamic = this.state.dynamicMode !== "none";
    const fallbackSize = isDynamic ? 10000 : this.state.targetSizeUsd;
    const emptyLeg: SimFillResult = {
      isComplete: false,
      avgPrice: 0,
      bestPrice: 0,
      slippageBps: 0,
      levelsSwept: 0,
      totalCostUsd: 0,
      filledBase: 0,
      totalAvailableUsd: 0,
      totalAvailableBase: 0,
    };

    return {
      symbol: m.symbol,
      leverage: m.leverage,
      leverageNum: m.leverageNum,
      rhLeverage: m.rhLeverage,
      coreLeverage: m.coreLeverage,
      midPrice: 0,
      rhMid: 0,
      coreMid: 0,
      deltaMidUsd: 0,
      deltaMidBps: 0,
      baseQty: 0,
      allFilled: false,
      isStale: false,
      totalVolume24h: m.totalVolume24h,
      rhVolume24h: m.rhVolume24h,
      totalOiUsd: m.totalOiUsd,
      rawSpreadBps: 0,
      slippageBps: 0,
      entryDragBps: 0,
      exitDragBps: 0,
      entryLossUsd: 0,
      exitLossUsd: 0,
      vwapTotalDragBps: 0,
      costUsd: 999999,
      rawCostUsd: 999999,
      pointCostUsd: 999999,
      pointsEarned: 0,
      maxLevelsSwept: 0,
      minDepthUsd: 0,
      optimalSizeUsd: 10000,
      effectiveTargetUsd: fallbackSize,
      isDynamic,
      dynamicMode: this.state.dynamicMode,
      status: "LOW LIQ",
      legs: {
        entryRh: emptyLeg,
        entryCore: emptyLeg,
        exitRh: emptyLeg,
        exitCore: emptyLeg,
        rhBestAsk: 0,
        coreBestBid: 0,
        rhBestBid: 0,
        coreBestAsk: 0,
        rhMid: 0,
        coreMid: 0,
      },
    };
  }

  public rerank(): void {
    const rows: MarketMetrics[] = [];
    const now = performance.now();

    for (const m of this.state.markets.values()) {
      if (this.state.filterEquities && NON_EQUITY_SYMBOLS.has(m.symbol)) continue;
      if (this.state.minLeverageFilter > 0 && m.leverageNum < this.state.minLeverageFilter)
        continue;
      if (
        this.state.searchQuery &&
        !m.symbol.toUpperCase().includes(this.state.searchQuery.toUpperCase())
      ) {
        continue;
      }

      // If we have fresh metrics and market was not marked dirty — use cached!
      let row = m.latestMetrics;
      if (!row || this.dirtySymbols.has(m.symbol)) {
        row = getMetrics(
          m,
          this.state,
          this.wsManager.lastCoreMsgAt,
          this.wsManager.lastRhMsgAt,
          now,
        );
        this.dirtySymbols.delete(m.symbol);
      }

      if (row) {
        if (this.state.filterReadyOnly && row.status !== "READY") continue;
        rows.push(row);
      } else if (!this.state.filterReadyOnly) {
        rows.push(this.createFallbackMetrics(m));
      }
    }

    const dir = this.state.sortDirection === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      if (this.state.sortColumn === "symbol") return a.symbol.localeCompare(b.symbol) * dir;
      if (this.state.sortColumn === "leverageNum") return (a.leverageNum - b.leverageNum) * dir;
      if (this.state.sortColumn === "effectiveTargetUsd")
        return (a.effectiveTargetUsd - b.effectiveTargetUsd) * dir;
      if (this.state.sortColumn === "totalVolume24h")
        return (a.totalVolume24h - b.totalVolume24h) * dir;
      if (this.state.sortColumn === "totalOiUsd") return (a.totalOiUsd - b.totalOiUsd) * dir;
      if (this.state.sortColumn === "status") {
        const rank = { READY: 1, SLIPPAGE: 2, "LOW LIQ": 3, STALE: 4 };
        return ((rank[a.status] || 9) - (rank[b.status] || 9)) * dir;
      }
      const rankA = a.status === "READY" ? 0 : a.status === "SLIPPAGE" ? 1 : 2;
      const rankB = b.status === "READY" ? 0 : b.status === "SLIPPAGE" ? 1 : 2;
      if (rankA !== rankB) return rankA - rankB;

      if (this.state.isDynamicSize && this.state.sortColumn === "costUsd") {
        return (a.pointCostUsd - b.pointCostUsd) * dir;
      }

      const col = this.state.sortColumn as keyof MarketMetrics;
      const valA = (a[col] as unknown as number) || 0;
      const valB = (b[col] as unknown as number) || 0;
      return (valA - valB) * dir;
    });

    const newOrder = rows.map((r) => r.symbol);

    // Check: did the order change relative to previous rerank?
    let isOrderUnchanged = this.state.displayedSymbolsOrder.length === newOrder.length;

    if (isOrderUnchanged) {
      for (let i = 0; i < newOrder.length; i++) {
        if (this.state.displayedSymbolsOrder[i] !== newOrder[i]) {
          isOrderUnchanged = false;
          break;
        }
      }
    }

    this.state.displayedSymbolsOrder = newOrder;

    const tableBody = document.getElementById("tableBody");
    if (!tableBody) {
      return;
    }

    const emptyRow = document.getElementById("emptyRow");
    if (emptyRow) emptyRow.remove();

    if (rows.length === 0) {
      const hasAnySnapshots =
        Array.from(this.state.coreBooks.values()).some((b) => b.isSnapshotReceived) &&
        Array.from(this.state.rhBooks.values()).some((b) => b.isSnapshotReceived);

      const colSpan = this.state.dynamicMode !== "none" ? 10 : 9;
      if (!hasAnySnapshots) {
        tableBody.innerHTML = `
          <tr id="emptyRow">
            <td colspan="${colSpan}" class="empty-table-cell py-12 text-center text-terminal-muted">
              <div class="inline-flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-terminal-accent animate-ping"></span>
                <span>Syncing order books from Lighter Core & Robinhood Chain...</span>
              </div>
            </td>
          </tr>
        `;
      } else {
        tableBody.innerHTML = `
          <tr>
            <td colspan="${colSpan}" class="empty-table-cell py-12 text-center text-terminal-muted">
              No matching pairs for the active filters.
            </td>
          </tr>
        `;
      }
      this.hasInitialRenderHappened = true;
      updateExecutiveSummary(null, this.state.dynamicMode);
      return;
    }

    // If order has not changed — skip DOM mutations entirely!
    if (isOrderUnchanged && this.hasInitialRenderHappened) {
      this.updateCellsInPlace(true);
      this.state.rerankTimerRemaining = CONFIG.RERANK_INTERVAL_SEC;
      this.resetHysteresisTimerCallback?.();
      return;
    }

    // 3. If order changed — update via DocumentFragment in a single batch operation:
    const fragment = document.createDocumentFragment();
    for (const r of rows) {
      let cache = this.rowDomCache.get(r.symbol);
      if (!cache) {
        cache = createRowElement(r, (sym) => this.toggleExpand(sym));
        this.rowDomCache.set(r.symbol, cache);
      }
      fragment.appendChild(cache.tr);

      if (this.state.expandedSymbol === r.symbol && this.detailRowDom) {
        fragment.appendChild(this.detailRowDom);
      }
    }
    tableBody.replaceChildren(fragment);

    this.updateCellsInPlace(true);
    this.hasInitialRenderHappened = true;
    this.state.rerankTimerRemaining = CONFIG.RERANK_INTERVAL_SEC;
    this.resetHysteresisTimerCallback?.();
  }

  private toggleExpand(symbol: string): void {
    if (this.state.expandedSymbol === symbol) {
      this.state.expandedSymbol = null;
      if (this.detailRowDom) this.detailRowDom.remove();
      this.detailRowDom = null;
    } else {
      const m = this.state.markets.get(symbol);
      if (!m) return;
      this.state.expandedSymbol = symbol;
      if (this.detailRowDom) this.detailRowDom.remove();

      const r =
        m.latestMetrics ||
        getMetrics(m, this.state, this.wsManager.lastCoreMsgAt, this.wsManager.lastRhMsgAt);
      if (!r) return;

      this.detailRowDom = createDetailRowElement(r, this.state.targetSizeUsd);
      const cache = this.rowDomCache.get(symbol);
      if (cache?.tr) {
        cache.tr.after(this.detailRowDom);
      }
    }
  }

  private scheduleNextFetch(delayMs: number): void {
    if (this.nextFetchTimer) clearTimeout(this.nextFetchTimer);
    this.nextFetchTimer = setTimeout(() => this.fetchMarkets(), delayMs);
  }

  private async fetchMarkets(): Promise<void> {
    if (this.fetchInFlight) return;
    this.fetchInFlight = true;

    try {
      const [coreRes, rhRes] = await Promise.all([
        fetch(`${CONFIG.CORE_API_URL}/orderBookDetails`),
        fetch(`${CONFIG.RH_API_URL}/orderBookDetails`),
      ]);

      if (!coreRes.ok || !rhRes.ok) {
        console.warn("Failed to fetch orderBookDetails, retrying in 5s");
        this.scheduleNextFetch(5000);
        return;
      }

      const [coreJson, rhJson] = await Promise.all([coreRes.json(), rhRes.json()]);

      const coreMap = new Map();
      for (const m of coreJson.order_book_details || []) {
        if (m.status === "active" && !m.is_frozen) {
          coreMap.set(m.symbol, m);
        }
      }

      const map = new Map<string, MarketInfo>();
      for (const rm of rhJson.order_book_details || []) {
        if (rm.status !== "active" || rm.is_frozen) continue;
        const cm = coreMap.get(rm.symbol);
        if (!cm) continue;

        this.marketIdToSymbol.core.set(cm.market_id, rm.symbol);
        this.marketIdToSymbol.rh.set(rm.market_id, rm.symbol);

        const rhMargin = rm.min_initial_margin_fraction || 500;
        const coreMargin = cm.min_initial_margin_fraction || 500;
        const rhLev = Math.round(10000 / rhMargin);
        const coreLev = Math.round(10000 / coreMargin);
        const minLeverageNum = Math.min(rhLev, coreLev);

        const rhQuoteVol = parseFloat(rm.daily_quote_token_volume);
        const rhVol =
          !isNaN(rhQuoteVol) && rhQuoteVol > 0
            ? rhQuoteVol
            : (parseFloat(rm.daily_base_token_volume) || 0) *
              (parseFloat(rm.last_trade_price) || 0);

        const coreQuoteVol = parseFloat(cm.daily_quote_token_volume);
        const coreVol =
          !isNaN(coreQuoteVol) && coreQuoteVol > 0
            ? coreQuoteVol
            : (parseFloat(cm.daily_base_token_volume) || 0) *
              (parseFloat(cm.last_trade_price) || 0);

        const rhOi = (parseFloat(rm.open_interest) || 0) * (parseFloat(rm.last_trade_price) || 0);
        const coreOi = (parseFloat(cm.open_interest) || 0) * (parseFloat(cm.last_trade_price) || 0);

        const oldMarket = this.state.markets.get(rm.symbol);
        const isNewMarket = !this.state.markets.has(rm.symbol);

        map.set(rm.symbol, {
          symbol: rm.symbol,
          leverage: `${minLeverageNum}x`,
          leverageNum: minLeverageNum,
          rhLeverage: `${rhLev}x`,
          coreLeverage: `${coreLev}x`,
          rhMarketId: rm.market_id,
          coreMarketId: cm.market_id,
          rhVolume24h: rhVol,
          coreVolume24h: coreVol,
          totalVolume24h: rhVol + coreVol,
          rhOiUsd: rhOi,
          coreOiUsd: coreOi,
          totalOiUsd: rhOi + coreOi,
          latestMetrics: oldMarket?.latestMetrics || null,
        });

        if (isNewMarket) {
          this.wsManager.subscribeCore(cm.market_id);
          this.wsManager.subscribeRh(rm.market_id);
        }
      }

      // Prune delisted markets
      for (const [mid, sym] of this.marketIdToSymbol.core.entries()) {
        if (!map.has(sym)) this.marketIdToSymbol.core.delete(mid);
      }
      for (const [mid, sym] of this.marketIdToSymbol.rh.entries()) {
        if (!map.has(sym)) this.marketIdToSymbol.rh.delete(mid);
      }
      for (const sym of this.dirtySymbols) {
        if (!map.has(sym)) this.dirtySymbols.delete(sym);
      }
      for (const sym of this.state.emaMap.keys()) {
        if (!map.has(sym)) this.state.emaMap.delete(sym);
      }

      this.state.markets = map;

      if (!this.isWsInitialized) {
        this.isWsInitialized = true;
        this.wsManager.connectAll();
      }

      this.triggerWarmupSync();
      this.scheduleNextFetch(60000);
    } catch (e) {
      console.error("Error fetching market metadata:", e);
      this.scheduleNextFetch(5000);
    } finally {
      this.fetchInFlight = false;
    }
  }

  private setupHysteresisTimer(): void {
    const timerText = document.getElementById("rerankTimerText");
    let targetExpiry = performance.now() + CONFIG.RERANK_INTERVAL_SEC * 1000;

    this.resetHysteresisTimerCallback = () => {
      targetExpiry = performance.now() + CONFIG.RERANK_INTERVAL_SEC * 1000;
    };

    setInterval(() => {
      if (!this.state.isAutoSortEnabled) return;

      const now = performance.now();
      const remainingSec = Math.max(0, (targetExpiry - now) / 1000);
      this.state.rerankTimerRemaining = remainingSec;

      if (remainingSec <= 0) {
        targetExpiry = performance.now() + CONFIG.RERANK_INTERVAL_SEC * 1000;
        this.state.rerankTimerRemaining = CONFIG.RERANK_INTERVAL_SEC;
        this.rerank();
      }

      if (timerText) {
        timerText.textContent = `${Math.ceil(this.state.rerankTimerRemaining)}s`;
      }
    }, 200);
  }

  private updateSizeControls(
    val: number | "auto" | "auto-min-burn" | "auto-max-vol",
    cap?: number,
  ): void {
    const sizeInput = document.getElementById("sizeInput") as HTMLInputElement | null;
    const sizeInputLabel = document.getElementById("sizeInputLabel");

    if (val === "auto-min-burn" || val === "auto") {
      this.state.isDynamicSize = true;
      this.state.dynamicMode = "min_burn";
      if (cap && cap > 0) this.state.maxCapUsd = cap;
      if (sizeInputLabel) sizeInputLabel.textContent = "Cap:";
      if (sizeInput) {
        sizeInput.value = String(this.state.maxCapUsd || 20000);
        sizeInput.title = "Max position size cap to optimize up to (Min Burn mode)";
      }
    } else if (val === "auto-max-vol") {
      this.state.isDynamicSize = true;
      this.state.dynamicMode = "max_vol";
      if (cap && cap > 0) this.state.maxCapUsd = cap;
      if (sizeInputLabel) sizeInputLabel.textContent = "Cap:";
      if (sizeInput) {
        sizeInput.value = String(this.state.maxCapUsd || 20000);
        sizeInput.title = "Max position size cap to optimize up to (Max Vol mode)";
      }
    } else {
      this.state.isDynamicSize = false;
      this.state.dynamicMode = "none";
      this.state.targetSizeUsd = val;
      if (sizeInputLabel) sizeInputLabel.textContent = "Size:";
      if (sizeInput) {
        sizeInput.value = String(val);
        sizeInput.title = "Fixed target size in USD";
      }
    }

    document.querySelectorAll(".size-btn").forEach((btn) => {
      const sz = (btn as HTMLElement).dataset.size;
      const isActive =
        (this.state.dynamicMode === "min_burn" && (sz === "auto-min-burn" || sz === "auto")) ||
        (this.state.dynamicMode === "max_vol" && sz === "auto-max-vol") ||
        (this.state.dynamicMode === "none" &&
          typeof val === "number" &&
          parseFloat(sz || "0") === val);

      if (isActive) {
        btn.className =
          "size-btn size-btn-active px-1.5 sm:px-2 py-0.5 rounded bg-terminal-border text-white font-bold transition cursor-pointer whitespace-nowrap";
      } else {
        btn.className =
          "size-btn px-1.5 sm:px-2 py-0.5 rounded text-terminal-muted hover:text-white transition cursor-pointer whitespace-nowrap";
      }
    });

    const isDynamic = this.state.dynamicMode !== "none";
    const terminalTable = document.getElementById("terminalTable");
    if (terminalTable) {
      terminalTable.classList.toggle("hide-opt-size", !isDynamic);
    }
    document.querySelectorAll(".detail-row-cell, .empty-table-cell").forEach((el) => {
      el.setAttribute("colspan", isDynamic ? "10" : "9");
    });

    if (!isDynamic && this.state.sortColumn === "effectiveTargetUsd") {
      this.state.sortColumn = "costUsd";
      this.state.sortDirection = "asc";
      this.updateSortHeaderUi();
    }
  }

  private updateSortHeaderUi(): void {
    document.querySelectorAll("#terminalTable th").forEach((th) => {
      const col = (th as HTMLElement).dataset.sort;
      const ind = th.querySelector(".sort-indicator");
      if (ind) {
        if (col === this.state.sortColumn) {
          ind.textContent = this.state.sortDirection === "asc" ? "▲" : "▼";
          ind.className = "sort-indicator text-terminal-accent";
        } else {
          ind.textContent = "";
        }
      }
    });
  }

  private updateLeverageControls(lev: number): void {
    document.querySelectorAll(".lev-btn").forEach((btn) => {
      const l = parseInt((btn as HTMLElement).dataset.lev || "0", 10);
      if (l === lev) {
        btn.className =
          "lev-btn lev-btn-active px-1.5 sm:px-2 py-0.5 rounded bg-terminal-border text-white font-bold transition cursor-pointer whitespace-nowrap";
      } else {
        btn.className =
          "lev-btn px-1.5 sm:px-2 py-0.5 rounded text-terminal-muted hover:text-white transition cursor-pointer whitespace-nowrap";
      }
    });
  }

  private updateEquitiesControl(active: boolean): void {
    const eqBtn = document.getElementById("equitiesToggle");
    if (!eqBtn) return;
    if (active) {
      eqBtn.className =
        "flex-1 sm:flex-initial px-2 py-0.5 rounded border border-terminal-accent/40 bg-terminal-bg text-terminal-accent text-[11px] font-semibold transition cursor-pointer whitespace-nowrap text-center";
      eqBtn.textContent = "Stocks Only";
    } else {
      eqBtn.className =
        "flex-1 sm:flex-initial px-2 py-0.5 rounded border border-terminal-border bg-terminal-bg text-terminal-muted hover:text-white text-[11px] transition cursor-pointer whitespace-nowrap text-center";
      eqBtn.textContent = "All Markets";
    }
  }

  private updateReadyControl(active: boolean): void {
    const readyBtn = document.getElementById("readyToggle");
    if (!readyBtn) return;
    if (active) {
      readyBtn.className =
        "flex-1 sm:flex-initial px-2 py-0.5 rounded border border-terminal-emerald/40 bg-terminal-bg text-terminal-emerald text-[11px] font-semibold transition cursor-pointer whitespace-nowrap text-center";
      readyBtn.textContent = "● Ready Only";
    } else {
      readyBtn.className =
        "flex-1 sm:flex-initial px-2 py-0.5 rounded border border-terminal-border bg-terminal-bg text-terminal-muted hover:text-white text-[11px] transition cursor-pointer whitespace-nowrap text-center";
      readyBtn.textContent = "All Statuses";
    }
  }

  private saveFilterSettings(): void {
    try {
      localStorage.setItem(STORAGE_KEYS.SIZE, String(this.state.targetSizeUsd));
      localStorage.setItem(STORAGE_KEYS.SIZE_MODE, this.state.dynamicMode);
      localStorage.setItem(STORAGE_KEYS.MAX_CAP, String(this.state.maxCapUsd));
      localStorage.setItem(STORAGE_KEYS.LEVERAGE, String(this.state.minLeverageFilter));
      localStorage.setItem(STORAGE_KEYS.FILTER_EQUITIES, String(this.state.filterEquities));
      localStorage.setItem(STORAGE_KEYS.FILTER_READY, String(this.state.filterReadyOnly));
    } catch {}
  }

  private restoreFilterSettings(): void {
    try {
      const savedCap = localStorage.getItem(STORAGE_KEYS.MAX_CAP);
      if (savedCap !== null) {
        const cap = parseFloat(savedCap);
        if (!isNaN(cap) && cap > 0) this.state.maxCapUsd = cap;
      }

      const savedMode = localStorage.getItem(STORAGE_KEYS.SIZE_MODE);
      if (savedMode === "auto-max-vol" || savedMode === "max_vol") {
        this.updateSizeControls("auto-max-vol");
      } else if (
        savedMode === "auto-min-burn" ||
        savedMode === "min_burn" ||
        savedMode === "auto"
      ) {
        this.updateSizeControls("auto-min-burn");
      } else {
        const savedSize = localStorage.getItem(STORAGE_KEYS.SIZE);
        if (savedSize !== null) {
          const val = parseFloat(savedSize);
          if (!isNaN(val) && val > 0) {
            this.updateSizeControls(val);
          }
        }
      }

      const savedLev = localStorage.getItem(STORAGE_KEYS.LEVERAGE);
      if (savedLev !== null) {
        const lev = parseInt(savedLev, 10);
        if (!isNaN(lev) && [0, 5, 10, 20, 50].includes(lev)) {
          this.state.minLeverageFilter = lev;
          this.updateLeverageControls(lev);
        }
      }

      const savedEq = localStorage.getItem(STORAGE_KEYS.FILTER_EQUITIES);
      if (savedEq !== null) {
        this.state.filterEquities = savedEq === "true";
        this.updateEquitiesControl(this.state.filterEquities);
      }

      const savedReady = localStorage.getItem(STORAGE_KEYS.FILTER_READY);
      if (savedReady !== null) {
        this.state.filterReadyOnly = savedReady === "true";
        this.updateReadyControl(this.state.filterReadyOnly);
      }
    } catch {}
  }

  private resetFiltersToDefault(): void {
    this.state.targetSizeUsd = 10000;
    this.state.isDynamicSize = false;
    this.state.dynamicMode = "none";
    this.state.maxCapUsd = 20000;
    this.state.minLeverageFilter = 0;
    this.state.filterEquities = true;
    this.state.filterReadyOnly = false;
    this.state.searchQuery = "";
    this.state.emaMap.clear();

    const searchBox = document.getElementById("searchBox") as HTMLInputElement | null;
    const clearSearchBtn = document.getElementById("clearSearchBtn");
    if (searchBox) searchBox.value = "";
    clearSearchBtn?.classList.add("hidden");

    this.updateSizeControls(10000);
    this.updateLeverageControls(0);
    this.updateEquitiesControl(true);
    this.updateReadyControl(false);

    try {
      localStorage.removeItem(STORAGE_KEYS.SIZE);
      localStorage.removeItem(STORAGE_KEYS.SIZE_MODE);
      localStorage.removeItem(STORAGE_KEYS.LEVERAGE);
      localStorage.removeItem(STORAGE_KEYS.FILTER_EQUITIES);
      localStorage.removeItem(STORAGE_KEYS.FILTER_READY);
    } catch {}

    this.rerank();
  }

  private setupEventListeners(): void {
    // 0. Font selector
    initFontSelector();

    // 1. Auto-sort toggle button & manual rerank button
    const autoSortBtn = document.getElementById("autoSortToggle");
    const manualRerankBtn = document.getElementById("manualRerankBtn");

    manualRerankBtn?.addEventListener("click", () => {
      this.rerank();
    });

    autoSortBtn?.addEventListener("click", () => {
      this.state.isAutoSortEnabled = !this.state.isAutoSortEnabled;
      if (this.state.isAutoSortEnabled) {
        if (autoSortBtn) {
          autoSortBtn.textContent = "Auto: ON";
          autoSortBtn.className =
            "text-[11px] text-terminal-muted hover:text-white transition cursor-pointer select-none outline-none focus:outline-none border-0 bg-transparent p-0";
        }
      } else {
        if (autoSortBtn) {
          autoSortBtn.textContent = "Auto: FROZEN";
          autoSortBtn.className =
            "text-[11px] text-terminal-amber font-semibold hover:text-amber-400 transition cursor-pointer select-none outline-none focus:outline-none border-0 bg-transparent p-0";
        }
      }
    });

    // 2. Size input and buttons
    const sizeInput = document.getElementById("sizeInput") as HTMLInputElement | null;
    sizeInput?.addEventListener("change", (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (!isNaN(val) && val > 0) {
        this.state.emaMap.clear();
        if (this.state.dynamicMode !== "none") {
          this.state.maxCapUsd = val;
          this.updateSizeControls(
            this.state.dynamicMode === "max_vol" ? "auto-max-vol" : "auto-min-burn",
            val,
          );
        } else {
          this.updateSizeControls(val);
        }
        this.saveFilterSettings();
        this.rerank();
      }
    });

    document.querySelectorAll(".size-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sz = (btn as HTMLElement).dataset.size;
        this.state.emaMap.clear();
        if (sz === "auto-min-burn" || sz === "auto") {
          this.updateSizeControls("auto-min-burn");
        } else if (sz === "auto-max-vol") {
          this.updateSizeControls("auto-max-vol");
        } else {
          const val = parseFloat(sz || "10000");
          this.updateSizeControls(val);
        }
        this.saveFilterSettings();
        this.rerank();
      });
    });

    // 3. Leverage buttons
    document.querySelectorAll(".lev-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const lev = parseInt((btn as HTMLElement).dataset.lev || "0", 10);
        this.state.minLeverageFilter = lev;
        this.updateLeverageControls(lev);
        this.saveFilterSettings();
        this.rerank();
      });
    });

    // 4. Search Box
    const searchBox = document.getElementById("searchBox") as HTMLInputElement | null;
    const clearSearchBtn = document.getElementById("clearSearchBtn");

    searchBox?.addEventListener("input", (e) => {
      this.state.searchQuery = (e.target as HTMLInputElement).value.trim();
      if (this.state.searchQuery.length > 0) {
        clearSearchBtn?.classList.remove("hidden");
      } else {
        clearSearchBtn?.classList.add("hidden");
      }
      this.rerank();
    });

    clearSearchBtn?.addEventListener("click", () => {
      if (searchBox) searchBox.value = "";
      this.state.searchQuery = "";
      clearSearchBtn.classList.add("hidden");
      this.rerank();
    });

    // Hotkeys: '/' and 'Escape'
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "/" &&
        document.activeElement !== searchBox &&
        !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName || "")
      ) {
        e.preventDefault();
        searchBox?.focus();
        searchBox?.select();
      } else if (e.key === "Escape" && document.activeElement === searchBox) {
        if (searchBox) searchBox.value = "";
        this.state.searchQuery = "";
        clearSearchBtn?.classList.add("hidden");
        searchBox?.blur();
        this.rerank();
      }
    });

    // 5. Equities toggle
    const eqBtn = document.getElementById("equitiesToggle");
    eqBtn?.addEventListener("click", () => {
      this.state.filterEquities = !this.state.filterEquities;
      this.updateEquitiesControl(this.state.filterEquities);
      this.saveFilterSettings();
      this.rerank();
    });

    // 6. Ready Only toggle
    const readyBtn = document.getElementById("readyToggle");
    readyBtn?.addEventListener("click", () => {
      this.state.filterReadyOnly = !this.state.filterReadyOnly;
      this.updateReadyControl(this.state.filterReadyOnly);
      this.saveFilterSettings();
      this.rerank();
    });

    // 7. Reset filters
    const resetBtn = document.getElementById("resetFiltersBtn");
    resetBtn?.addEventListener("click", () => {
      this.resetFiltersToDefault();
    });

    // 8. Column Header Sorting
    document.querySelectorAll("#terminalTable th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const col = (th as HTMLElement).dataset.sort as keyof MarketMetrics;
        if (this.state.sortColumn === col) {
          this.state.sortDirection = this.state.sortDirection === "asc" ? "desc" : "asc";
        } else {
          this.state.sortColumn = col;
          this.state.sortDirection =
            col === "totalVolume24h" || col === "totalOiUsd" ? "desc" : "asc";
        }

        this.updateSortHeaderUi();
        this.rerank();
      });
    });
  }
}
