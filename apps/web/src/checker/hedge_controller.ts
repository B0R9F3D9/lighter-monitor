import {
  downloadTextFile,
  getStaticMarketMap,
  normalizeTimestampMs,
  parseTradeForView,
  processTradesFundingHistory,
  sortParsedTradesChronologicalDesc,
  sortTradesChronologicalDesc,
} from "./api";
import {
  type ActiveDateFilter,
  createPresetDateFilter,
  findPresetById,
  isTradeInDateRange,
  parseCustomDateRange,
  populatePresetSelect,
} from "./date_filter";
import {
  clearAllData,
  getAccountFunding,
  getAccountMeta,
  getAccountTrades,
  getAccountWithdrawals,
  saveAccountMeta,
} from "./db";
import {
  type HedgeMetricElements,
  type HedgeSelectionMetricElements,
  type IndividualAccountMetricElements,
  renderHedgeTable,
  renderMarketSummaryCards,
  renderWeeklyPointsTable,
  updateHedgeExecutiveMetrics,
  updateHedgeSelectionMetrics,
  updateIndividualAccountMetrics,
  updateScrollMask,
} from "./dom";
import {
  calculateAccountAverageOi,
  calculateAccountDailyStats,
  calculateHedgeMetrics,
  calculateMarketSummaryStats,
  calculateSelectedHedgeMetrics,
  computeRangeSelection,
  exportHedgeReportToCsv,
  getParticipatingWeeksStats,
  matchHedgeTrades,
  sortWeeklyPointsStats,
} from "./hedge";
import { AuthExpiredError, parseLighterToken, syncDualAccounts } from "./sync";
import type {
  AccountMetaRecord,
  HedgePair,
  HedgeSummaryMetrics,
  IndividualAccountMetrics,
  LighterTrade,
  MarketSummarySortColumn,
  ParsedTradeView,
  PositionFundingRecord,
  SyncProgressInfo,
  UnhedgedTrade,
  WeeklyPointsSortColumn,
  WithdrawalRecord,
} from "./types";

const STORAGE_KEY_RH_TOKEN = "lighter_ro_token_rh";
const STORAGE_KEY_CORE_TOKEN = "lighter_ro_token_core";
const STORAGE_KEY_ACTIVE_RH_KEY = "lighter_active_rh_key";
const STORAGE_KEY_ACTIVE_CORE_KEY = "lighter_active_core_key";

export class HedgeController {
  // In-Memory dataset (Loaded once from IDB, updated in O(K) on delta sync)
  private rhRawTrades: LighterTrade[] = [];
  private coreRawTrades: LighterTrade[] = [];
  private rhFunding: PositionFundingRecord[] = [];
  private coreFunding: PositionFundingRecord[] = [];
  private rhWithdrawals: WithdrawalRecord[] = [];
  private coreWithdrawals: WithdrawalRecord[] = [];

  private rhAccountMeta: AccountMetaRecord | null = null;
  private coreAccountMeta: AccountMetaRecord | null = null;
  private activeRhAccountKey = "";
  private activeCoreAccountKey = "";

  private rhParsedTrades: ParsedTradeView[] = [];
  private coreParsedTrades: ParsedTradeView[] = [];
  private rhAccountIndex: number | null = null;
  private coreAccountIndex: number | null = null;
  private rhAccountIndices: number[] = [];
  private coreAccountIndices: number[] = [];

  private hedgePairs: HedgePair[] = [];
  private unhedgedTrades: UnhedgedTrade[] = [];
  private hedgePairsMap = new Map<string, HedgePair>();
  private unhedgedTradesMap = new Map<string, UnhedgedTrade>();
  private filteredHedgePairs: HedgePair[] = [];
  private filteredUnhedgedTrades: UnhedgedTrade[] = [];
  private hedgeMetrics: HedgeSummaryMetrics | null = null;
  private hedgeFilterTab: "all" | "unhedged" = "all";
  private hedgeSearchQuery = "";
  private hedgeFilterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private rhMarketMap: Map<number, string> = getStaticMarketMap("rh");
  private coreMarketMap: Map<number, string> = getStaticMarketMap("mainnet");

  private isSyncing = false;
  private syncAbortController: AbortController | null = null;

  // Sync Control Bar Elements
  private labelLastSyncedAt: HTMLElement | null = null;
  private btnSyncNewData: HTMLButtonElement | null = null;
  private labelSyncButtonText: HTMLElement | null = null;
  private btnFullResync: HTMLButtonElement | null = null;
  private btnToggleCredentials: HTMLButtonElement | null = null;
  private syncIconSpin: HTMLElement | null = null;
  private stopIconCross: HTMLElement | null = null;
  private syncProgressWrapper: HTMLElement | null = null;
  private syncProgressBar: HTMLElement | null = null;
  private syncStatusMessage: HTMLElement | null = null;
  private syncDurationLabel: HTMLElement | null = null;
  private btnHedgeExportCsv: HTMLButtonElement | null = null;

  // Credentials Drawer Elements
  private credentialsDrawer: HTMLElement | null = null;
  private btnCloseCredentials: HTMLButtonElement | null = null;
  private btnDismissCredentials: HTMLButtonElement | null = null;
  private btnSaveCredentialsAndSync: HTMLButtonElement | null = null;
  private btnClearStoredCredentials: HTMLButtonElement | null = null;
  private inputRhToken: HTMLInputElement | null = null;
  private inputCoreToken: HTMLInputElement | null = null;
  private btnToggleRhVisibility: HTMLButtonElement | null = null;
  private btnToggleCoreVisibility: HTMLButtonElement | null = null;
  private badgeRhTokenParsed: HTMLElement | null = null;
  private badgeCoreTokenParsed: HTMLElement | null = null;
  private badgeRhExpiry: HTMLElement | null = null;
  private badgeCoreExpiry: HTMLElement | null = null;

  // Confirmation Modal Elements
  private modalConfirmFullResync: HTMLElement | null = null;
  private btnConfirmFullResync: HTMLButtonElement | null = null;
  private btnCancelFullResync: HTMLButtonElement | null = null;
  private btnCloseFullResyncModal: HTMLButtonElement | null = null;
  private backdropConfirmFullResync: HTMLElement | null = null;

  private modalConfirmPurge: HTMLElement | null = null;
  private btnConfirmPurge: HTMLButtonElement | null = null;
  private btnCancelPurge: HTMLButtonElement | null = null;
  private btnClosePurgeModal: HTMLButtonElement | null = null;
  private backdropConfirmPurge: HTMLElement | null = null;

  // Summary Metrics Elements
  private hedgeMetricElements: HedgeMetricElements = {
    accountsBadge: null,
    pairsCount: null,
    hedgedVolume: null,
    netPnl: null,
    pnlBps: null,
    slippage: null,
    fees: null,
    unhedgedCount: null,
  };

  // Individual Account Metrics Elements
  private rhMetricElements: IndividualAccountMetricElements = {
    accountBadge: null,
    tradesCount: null,
    volume: null,
    realizedPnl: null,
    fees: null,
    unhedgedCount: null,
  };
  private coreMetricElements: IndividualAccountMetricElements = {
    accountBadge: null,
    tradesCount: null,
    volume: null,
    realizedPnl: null,
    fees: null,
    unhedgedCount: null,
  };

  private weeklyPointsTableCard: HTMLElement | null = null;
  private weeklyPointsTableContainer: HTMLElement | null = null;
  private weeklyPointsSortColumn: WeeklyPointsSortColumn = "weekNumber";
  private weeklyPointsSortDirection: "asc" | "desc" = "asc";
  private rhIndividualMetrics: IndividualAccountMetrics | null = null;
  private coreIndividualMetrics: IndividualAccountMetrics | null = null;

  // Filter & Search Controls
  private inputHedgeSearch: HTMLInputElement | null = null;
  private tabBtnHedgeAll: HTMLButtonElement | null = null;
  private tabBtnHedgeUnhedged: HTMLButtonElement | null = null;
  private hedgeAggregateMode: "aggregated" | "raw" = "aggregated";
  private btnHedgeModeAggregated: HTMLButtonElement | null = null;
  private btnHedgeModeRaw: HTMLButtonElement | null = null;
  private hedgeCountNotice: HTMLElement | null = null;

  private hedgeTableBody: HTMLTableSectionElement | null = null;
  private checkAllHedge: HTMLInputElement | null = null;

  // Row selection & HUD metrics
  private hedgeDisplayLimit = 100;
  private selectedHedgeRowIds = new Set<string>();
  private lastClickedHedgeRowId: string | null = null;
  private lastClickedHedgeRowState = true;
  private selectionSnapshot = new Set<string>();
  private hedgeSelectionCard: HTMLElement | null = null;
  private btnDeselectAllHedge: HTMLButtonElement | null = null;
  private hedgeSelectionMetricElements: HedgeSelectionMetricElements = {
    selectionCard: null,
    countBadge: null,
    pairsCount: null,
    volume: null,
    netPnl: null,
    pnlBps: null,
    weightedDelta: null,
    weightedDeltaBps: null,
    slippage: null,
    fees: null,
    unhedgedCount: null,
  };

  // Date Filter & Promo Elements
  private activeHedgeDateFilter: ActiveDateFilter | null = null;
  private allHedgePairs: HedgePair[] = [];
  private allUnhedgedTrades: UnhedgedTrade[] = [];
  private selectHedgeDatePreset: HTMLSelectElement | null = null;
  private customHedgeDateContainer: HTMLElement | null = null;
  private inputCustomHedgeDateFrom: HTMLInputElement | null = null;
  private inputCustomHedgeDateTo: HTMLInputElement | null = null;
  private btnApplyCustomHedgeDate: HTMLButtonElement | null = null;

  // Token / Market Summary Elements
  private hedgeMarketSummaryCard: HTMLElement | null = null;
  private hedgeMarketCardsContainer: HTMLElement | null = null;
  private activeMarketFilter: string | null = null;
  private marketSortColumn: MarketSummarySortColumn = "volumeUsd";
  private marketSortDirection: "asc" | "desc" = "desc";

  // Card Loading Overlays
  private cardOverlays: HTMLElement[] = [];

  public async init(): Promise<void> {
    this.cacheDomElements();
    this.initDateFilterSection();
    this.bindEvents();

    await this.loadStoredCredentialsAndAccounts();
    await this.loadCachedDataFromDb();

    // Stale-While-Revalidate: If tokens exist, trigger delta sync and show loading progress bar
    if (this.rhAccountMeta?.authToken || this.coreAccountMeta?.authToken) {
      setTimeout(() => {
        this.runSync(false, false).catch(() => {});
      }, 50);
    } else {
      // If tokens are missing, automatically open the credentials drawer
      this.openCredentialsDrawer();
    }
  }

  private initDateFilterSection(): void {
    if (this.selectHedgeDatePreset) {
      populatePresetSelect(
        this.selectHedgeDatePreset,
        this.activeHedgeDateFilter?.presetId || "all",
      );
    }
  }

  private cacheDomElements(): void {
    // Card loading overlays across all data sections
    this.cardOverlays = Array.from(document.querySelectorAll<HTMLElement>(".sync-card-overlay"));

    // Sync Control Bar
    this.labelLastSyncedAt = document.getElementById("labelLastSyncedAt");
    this.btnSyncNewData = document.getElementById("btnSyncNewData") as HTMLButtonElement | null;
    this.labelSyncButtonText = document.getElementById("labelSyncButtonText");
    this.btnFullResync = document.getElementById("btnFullResync") as HTMLButtonElement | null;
    this.btnToggleCredentials = document.getElementById(
      "btnToggleCredentials",
    ) as HTMLButtonElement | null;
    this.syncIconSpin = document.getElementById("syncIconSpin");
    this.stopIconCross = document.getElementById("stopIconCross");
    this.syncProgressWrapper = document.getElementById("syncProgressWrapper");
    this.syncProgressBar = document.getElementById("syncProgressBar");
    this.syncStatusMessage = document.getElementById("syncStatusMessage");
    this.syncDurationLabel = document.getElementById("syncDurationLabel");
    this.btnHedgeExportCsv = document.getElementById(
      "btnHedgeExportCsv",
    ) as HTMLButtonElement | null;

    // Credentials Drawer
    this.credentialsDrawer = document.getElementById("credentialsDrawer");
    this.btnCloseCredentials = document.getElementById(
      "btnCloseCredentials",
    ) as HTMLButtonElement | null;
    this.btnDismissCredentials = document.getElementById(
      "btnDismissCredentials",
    ) as HTMLButtonElement | null;
    this.btnSaveCredentialsAndSync = document.getElementById(
      "btnSaveCredentialsAndSync",
    ) as HTMLButtonElement | null;
    this.btnClearStoredCredentials = document.getElementById(
      "btnClearStoredCredentials",
    ) as HTMLButtonElement | null;
    this.inputRhToken = document.getElementById("inputRhToken") as HTMLInputElement | null;
    this.inputCoreToken = document.getElementById("inputCoreToken") as HTMLInputElement | null;
    this.btnToggleRhVisibility = document.getElementById(
      "btnToggleRhVisibility",
    ) as HTMLButtonElement | null;
    this.btnToggleCoreVisibility = document.getElementById(
      "btnToggleCoreVisibility",
    ) as HTMLButtonElement | null;
    this.badgeRhTokenParsed = document.getElementById("badgeRhTokenParsed");
    this.badgeCoreTokenParsed = document.getElementById("badgeCoreTokenParsed");
    this.badgeRhExpiry = document.getElementById("badgeRhExpiry");
    this.badgeCoreExpiry = document.getElementById("badgeCoreExpiry");

    // Confirmation Modals
    this.modalConfirmFullResync = document.getElementById("modalConfirmFullResync");
    this.btnConfirmFullResync = document.getElementById(
      "btnConfirmFullResync",
    ) as HTMLButtonElement | null;
    this.btnCancelFullResync = document.getElementById(
      "btnCancelFullResync",
    ) as HTMLButtonElement | null;
    this.btnCloseFullResyncModal = document.getElementById(
      "btnCloseFullResyncModal",
    ) as HTMLButtonElement | null;
    this.backdropConfirmFullResync = document.getElementById("backdropConfirmFullResync");

    this.modalConfirmPurge = document.getElementById("modalConfirmPurge");
    this.btnConfirmPurge = document.getElementById("btnConfirmPurge") as HTMLButtonElement | null;
    this.btnCancelPurge = document.getElementById("btnCancelPurge") as HTMLButtonElement | null;
    this.btnClosePurgeModal = document.getElementById(
      "btnClosePurgeModal",
    ) as HTMLButtonElement | null;
    this.backdropConfirmPurge = document.getElementById("backdropConfirmPurge");

    // Metrics
    this.hedgeMetricElements = {
      accountsBadge: document.getElementById("leadHedgeAccountsBadge"),
      pairsCount: document.getElementById("leadHedgePairsCount"),
      hedgedVolume: document.getElementById("leadHedgeVolume"),
      netPnl: document.getElementById("leadHedgeNetPnl"),
      pnlBps: null,
      slippage: document.getElementById("leadHedgeSlippage"),
      fees: document.getElementById("leadHedgeFees"),
      funding: document.getElementById("leadHedgeFunding"),
      withdrawals: document.getElementById("leadHedgeWithdrawals"),
      unhedgedCount: document.getElementById("leadHedgeUnhedgedCount"),
      avgOi: document.getElementById("leadHedgeAvgOi"),
    };

    this.rhMetricElements = {
      accountBadge: document.getElementById("leadRhAccountBadge"),
      tradesCount: document.getElementById("leadRhTradesCount"),
      volume: document.getElementById("leadRhVolume"),
      realizedPnl: document.getElementById("leadRhRealizedPnl"),
      fees: document.getElementById("leadRhFees"),
      funding: document.getElementById("leadRhFunding"),
      withdrawals: document.getElementById("leadRhWithdrawals"),
      unhedgedCount: document.getElementById("leadRhUnhedgedCount"),
      avgOi: document.getElementById("leadRhAvgOi"),
      dailySummary: document.getElementById("leadRhDailySummary"),
    };

    this.coreMetricElements = {
      accountBadge: document.getElementById("leadCoreAccountBadge"),
      tradesCount: document.getElementById("leadCoreTradesCount"),
      volume: document.getElementById("leadCoreVolume"),
      realizedPnl: document.getElementById("leadCoreRealizedPnl"),
      fees: document.getElementById("leadCoreFees"),
      funding: document.getElementById("leadCoreFunding"),
      withdrawals: document.getElementById("leadCoreWithdrawals"),
      unhedgedCount: document.getElementById("leadCoreUnhedgedCount"),
      avgOi: document.getElementById("leadCoreAvgOi"),
      dailySummary: document.getElementById("leadCoreDailySummary"),
    };

    // Filters & Search
    this.inputHedgeSearch = document.getElementById(
      "inputHedgeSearchFilter",
    ) as HTMLInputElement | null;
    this.tabBtnHedgeAll = document.getElementById("tabBtnHedgeAll") as HTMLButtonElement | null;
    this.tabBtnHedgeUnhedged = document.getElementById(
      "tabBtnHedgeUnhedged",
    ) as HTMLButtonElement | null;
    this.btnHedgeModeAggregated = document.getElementById(
      "btnHedgeModeAggregated",
    ) as HTMLButtonElement | null;
    this.btnHedgeModeRaw = document.getElementById("btnHedgeModeRaw") as HTMLButtonElement | null;
    this.hedgeCountNotice = document.getElementById("hedgeCountNotice");

    this.hedgeTableBody = document.getElementById(
      "hedgeTableBody",
    ) as HTMLTableSectionElement | null;
    this.checkAllHedge = document.getElementById("checkAllHedge") as HTMLInputElement | null;

    // Selection Card
    this.hedgeSelectionCard = document.getElementById("hedgeSelectionCard");
    this.btnDeselectAllHedge = document.getElementById(
      "btnDeselectAllHedge",
    ) as HTMLButtonElement | null;
    this.hedgeSelectionMetricElements = {
      selectionCard: this.hedgeSelectionCard,
      countBadge: document.getElementById("selectedCountBadge"),
      pairsCount: document.getElementById("selectedPairsCount"),
      volume: document.getElementById("selectedVolume"),
      netPnl: document.getElementById("selectedNetPnl"),
      pnlBps: document.getElementById("selectedPnlBps"),
      weightedDelta: document.getElementById("selectedWeightedDelta"),
      weightedDeltaBps: document.getElementById("selectedWeightedDeltaBps"),
      slippage: document.getElementById("selectedSlippage"),
      funding: document.getElementById("selectedFunding"),
      fees: document.getElementById("selectedFees"),
      unhedgedCount: document.getElementById("selectedUnhedgedCount"),
    };

    // Date Filter & Promo Elements
    this.selectHedgeDatePreset = document.getElementById(
      "selectHedgeDatePreset",
    ) as HTMLSelectElement | null;
    this.customHedgeDateContainer = document.getElementById("customHedgeDateContainer");
    this.inputCustomHedgeDateFrom = document.getElementById(
      "inputCustomHedgeDateFrom",
    ) as HTMLInputElement | null;
    this.inputCustomHedgeDateTo = document.getElementById(
      "inputCustomHedgeDateTo",
    ) as HTMLInputElement | null;
    this.btnApplyCustomHedgeDate = document.getElementById(
      "btnApplyCustomHedgeDate",
    ) as HTMLButtonElement | null;

    // Token / Market Summary Elements
    this.hedgeMarketSummaryCard = document.getElementById("hedgeMarketSummaryCard");
    this.hedgeMarketCardsContainer = document.getElementById("hedgeMarketCardsContainer");

    // Weekly Points Table Elements
    this.weeklyPointsTableCard = document.getElementById("hedgeWeeklyPointsTableCard");
    this.weeklyPointsTableContainer = document.getElementById("hedgeWeeklyPointsTableContainer");
  }

  private bindEvents(): void {
    // Sync buttons
    this.btnSyncNewData?.addEventListener("click", () => {
      if (this.isSyncing) {
        this.stopSync();
      } else {
        void this.runSync(false);
      }
    });
    this.btnFullResync?.addEventListener("click", () => this.openFullResyncModal());
    this.btnCancelFullResync?.addEventListener("click", () => this.closeFullResyncModal());
    this.btnCloseFullResyncModal?.addEventListener("click", () => this.closeFullResyncModal());
    this.backdropConfirmFullResync?.addEventListener("click", () => this.closeFullResyncModal());
    this.btnConfirmFullResync?.addEventListener("click", () => {
      this.closeFullResyncModal();
      void this.runSync(true);
    });

    this.btnToggleCredentials?.addEventListener("click", () => this.toggleCredentialsDrawer());

    // Credentials drawer
    this.btnCloseCredentials?.addEventListener("click", () => this.closeCredentialsDrawer());
    this.btnDismissCredentials?.addEventListener("click", () => this.closeCredentialsDrawer());
    this.btnSaveCredentialsAndSync?.addEventListener("click", () => this.handleSaveTokensAndSync());
    this.btnClearStoredCredentials?.addEventListener("click", () => this.openPurgeModal());
    this.btnCancelPurge?.addEventListener("click", () => this.closePurgeModal());
    this.btnClosePurgeModal?.addEventListener("click", () => this.closePurgeModal());
    this.backdropConfirmPurge?.addEventListener("click", () => this.closePurgeModal());
    this.btnConfirmPurge?.addEventListener("click", () => {
      this.closePurgeModal();
      void this.executePurgeStoredCredentials();
    });

    // Eye visibility toggles
    this.btnToggleRhVisibility?.addEventListener("click", () => {
      if (!this.inputRhToken) return;
      const isPwd = this.inputRhToken.type === "password";
      this.inputRhToken.type = isPwd ? "text" : "password";
      if (this.btnToggleRhVisibility)
        this.btnToggleRhVisibility.textContent = isPwd ? "Hide" : "Show";
    });

    this.btnToggleCoreVisibility?.addEventListener("click", () => {
      if (!this.inputCoreToken) return;
      const isPwd = this.inputCoreToken.type === "password";
      this.inputCoreToken.type = isPwd ? "text" : "password";
      if (this.btnToggleCoreVisibility)
        this.btnToggleCoreVisibility.textContent = isPwd ? "Hide" : "Show";
    });

    // Live token input parsing
    this.inputRhToken?.addEventListener("input", () => this.updateLiveTokenPreview("rh"));
    this.inputCoreToken?.addEventListener("input", () => this.updateLiveTokenPreview("core"));

    // CSV export
    this.btnHedgeExportCsv?.addEventListener("click", () => this.downloadHedgeCsv());

    // Search and filters with 150ms debounce
    this.inputHedgeSearch?.addEventListener("input", (e) => {
      this.hedgeSearchQuery = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.hedgeDisplayLimit = 100;
      if (
        this.activeMarketFilter &&
        this.activeMarketFilter.toLowerCase() !== this.hedgeSearchQuery
      ) {
        this.activeMarketFilter = null;
        this.updateHedgeMarketSummary();
      }
      if (this.hedgeFilterDebounceTimer) {
        clearTimeout(this.hedgeFilterDebounceTimer);
      }
      this.hedgeFilterDebounceTimer = setTimeout(() => {
        this.applyHedgeFilter();
      }, 150);
    });

    // Daily summary ribbon horizontal scroll listener for dynamic edge masks
    this.rhMetricElements.dailySummary?.addEventListener(
      "scroll",
      () => updateScrollMask(this.rhMetricElements.dailySummary),
      { passive: true },
    );
    this.coreMetricElements.dailySummary?.addEventListener(
      "scroll",
      () => updateScrollMask(this.coreMetricElements.dailySummary),
      { passive: true },
    );
    window.addEventListener(
      "resize",
      () => {
        updateScrollMask(this.rhMetricElements.dailySummary);
        updateScrollMask(this.coreMetricElements.dailySummary);
      },
      { passive: true },
    );

    this.tabBtnHedgeAll?.addEventListener("click", () => this.switchHedgeFilterTab("all"));
    this.tabBtnHedgeUnhedged?.addEventListener("click", () =>
      this.switchHedgeFilterTab("unhedged"),
    );

    this.btnHedgeModeAggregated?.addEventListener("click", () =>
      this.switchHedgeAggregateMode("aggregated"),
    );
    this.btnHedgeModeRaw?.addEventListener("click", () => this.switchHedgeAggregateMode("raw"));

    // Selection
    this.checkAllHedge?.addEventListener("click", () => this.toggleSelectAllVisibleHedge());
    this.hedgeTableBody?.addEventListener("mousedown", (e) => {
      // Prevent browser native text selection when Shift+Clicking rows
      if (e.shiftKey) {
        e.preventDefault();
      }
    });
    this.hedgeTableBody?.addEventListener("click", (e) => this.handleHedgeTableClick(e));
    this.btnDeselectAllHedge?.addEventListener("click", () => {
      this.selectedHedgeRowIds.clear();
      this.lastClickedHedgeRowId = null;
      this.lastClickedHedgeRowState = true;
      this.selectionSnapshot.clear();
      if (this.activeMarketFilter) {
        this.activeMarketFilter = null;
        this.updateHedgeMarketSummary();
      }
      this.onHedgeSelectionChanged();
    });

    // Date Preset Select
    this.selectHedgeDatePreset?.addEventListener("change", (e) => {
      const presetId = (e.target as HTMLSelectElement).value;
      if (presetId === "custom") {
        this.customHedgeDateContainer?.classList.remove("hidden");
        return;
      }
      this.customHedgeDateContainer?.classList.add("hidden");
      const preset = findPresetById(presetId);
      if (preset) {
        this.activeHedgeDateFilter = createPresetDateFilter(preset);
      } else {
        this.activeHedgeDateFilter = null;
      }
      this.applyHedgeDateFilter();
    });

    // Custom Date Range Apply
    this.btnApplyCustomHedgeDate?.addEventListener("click", () => {
      const from = this.inputCustomHedgeDateFrom?.value;
      const to = this.inputCustomHedgeDateTo?.value;
      if (!from && !to) {
        this.activeHedgeDateFilter = null;
        if (this.selectHedgeDatePreset) this.selectHedgeDatePreset.value = "all";
      } else {
        this.activeHedgeDateFilter = parseCustomDateRange(from, to);
      }
      this.applyHedgeDateFilter();
    });

    // Keyboard hotkeys
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (
          this.modalConfirmFullResync &&
          !this.modalConfirmFullResync.classList.contains("hidden")
        ) {
          this.closeFullResyncModal();
          return;
        }
        if (this.modalConfirmPurge && !this.modalConfirmPurge.classList.contains("hidden")) {
          this.closePurgeModal();
          return;
        }
        if (!this.credentialsDrawer?.classList.contains("hidden")) {
          this.closeCredentialsDrawer();
          return;
        }
        if (this.selectedHedgeRowIds.size > 0) {
          this.selectedHedgeRowIds.clear();
          this.lastClickedHedgeRowId = null;
          this.lastClickedHedgeRowState = true;
          this.selectionSnapshot.clear();
          this.onHedgeSelectionChanged();
        }
      }
    });
  }

  public openCredentialsDrawer(): void {
    this.credentialsDrawer?.classList.remove("hidden");
  }

  public closeCredentialsDrawer(): void {
    this.credentialsDrawer?.classList.add("hidden");
  }

  public toggleCredentialsDrawer(): void {
    this.credentialsDrawer?.classList.toggle("hidden");
  }

  public openFullResyncModal(): void {
    this.modalConfirmFullResync?.classList.remove("hidden");
  }

  public closeFullResyncModal(): void {
    this.modalConfirmFullResync?.classList.add("hidden");
  }

  public openPurgeModal(): void {
    this.modalConfirmPurge?.classList.remove("hidden");
  }

  public closePurgeModal(): void {
    this.modalConfirmPurge?.classList.add("hidden");
  }

  private updateLiveTokenPreview(network: "rh" | "core"): void {
    const input = network === "rh" ? this.inputRhToken : this.inputCoreToken;
    const badgeAccount = network === "rh" ? this.badgeRhTokenParsed : this.badgeCoreTokenParsed;
    const badgeExpiry = network === "rh" ? this.badgeRhExpiry : this.badgeCoreExpiry;
    if (!input || !badgeAccount || !badgeExpiry) return;

    const val = input.value.trim();
    if (!val) {
      badgeAccount.textContent = "Account: --";
      badgeAccount.className = "text-[10px] text-terminal-muted";
      badgeExpiry.textContent = "Expiry: --";
      return;
    }

    try {
      const parsed = parseLighterToken(val, network === "rh" ? "rh" : "mainnet");
      badgeAccount.textContent = `Account #${parsed.accountIndex}`;
      badgeAccount.className = `text-[10px] font-bold ${network === "rh" ? "text-terminal-emerald" : "text-terminal-accent"}`;

      if (parsed.expiryMs) {
        const d = new Date(parsed.expiryMs);
        badgeExpiry.textContent = `Expires: ${d.toISOString().slice(0, 10)}`;
      } else {
        badgeExpiry.textContent = "Expires: standard session";
      }
    } catch {
      badgeAccount.textContent = "Invalid token format";
      badgeAccount.className = "text-[10px] text-terminal-coral font-semibold";
      badgeExpiry.textContent = "Expiry: --";
    }
  }

  /**
   * Restores stored tokens and active account keys from localStorage and IDB.
   */
  private async loadStoredCredentialsAndAccounts(): Promise<void> {
    const rhToken = localStorage.getItem(STORAGE_KEY_RH_TOKEN) || "";
    const coreToken = localStorage.getItem(STORAGE_KEY_CORE_TOKEN) || "";

    if (this.inputRhToken && rhToken) {
      this.inputRhToken.value = rhToken;
      this.updateLiveTokenPreview("rh");
    }
    if (this.inputCoreToken && coreToken) {
      this.inputCoreToken.value = coreToken;
      this.updateLiveTokenPreview("core");
    }

    let activeRhKey = localStorage.getItem(STORAGE_KEY_ACTIVE_RH_KEY) || "";
    let activeCoreKey = localStorage.getItem(STORAGE_KEY_ACTIVE_CORE_KEY) || "";

    if (!activeRhKey && rhToken) {
      try {
        const parsed = parseLighterToken(rhToken, "rh");
        activeRhKey = `rh:${parsed.accountIndex}`;
        localStorage.setItem(STORAGE_KEY_ACTIVE_RH_KEY, activeRhKey);
      } catch {}
    }

    if (!activeCoreKey && coreToken) {
      try {
        const parsed = parseLighterToken(coreToken, "mainnet");
        activeCoreKey = `mainnet:${parsed.accountIndex}`;
        localStorage.setItem(STORAGE_KEY_ACTIVE_CORE_KEY, activeCoreKey);
      } catch {}
    }

    this.activeRhAccountKey = activeRhKey;
    this.activeCoreAccountKey = activeCoreKey;

    if (activeRhKey) {
      let meta = await getAccountMeta(activeRhKey);
      if (!meta && rhToken) {
        const parsed = parseLighterToken(rhToken, "rh");
        meta = {
          accountKey: activeRhKey,
          network: "rh",
          accountIndex: parsed.accountIndex,
          authToken: rhToken,
          syncState: { hasFullHistory: false },
        };
        await saveAccountMeta(meta);
      }
      this.rhAccountMeta = meta;
    }

    if (activeCoreKey) {
      let meta = await getAccountMeta(activeCoreKey);
      if (!meta && coreToken) {
        const parsed = parseLighterToken(coreToken, "mainnet");
        meta = {
          accountKey: activeCoreKey,
          network: "mainnet",
          accountIndex: parsed.accountIndex,
          authToken: coreToken,
          syncState: { hasFullHistory: false },
        };
        await saveAccountMeta(meta);
      }
      this.coreAccountMeta = meta;
    }

    this.updateSlotStatusBadges();
  }

  private updateSlotStatusBadges(): void {
    if (this.labelLastSyncedAt) {
      const ts = Math.max(
        this.rhAccountMeta?.lastSyncedAt || 0,
        this.coreAccountMeta?.lastSyncedAt || 0,
      );
      if (ts > 0) {
        const d = new Date(ts);
        const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        this.labelLastSyncedAt.textContent = `(${timeStr})`;
        if (this.btnSyncNewData) {
          this.btnSyncNewData.title = `Last sync: ${timeStr} · Fetch only new trades (~200ms)`;
        }
      } else {
        this.labelLastSyncedAt.textContent = "";
        if (this.btnSyncNewData) {
          this.btnSyncNewData.title = "Fetch only new trades and funding (~200ms)";
        }
      }
    }
  }

  /**
   * Fast cold-start reading from IndexedDB (< 50ms on M3 / Ryzen).
   * Range scan directly over primary keys in LevelDB B-tree.
   */
  private async loadCachedDataFromDb(): Promise<void> {
    if (this.activeRhAccountKey) {
      this.rhAccountMeta = await getAccountMeta(this.activeRhAccountKey);
      const [trades, funding, withdrawals] = await Promise.all([
        getAccountTrades(this.activeRhAccountKey),
        getAccountFunding(this.activeRhAccountKey),
        getAccountWithdrawals(this.activeRhAccountKey),
      ]);
      this.rhRawTrades = trades;
      this.rhFunding = funding;
      this.rhWithdrawals = withdrawals;
      this.rhAccountIndex = this.rhAccountMeta?.accountIndex ?? null;
      this.rhAccountIndices = this.rhAccountIndex != null ? [this.rhAccountIndex] : [];
    } else {
      this.rhAccountMeta = null;
      this.rhRawTrades = [];
      this.rhFunding = [];
      this.rhWithdrawals = [];
      this.rhAccountIndex = null;
      this.rhAccountIndices = [];
    }

    if (this.activeCoreAccountKey) {
      this.coreAccountMeta = await getAccountMeta(this.activeCoreAccountKey);
      const [trades, funding, withdrawals] = await Promise.all([
        getAccountTrades(this.activeCoreAccountKey),
        getAccountFunding(this.activeCoreAccountKey),
        getAccountWithdrawals(this.activeCoreAccountKey),
      ]);
      this.coreRawTrades = trades;
      this.coreFunding = funding;
      this.coreWithdrawals = withdrawals;
      this.coreAccountIndex = this.coreAccountMeta?.accountIndex ?? null;
      this.coreAccountIndices = this.coreAccountIndex != null ? [this.coreAccountIndex] : [];
    } else {
      this.coreAccountMeta = null;
      this.coreRawTrades = [];
      this.coreFunding = [];
      this.coreWithdrawals = [];
      this.coreAccountIndex = null;
      this.coreAccountIndices = [];
    }

    this.updateSlotStatusBadges();
    this.recalculateAndRenderHedge();
  }

  public async handleSaveTokensAndSync(): Promise<void> {
    const rhVal = this.inputRhToken?.value?.trim() || "";
    const coreVal = this.inputCoreToken?.value?.trim() || "";

    if (!rhVal && !coreVal) {
      alert("Please provide at least one Read-Only token.");
      return;
    }

    try {
      if (rhVal) {
        const rhInfo = parseLighterToken(rhVal, "rh");
        const key = `rh:${rhInfo.accountIndex}`;
        localStorage.setItem(STORAGE_KEY_RH_TOKEN, rhVal);
        localStorage.setItem(STORAGE_KEY_ACTIVE_RH_KEY, key);
        this.activeRhAccountKey = key;

        let meta = await getAccountMeta(key);
        if (!meta) {
          meta = {
            accountKey: key,
            network: "rh",
            accountIndex: rhInfo.accountIndex,
            authToken: rhVal,
            syncState: { hasFullHistory: false },
          };
        } else {
          meta.authToken = rhVal;
        }
        await saveAccountMeta(meta);
        this.rhAccountMeta = meta;
      }

      if (coreVal) {
        const coreInfo = parseLighterToken(coreVal, "mainnet");
        const key = `mainnet:${coreInfo.accountIndex}`;
        localStorage.setItem(STORAGE_KEY_CORE_TOKEN, coreVal);
        localStorage.setItem(STORAGE_KEY_ACTIVE_CORE_KEY, key);
        this.activeCoreAccountKey = key;

        let meta = await getAccountMeta(key);
        if (!meta) {
          meta = {
            accountKey: key,
            network: "mainnet",
            accountIndex: coreInfo.accountIndex,
            authToken: coreVal,
            syncState: { hasFullHistory: false },
          };
        } else {
          meta.authToken = coreVal;
        }
        await saveAccountMeta(meta);
        this.coreAccountMeta = meta;
      }

      this.updateSlotStatusBadges();
      this.closeCredentialsDrawer();
      await this.loadCachedDataFromDb();
      await this.runSync(false);
    } catch (err: any) {
      alert(`Invalid token: ${err.message || String(err)}`);
    }
  }

  public async executePurgeStoredCredentials(): Promise<void> {
    localStorage.removeItem(STORAGE_KEY_RH_TOKEN);
    localStorage.removeItem(STORAGE_KEY_CORE_TOKEN);
    localStorage.removeItem(STORAGE_KEY_ACTIVE_RH_KEY);
    localStorage.removeItem(STORAGE_KEY_ACTIVE_CORE_KEY);

    await clearAllData();

    this.rhRawTrades = [];
    this.coreRawTrades = [];
    this.rhFunding = [];
    this.coreFunding = [];
    this.rhWithdrawals = [];
    this.coreWithdrawals = [];
    this.rhAccountMeta = null;
    this.coreAccountMeta = null;
    this.activeRhAccountKey = "";
    this.activeCoreAccountKey = "";

    if (this.inputRhToken) this.inputRhToken.value = "";
    if (this.inputCoreToken) this.inputCoreToken.value = "";
    this.updateLiveTokenPreview("rh");
    this.updateLiveTokenPreview("core");
    this.updateSlotStatusBadges();

    this.allHedgePairs = [];
    this.allUnhedgedTrades = [];
    this.hedgePairs = [];
    this.unhedgedTrades = [];
    this.hedgePairsMap.clear();
    this.unhedgedTradesMap.clear();
    this.filteredHedgePairs = [];
    this.filteredUnhedgedTrades = [];
    this.hedgeMetrics = null;

    this.updateHedgeExecutiveSummary();
    this.updateHedgeMarketSummary();
    this.applyHedgeFilter();
    this.renderWeeklyPointsAnalysis();

    if (this.syncStatusMessage) {
      this.syncStatusMessage.textContent = "Database cleared. Please enter new Read-Only tokens.";
    }
  }

  public async handleClearStoredCredentials(): Promise<void> {
    this.openPurgeModal();
  }

  public stopSync(): void {
    if (this.syncAbortController) {
      this.syncAbortController.abort();
      this.syncAbortController = null;
    }
    this.isSyncing = false;
    this.updateSyncUiState(false, "Sync cancelled by user.");
  }

  /**
   * Main synchronization execution: runs concurrent dual-network sync over HTTP/2.
   * Performs in-memory delta merge on Delta Sync to eliminate IDB re-reading latency.
   */
  public async runSync(forceFull = false, silent = false): Promise<void> {
    if (this.isSyncing) return;

    if (!this.rhAccountMeta?.authToken && !this.coreAccountMeta?.authToken) {
      if (!silent) this.openCredentialsDrawer();
      return;
    }

    this.isSyncing = true;
    this.syncAbortController = new AbortController();
    const signal = this.syncAbortController.signal;

    if (!silent) {
      this.updateSyncUiState(
        true,
        forceFull ? "Starting Resync..." : "Syncing new data (~200ms)...",
      );
    }

    const startTime = Date.now();
    let rhMessage = "";
    let coreMessage = "";
    let rhProgress = 5;
    let coreProgress = 5;

    const onProgress = (info: SyncProgressInfo) => {
      const p = info.progressPercent ?? 0;
      if (info.network === "rh") {
        rhMessage = `RH: ${info.message}`;
        rhProgress = p;
      } else {
        coreMessage = `Core: ${info.message}`;
        coreProgress = p;
      }
      if (this.syncStatusMessage && !silent) {
        this.syncStatusMessage.textContent = [rhMessage, coreMessage].filter(Boolean).join(" | ");
      }
      if (this.syncProgressBar && !silent) {
        const hasRh = Boolean(this.rhAccountMeta?.authToken);
        const hasCore = Boolean(this.coreAccountMeta?.authToken);
        let combined = 5;
        if (hasRh && hasCore) {
          combined = Math.round((rhProgress + coreProgress) / 2);
        } else if (hasRh) {
          combined = rhProgress;
        } else if (hasCore) {
          combined = coreProgress;
        }
        const clamped = Math.min(98, Math.max(5, combined));
        this.syncProgressBar.style.width = `${clamped}%`;
      }
    };

    try {
      const { rhResult, coreResult, errors } = await syncDualAccounts(
        this.rhAccountMeta,
        this.coreAccountMeta,
        {
          forceFullSync: forceFull,
          signal,
          onProgress,
        },
      );

      if (errors.length > 0) {
        const expired = errors.find((e) => e instanceof AuthExpiredError);
        if (expired) {
          alert((expired as AuthExpiredError).message);
          this.openCredentialsDrawer();
        } else {
          console.warn("[LighterSync] Non-fatal sync warnings:", errors);
        }
      }

      if (this.syncProgressBar && !silent) {
        this.syncProgressBar.style.width = "97%";
      }
      if (this.syncStatusMessage && !silent) {
        this.syncStatusMessage.textContent = "Calculating hedge matches...";
      }

      // Fast In-Memory Delta Merge in O(K) without re-reading IDB!
      if (!forceFull) {
        if (rhResult && rhResult.newTrades.length > 0) {
          const seen = new Set(rhResult.newTrades.map((t) => t.trade_id));
          this.rhRawTrades = [
            ...rhResult.newTrades,
            ...this.rhRawTrades.filter((t) => !seen.has(t.trade_id)),
          ];
        }
        if (rhResult && rhResult.newFunding.length > 0) {
          const seen = new Set(rhResult.newFunding.map((f) => `${f.timestamp}_${f.market_id}`));
          this.rhFunding = [
            ...rhResult.newFunding,
            ...this.rhFunding.filter((f) => !seen.has(`${f.timestamp}_${f.market_id}`)),
          ];
        }
        if (rhResult && rhResult.newWithdrawals.length > 0) {
          const seen = new Set(rhResult.newWithdrawals.map((w) => w.id));
          this.rhWithdrawals = [
            ...rhResult.newWithdrawals,
            ...this.rhWithdrawals.filter((w) => !seen.has(w.id)),
          ];
        }

        if (coreResult && coreResult.newTrades.length > 0) {
          const seen = new Set(coreResult.newTrades.map((t) => t.trade_id));
          this.coreRawTrades = [
            ...coreResult.newTrades,
            ...this.coreRawTrades.filter((t) => !seen.has(t.trade_id)),
          ];
        }
        if (coreResult && coreResult.newFunding.length > 0) {
          const seen = new Set(coreResult.newFunding.map((f) => `${f.timestamp}_${f.market_id}`));
          this.coreFunding = [
            ...coreResult.newFunding,
            ...this.coreFunding.filter((f) => !seen.has(`${f.timestamp}_${f.market_id}`)),
          ];
        }
        if (coreResult && coreResult.newWithdrawals.length > 0) {
          const seen = new Set(coreResult.newWithdrawals.map((w) => w.id));
          this.coreWithdrawals = [
            ...coreResult.newWithdrawals,
            ...this.coreWithdrawals.filter((w) => !seen.has(w.id)),
          ];
        }
      } else {
        // Full Resync: re-read everything fresh from IDB
        await this.loadCachedDataFromDb();
      }

      // Re-read updated metadata
      if (this.activeRhAccountKey) {
        this.rhAccountMeta = await getAccountMeta(this.activeRhAccountKey);
      }
      if (this.activeCoreAccountKey) {
        this.coreAccountMeta = await getAccountMeta(this.activeCoreAccountKey);
      }

      this.rhAccountIndex = this.rhAccountMeta?.accountIndex ?? null;
      this.rhAccountIndices = this.rhAccountIndex != null ? [this.rhAccountIndex] : [];
      this.coreAccountIndex = this.coreAccountMeta?.accountIndex ?? null;
      this.coreAccountIndices = this.coreAccountIndex != null ? [this.coreAccountIndex] : [];

      this.updateSlotStatusBadges();

      // Recalculate hedge analytics directly in memory (~15-30ms)
      this.recalculateAndRenderHedge();

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const totalNewTrades =
        (rhResult?.newTrades.length || 0) + (coreResult?.newTrades.length || 0);

      this.updateSyncUiState(
        false,
        totalNewTrades > 0
          ? `Synced +${totalNewTrades} new trades in ${elapsedSec}s.`
          : `All data is up to date (${elapsedSec}s).`,
      );
    } catch (err: any) {
      if (err.name === "AbortError" || signal.aborted) {
        this.updateSyncUiState(false, "Sync cancelled.");
      } else if (err instanceof AuthExpiredError) {
        alert(err.message);
        this.openCredentialsDrawer();
        this.updateSyncUiState(false, err.message);
      } else {
        console.error("[LighterSync] Sync failed:", err);
        this.updateSyncUiState(false, `Sync error: ${err.message || String(err)}`);
      }
    } finally {
      this.isSyncing = false;
      this.syncAbortController = null;
    }
  }

  private setCardOverlaysVisible(visible: boolean): void {
    for (const el of this.cardOverlays) {
      if (visible) {
        el.classList.remove("hidden");
      } else {
        el.classList.add("hidden");
      }
    }
  }

  private updateSyncUiState(syncing: boolean, message: string): void {
    if (this.syncStatusMessage) this.syncStatusMessage.textContent = message;

    if (this.syncIconSpin) {
      if (syncing) this.syncIconSpin.classList.add("animate-spin");
      else this.syncIconSpin.classList.remove("animate-spin");
    }

    this.setCardOverlaysVisible(syncing);

    if (syncing) {
      if (this.btnSyncNewData) {
        this.btnSyncNewData.classList.remove(
          "bg-terminal-emerald/20",
          "border-terminal-emerald/50",
          "hover:bg-terminal-emerald/30",
          "text-terminal-emerald",
        );
        this.btnSyncNewData.classList.add(
          "bg-terminal-coral/20",
          "border-terminal-coral/50",
          "hover:bg-terminal-coral/30",
          "text-terminal-coral",
        );
        this.btnSyncNewData.title = "Stop synchronization";
      }
      this.syncIconSpin?.classList.add("hidden");
      this.stopIconCross?.classList.remove("hidden");
      if (this.labelSyncButtonText) this.labelSyncButtonText.textContent = "Stop";
      this.labelLastSyncedAt?.classList.add("hidden");

      this.btnFullResync?.classList.add("opacity-50", "pointer-events-none");
      this.btnHedgeExportCsv?.classList.add("opacity-50", "pointer-events-none");
      if (this.btnHedgeExportCsv) this.btnHedgeExportCsv.disabled = true;
      this.syncProgressWrapper?.classList.remove("hidden");
      if (this.syncProgressBar) this.syncProgressBar.style.width = "5%";
    } else {
      if (this.btnSyncNewData) {
        this.btnSyncNewData.classList.remove(
          "bg-terminal-coral/20",
          "border-terminal-coral/50",
          "hover:bg-terminal-coral/30",
          "text-terminal-coral",
        );
        this.btnSyncNewData.classList.add(
          "bg-terminal-emerald/20",
          "border-terminal-emerald/50",
          "hover:bg-terminal-emerald/30",
          "text-terminal-emerald",
        );
      }
      this.syncIconSpin?.classList.remove("hidden");
      this.stopIconCross?.classList.add("hidden");
      if (this.labelSyncButtonText) this.labelSyncButtonText.textContent = "Sync";
      this.labelLastSyncedAt?.classList.remove("hidden");
      this.updateSlotStatusBadges();

      this.btnFullResync?.classList.remove("opacity-50", "pointer-events-none");
      this.btnHedgeExportCsv?.classList.remove("opacity-50", "pointer-events-none");
      if (this.btnHedgeExportCsv) this.btnHedgeExportCsv.disabled = false;
      if (this.syncProgressBar) this.syncProgressBar.style.width = "100%";
      setTimeout(() => {
        if (!this.isSyncing) {
          this.syncProgressWrapper?.classList.add("hidden");
          if (this.syncProgressBar) this.syncProgressBar.style.width = "0%";
        }
      }, 600);
    }
  }

  private recalculateAndRenderHedge(): void {
    sortTradesChronologicalDesc(this.rhRawTrades);
    sortTradesChronologicalDesc(this.coreRawTrades);

    const rhAccQuery =
      this.rhAccountIndices.length > 0 ? this.rhAccountIndices : (this.rhAccountIndex ?? 0);
    const coreAccQuery =
      this.coreAccountIndices.length > 0 ? this.coreAccountIndices : (this.coreAccountIndex ?? 0);

    this.rhParsedTrades = this.rhRawTrades.map((t) =>
      parseTradeForView(t, rhAccQuery, this.rhMarketMap),
    );
    this.coreParsedTrades = this.coreRawTrades.map((t) =>
      parseTradeForView(t, coreAccQuery, this.coreMarketMap),
    );

    processTradesFundingHistory(this.rhParsedTrades, this.rhFunding);
    processTradesFundingHistory(this.coreParsedTrades, this.coreFunding);

    sortParsedTradesChronologicalDesc(this.rhParsedTrades);
    sortParsedTradesChronologicalDesc(this.coreParsedTrades);

    const result = matchHedgeTrades(
      this.rhParsedTrades,
      this.coreParsedTrades,
      rhAccQuery,
      coreAccQuery,
      600,
      this.hedgeAggregateMode === "aggregated",
      this.rhAccountIndices,
      this.coreAccountIndices,
    );

    this.allHedgePairs = result.pairs;
    this.allUnhedgedTrades = result.unhedged;

    this.applyHedgeDateFilter();
  }

  private updateHedgeDateFilterUi(): void {
    if (this.selectHedgeDatePreset) {
      this.selectHedgeDatePreset.value = this.activeHedgeDateFilter?.presetId || "all";
    }

    if (this.activeHedgeDateFilter?.isCustom) {
      this.customHedgeDateContainer?.classList.remove("hidden");
    } else if (this.selectHedgeDatePreset?.value !== "custom") {
      this.customHedgeDateContainer?.classList.add("hidden");
    }
  }

  private applyHedgeDateFilter(): void {
    this.hedgeDisplayLimit = 100;
    if (this.activeHedgeDateFilter) {
      this.hedgePairs = this.allHedgePairs.filter((p) =>
        isTradeInDateRange(p.rhTimestampMs, this.activeHedgeDateFilter),
      );
      this.unhedgedTrades = this.allUnhedgedTrades.filter((u) =>
        isTradeInDateRange(u.timestampMs, this.activeHedgeDateFilter),
      );
    } else {
      this.hedgePairs = this.allHedgePairs;
      this.unhedgedTrades = this.allUnhedgedTrades;
    }

    this.hedgePairsMap.clear();
    for (const p of this.hedgePairs) {
      this.hedgePairsMap.set(p.id, p);
    }
    this.unhedgedTradesMap.clear();
    for (const u of this.unhedgedTrades) {
      const id = u.id || `unhedged-${u.network}-${u.tradeId}`;
      this.unhedgedTradesMap.set(id, u);
    }

    if (this.selectedHedgeRowIds.size > 0) {
      for (const id of Array.from(this.selectedHedgeRowIds)) {
        if (!this.hedgePairsMap.has(id) && !this.unhedgedTradesMap.has(id)) {
          this.selectedHedgeRowIds.delete(id);
        }
      }
      this.selectionSnapshot = new Set(this.selectedHedgeRowIds);
    }

    const rhAccQuery =
      this.rhAccountIndices.length > 0 ? this.rhAccountIndices[0] : (this.rhAccountIndex ?? null);
    const coreAccQuery =
      this.coreAccountIndices.length > 0
        ? this.coreAccountIndices[0]
        : (this.coreAccountIndex ?? null);

    const rhTradesCount = this.activeHedgeDateFilter
      ? this.rhRawTrades.filter((t) =>
          isTradeInDateRange(normalizeTimestampMs(t.timestamp), this.activeHedgeDateFilter),
        ).length
      : this.rhRawTrades.length;
    const coreTradesCount = this.activeHedgeDateFilter
      ? this.coreRawTrades.filter((t) =>
          isTradeInDateRange(normalizeTimestampMs(t.timestamp), this.activeHedgeDateFilter),
        ).length
      : this.coreRawTrades.length;

    const rhFilteredWithdrawals = this.activeHedgeDateFilter
      ? this.rhWithdrawals.filter((w) =>
          isTradeInDateRange(w.timestampMs, this.activeHedgeDateFilter),
        )
      : this.rhWithdrawals;

    const coreFilteredWithdrawals = this.activeHedgeDateFilter
      ? this.coreWithdrawals.filter((w) =>
          isTradeInDateRange(w.timestampMs, this.activeHedgeDateFilter),
        )
      : this.coreWithdrawals;

    this.hedgeMetrics = calculateHedgeMetrics(
      this.hedgePairs,
      this.unhedgedTrades,
      rhAccQuery,
      coreAccQuery,
      rhTradesCount,
      coreTradesCount,
      this.rhAccountIndices,
      this.coreAccountIndices,
      {
        rhWithdrawals: rhFilteredWithdrawals,
        coreWithdrawals: coreFilteredWithdrawals,
      },
    );

    this.updateHedgeExecutiveSummary();
    this.updateHedgeMarketSummary();
    this.applyHedgeFilter();
    this.updateHedgeDateFilterUi();
    this.onHedgeSelectionChanged();
    this.renderWeeklyPointsAnalysis();
  }

  private updateHedgeMarketSummary(): void {
    if (!this.hedgeMarketCardsContainer) return;

    const stats = calculateMarketSummaryStats(
      this.hedgePairs,
      this.unhedgedTrades,
      this.rhParsedTrades,
      this.coreParsedTrades,
      this.activeHedgeDateFilter,
      Date.now(),
      this.marketSortColumn,
      this.marketSortDirection,
      this.rhFunding,
      this.coreFunding,
    );

    renderMarketSummaryCards(
      this.hedgeMarketCardsContainer,
      stats,
      this.activeMarketFilter,
      (clickedMarket) => this.handleMarketCardClick(clickedMarket),
      this.marketSortColumn,
      this.marketSortDirection,
      (clickedCol) => this.handleMarketHeaderSort(clickedCol),
    );
  }

  private handleMarketHeaderSort(column: MarketSummarySortColumn): void {
    if (this.marketSortColumn === column) {
      this.marketSortDirection = this.marketSortDirection === "asc" ? "desc" : "asc";
    } else {
      this.marketSortColumn = column;
      this.marketSortDirection = column === "marketSymbol" ? "asc" : "desc";
    }
    this.updateHedgeMarketSummary();
  }

  private handleMarketCardClick(marketSymbol: string): void {
    const sym = marketSymbol.trim();
    if (
      this.activeMarketFilter?.toUpperCase() === sym.toUpperCase() ||
      sym === "" ||
      sym.toUpperCase() === "TOTAL"
    ) {
      this.activeMarketFilter = null;
      this.selectedHedgeRowIds.clear();
      this.lastClickedHedgeRowId = null;
      this.lastClickedHedgeRowState = true;
      this.selectionSnapshot.clear();
      this.onHedgeSelectionChanged();
      this.updateHedgeMarketSummary();
      return;
    }

    this.activeMarketFilter = sym;
    this.selectedHedgeRowIds.clear();
    const targetSym = sym.toUpperCase();
    for (const p of this.hedgePairs) {
      if (p.marketSymbol.toUpperCase() === targetSym) {
        this.selectedHedgeRowIds.add(p.id);
      }
    }
    for (const u of this.unhedgedTrades) {
      if (u.marketSymbol.toUpperCase() === targetSym) {
        const id = u.id || `unhedged-${u.network}-${u.tradeId}`;
        this.selectedHedgeRowIds.add(id);
      }
    }
    this.lastClickedHedgeRowId = null;
    this.lastClickedHedgeRowState = true;
    this.selectionSnapshot = new Set(this.selectedHedgeRowIds);

    this.onHedgeSelectionChanged();
    this.updateHedgeMarketSummary();
  }

  private updateHedgeExecutiveSummary(): void {
    const rhMetrics = this.computeIndividualAccountMetrics("RH");
    const coreMetrics = this.computeIndividualAccountMetrics("CORE");
    this.rhIndividualMetrics = rhMetrics;
    this.coreIndividualMetrics = coreMetrics;

    if (this.hedgeMetrics) {
      this.hedgeMetrics.rhAvgOiUsd = rhMetrics.avgOiUsd;
      this.hedgeMetrics.coreAvgOiUsd = coreMetrics.avgOiUsd;
      this.hedgeMetrics.totalAvgOiUsd = rhMetrics.avgOiUsd ?? 0;
    }

    updateHedgeExecutiveMetrics(this.hedgeMetrics, this.hedgeMetricElements);
    updateIndividualAccountMetrics(rhMetrics, this.rhMetricElements);
    updateIndividualAccountMetrics(coreMetrics, this.coreMetricElements);
  }

  private handleWeeklyPointsChange(weekNum: number, rawValue: string): void {
    const trimmed = rawValue.replace(/,/g, "").trim();
    if (trimmed) {
      try {
        localStorage.setItem(`lighter_hedge_points_w${weekNum}`, trimmed);
      } catch {}
    } else {
      try {
        localStorage.removeItem(`lighter_hedge_points_w${weekNum}`);
      } catch {}
    }
    this.renderWeeklyPointsAnalysis();
  }

  private handleWeeklyPointsRowClick(weekNum: number): void {
    const currentWeek = this.activeHedgeDateFilter?.weekNumber;
    if (weekNum <= 0 || currentWeek === weekNum) {
      if (this.selectHedgeDatePreset) this.selectHedgeDatePreset.value = "all";
      this.activeHedgeDateFilter = null;
    } else {
      if (this.selectHedgeDatePreset) this.selectHedgeDatePreset.value = `week-${weekNum}`;
      const preset = findPresetById(`week-${weekNum}`);
      if (preset) {
        this.activeHedgeDateFilter = createPresetDateFilter(preset);
      }
    }
    this.applyHedgeDateFilter();
  }

  private handleWeeklyPointsHeaderSort(column: WeeklyPointsSortColumn): void {
    if (this.weeklyPointsSortColumn === column) {
      this.weeklyPointsSortDirection = this.weeklyPointsSortDirection === "asc" ? "desc" : "asc";
    } else {
      this.weeklyPointsSortColumn = column;
      this.weeklyPointsSortDirection =
        column === "weekNumber" || column === "dateRange" ? "asc" : "desc";
    }
    this.renderWeeklyPointsAnalysis();
  }

  private renderWeeklyPointsAnalysis(): void {
    if (!this.weeklyPointsTableContainer) return;

    const hasTrades =
      this.allHedgePairs.length > 0 ||
      this.allUnhedgedTrades.length > 0 ||
      this.rhParsedTrades.length > 0;

    if (!hasTrades) {
      renderWeeklyPointsTable(
        this.weeklyPointsTableContainer,
        [],
        null,
        () => {},
        () => {},
      );
      return;
    }

    const pointsByWeek: Record<number, number | null> = {};
    for (let w = 1; w <= 20; w++) {
      try {
        const raw = localStorage.getItem(`lighter_hedge_points_w${w}`);
        if (raw) {
          const parsed = parseFloat(raw.replace(/,/g, "").trim());
          if (!isNaN(parsed) && parsed > 0) {
            pointsByWeek[w] = parsed;
          }
        }
      } catch {}
    }

    const rhAccQuery =
      this.rhAccountIndices.length > 0 ? this.rhAccountIndices[0] : (this.rhAccountIndex ?? null);
    const coreAccQuery =
      this.coreAccountIndices.length > 0
        ? this.coreAccountIndices[0]
        : (this.coreAccountIndex ?? null);

    const participating = getParticipatingWeeksStats({
      allHedgePairs: this.allHedgePairs,
      allUnhedgedTrades: this.allUnhedgedTrades,
      rhParsedTrades: this.rhParsedTrades,
      coreParsedTrades: this.coreParsedTrades,
      rhAccountIndex: rhAccQuery,
      coreAccountIndex: coreAccQuery,
      rhAccountIndices: this.rhAccountIndices,
      coreAccountIndices: this.coreAccountIndices,
      rhFundingHistory: this.rhFunding,
      rhWithdrawals: this.rhWithdrawals,
      coreWithdrawals: this.coreWithdrawals,
      nowMs: Date.now(),
      pointsByWeek,
    });

    if (participating.length === 0) {
      renderWeeklyPointsTable(
        this.weeklyPointsTableContainer,
        [],
        null,
        () => {},
        () => {},
      );
      return;
    }

    const activeWeekNumber = this.activeHedgeDateFilter?.weekNumber ?? null;
    const sortedParticipating = sortWeeklyPointsStats(
      participating,
      this.weeklyPointsSortColumn,
      this.weeklyPointsSortDirection,
    );

    renderWeeklyPointsTable(
      this.weeklyPointsTableContainer,
      sortedParticipating,
      activeWeekNumber,
      (wNum, val) => this.handleWeeklyPointsChange(wNum, val),
      (wNum) => this.handleWeeklyPointsRowClick(wNum),
      this.weeklyPointsSortColumn,
      this.weeklyPointsSortDirection,
      (clickedCol) => this.handleWeeklyPointsHeaderSort(clickedCol),
    );
  }

  private computeIndividualAccountMetrics(network: "RH" | "CORE"): IndividualAccountMetrics {
    const isRh = network === "RH";
    const trades = isRh ? this.rhParsedTrades : this.coreParsedTrades;
    const accountIndex = isRh ? this.rhAccountIndex : this.coreAccountIndex;
    const accountIndices = isRh ? this.rhAccountIndices : this.coreAccountIndices;

    const filteredTrades = this.activeHedgeDateFilter
      ? trades.filter((t) => isTradeInDateRange(t.timestampMs, this.activeHedgeDateFilter))
      : trades;

    let totalVolumeUsd = 0;
    let realizedPnlUsd = 0;
    let totalFeesUsd = 0;
    let totalFundingUsd: number | null = null;
    let hasFunding = false;

    for (const t of filteredTrades) {
      totalVolumeUsd += t.usdValue;
      realizedPnlUsd += t.realizedPnl;
      totalFeesUsd += t.feeUsd;
      if (t.fundingUsd !== null && t.fundingUsd !== undefined) {
        totalFundingUsd = (totalFundingUsd ?? 0) + t.fundingUsd;
        hasFunding = true;
      }
    }

    const unhedgedCount = this.unhedgedTrades.filter((u) => u.network === network).length;
    const fundingHistory = isRh ? this.rhFunding : this.coreFunding;
    const oiResult = calculateAccountAverageOi(
      trades,
      this.activeHedgeDateFilter,
      Date.now(),
      fundingHistory,
    );
    const dailyStats = calculateAccountDailyStats(
      trades,
      this.activeHedgeDateFilter,
      Date.now(),
      fundingHistory,
    );

    const rawWithdrawals = isRh ? this.rhWithdrawals : this.coreWithdrawals;
    const filteredWithdrawals = (rawWithdrawals || []).filter((w) =>
      this.activeHedgeDateFilter
        ? isTradeInDateRange(w.timestampMs, this.activeHedgeDateFilter)
        : true,
    );
    let totalWithdrawalsUsd = 0;
    let totalWithdrawalFeesUsd = 0;
    for (const w of filteredWithdrawals) {
      const statusLower = (w.status || "").toLowerCase();
      if (statusLower === "failed" || statusLower === "cancelled" || statusLower === "refunded") {
        continue;
      }
      totalWithdrawalsUsd += w.amountUsd ?? (Number(w.amount) || 0);
      totalWithdrawalFeesUsd += w.feeUsd ?? (Number(w.fee) || 0);
    }

    return {
      accountIndex,
      accountIndices: accountIndices.length > 0 ? accountIndices : undefined,
      network,
      tradesCount: filteredTrades.length,
      totalVolumeUsd,
      realizedPnlUsd,
      totalFeesUsd,
      totalFundingUsd: hasFunding ? totalFundingUsd : null,
      totalWithdrawalsUsd,
      totalWithdrawalFeesUsd,
      withdrawalsCount: filteredWithdrawals.length,
      unhedgedCount,
      avgOiUsd: oiResult.avgOiUsd,
      avgOiDetails: oiResult,
      dailyStats,
    };
  }

  private applyHedgeFilter(): void {
    const q = this.hedgeSearchQuery;

    if (!q) {
      this.filteredHedgePairs = this.hedgePairs;
      this.filteredUnhedgedTrades = this.unhedgedTrades;
    } else {
      this.filteredHedgePairs = this.hedgePairs.filter((p) =>
        p.searchIndex
          ? p.searchIndex.includes(q)
          : p.marketSymbol.toLowerCase().includes(q) ||
            p.rhSide.toLowerCase().includes(q) ||
            p.coreSide.toLowerCase().includes(q) ||
            p.rhTradeId.includes(q) ||
            p.coreTradeId.includes(q),
      );

      this.filteredUnhedgedTrades = this.unhedgedTrades.filter((u) =>
        u.searchIndex
          ? u.searchIndex.includes(q)
          : u.marketSymbol.toLowerCase().includes(q) ||
            u.side.toLowerCase().includes(q) ||
            u.network.toLowerCase().includes(q) ||
            u.tradeId.includes(q),
      );
    }

    if (this.hedgeTableBody) {
      renderHedgeTable(
        this.hedgeTableBody,
        this.filteredHedgePairs,
        this.filteredUnhedgedTrades,
        this.hedgeFilterTab,
        this.hedgeDisplayLimit,
        this.selectedHedgeRowIds,
        () => {
          this.hedgeDisplayLimit += 100;
          this.applyHedgeFilter();
        },
      );
      this.updateHeaderCheckboxState();
    }

    if (this.hedgeCountNotice) {
      const showPairs = this.hedgeFilterTab === "all";
      const count =
        (showPairs ? this.filteredHedgePairs.length : 0) + this.filteredUnhedgedTrades.length;
      const total = (showPairs ? this.hedgePairs.length : 0) + this.unhedgedTrades.length;

      if (q && total > 0) {
        this.hedgeCountNotice.textContent = `Showing ${Math.min(this.hedgeDisplayLimit, count)} of ${total} records`;
        this.hedgeCountNotice.className = "text-[11px] text-terminal-accent font-medium font-mono";
      } else if (this.activeHedgeDateFilter && this.activeHedgeDateFilter.presetId !== "all") {
        const allTotal =
          (showPairs ? this.allHedgePairs.length : 0) + this.allUnhedgedTrades.length;
        this.hedgeCountNotice.textContent = `Showing ${Math.min(this.hedgeDisplayLimit, total)} of ${allTotal} in range`;
        this.hedgeCountNotice.className = "text-[11px] text-terminal-accent font-medium font-mono";
      } else if (total > 0) {
        this.hedgeCountNotice.textContent = `${this.hedgePairs.length} pairs hedged`;
        this.hedgeCountNotice.className = "text-[11px] text-terminal-muted font-mono";
      } else {
        this.hedgeCountNotice.textContent = "";
      }
    }
  }

  private switchHedgeFilterTab(tab: "all" | "unhedged"): void {
    this.hedgeFilterTab = tab;
    this.hedgeDisplayLimit = 100;
    if (tab === "all") {
      this.tabBtnHedgeAll?.classList.add("bg-terminal-surface", "text-white", "font-semibold");
      this.tabBtnHedgeAll?.classList.remove("text-terminal-muted");
      this.tabBtnHedgeUnhedged?.classList.remove(
        "bg-terminal-surface",
        "text-white",
        "font-semibold",
      );
      this.tabBtnHedgeUnhedged?.classList.add("text-terminal-muted");
    } else {
      this.tabBtnHedgeUnhedged?.classList.add("bg-terminal-surface", "text-white", "font-semibold");
      this.tabBtnHedgeUnhedged?.classList.remove("text-terminal-muted");
      this.tabBtnHedgeAll?.classList.remove("bg-terminal-surface", "text-white", "font-semibold");
      this.tabBtnHedgeAll?.classList.add("text-terminal-muted");
    }
    this.applyHedgeFilter();
  }

  private switchHedgeAggregateMode(mode: "aggregated" | "raw"): void {
    if (this.hedgeAggregateMode === mode) return;
    this.hedgeAggregateMode = mode;
    this.hedgeDisplayLimit = 100;

    if (mode === "aggregated") {
      this.btnHedgeModeAggregated?.classList.add(
        "bg-terminal-surface",
        "text-white",
        "font-semibold",
      );
      this.btnHedgeModeAggregated?.classList.remove("text-terminal-muted");
      this.btnHedgeModeRaw?.classList.remove("bg-terminal-surface", "text-white", "font-semibold");
      this.btnHedgeModeRaw?.classList.add("text-terminal-muted");
    } else {
      this.btnHedgeModeRaw?.classList.add("bg-terminal-surface", "text-white", "font-semibold");
      this.btnHedgeModeRaw?.classList.remove("text-terminal-muted");
      this.btnHedgeModeAggregated?.classList.remove(
        "bg-terminal-surface",
        "text-white",
        "font-semibold",
      );
      this.btnHedgeModeAggregated?.classList.add("text-terminal-muted");
    }

    this.selectedHedgeRowIds.clear();
    this.lastClickedHedgeRowId = null;
    this.lastClickedHedgeRowState = true;
    this.selectionSnapshot.clear();
    updateHedgeSelectionMetrics(null, this.hedgeSelectionMetricElements);

    if (this.rhRawTrades.length > 0 && this.coreRawTrades.length > 0) {
      this.recalculateAndRenderHedge();
    }
  }

  public downloadHedgeCsv(): void {
    if (this.isSyncing || (this.hedgePairs.length === 0 && this.unhedgedTrades.length === 0))
      return;

    let pairsToExport = this.hedgePairs;
    let unhedgedToExport = this.unhedgedTrades;

    if (this.selectedHedgeRowIds.size > 0) {
      const selPairs: HedgePair[] = [];
      const selUnhedged: UnhedgedTrade[] = [];
      for (const id of this.selectedHedgeRowIds) {
        const p = this.hedgePairsMap.get(id);
        if (p) selPairs.push(p);
        else {
          const u = this.unhedgedTradesMap.get(id);
          if (u) selUnhedged.push(u);
        }
      }
      pairsToExport = selPairs;
      unhedgedToExport = selUnhedged;
    }

    const csvContent = exportHedgeReportToCsv(pairsToExport, unhedgedToExport);
    const dateStr = new Date().toISOString().slice(0, 10);
    const selSuffix = this.selectedHedgeRowIds.size > 0 ? "-selected" : "";
    const dateRangeSuffix =
      this.activeHedgeDateFilter && this.activeHedgeDateFilter.presetId !== "all"
        ? `-${this.activeHedgeDateFilter.presetId}`
        : "";
    const rhAccStr =
      this.rhAccountIndices.length > 0
        ? this.rhAccountIndices.join("-")
        : (this.rhAccountIndex ?? "0");
    const coreAccStr =
      this.coreAccountIndices.length > 0
        ? this.coreAccountIndices.join("-")
        : (this.coreAccountIndex ?? "0");
    const filename = `lighter-hedge-audit-rh${rhAccStr}-core${coreAccStr}${dateRangeSuffix}${selSuffix}-${dateStr}.csv`;
    downloadTextFile(csvContent, filename, "text/csv;charset=utf-8");
  }

  private getVisibleHedgeRowIds(): string[] {
    if (!this.hedgeTableBody) return [];
    const ids: string[] = [];
    const rows = this.hedgeTableBody.querySelectorAll<HTMLTableRowElement>("tr[data-id]");
    for (const r of rows) {
      if (r.dataset.id) ids.push(r.dataset.id);
    }
    return ids;
  }

  private handleHedgeRangeSelection(targetId: string): void {
    const visibleIds = this.getVisibleHedgeRowIds();
    const result = computeRangeSelection(
      visibleIds,
      this.lastClickedHedgeRowId,
      targetId,
      this.selectionSnapshot,
      this.lastClickedHedgeRowState,
    );

    this.selectedHedgeRowIds = result.newSelectedIds;
    this.lastClickedHedgeRowId = result.newAnchorId;
    this.onHedgeSelectionChanged();
  }

  private handleHedgeTableClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // Check if clicking "Load more" button
    const loadMoreBtn = target.closest<HTMLButtonElement>(
      "#btnLoadMoreHedge, [data-action='load-more']",
    );
    if (loadMoreBtn) {
      e.preventDefault();
      this.hedgeDisplayLimit += 100;
      this.applyHedgeFilter();
      return;
    }

    const row = target.closest("tr[data-id]") as HTMLTableRowElement | null;
    if (!row || !row.dataset.id) return;

    const rowId = row.dataset.id;
    const isCheckbox = target instanceof HTMLInputElement && target.type === "checkbox";

    if (e.shiftKey) {
      e.preventDefault();
      if (typeof window !== "undefined" && window.getSelection) {
        window.getSelection()?.removeAllRanges();
      }
      this.handleHedgeRangeSelection(rowId);
      return;
    }

    if (isCheckbox) {
      const cb = target as HTMLInputElement;
      if (cb.checked) {
        this.selectedHedgeRowIds.add(rowId);
      } else {
        this.selectedHedgeRowIds.delete(rowId);
      }
      this.lastClickedHedgeRowId = rowId;
      this.lastClickedHedgeRowState = cb.checked;
      this.selectionSnapshot = new Set(this.selectedHedgeRowIds);
      this.onHedgeSelectionChanged();
      return;
    }

    if (this.selectedHedgeRowIds.has(rowId)) {
      this.selectedHedgeRowIds.delete(rowId);
      this.lastClickedHedgeRowState = false;
    } else {
      this.selectedHedgeRowIds.add(rowId);
      this.lastClickedHedgeRowState = true;
    }
    this.lastClickedHedgeRowId = rowId;
    this.selectionSnapshot = new Set(this.selectedHedgeRowIds);
    this.onHedgeSelectionChanged();
  }

  private toggleSelectAllVisibleHedge(): void {
    const visibleIds = this.getVisibleHedgeRowIds();
    if (visibleIds.length === 0) return;

    const allSelected = visibleIds.every((id) => this.selectedHedgeRowIds.has(id));
    if (allSelected) {
      for (const id of visibleIds) {
        this.selectedHedgeRowIds.delete(id);
      }
    } else {
      for (const id of visibleIds) {
        this.selectedHedgeRowIds.add(id);
      }
    }
    this.lastClickedHedgeRowId = null;
    this.lastClickedHedgeRowState = true;
    this.selectionSnapshot = new Set(this.selectedHedgeRowIds);
    this.onHedgeSelectionChanged();
  }

  private onHedgeSelectionChanged(): void {
    if (this.hedgeTableBody) {
      const rows = this.hedgeTableBody.querySelectorAll<HTMLTableRowElement>("tr[data-id]");
      for (const r of rows) {
        const id = r.dataset.id;
        if (!id) continue;
        const cb = r.querySelector<HTMLInputElement>("input.hedge-row-cb");
        const isSelected = this.selectedHedgeRowIds.has(id);
        if (cb) cb.checked = isSelected;
        const firstCell = r.cells[0];
        if (isSelected) {
          r.classList.add("bg-white/10", "hover:bg-white/[0.13]");
          if (firstCell) {
            firstCell.classList.remove("border-l-transparent");
            firstCell.classList.add("border-l-terminal-accent");
          }
        } else {
          r.classList.remove("bg-white/10", "hover:bg-white/[0.13]");
          if (firstCell) {
            firstCell.classList.remove("border-l-terminal-accent");
            firstCell.classList.add("border-l-transparent");
          }
        }
      }
    }

    this.updateHeaderCheckboxState();

    if (this.selectedHedgeRowIds.size === 0) {
      updateHedgeSelectionMetrics(null, this.hedgeSelectionMetricElements);
      return;
    }

    const selPairs: HedgePair[] = [];
    const selUnhedged: UnhedgedTrade[] = [];
    for (const id of this.selectedHedgeRowIds) {
      const p = this.hedgePairsMap.get(id);
      if (p) selPairs.push(p);
      else {
        const u = this.unhedgedTradesMap.get(id);
        if (u) selUnhedged.push(u);
      }
    }

    const selMetrics = calculateSelectedHedgeMetrics(selPairs, selUnhedged);
    updateHedgeSelectionMetrics(selMetrics, this.hedgeSelectionMetricElements);
  }

  private updateHeaderCheckboxState(): void {
    if (!this.checkAllHedge) return;
    const visibleIds = this.getVisibleHedgeRowIds();
    if (visibleIds.length === 0) {
      this.checkAllHedge.checked = false;
      this.checkAllHedge.indeterminate = false;
      return;
    }
    const count = visibleIds.filter((id) => this.selectedHedgeRowIds.has(id)).length;
    if (count === 0) {
      this.checkAllHedge.checked = false;
      this.checkAllHedge.indeterminate = false;
    } else if (count === visibleIds.length) {
      this.checkAllHedge.checked = true;
      this.checkAllHedge.indeterminate = false;
    } else {
      this.checkAllHedge.checked = false;
      this.checkAllHedge.indeterminate = true;
    }
  }
}
