import { copyToClipboard } from "../shared/clipboard";
import {
  downloadTextFile,
  getStaticMarketMap,
  normalizeTimestampMs,
  parseImportedTradesJson,
  parseTradeForView,
  sortParsedTradesChronologicalDesc,
  sortTradesChronologicalDesc,
  stitchTradeBatches,
} from "./api";
import { getBookmarkletHref } from "./bookmarklet";
import {
  type ActiveDateFilter,
  createPresetDateFilter,
  findPresetById,
  formatDateRangeFilterLabel,
  isTradeInDateRange,
  parseCustomDateRange,
  populatePresetSelect,
  renderPromoWeeksGrid,
} from "./date_filter";
import {
  formatDisplayFileName,
  type HedgeMetricElements,
  type HedgeSelectionMetricElements,
  type IndividualAccountMetricElements,
  renderHedgeTable,
  updateHedgeExecutiveMetrics,
  updateHedgeSelectionMetrics,
  updateIndividualAccountMetrics,
} from "./dom";
import {
  calculateHedgeMetrics,
  calculateSelectedHedgeMetrics,
  computeRangeSelection,
  exportHedgeReportToCsv,
  matchHedgeTrades,
} from "./hedge";
import type {
  HedgePair,
  HedgeSummaryMetrics,
  ImportedTradesResult,
  IndividualAccountMetrics,
  LighterTrade,
  ParsedTradeView,
  UnhedgedTrade,
} from "./types";

export class HedgeController {
  // Hedge mode state
  private rhBatches: ImportedTradesResult[] = [];
  private coreBatches: ImportedTradesResult[] = [];
  private rhRawTrades: LighterTrade[] = [];
  private coreRawTrades: LighterTrade[] = [];
  private rhParsedTrades: ParsedTradeView[] = [];
  private coreParsedTrades: ParsedTradeView[] = [];
  private rhAccountIndex: number | null = null;
  private coreAccountIndex: number | null = null;
  private rhAccountIndices: number[] = [];
  private coreAccountIndices: number[] = [];
  private rhFileName = "";
  private coreFileName = "";
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
  private uploadSessionId = 0;

  // Bookmarklet DOM Elements
  private hedgeBookmarkletLink: HTMLAnchorElement | null = null;
  private btnCopyBookmarkletHedge: HTMLButtonElement | null = null;
  private modalBookmarkletLink: HTMLAnchorElement | null = null;
  private modalCopyBookmarkletBtn: HTMLButtonElement | null = null;

  // Export Help Modal
  private exportModal: HTMLElement | null = null;
  private btnOpenExportHelpHedgeEmpty: HTMLElement | null = null;
  private btnOpenExportHelpHedge: HTMLElement | null = null;
  private btnCloseExportModal: HTMLElement | null = null;
  private btnDismissExportModal: HTMLElement | null = null;

  // Notification Status Card
  private statusCard: HTMLElement | null = null;
  private statusDot: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;
  private statusCountdown: HTMLElement | null = null;
  private btnCloseStatus: HTMLElement | null = null;
  private statusTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private countdownIntervalId: ReturnType<typeof setInterval> | null = null;

  // Dropzones & File inputs
  private dropzoneRh: HTMLElement | null = null;
  private dropzoneCore: HTMLElement | null = null;
  private fileInputRh: HTMLInputElement | null = null;
  private fileInputCore: HTMLInputElement | null = null;
  private statusRhFile: HTMLElement | null = null;
  private statusCoreFile: HTMLElement | null = null;
  private labelRhAccount: HTMLElement | null = null;
  private labelCoreAccount: HTMLElement | null = null;
  private btnClearRh: HTMLElement | null = null;
  private btnClearCore: HTMLElement | null = null;
  private btnBrowseRhFile: HTMLButtonElement | null = null;
  private btnPasteRhBox: HTMLButtonElement | null = null;
  private btnBrowseCoreFile: HTMLButtonElement | null = null;
  private btnPasteCoreBox: HTMLButtonElement | null = null;

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

  private hedgeEmptyStatePanel: HTMLElement | null = null;
  private hedgeLoadedToolbar: HTMLElement | null = null;
  private loadedRhFileName: HTMLElement | null = null;
  private loadedCoreFileName: HTMLElement | null = null;
  private btnAddRhFileLoaded: HTMLButtonElement | null = null;
  private btnPasteRhLoaded: HTMLButtonElement | null = null;
  private btnAddCoreFileLoaded: HTMLButtonElement | null = null;
  private btnPasteCoreLoaded: HTMLButtonElement | null = null;
  private btnClearHedgeAll: HTMLButtonElement | null = null;
  private btnHedgeExportCsv: HTMLButtonElement | null = null;

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

  // Paste JSON Modal
  private pasteModal: HTMLElement | null = null;
  private selectPasteTarget: HTMLSelectElement | null = null;
  private textareaPasteJson: HTMLTextAreaElement | null = null;
  private btnClosePasteModal: HTMLElement | null = null;
  private btnDismissPasteModal: HTMLElement | null = null;
  private btnSubmitPasteJson: HTMLElement | null = null;

  // Date Filter & Promo Modal Elements
  private activeHedgeDateFilter: ActiveDateFilter | null = null;
  private allHedgePairs: HedgePair[] = [];
  private allUnhedgedTrades: UnhedgedTrade[] = [];
  private selectHedgeDatePreset: HTMLSelectElement | null = null;
  private customHedgeDateContainer: HTMLElement | null = null;
  private inputCustomHedgeDateFrom: HTMLInputElement | null = null;
  private inputCustomHedgeDateTo: HTMLInputElement | null = null;
  private btnApplyCustomHedgeDate: HTMLButtonElement | null = null;
  private activeHedgeDateBadge: HTMLElement | null = null;
  private activeHedgeDateBadgeText: HTMLElement | null = null;
  private btnClearHedgeDateFilter: HTMLButtonElement | null = null;
  private btnOpenHedgePromoModal: HTMLButtonElement | null = null;
  private hedgePromoModal: HTMLElement | null = null;
  private btnCloseHedgePromoModal: HTMLButtonElement | null = null;
  private btnDismissHedgePromoModal: HTMLButtonElement | null = null;
  private btnHedgePromoSelectAll: HTMLButtonElement | null = null;
  private hedgePromoWeeksGrid: HTMLElement | null = null;

  public init(): void {
    this.cacheDomElements();
    this.initDateFilterSection();
    this.initBookmarkletSection();
    this.bindEvents();
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
    // Bookmarklet
    this.hedgeBookmarkletLink = document.getElementById(
      "hedgeBookmarkletLink",
    ) as HTMLAnchorElement | null;
    this.btnCopyBookmarkletHedge = document.getElementById(
      "btnCopyBookmarkletHedge",
    ) as HTMLButtonElement | null;
    this.modalBookmarkletLink = document.getElementById(
      "modalBookmarkletLink",
    ) as HTMLAnchorElement | null;
    this.modalCopyBookmarkletBtn = document.getElementById(
      "modalCopyBookmarkletBtn",
    ) as HTMLButtonElement | null;

    // Export Modal
    this.exportModal = document.getElementById("exportModal");
    this.btnOpenExportHelpHedgeEmpty = document.getElementById("btnOpenExportHelpHedgeEmpty");
    this.btnOpenExportHelpHedge = document.getElementById("btnOpenExportHelpHedge");
    this.btnCloseExportModal = document.getElementById("btnCloseExportModal");
    this.btnDismissExportModal = document.getElementById("btnDismissExportModal");

    // Notification Status Card
    this.statusCard = document.getElementById("statusCard");
    this.statusDot = document.getElementById("statusDot");
    this.statusText = document.getElementById("statusText");
    this.statusCountdown = document.getElementById("statusCountdown");
    this.btnCloseStatus = document.getElementById("btnCloseStatus");

    // Dual Dropzones
    this.dropzoneRh = document.getElementById("dropzoneRh");
    this.dropzoneCore = document.getElementById("dropzoneCore");
    this.fileInputRh = document.getElementById("fileInputRh") as HTMLInputElement | null;
    this.fileInputCore = document.getElementById("fileInputCore") as HTMLInputElement | null;
    this.statusRhFile = document.getElementById("statusRhFile");
    this.statusCoreFile = document.getElementById("statusCoreFile");
    this.labelRhAccount = document.getElementById("labelRhAccount");
    this.labelCoreAccount = document.getElementById("labelCoreAccount");
    this.btnClearRh = document.getElementById("btnClearRh");
    this.btnClearCore = document.getElementById("btnClearCore");
    this.btnBrowseRhFile = document.getElementById("btnBrowseRhFile") as HTMLButtonElement | null;
    this.btnPasteRhBox = document.getElementById("btnPasteRhBox") as HTMLButtonElement | null;
    this.btnBrowseCoreFile = document.getElementById(
      "btnBrowseCoreFile",
    ) as HTMLButtonElement | null;
    this.btnPasteCoreBox = document.getElementById("btnPasteCoreBox") as HTMLButtonElement | null;

    // Metrics
    this.hedgeMetricElements = {
      accountsBadge: document.getElementById("leadHedgeAccountsBadge"),
      pairsCount: document.getElementById("leadHedgePairsCount"),
      hedgedVolume: document.getElementById("leadHedgeVolume"),
      netPnl: document.getElementById("leadHedgeNetPnl"),
      pnlBps: document.getElementById("leadHedgePnlBps"),
      slippage: document.getElementById("leadHedgeSlippage"),
      fees: document.getElementById("leadHedgeFees"),
      unhedgedCount: document.getElementById("leadHedgeUnhedgedCount"),
    };

    this.rhMetricElements = {
      accountBadge: document.getElementById("leadRhAccountBadge"),
      tradesCount: document.getElementById("leadRhTradesCount"),
      volume: document.getElementById("leadRhVolume"),
      realizedPnl: document.getElementById("leadRhRealizedPnl"),
      fees: document.getElementById("leadRhFees"),
      unhedgedCount: document.getElementById("leadRhUnhedgedCount"),
    };

    this.coreMetricElements = {
      accountBadge: document.getElementById("leadCoreAccountBadge"),
      tradesCount: document.getElementById("leadCoreTradesCount"),
      volume: document.getElementById("leadCoreVolume"),
      realizedPnl: document.getElementById("leadCoreRealizedPnl"),
      fees: document.getElementById("leadCoreFees"),
      unhedgedCount: document.getElementById("leadCoreUnhedgedCount"),
    };

    this.hedgeEmptyStatePanel = document.getElementById("hedgeEmptyStatePanel");
    this.hedgeLoadedToolbar = document.getElementById("hedgeLoadedToolbar");
    this.loadedRhFileName = document.getElementById("loadedRhFileName");
    this.loadedCoreFileName = document.getElementById("loadedCoreFileName");
    this.btnAddRhFileLoaded = document.getElementById(
      "btnAddRhFileLoaded",
    ) as HTMLButtonElement | null;
    this.btnPasteRhLoaded = document.getElementById("btnPasteRhLoaded") as HTMLButtonElement | null;
    this.btnAddCoreFileLoaded = document.getElementById(
      "btnAddCoreFileLoaded",
    ) as HTMLButtonElement | null;
    this.btnPasteCoreLoaded = document.getElementById(
      "btnPasteCoreLoaded",
    ) as HTMLButtonElement | null;
    this.btnClearHedgeAll = document.getElementById("btnHedgeClear") as HTMLButtonElement | null;
    this.btnHedgeExportCsv = document.getElementById(
      "btnHedgeExportCsv",
    ) as HTMLButtonElement | null;

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
      fees: document.getElementById("selectedFees"),
      unhedgedCount: document.getElementById("selectedUnhedgedCount"),
    };

    // Paste Modal
    this.pasteModal = document.getElementById("pasteModal");
    this.selectPasteTarget = document.getElementById(
      "selectPasteTarget",
    ) as HTMLSelectElement | null;
    this.textareaPasteJson = document.getElementById(
      "textareaPasteJson",
    ) as HTMLTextAreaElement | null;
    this.btnClosePasteModal = document.getElementById("btnClosePasteModal");
    this.btnDismissPasteModal = document.getElementById("btnDismissPasteModal");
    this.btnSubmitPasteJson = document.getElementById("btnSubmitPasteJson");

    // Date Filter & Promo Modal Elements
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
    this.activeHedgeDateBadge = document.getElementById("activeHedgeDateBadge");
    this.activeHedgeDateBadgeText = document.getElementById("activeHedgeDateBadgeText");
    this.btnClearHedgeDateFilter = document.getElementById(
      "btnClearHedgeDateFilter",
    ) as HTMLButtonElement | null;
    this.btnOpenHedgePromoModal = document.getElementById(
      "btnOpenHedgePromoModal",
    ) as HTMLButtonElement | null;
    this.hedgePromoModal = document.getElementById("hedgePromoModal");
    this.btnCloseHedgePromoModal = document.getElementById(
      "btnCloseHedgePromoModal",
    ) as HTMLButtonElement | null;
    this.btnDismissHedgePromoModal = document.getElementById(
      "btnDismissHedgePromoModal",
    ) as HTMLButtonElement | null;
    this.btnHedgePromoSelectAll = document.getElementById(
      "btnHedgePromoSelectAll",
    ) as HTMLButtonElement | null;
    this.hedgePromoWeeksGrid = document.getElementById("hedgePromoWeeksGrid");
  }

  private handleBookmarkletClick(e: MouseEvent): void {
    e.preventDefault();
    this.openExportModal();
  }

  private initBookmarkletSection(): void {
    const bookmarkletHref = getBookmarkletHref();

    if (this.hedgeBookmarkletLink) {
      this.hedgeBookmarkletLink.href = bookmarkletHref;
      this.hedgeBookmarkletLink.addEventListener("click", (e) => this.handleBookmarkletClick(e));
    }
    if (this.modalBookmarkletLink) {
      this.modalBookmarkletLink.href = bookmarkletHref;
      this.modalBookmarkletLink.addEventListener("click", (e) => this.handleBookmarkletClick(e));
    }
    if (this.btnCopyBookmarkletHedge) {
      const btn = this.btnCopyBookmarkletHedge;
      btn.addEventListener("click", () => {
        copyToClipboard(getBookmarkletHref(), btn, "Copy Code");
      });
    }
    if (this.modalCopyBookmarkletBtn) {
      const btn = this.modalCopyBookmarkletBtn;
      btn.addEventListener("click", () => {
        copyToClipboard(getBookmarkletHref(), btn, "Copy Code");
      });
    }
  }

  private bindEvents(): void {
    // Export Modal
    this.btnOpenExportHelpHedgeEmpty?.addEventListener("click", () => this.openExportModal());
    this.btnOpenExportHelpHedge?.addEventListener("click", () => this.openExportModal());
    this.btnCloseExportModal?.addEventListener("click", () => this.closeExportModal());
    this.btnDismissExportModal?.addEventListener("click", () => this.closeExportModal());
    this.exportModal?.addEventListener("click", (e) => {
      if (e.target === this.exportModal) this.closeExportModal();
    });

    // Paste Modal
    this.btnClosePasteModal?.addEventListener("click", () => this.closePasteModal());
    this.btnDismissPasteModal?.addEventListener("click", () => this.closePasteModal());
    this.btnSubmitPasteJson?.addEventListener("click", () => this.handlePasteSubmit());
    this.pasteModal?.addEventListener("click", (e) => {
      if (e.target === this.pasteModal) this.closePasteModal();
    });

    // Notification close
    this.btnCloseStatus?.addEventListener("click", () => {
      this.clearStatusTimers();
      this.statusCard?.classList.add("hidden");
    });

    // Dual Dropzones
    this.setupHedgeDropzone(this.dropzoneRh, "rh");
    this.setupHedgeDropzone(this.dropzoneCore, "core");

    this.btnBrowseRhFile?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.fileInputRh?.click();
    });

    this.btnBrowseCoreFile?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.fileInputCore?.click();
    });

    this.btnPasteRhBox?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.pasteFromClipboard("rh");
    });

    this.btnPasteCoreBox?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.pasteFromClipboard("core");
    });

    this.fileInputRh?.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const files = input.files;
      if (files && files.length > 0) this.handleHedgeFiles(files, "rh");
      input.value = "";
    });

    this.fileInputCore?.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const files = input.files;
      if (files && files.length > 0) this.handleHedgeFiles(files, "core");
      input.value = "";
    });

    this.btnClearRh?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clearHedgeSlot("rh");
    });

    this.btnClearCore?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clearHedgeSlot("core");
    });

    // Loaded Toolbar buttons
    this.btnAddRhFileLoaded?.addEventListener("click", () => {
      this.fileInputRh?.click();
    });

    this.btnPasteRhLoaded?.addEventListener("click", () => {
      this.pasteFromClipboard("rh");
    });

    this.btnAddCoreFileLoaded?.addEventListener("click", () => {
      this.fileInputCore?.click();
    });

    this.btnPasteCoreLoaded?.addEventListener("click", () => {
      this.pasteFromClipboard("core");
    });

    this.btnClearHedgeAll?.addEventListener("click", () => this.clearHedge());
    this.btnHedgeExportCsv?.addEventListener("click", () => this.downloadHedgeCsv());

    // Search and filters with 150ms debounce
    this.inputHedgeSearch?.addEventListener("input", (e) => {
      this.hedgeSearchQuery = (e.target as HTMLInputElement).value.trim().toLowerCase();
      if (this.hedgeFilterDebounceTimer) {
        clearTimeout(this.hedgeFilterDebounceTimer);
      }
      this.hedgeFilterDebounceTimer = setTimeout(() => {
        this.applyHedgeFilter();
      }, 150);
    });

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
    this.hedgeTableBody?.addEventListener("click", (e) => this.handleHedgeTableClick(e));
    this.btnDeselectAllHedge?.addEventListener("click", () => {
      this.selectedHedgeRowIds.clear();
      this.lastClickedHedgeRowId = null;
      this.lastClickedHedgeRowState = true;
      this.selectionSnapshot.clear();
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

    // Clear Date Filter
    this.btnClearHedgeDateFilter?.addEventListener("click", () => {
      this.activeHedgeDateFilter = null;
      if (this.selectHedgeDatePreset) this.selectHedgeDatePreset.value = "all";
      if (this.inputCustomHedgeDateFrom) this.inputCustomHedgeDateFrom.value = "";
      if (this.inputCustomHedgeDateTo) this.inputCustomHedgeDateTo.value = "";
      this.customHedgeDateContainer?.classList.add("hidden");
      this.applyHedgeDateFilter();
    });

    // 20-Weeks Promo Modal Controls
    this.btnOpenHedgePromoModal?.addEventListener("click", () => this.openHedgePromoModal());
    this.btnCloseHedgePromoModal?.addEventListener("click", () => this.closeHedgePromoModal());
    this.btnDismissHedgePromoModal?.addEventListener("click", () => this.closeHedgePromoModal());
    this.hedgePromoModal?.addEventListener("click", (e) => {
      if (e.target === this.hedgePromoModal) this.closeHedgePromoModal();
    });
    this.btnHedgePromoSelectAll?.addEventListener("click", () => {
      this.activeHedgeDateFilter = null;
      if (this.selectHedgeDatePreset) this.selectHedgeDatePreset.value = "all";
      this.closeHedgePromoModal();
      this.applyHedgeDateFilter();
    });

    // Keyboard hotkeys
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!this.exportModal?.classList.contains("hidden")) this.closeExportModal();
        if (!this.pasteModal?.classList.contains("hidden")) this.closePasteModal();
        if (!this.hedgePromoModal?.classList.contains("hidden")) this.closeHedgePromoModal();
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

  private setupHedgeDropzone(dropzone: HTMLElement | null, defaultSlot: "rh" | "core"): void {
    if (!dropzone) return;

    const highlight = () => {
      dropzone.classList.add("border-terminal-accent", "bg-terminal-surfaceHover");
      dropzone.classList.remove("border-terminal-border");
    };
    const unhighlight = () => {
      dropzone.classList.remove("border-terminal-accent", "bg-terminal-surfaceHover");
      dropzone.classList.add("border-terminal-border");
    };

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      highlight();
    });
    dropzone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      highlight();
    });
    dropzone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      unhighlight();
    });

    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      unhighlight();
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        this.handleHedgeFiles(e.dataTransfer.files, defaultSlot);
      }
    });

    dropzone.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      if (defaultSlot === "rh") {
        this.fileInputRh?.click();
      } else {
        this.fileInputCore?.click();
      }
    });
  }

  public openExportModal(): void {
    this.exportModal?.classList.remove("hidden");
  }

  public closeExportModal(): void {
    this.exportModal?.classList.add("hidden");
  }

  public openPasteModal(target: "auto" | "rh" | "core" = "auto"): void {
    if (this.selectPasteTarget) this.selectPasteTarget.value = target;
    if (this.textareaPasteJson) this.textareaPasteJson.value = "";
    this.pasteModal?.classList.remove("hidden");
    setTimeout(() => this.textareaPasteJson?.focus(), 50);
  }

  public closePasteModal(): void {
    this.pasteModal?.classList.add("hidden");
  }

  public handlePasteSubmit(): void {
    const rawText = this.textareaPasteJson?.value?.trim() || "";
    if (!rawText) {
      this.showStatusError("No JSON text provided.");
      return;
    }

    this.uploadSessionId++;
    try {
      const parsed = parseImportedTradesJson(rawText, "pasted-response.json");
      const chosenTarget = this.selectPasteTarget?.value || "auto";

      let finalSlot: "rh" | "core" = "core";
      if (chosenTarget === "rh") {
        finalSlot = "rh";
      } else if (chosenTarget === "core") {
        finalSlot = "core";
      } else {
        finalSlot = parsed.network === "rh" ? "rh" : "core";
      }

      if (finalSlot === "rh") {
        this.rhBatches = [...this.rhBatches, parsed];
      } else {
        this.coreBatches = [...this.coreBatches, parsed];
      }

      this.closePasteModal();
      this.applyHedgeBatches();
    } catch (err: any) {
      this.showStatusError(`Failed to parse pasted JSON: ${err.message || String(err)}`);
    }
  }

  private async pasteFromClipboard(slot: "rh" | "core"): Promise<void> {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        const sessionId = ++this.uploadSessionId;
        const text = await navigator.clipboard.readText();
        if (sessionId !== this.uploadSessionId) return;

        if (text && /\S/.test(text)) {
          const parsed = parseImportedTradesJson(
            text,
            `Clipboard-${slot.toUpperCase()}-${Date.now().toString().slice(-4)}.json`,
          );
          if (sessionId !== this.uploadSessionId) return;

          if (slot === "rh") {
            this.rhBatches = [...this.rhBatches, parsed];
          } else {
            this.coreBatches = [...this.coreBatches, parsed];
          }
          this.applyHedgeBatches();
          this.showStatusSuccess(
            `Added ${parsed.trades.length} trades to ${slot === "rh" ? "RH" : "Core"} from clipboard.`,
          );
          return;
        }
      }
    } catch {
      // Clipboard read failed or was denied by permissions policy -> fallback to modal
    }

    // Fallback: open paste modal pre-targeted for this slot
    this.openPasteModal(slot);
  }

  private async handleHedgeFiles(files: FileList, defaultSlot: "rh" | "core"): Promise<void> {
    const sessionId = ++this.uploadSessionId;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileNameLower = file.name.toLowerCase();
      const isJson =
        fileNameLower.endsWith(".json") ||
        fileNameLower.includes(".json") ||
        file.type === "application/json" ||
        file.type === "text/plain" ||
        file.type.includes("json") ||
        file.type === "";

      if (!isJson) {
        this.showStatusError(`Skipped "${file.name}": not a valid .json file.`);
        continue;
      }

      try {
        const text = await file.text();
        if (sessionId !== this.uploadSessionId) return;

        if (!/\S/.test(text)) {
          this.showStatusError(`Skipped "${file.name}": file is empty.`);
          continue;
        }

        this.showStatusSuccess(`Parsing "${file.name}"...`);
        // Yield to event loop to keep UI responsive with large files and allow browser to paint status
        await new Promise((r) => setTimeout(r, 0));
        if (sessionId !== this.uploadSessionId) return;

        const parsed = parseImportedTradesJson(text, file.name);
        if (sessionId !== this.uploadSessionId) return;

        // Smart network routing
        let targetSlot = defaultSlot;
        if (
          parsed.network === "mainnet" ||
          file.name.toLowerCase().includes("mainnet") ||
          file.name.toLowerCase().includes("core")
        ) {
          targetSlot = "core";
        } else if (parsed.network === "rh" || file.name.toLowerCase().includes("-rh-")) {
          targetSlot = "rh";
        }

        if (targetSlot === "rh") {
          this.rhBatches = [...this.rhBatches, parsed];
        } else {
          this.coreBatches = [...this.coreBatches, parsed];
        }
      } catch (err: any) {
        if (sessionId === this.uploadSessionId) {
          this.showStatusError(`Error reading "${file.name}": ${err.message || String(err)}`);
        }
      }
    }

    if (sessionId !== this.uploadSessionId) return;
    this.applyHedgeBatches();
  }

  private applyHedgeBatches(): void {
    if (this.rhBatches.length > 0) {
      const rhStitched = stitchTradeBatches(this.rhBatches);
      this.rhRawTrades = sortTradesChronologicalDesc(rhStitched.trades);
      this.rhAccountIndices = rhStitched.accountIndices;
      this.rhAccountIndex =
        rhStitched.accountIndices.length > 0 ? rhStitched.accountIndices[0] : null;

      const rawFileName = this.rhBatches[0].fileName || "RH JSON";
      const fileCountText =
        this.rhBatches.length === 1
          ? formatDisplayFileName(rawFileName, 22)
          : `${this.rhBatches.length} files`;

      if (this.statusRhFile) {
        this.statusRhFile.textContent = `✓ ${fileCountText} (${this.rhRawTrades.length} trades)`;
        this.statusRhFile.title = `${this.rhBatches.length === 1 ? rawFileName : `${this.rhBatches.length} files`} (${this.rhRawTrades.length} trades)`;
        this.statusRhFile.className =
          "text-[11px] text-terminal-emerald font-semibold my-1.5 truncate w-full max-w-full px-1 text-center";
      }
      if (this.labelRhAccount) {
        this.labelRhAccount.textContent =
          this.rhAccountIndices.length > 0
            ? `Account(s) ${this.rhAccountIndices.map((a) => `#${a}`).join(", ")}`
            : `Account #${this.rhAccountIndex ?? "--"}`;
        this.labelRhAccount.className =
          "text-[10px] text-terminal-emerald font-semibold truncate max-w-28 sm:max-w-36";
      }
      if (this.btnClearRh) this.btnClearRh.classList.remove("hidden");
      if (this.btnBrowseRhFile) {
        this.btnBrowseRhFile.textContent = "Add More Files";
      }
      if (this.loadedRhFileName) {
        this.loadedRhFileName.textContent = fileCountText;
        this.loadedRhFileName.title = `${this.rhBatches.length === 1 ? rawFileName : `${this.rhBatches.length} files`} (${this.rhRawTrades.length} trades)`;
      }
    }

    if (this.coreBatches.length > 0) {
      const coreStitched = stitchTradeBatches(this.coreBatches);
      this.coreRawTrades = sortTradesChronologicalDesc(coreStitched.trades);
      this.coreAccountIndices = coreStitched.accountIndices;
      this.coreAccountIndex =
        coreStitched.accountIndices.length > 0 ? coreStitched.accountIndices[0] : null;

      const rawFileName = this.coreBatches[0].fileName || "Core JSON";
      const fileCountText =
        this.coreBatches.length === 1
          ? formatDisplayFileName(rawFileName, 22)
          : `${this.coreBatches.length} files`;

      if (this.statusCoreFile) {
        this.statusCoreFile.textContent = `✓ ${fileCountText} (${this.coreRawTrades.length} trades)`;
        this.statusCoreFile.title = `${this.coreBatches.length === 1 ? rawFileName : `${this.coreBatches.length} files`} (${this.coreRawTrades.length} trades)`;
        this.statusCoreFile.className =
          "text-[11px] text-terminal-emerald font-semibold my-1.5 truncate w-full max-w-full px-1 text-center";
      }
      if (this.labelCoreAccount) {
        this.labelCoreAccount.textContent =
          this.coreAccountIndices.length > 0
            ? `Account(s) ${this.coreAccountIndices.map((a) => `#${a}`).join(", ")}`
            : `Account #${this.coreAccountIndex ?? "--"}`;
        this.labelCoreAccount.className =
          "text-[10px] text-terminal-accent font-semibold truncate max-w-28 sm:max-w-36";
      }
      if (this.btnClearCore) this.btnClearCore.classList.remove("hidden");
      if (this.btnBrowseCoreFile) {
        this.btnBrowseCoreFile.textContent = "Add More Files";
      }
      if (this.loadedCoreFileName) {
        this.loadedCoreFileName.textContent = fileCountText;
        this.loadedCoreFileName.title = `${this.coreBatches.length === 1 ? rawFileName : `${this.coreBatches.length} files`} (${this.coreRawTrades.length} trades)`;
      }
    }

    if (this.rhRawTrades.length > 0 && this.coreRawTrades.length > 0) {
      this.recalculateAndRenderHedge();
      this.hedgeEmptyStatePanel?.classList.add("hidden");
      this.hedgeLoadedToolbar?.classList.remove("hidden");

      const rhAccStr =
        this.rhAccountIndices.length > 0
          ? this.rhAccountIndices.map((a) => `#${a}`).join(", ")
          : `${this.rhAccountIndex ?? "--"}`;
      const coreAccStr =
        this.coreAccountIndices.length > 0
          ? this.coreAccountIndices.map((a) => `#${a}`).join(", ")
          : `${this.coreAccountIndex ?? "--"}`;
      this.showStatusSuccess(
        `Hedge audit ready: matched ${this.allHedgePairs.length} pairs between RH (${rhAccStr}) and Core (${coreAccStr}).`,
      );
    } else if (this.rhRawTrades.length > 0) {
      this.showStatusSuccess(
        `Loaded RH: ${this.rhRawTrades.length} trades across ${this.rhBatches.length} file(s). Now add your Core file(s).`,
      );
    } else if (this.coreRawTrades.length > 0) {
      this.showStatusSuccess(
        `Loaded Core: ${this.coreRawTrades.length} trades across ${this.coreBatches.length} file(s). Now add your RH file(s).`,
      );
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

  public openHedgePromoModal(): void {
    if (this.hedgePromoWeeksGrid) {
      renderPromoWeeksGrid(
        this.hedgePromoWeeksGrid,
        (preset) => {
          this.activeHedgeDateFilter = createPresetDateFilter(preset);
          if (this.selectHedgeDatePreset) this.selectHedgeDatePreset.value = preset.id;
          if (preset.startDateFormatted && this.inputCustomHedgeDateFrom) {
            this.inputCustomHedgeDateFrom.value = preset.startDateFormatted;
          }
          if (preset.endDateFormatted && this.inputCustomHedgeDateTo) {
            this.inputCustomHedgeDateTo.value = preset.endDateFormatted;
          }
          this.closeHedgePromoModal();
          this.applyHedgeDateFilter();
        },
        this.activeHedgeDateFilter?.presetId,
      );
    }
    this.hedgePromoModal?.classList.remove("hidden");
  }

  public closeHedgePromoModal(): void {
    this.hedgePromoModal?.classList.add("hidden");
  }

  private updateHedgeDateFilterUi(): void {
    if (this.selectHedgeDatePreset) {
      this.selectHedgeDatePreset.value = this.activeHedgeDateFilter?.presetId || "all";
    }

    if (this.activeHedgeDateFilter && this.activeHedgeDateFilter.presetId !== "all") {
      this.activeHedgeDateBadge?.classList.remove("hidden");
      if (this.activeHedgeDateBadgeText) {
        this.activeHedgeDateBadgeText.textContent = formatDateRangeFilterLabel(
          this.activeHedgeDateFilter,
        );
      }
    } else {
      this.activeHedgeDateBadge?.classList.add("hidden");
    }

    if (this.activeHedgeDateFilter?.isCustom) {
      this.customHedgeDateContainer?.classList.remove("hidden");
    } else if (this.selectHedgeDatePreset?.value !== "custom") {
      this.customHedgeDateContainer?.classList.add("hidden");
    }
  }

  private applyHedgeDateFilter(): void {
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

    this.hedgeMetrics = calculateHedgeMetrics(
      this.hedgePairs,
      this.unhedgedTrades,
      rhAccQuery,
      coreAccQuery,
      rhTradesCount,
      coreTradesCount,
      this.rhAccountIndices,
      this.coreAccountIndices,
    );

    this.updateHedgeExecutiveSummary();
    this.applyHedgeFilter();
    this.updateHedgeDateFilterUi();
    this.onHedgeSelectionChanged();
  }

  private updateHedgeExecutiveSummary(): void {
    updateHedgeExecutiveMetrics(this.hedgeMetrics, this.hedgeMetricElements);

    const rhMetrics = this.computeIndividualAccountMetrics("RH");
    updateIndividualAccountMetrics(rhMetrics, this.rhMetricElements);

    const coreMetrics = this.computeIndividualAccountMetrics("CORE");
    updateIndividualAccountMetrics(coreMetrics, this.coreMetricElements);
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

    for (const t of filteredTrades) {
      totalVolumeUsd += t.usdValue;
      realizedPnlUsd += t.realizedPnl;
      totalFeesUsd += t.feeUsd;
    }

    const unhedgedCount = this.unhedgedTrades.filter((u) => u.network === network).length;

    return {
      accountIndex,
      accountIndices: accountIndices.length > 0 ? accountIndices : undefined,
      network,
      tradesCount: filteredTrades.length,
      totalVolumeUsd,
      realizedPnlUsd,
      totalFeesUsd,
      unhedgedCount,
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
        250,
        this.selectedHedgeRowIds,
      );
      this.updateHeaderCheckboxState();
    }

    if (this.hedgeCountNotice) {
      const showPairs = this.hedgeFilterTab === "all";
      const count =
        (showPairs ? this.filteredHedgePairs.length : 0) + this.filteredUnhedgedTrades.length;
      const total = (showPairs ? this.hedgePairs.length : 0) + this.unhedgedTrades.length;

      if (q && total > 0) {
        this.hedgeCountNotice.textContent = `Showing ${count} of ${total} records`;
        this.hedgeCountNotice.className = "text-[11px] text-terminal-accent font-medium";
      } else if (this.activeHedgeDateFilter && this.activeHedgeDateFilter.presetId !== "all") {
        const allTotal =
          (showPairs ? this.allHedgePairs.length : 0) + this.allUnhedgedTrades.length;
        this.hedgeCountNotice.textContent = `Showing ${total} of ${allTotal} in range`;
        this.hedgeCountNotice.className = "text-[11px] text-terminal-accent font-medium";
      } else if (total > 0) {
        this.hedgeCountNotice.textContent = `${this.hedgePairs.length} pairs hedged`;
        this.hedgeCountNotice.className = "text-[11px] text-terminal-muted";
      } else {
        this.hedgeCountNotice.textContent = "";
      }
    }
  }

  private switchHedgeFilterTab(tab: "all" | "unhedged"): void {
    this.hedgeFilterTab = tab;
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
    if (this.hedgePairs.length === 0 && this.unhedgedTrades.length === 0) return;

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

  public clearHedgeSlot(slot: "rh" | "core"): void {
    this.uploadSessionId++;
    if (slot === "rh") {
      this.rhBatches = [];
      this.rhRawTrades = [];
      this.rhParsedTrades = [];
      this.rhAccountIndex = null;
      this.rhAccountIndices = [];
      this.rhFileName = "";
      if (this.statusRhFile) {
        this.statusRhFile.innerHTML =
          'Drop <code class="text-terminal-emerald">rh-*.json</code> or raw API';
        this.statusRhFile.title = "";
        this.statusRhFile.className =
          "text-[11px] text-terminal-secondary truncate w-full max-w-full px-1 text-center";
      }
      if (this.labelRhAccount) {
        this.labelRhAccount.textContent = "No files loaded";
        this.labelRhAccount.className = "text-[10px] text-terminal-muted truncate max-w-28 sm:max-w-36";
      }
      if (this.btnClearRh) this.btnClearRh.classList.add("hidden");
      if (this.fileInputRh) this.fileInputRh.value = "";
      if (this.btnBrowseRhFile) this.btnBrowseRhFile.textContent = "Select Files";
      if (this.loadedRhFileName) {
        this.loadedRhFileName.textContent = "--";
        this.loadedRhFileName.title = "";
      }
    } else {
      this.coreBatches = [];
      this.coreRawTrades = [];
      this.coreParsedTrades = [];
      this.coreAccountIndex = null;
      this.coreAccountIndices = [];
      this.coreFileName = "";
      if (this.statusCoreFile) {
        this.statusCoreFile.innerHTML =
          'Drop <code class="text-terminal-accent">mainnet-*.json</code> or raw API';
        this.statusCoreFile.title = "";
        this.statusCoreFile.className =
          "text-[11px] text-terminal-secondary truncate w-full max-w-full px-1 text-center";
      }
      if (this.labelCoreAccount) {
        this.labelCoreAccount.textContent = "No files loaded";
        this.labelCoreAccount.className = "text-[10px] text-terminal-muted truncate max-w-28 sm:max-w-36";
      }
      if (this.btnClearCore) this.btnClearCore.classList.add("hidden");
      if (this.fileInputCore) this.fileInputCore.value = "";
      if (this.btnBrowseCoreFile) this.btnBrowseCoreFile.textContent = "Select Files";
      if (this.loadedCoreFileName) {
        this.loadedCoreFileName.textContent = "--";
        this.loadedCoreFileName.title = "";
      }
    }

    this.allHedgePairs = [];
    this.allUnhedgedTrades = [];
    this.hedgePairs = [];
    this.unhedgedTrades = [];
    this.hedgePairsMap.clear();
    this.unhedgedTradesMap.clear();
    this.filteredHedgePairs = [];
    this.filteredUnhedgedTrades = [];
    this.hedgeMetrics = null;
    this.selectedHedgeRowIds.clear();
    this.lastClickedHedgeRowId = null;
    this.lastClickedHedgeRowState = true;
    this.selectionSnapshot.clear();
    updateHedgeSelectionMetrics(null, this.hedgeSelectionMetricElements);

    if (this.rhRawTrades.length === 0 || this.coreRawTrades.length === 0) {
      this.hedgeLoadedToolbar?.classList.add("hidden");
      this.hedgeEmptyStatePanel?.classList.remove("hidden");
    }

    this.updateHedgeExecutiveSummary();
    this.applyHedgeFilter();
    this.updateHedgeDateFilterUi();
  }

  public clearHedge(): void {
    this.uploadSessionId++;
    this.activeHedgeDateFilter = null;
    if (this.selectHedgeDatePreset) this.selectHedgeDatePreset.value = "all";
    if (this.inputCustomHedgeDateFrom) this.inputCustomHedgeDateFrom.value = "";
    if (this.inputCustomHedgeDateTo) this.inputCustomHedgeDateTo.value = "";
    this.customHedgeDateContainer?.classList.add("hidden");
    this.clearHedgeSlot("rh");
    this.clearHedgeSlot("core");
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
    if (
      result.newAnchorId === targetId &&
      !this.selectionSnapshot.has(targetId) &&
      this.lastClickedHedgeRowState
    ) {
      this.selectionSnapshot = new Set(this.selectedHedgeRowIds);
    }
  }

  private handleHedgeTableClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const tr = target.closest("tr") as HTMLTableRowElement | null;
    if (!tr || !tr.dataset.id) return;

    const id = tr.dataset.id;
    const isCheckbox =
      target.classList.contains("hedge-row-cb") || target instanceof HTMLInputElement;

    // Ignore clicks on links or action buttons inside the row
    if (!isCheckbox && (target.closest("a") || target.closest("button"))) return;

    // Ignore text selection on normal drag-selection clicks (never block Shift-range selection)
    if (!e.shiftKey && !isCheckbox) {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) return;
    }

    if (e.shiftKey) {
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      this.handleHedgeRangeSelection(id);
    } else {
      if (isCheckbox) {
        const cb = target as HTMLInputElement;
        const isChecked = cb.checked;
        if (isChecked) {
          this.selectedHedgeRowIds.add(id);
        } else {
          this.selectedHedgeRowIds.delete(id);
        }
        this.lastClickedHedgeRowId = id;
        this.lastClickedHedgeRowState = isChecked;
        this.selectionSnapshot = new Set(this.selectedHedgeRowIds);
      } else {
        const isNowSelected = !this.selectedHedgeRowIds.has(id);
        if (isNowSelected) {
          this.selectedHedgeRowIds.add(id);
        } else {
          this.selectedHedgeRowIds.delete(id);
        }
        this.lastClickedHedgeRowId = id;
        this.lastClickedHedgeRowState = isNowSelected;
        this.selectionSnapshot = new Set(this.selectedHedgeRowIds);
      }
    }

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

  private updateHeaderCheckboxState(): void {
    if (!this.checkAllHedge) return;
    const visibleIds = this.getVisibleHedgeRowIds();
    if (visibleIds.length === 0) {
      this.checkAllHedge.checked = false;
      this.checkAllHedge.indeterminate = false;
      return;
    }

    const selectedVisibleCount = visibleIds.filter((id) => this.selectedHedgeRowIds.has(id)).length;
    this.checkAllHedge.checked = selectedVisibleCount === visibleIds.length;
    this.checkAllHedge.indeterminate =
      selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
  }

  private onHedgeSelectionChanged(): void {
    const selectedPairs: HedgePair[] = [];
    const selectedUnhedged: UnhedgedTrade[] = [];

    for (const id of this.selectedHedgeRowIds) {
      const p = this.hedgePairsMap.get(id);
      if (p) {
        selectedPairs.push(p);
      } else {
        const u = this.unhedgedTradesMap.get(id);
        if (u) selectedUnhedged.push(u);
      }
    }

    const metrics = calculateSelectedHedgeMetrics(selectedPairs, selectedUnhedged);
    updateHedgeSelectionMetrics(metrics, this.hedgeSelectionMetricElements);

    // Fast DOM sync without full table reconstruction
    if (this.hedgeTableBody) {
      const rows = this.hedgeTableBody.querySelectorAll<HTMLTableRowElement>("tr[data-id]");
      for (const r of rows) {
        const id = r.dataset.id;
        if (!id) continue;
        const isSelected = this.selectedHedgeRowIds.has(id);
        const cb = r.querySelector<HTMLInputElement>(".hedge-row-cb");
        if (cb && cb.checked !== isSelected) {
          cb.checked = isSelected;
        }

        const baseClass =
          "hover:bg-terminal-surfaceHover transition-colors text-xs font-mono select-text cursor-pointer";
        const isUnhedged = id.startsWith("unhedged-");
        if (isSelected) {
          r.className = `${baseClass} bg-white/10 hover:bg-white/[0.13]`;
        } else {
          r.className = isUnhedged ? `${baseClass} bg-terminal-coral/5` : baseClass;
        }
      }
    }

    this.updateHeaderCheckboxState();

    if (this.btnHedgeExportCsv) {
      this.btnHedgeExportCsv.textContent =
        this.selectedHedgeRowIds.size > 0
          ? `Export CSV (${this.selectedHedgeRowIds.size})`
          : "Export CSV";
    }
  }

  // ==========================================
  // NOTIFICATIONS
  // ==========================================

  private clearStatusTimers(): void {
    if (this.statusTimeoutId) {
      clearTimeout(this.statusTimeoutId);
      this.statusTimeoutId = null;
    }
    if (this.countdownIntervalId) {
      clearInterval(this.countdownIntervalId);
      this.countdownIntervalId = null;
    }
  }

  private showStatusSuccess(message: string, durationMs = 5000): void {
    this.clearStatusTimers();
    if (!this.statusCard) return;

    this.statusCard.className =
      "bg-terminal-surface border border-terminal-border rounded p-3 text-xs font-mono transition-all duration-150";
    if (this.statusDot) this.statusDot.className = "w-2 h-2 rounded-full bg-terminal-emerald";
    if (this.statusText) {
      this.statusText.textContent = message;
      this.statusText.className = "text-white font-medium";
    }

    let remainingSec = Math.ceil(durationMs / 1000);
    if (this.statusCountdown) this.statusCountdown.textContent = `${remainingSec}s`;

    this.countdownIntervalId = setInterval(() => {
      remainingSec -= 1;
      if (this.statusCountdown) {
        this.statusCountdown.textContent = remainingSec > 0 ? `${remainingSec}s` : "";
      }
    }, 1000);

    this.statusTimeoutId = setTimeout(() => {
      this.clearStatusTimers();
      this.statusCard?.classList.add("hidden");
    }, durationMs);

    this.statusCard.classList.remove("hidden");
  }

  private showStatusError(errorMsg: string): void {
    this.clearStatusTimers();
    if (!this.statusCard) return;

    this.statusCard.className =
      "bg-terminal-coral/10 border border-terminal-coral/40 rounded p-3 text-xs font-mono transition-all duration-150";
    if (this.statusDot) this.statusDot.className = "w-2 h-2 rounded-full bg-terminal-coral";
    if (this.statusText) {
      this.statusText.textContent = errorMsg;
      this.statusText.className = "text-terminal-coral font-medium";
    }
    if (this.statusCountdown) this.statusCountdown.textContent = "";

    this.statusCard.classList.remove("hidden");
  }
}
