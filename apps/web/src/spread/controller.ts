import type { MarketInfo, MarketMetrics, RowDomCache, SimFillResult, TerminalState } from "./types";
import { CONFIG, STORAGE_KEYS } from "./config";
import { getMetrics } from "./metrics";
import { getOrCreateBook, updateBookFromWs } from "./orderbook";
import { WebSocketManager, type WsOrderBookData } from "./ws";
import {
  initFontSelector,
  registerTokens,
  matchesCategory,
  normalizeCategoryFilter,
  getCategoryShortLabel,
  MARKET_CATEGORIES,
  getHedgeCategory,
  getHedgeSideConfig,
  type TokenCategoryType,
} from "../shared";
import {
  createRowElement,
  applyRowMetricsToDom,
  applyNullMetricsToDom,
  createDetailRowElement,
  updateDetailRow,
  updateExecutiveSummary,
} from "./dom";

const STATUS_RANK: Record<string, number> = { READY: 1, SLIPPAGE: 2, "LOW LIQ": 3, STALE: 4 };

export class TerminalController {
  public state: TerminalState = {
    markets: new Map(),
    coreBooks: new Map(),
    rhBooks: new Map(),
    targetSizeUsd: 10000,
    isDynamicSize: false,
    dynamicMode: "none",
    maxCapUsd: 20000,
    filterEquities: false,
    categoryFilter: "all",
    filterReadyOnly: false,
    minLeverageFilter: 0,
    searchQuery: "",
    sortColumn: "costUsd",
    sortDirection: "asc",
    isAutoSortEnabled: true,
    displayedSymbolsOrder: [],
    rerankTimerRemaining: CONFIG.DEFAULT_RERANK_INTERVAL_SEC,
    rerankIntervalSec: CONFIG.DEFAULT_RERANK_INTERVAL_SEC,
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
  private activeTrRows: HTMLElement[] = [];
  private scratchRows: MarketMetrics[] = [];
  private scratchOrder: string[] = [];

  private wsManager: WebSocketManager;
  private isWsInitialized = false;
  private fetchInFlight = false;
  private nextFetchTimer: ReturnType<typeof setTimeout> | null = null;

  private updateScheduled = false;
  private hasInitialRenderHappened = false;
  private resetHysteresisTimerCallback: (() => void) | null = null;

  constructor() {
    this.wsManager = new WebSocketManager({
      onCoreOpen: () => {
        this.state.isCoreConnected = true;
        this.updateDotStatus("coreWsDot", "bg-terminal-emerald");
        this.syncSubscriptions();
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
        this.syncSubscriptions();
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
  }

  public syncSubscriptions(): void {
    for (const m of this.state.markets.values()) {
      const shouldBeSubscribed = matchesCategory(m.symbol, this.state.categoryFilter);

      if (shouldBeSubscribed) {
        if (!this.wsManager.isCoreSubscribed(m.coreMarketId)) {
          this.wsManager.subscribeCore(m.coreMarketId);
        }
        if (!this.wsManager.isRhSubscribed(m.rhMarketId)) {
          this.wsManager.subscribeRh(m.rhMarketId);
        }
      } else {
        if (this.wsManager.isCoreSubscribed(m.coreMarketId)) {
          this.wsManager.unsubscribeCore(m.coreMarketId);
          const coreBook = this.state.coreBooks.get(m.coreMarketId);
          if (coreBook) {
            coreBook.isSnapshotReceived = false;
          }
        }
        if (this.wsManager.isRhSubscribed(m.rhMarketId)) {
          this.wsManager.unsubscribeRh(m.rhMarketId);
          const rhBook = this.state.rhBooks.get(m.rhMarketId);
          if (rhBook) {
            rhBook.isSnapshotReceived = false;
          }
        }
        this.dirtySymbols.delete(m.symbol);
      }
    }
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
    const mobileId =
      id === "coreWsDot" ? "mobileCoreWsDot" : id === "rhWsDot" ? "mobileRhWsDot" : null;
    if (mobileId) {
      const mobileEl = document.getElementById(mobileId);
      if (mobileEl) mobileEl.className = `w-1.5 h-1.5 rounded-full ${className}`;
    }
    const mobileHeaderId =
      id === "coreWsDot" ? "mobileHeaderCoreDot" : id === "rhWsDot" ? "mobileHeaderRhDot" : null;
    if (mobileHeaderId) {
      const mobileHeaderEl = document.getElementById(mobileHeaderId);
      if (mobileHeaderEl) mobileHeaderEl.className = `w-1.5 h-1.5 rounded-full ${className}`;
    }
  }

  private handleCoreBookUpdate(
    marketId: number,
    data: WsOrderBookData,
    isSnapshot: boolean,
    offset: number,
  ): void {
    const symbol = this.marketIdToSymbol.core.get(marketId);
    if (!symbol || !matchesCategory(symbol, this.state.categoryFilter)) {
      return;
    }
    const book = getOrCreateBook(this.state.coreBooks, marketId);
    updateBookFromWs(book, data, isSnapshot, offset);
    this.dirtySymbols.add(symbol);
    this.scheduleInPlaceUpdate();
  }

  private handleRhBookUpdate(
    marketId: number,
    data: WsOrderBookData,
    isSnapshot: boolean,
    offset: number,
  ): void {
    const symbol = this.marketIdToSymbol.rh.get(marketId);
    if (!symbol || !matchesCategory(symbol, this.state.categoryFilter)) {
      return;
    }
    const book = getOrCreateBook(this.state.rhBooks, marketId);
    updateBookFromWs(book, data, isSnapshot, offset);
    this.dirtySymbols.add(symbol);
    this.scheduleInPlaceUpdate();
  }

  private scheduleInPlaceUpdate(): void {
    if (!this.hasInitialRenderHappened) {
      this.rerank();
      return;
    }

    if (this.updateScheduled) return;
    this.updateScheduled = true;

    requestAnimationFrame(() => {
      this.updateScheduled = false;
      if (this.state.rerankIntervalSec === 0 && this.state.isAutoSortEnabled) {
        this.rerank();
      } else {
        this.updateCellsInPlace(false);
      }
    });
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
        m.latestMetrics,
      );

      const cache = this.rowDomCache.get(symbol);
      if (!row) {
        if (cache) applyNullMetricsToDom(cache, m);
        continue;
      }
      if (!cache) continue;

      applyRowMetricsToDom(cache, row);
      if (this.state.expandedSymbol === symbol && this.detailRowDom) {
        updateDetailRow(row, this.state.targetSizeUsd, this.detailRowDom);
      }
    }

    this.updateLeaderSummary();
  }

  private updateLeaderSummary(): void {
    let topRow: MarketMetrics | null = null;
    let bestCost = Infinity;
    const nowTime = performance.now();
    const isSortedByCostAsc =
      this.state.sortColumn === "costUsd" && this.state.sortDirection === "asc";

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
        if (r.costUsd < bestCost) {
          bestCost = r.costUsd;
          topRow = r;
        }
        if (isSortedByCostAsc) {
          // In standard cost sort, the first eligible candidate is always the optimal leader
          break;
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

    const hedgeSideConfig = getHedgeSideConfig(m.symbol);
    const hedgeCategory = getHedgeCategory(m.symbol);

    return {
      symbol: m.symbol,
      isRhLong: hedgeSideConfig.isRhLong,
      hedgeCategory,
      hedgeSideConfig,
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
    this.scratchRows.length = 0;
    const rows = this.scratchRows;
    const now = performance.now();

    for (const m of this.state.markets.values()) {
      if (!matchesCategory(m.symbol, this.state.categoryFilter)) continue;
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
          m.latestMetrics,
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
        return ((STATUS_RANK[a.status] || 9) - (STATUS_RANK[b.status] || 9)) * dir;
      }
      const rankA = a.status === "READY" ? 0 : a.status === "SLIPPAGE" ? 1 : 2;
      const rankB = b.status === "READY" ? 0 : b.status === "SLIPPAGE" ? 1 : 2;
      if (rankA !== rankB) return rankA - rankB;

      if (this.state.sortColumn === "entryLossUsd" || this.state.sortColumn === "entryDragBps") {
        return (a.entryLossUsd - b.entryLossUsd) * dir;
      }
      if (this.state.sortColumn === "exitLossUsd" || this.state.sortColumn === "exitDragBps") {
        return (a.exitLossUsd - b.exitLossUsd) * dir;
      }

      const col = this.state.sortColumn as keyof MarketMetrics;
      const valA = (a[col] as unknown as number) || 0;
      const valB = (b[col] as unknown as number) || 0;
      return (valA - valB) * dir;
    });

    this.scratchOrder.length = 0;
    for (let i = 0; i < rows.length; i++) {
      this.scratchOrder.push(rows[i]!.symbol);
    }
    this.state.displayedSymbolsOrder = this.scratchOrder;

    if (this.state.expandedSymbol && !rows.some((r) => r.symbol === this.state.expandedSymbol)) {
      const prevCache = this.rowDomCache.get(this.state.expandedSymbol);
      prevCache?.chevronEl?.classList.remove("rotate-180");
      this.state.expandedSymbol = null;
      if (this.detailRowDom) {
        this.detailRowDom.remove();
        this.detailRowDom = null;
      }
    }

    const tableBody = document.getElementById("tableBody");
    if (!tableBody) {
      return;
    }

    const emptyRow = document.getElementById("emptyRow");
    if (emptyRow) emptyRow.remove();

    if (rows.length === 0) {
      this.activeTrRows.length = 0;
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

    // 3. Positional DOM reconciliation with JS array tracking (zero DOM collection traversal)
    if (this.activeTrRows.length === 0 && tableBody.children.length > 0) {
      this.activeTrRows = Array.from(tableBody.children) as HTMLElement[];
    }

    let domIndex = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      let cache = this.rowDomCache.get(r.symbol);
      if (!cache) {
        cache = createRowElement(r, (sym) => this.toggleExpand(sym));
        this.rowDomCache.set(r.symbol, cache);
      }
      cache.chevronEl?.classList.toggle("rotate-180", this.state.expandedSymbol === r.symbol);

      const targetTr = cache.tr;
      const currentTr = this.activeTrRows[domIndex];
      if (currentTr !== targetTr) {
        tableBody.insertBefore(targetTr, currentTr || null);
        const existingIdx = this.activeTrRows.indexOf(targetTr);
        if (existingIdx !== -1) {
          this.activeTrRows.splice(existingIdx, 1);
        }
        this.activeTrRows.splice(domIndex, 0, targetTr);
      }
      domIndex++;

      applyRowMetricsToDom(cache, r);

      if (this.state.expandedSymbol === r.symbol && this.detailRowDom) {
        const detailTr = this.activeTrRows[domIndex];
        if (detailTr !== this.detailRowDom) {
          tableBody.insertBefore(this.detailRowDom, detailTr || null);
          const existingIdx = this.activeTrRows.indexOf(this.detailRowDom);
          if (existingIdx !== -1) {
            this.activeTrRows.splice(existingIdx, 1);
          }
          this.activeTrRows.splice(domIndex, 0, this.detailRowDom);
        }
        domIndex++;
        updateDetailRow(r, this.state.targetSizeUsd, this.detailRowDom);
      }
    }

    // Clean up trailing rows (e.g. if filtered out)
    while (this.activeTrRows.length > domIndex) {
      const tr = this.activeTrRows.pop();
      tr?.remove();
    }

    this.updateLeaderSummary();
    this.hasInitialRenderHappened = true;
    this.state.rerankTimerRemaining = this.state.rerankIntervalSec;
    this.resetHysteresisTimerCallback?.();
  }

  private toggleExpand(symbol: string): void {
    if (this.state.expandedSymbol === symbol) {
      const prevCache = this.rowDomCache.get(this.state.expandedSymbol);
      prevCache?.chevronEl?.classList.remove("rotate-180");
      this.state.expandedSymbol = null;
      if (this.detailRowDom) {
        const idx = this.activeTrRows.indexOf(this.detailRowDom);
        if (idx !== -1) this.activeTrRows.splice(idx, 1);
        this.detailRowDom.remove();
      }
      this.detailRowDom = null;
    } else {
      if (this.state.expandedSymbol) {
        const prevCache = this.rowDomCache.get(this.state.expandedSymbol);
        prevCache?.chevronEl?.classList.remove("rotate-180");
      }
      const m = this.state.markets.get(symbol);
      if (!m) return;
      this.state.expandedSymbol = symbol;
      if (this.detailRowDom) {
        const idx = this.activeTrRows.indexOf(this.detailRowDom);
        if (idx !== -1) this.activeTrRows.splice(idx, 1);
        this.detailRowDom.remove();
      }

      const r =
        m.latestMetrics ||
        getMetrics(m, this.state, this.wsManager.lastCoreMsgAt, this.wsManager.lastRhMsgAt);
      if (!r) return;

      this.detailRowDom = createDetailRowElement(r, this.state.targetSizeUsd);
      const cache = this.rowDomCache.get(symbol);
      if (cache?.tr) {
        cache.tr.after(this.detailRowDom);
        const trIdx = this.activeTrRows.indexOf(cache.tr);
        if (trIdx !== -1) {
          this.activeTrRows.splice(trIdx + 1, 0, this.detailRowDom);
        } else {
          this.activeTrRows.push(this.detailRowDom);
        }
        cache.chevronEl?.classList.add("rotate-180");
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
      const [coreRes, rhRes, rhTokRes, coreTokRes] = await Promise.all([
        fetch(`${CONFIG.CORE_API_URL}/orderBookDetails`),
        fetch(`${CONFIG.RH_API_URL}/orderBookDetails`),
        fetch(`${CONFIG.RH_API_URL}/tokenlist`).catch(() => null),
        fetch(`${CONFIG.CORE_API_URL}/tokenlist`).catch(() => null),
      ]);

      if (!coreRes.ok || !rhRes.ok) {
        console.warn("Failed to fetch orderBookDetails, retrying in 5s");
        this.scheduleNextFetch(5000);
        return;
      }

      if (rhTokRes?.ok) {
        try {
          const rhTokJson = await rhTokRes.json();
          if (Array.isArray(rhTokJson.tokens)) {
            registerTokens(rhTokJson.tokens);
          }
        } catch (e) {
          console.warn("Failed to parse RH tokenlist:", e);
        }
      }

      if (coreTokRes?.ok) {
        try {
          const coreTokJson = await coreTokRes.json();
          if (Array.isArray(coreTokJson.tokens)) {
            registerTokens(coreTokJson.tokens);
          }
        } catch (e) {
          console.warn("Failed to parse Core tokenlist:", e);
        }
      }

      const [coreJson, rhJson] = await Promise.all([coreRes.json(), rhRes.json()]);

      const coreMap = new Map<string, any>();
      for (const m of coreJson.order_book_details || []) {
        if (m.symbol && m.status === "active" && !m.is_frozen) {
          coreMap.set(m.symbol.toUpperCase().trim(), m);
        }
      }

      const map = new Map<string, MarketInfo>();
      for (const rm of rhJson.order_book_details || []) {
        if (!rm.symbol || rm.status !== "active" || rm.is_frozen) continue;
        const sym = rm.symbol.toUpperCase().trim();
        const cm = coreMap.get(sym);
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
      this.syncSubscriptions();

      if (!this.isWsInitialized) {
        this.isWsInitialized = true;
        this.wsManager.connectAll();
      }

      this.rerank();
      this.scheduleNextFetch(60000);
    } catch (e) {
      console.error("Error fetching market metadata:", e);
      this.scheduleNextFetch(5000);
    } finally {
      this.fetchInFlight = false;
    }
  }

  private setupHysteresisTimer(): void {
    let targetExpiry = performance.now() + this.state.rerankIntervalSec * 1000;

    this.resetHysteresisTimerCallback = () => {
      targetExpiry = performance.now() + this.state.rerankIntervalSec * 1000;
    };

    setInterval(() => {
      if (!this.state.isAutoSortEnabled || this.state.rerankIntervalSec === 0) {
        return;
      }

      const now = performance.now();
      const remainingSec = Math.max(0, (targetExpiry - now) / 1000);
      this.state.rerankTimerRemaining = remainingSec;

      if (remainingSec <= 0) {
        targetExpiry = performance.now() + this.state.rerankIntervalSec * 1000;
        this.state.rerankTimerRemaining = this.state.rerankIntervalSec;
        requestAnimationFrame(() => this.rerank());
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
      this.saveFilterSettings();
    }

    // Mark all markets dirty so rerank recalculates metrics for the new size
    for (const sym of this.state.markets.keys()) {
      this.dirtySymbols.add(sym);
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

  private updateCategoryControl(cat: TokenCategoryType): void {
    const sel = document.getElementById("categorySelector") as HTMLSelectElement | null;
    if (sel) sel.value = cat;

    const eqBtn = document.getElementById("equitiesToggle");
    if (eqBtn) {
      const isFiltered = cat !== "all";
      eqBtn.className = isFiltered
        ? "flex-1 sm:flex-initial px-2 py-0.5 rounded border border-terminal-accent/40 bg-terminal-bg text-terminal-accent text-[11px] font-semibold transition cursor-pointer whitespace-nowrap text-center"
        : "flex-1 sm:flex-initial px-2 py-0.5 rounded border border-terminal-border bg-terminal-bg text-terminal-muted hover:text-white text-[11px] transition cursor-pointer whitespace-nowrap text-center";
      eqBtn.textContent = getCategoryShortLabel(cat);
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
      localStorage.setItem(STORAGE_KEYS.CATEGORY_FILTER, this.state.categoryFilter);
      localStorage.setItem(
        STORAGE_KEYS.FILTER_EQUITIES,
        String(this.state.categoryFilter === "rwa_pre_ipo_equities"),
      );
      localStorage.setItem(STORAGE_KEYS.FILTER_READY, String(this.state.filterReadyOnly));
      localStorage.setItem(STORAGE_KEYS.RERANK_INTERVAL, String(this.state.rerankIntervalSec));
      localStorage.setItem(STORAGE_KEYS.SORT_COLUMN, String(this.state.sortColumn));
      localStorage.setItem(STORAGE_KEYS.SORT_DIRECTION, String(this.state.sortDirection));
    } catch {}
  }

  private restoreFilterSettings(): void {
    try {
      const savedRerank =
        localStorage.getItem(STORAGE_KEYS.RERANK_INTERVAL) ??
        localStorage.getItem("terminal_freeze_interval");
      if (savedRerank !== null) {
        const sec = parseInt(savedRerank, 10);
        if ([0, 3, 5, 10].includes(sec)) {
          this.state.rerankIntervalSec = sec;
          this.state.rerankTimerRemaining = sec;
          const rerankSelector = document.getElementById(
            "rerankSelector",
          ) as HTMLSelectElement | null;
          const mobileRerankSelector = document.getElementById(
            "mobileRerankSelector",
          ) as HTMLSelectElement | null;
          if (rerankSelector) rerankSelector.value = String(sec);
          if (mobileRerankSelector) mobileRerankSelector.value = String(sec);
        }
      }

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

      const savedCat = localStorage.getItem(STORAGE_KEYS.CATEGORY_FILTER);
      if (savedCat) {
        this.state.categoryFilter = normalizeCategoryFilter(savedCat) as TokenCategoryType;
        this.state.filterEquities = this.state.categoryFilter === "rwa_pre_ipo_equities";
        this.updateCategoryControl(this.state.categoryFilter);
      } else {
        const savedEq = localStorage.getItem(STORAGE_KEYS.FILTER_EQUITIES);
        if (savedEq !== null) {
          this.state.categoryFilter = savedEq === "true" ? "rwa_pre_ipo_equities" : "all";
          this.state.filterEquities = savedEq === "true";
          this.updateCategoryControl(this.state.categoryFilter);
        }
      }

      const savedReady = localStorage.getItem(STORAGE_KEYS.FILTER_READY);
      if (savedReady !== null) {
        this.state.filterReadyOnly = savedReady === "true";
        this.updateReadyControl(this.state.filterReadyOnly);
      }

      const savedSortCol = localStorage.getItem(STORAGE_KEYS.SORT_COLUMN);
      const savedSortDir = localStorage.getItem(STORAGE_KEYS.SORT_DIRECTION);
      const VALID_SORT_COLS = new Set([
        "symbol",
        "status",
        "effectiveTargetUsd",
        "costUsd",
        "entryLossUsd",
        "entryDragBps",
        "exitLossUsd",
        "exitDragBps",
        "midPrice",
        "totalVolume24h",
        "totalOiUsd",
        "leverageNum",
      ]);
      if (savedSortCol && VALID_SORT_COLS.has(savedSortCol)) {
        this.state.sortColumn = savedSortCol as keyof MarketMetrics | "leverageNum";
      }
      if (savedSortDir === "asc" || savedSortDir === "desc") {
        this.state.sortDirection = savedSortDir;
      }
      this.updateSortHeaderUi();
    } catch {}
  }

  private resetFiltersToDefault(): void {
    this.state.targetSizeUsd = 10000;
    this.state.isDynamicSize = false;
    this.state.dynamicMode = "none";
    this.state.maxCapUsd = 20000;
    this.state.minLeverageFilter = 0;
    this.state.filterEquities = false;
    this.state.categoryFilter = "all";
    this.state.filterReadyOnly = false;
    this.state.searchQuery = "";
    this.state.sortColumn = "costUsd";
    this.state.sortDirection = "asc";
    this.state.emaMap.clear();
    this.state.rerankIntervalSec = CONFIG.DEFAULT_RERANK_INTERVAL_SEC;
    this.state.rerankTimerRemaining = CONFIG.DEFAULT_RERANK_INTERVAL_SEC;

    this.updateSortHeaderUi();

    const rerankSelector = document.getElementById("rerankSelector") as HTMLSelectElement | null;
    const mobileRerankSelector = document.getElementById(
      "mobileRerankSelector",
    ) as HTMLSelectElement | null;
    if (rerankSelector) rerankSelector.value = String(this.state.rerankIntervalSec);
    if (mobileRerankSelector) mobileRerankSelector.value = String(this.state.rerankIntervalSec);

    const searchBox = document.getElementById("searchBox") as HTMLInputElement | null;
    const clearSearchBtn = document.getElementById("clearSearchBtn");
    if (searchBox) searchBox.value = "";
    clearSearchBtn?.classList.add("hidden");

    this.updateSizeControls(10000);
    this.updateLeverageControls(0);
    this.updateCategoryControl("all");
    this.updateReadyControl(false);
    this.syncSubscriptions();

    try {
      localStorage.removeItem(STORAGE_KEYS.SIZE);
      localStorage.removeItem(STORAGE_KEYS.SIZE_MODE);
      localStorage.removeItem(STORAGE_KEYS.MAX_CAP);
      localStorage.removeItem(STORAGE_KEYS.LEVERAGE);
      localStorage.removeItem(STORAGE_KEYS.CATEGORY_FILTER);
      localStorage.removeItem(STORAGE_KEYS.FILTER_EQUITIES);
      localStorage.removeItem(STORAGE_KEYS.FILTER_READY);
      localStorage.removeItem(STORAGE_KEYS.RERANK_INTERVAL);
      localStorage.removeItem(STORAGE_KEYS.SORT_COLUMN);
      localStorage.removeItem(STORAGE_KEYS.SORT_DIRECTION);
      localStorage.removeItem("terminal_freeze_interval");
    } catch {}

    this.rerank();
  }

  private setupEventListeners(): void {
    // 0. Font selector
    initFontSelector();

    // 0.5. Rerank interval selectors (Desktop & Mobile)
    const rerankSelector = document.getElementById("rerankSelector") as HTMLSelectElement | null;
    const mobileRerankSelector = document.getElementById(
      "mobileRerankSelector",
    ) as HTMLSelectElement | null;

    if (rerankSelector) rerankSelector.value = String(this.state.rerankIntervalSec);
    if (mobileRerankSelector) mobileRerankSelector.value = String(this.state.rerankIntervalSec);

    const handleRerankChange = (sec: number) => {
      this.state.rerankIntervalSec = sec;
      this.state.rerankTimerRemaining = sec;
      if (rerankSelector) rerankSelector.value = String(sec);
      if (mobileRerankSelector) mobileRerankSelector.value = String(sec);
      this.resetHysteresisTimerCallback?.();
      try {
        localStorage.setItem(STORAGE_KEYS.RERANK_INTERVAL, String(sec));
      } catch {}
      if (sec === 0 && this.state.isAutoSortEnabled) {
        this.rerank();
      }
    };

    rerankSelector?.addEventListener("change", (e) => {
      handleRerankChange(parseInt((e.target as HTMLSelectElement).value, 10) || 0);
    });
    mobileRerankSelector?.addEventListener("change", (e) => {
      handleRerankChange(parseInt((e.target as HTMLSelectElement).value, 10) || 0);
    });

    // 1. Auto-sort toggle button
    const autoSortBtn = document.getElementById("autoSortToggle");
    const mobileAutoSortBtn = document.getElementById("mobileAutoSortToggle");

    const updateAutoSortButtons = () => {
      if (autoSortBtn) {
        if (this.state.isAutoSortEnabled) {
          autoSortBtn.textContent = "Auto: ON";
          autoSortBtn.className =
            "text-[11px] text-terminal-muted hover:text-white transition cursor-pointer select-none outline-none focus:outline-none border-0 bg-transparent p-0";
        } else {
          autoSortBtn.textContent = "Auto: FROZEN";
          autoSortBtn.className =
            "text-[11px] text-terminal-amber font-semibold hover:text-amber-400 transition cursor-pointer select-none outline-none focus:outline-none border-0 bg-transparent p-0";
        }
      }
      if (mobileAutoSortBtn) {
        if (this.state.isAutoSortEnabled) {
          mobileAutoSortBtn.textContent = "Auto: ON";
          mobileAutoSortBtn.className =
            "text-[11px] text-terminal-muted hover:text-white px-2 py-0.5 rounded border border-terminal-border bg-terminal-surface transition cursor-pointer select-none";
        } else {
          mobileAutoSortBtn.textContent = "Auto: FROZEN";
          mobileAutoSortBtn.className =
            "text-[11px] text-terminal-amber font-semibold hover:text-amber-400 px-2 py-0.5 rounded border border-terminal-amber/50 bg-terminal-surface transition cursor-pointer select-none";
        }
      }
      this.resetHysteresisTimerCallback?.();
    };

    const toggleAutoSort = () => {
      this.state.isAutoSortEnabled = !this.state.isAutoSortEnabled;
      updateAutoSortButtons();
    };

    autoSortBtn?.addEventListener("click", toggleAutoSort);
    mobileAutoSortBtn?.addEventListener("click", toggleAutoSort);

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

    // 4. Search Box with 100ms Debounce
    const searchBox = document.getElementById("searchBox") as HTMLInputElement | null;
    const clearSearchBtn = document.getElementById("clearSearchBtn");
    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    searchBox?.addEventListener("input", (e) => {
      this.state.searchQuery = (e.target as HTMLInputElement).value.trim();
      if (this.state.searchQuery.length > 0) {
        clearSearchBtn?.classList.remove("hidden");
      } else {
        clearSearchBtn?.classList.add("hidden");
      }
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null;
        this.rerank();
      }, 100);
    });

    clearSearchBtn?.addEventListener("click", () => {
      if (searchBox) searchBox.value = "";
      this.state.searchQuery = "";
      clearSearchBtn.classList.add("hidden");
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
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

    // 5. Category selector
    const catSel = document.getElementById("categorySelector") as HTMLSelectElement | null;
    if (catSel) {
      catSel.innerHTML = MARKET_CATEGORIES.map(
        (c) => `<option value="${c.id}" class="bg-terminal-surface text-white">${c.label}</option>`,
      ).join("");
      catSel.value = this.state.categoryFilter;
    }
    catSel?.addEventListener("change", (e) => {
      const val = (e.target as HTMLSelectElement).value as TokenCategoryType;
      this.state.categoryFilter = val;
      this.state.filterEquities = val === "rwa_pre_ipo_equities";
      this.saveFilterSettings();
      this.syncSubscriptions();
      this.rerank();
    });

    const eqBtn = document.getElementById("equitiesToggle");
    eqBtn?.addEventListener("click", () => {
      const nextCat: TokenCategoryType =
        this.state.categoryFilter === "all" ? "rwa_pre_ipo_equities" : "all";
      this.state.categoryFilter = nextCat;
      this.state.filterEquities = nextCat === "rwa_pre_ipo_equities";
      this.updateCategoryControl(nextCat);
      this.saveFilterSettings();
      this.syncSubscriptions();
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
        this.saveFilterSettings();
        this.rerank();
      });
    });
  }
}
