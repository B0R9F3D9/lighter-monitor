import { copyToClipboard } from "../shared/clipboard";
import {
  calculateTradeMetrics,
  downloadJsonFile,
  downloadTextFile,
  fetchMarketMap,
  getStaticMarketMap,
  parseImportedTradesJson,
  parseTradeForView,
  prepareExportPayload,
  sortParsedTradesChronologicalDesc,
  sortTradesChronologicalDesc,
  stitchTradeBatches,
} from "./api";
import { getBookmarkletHref } from "./bookmarklet";
import {
  formatDisplayFileName,
  HedgeSelectionMetricElements,
  renderHedgeTable,
  renderTradesTable,
  updateExecutiveMetrics,
  updateHedgeExecutiveMetrics,
  updateHedgeSelectionMetrics,
} from "./dom";
import { calculateSelectedHedgeMetrics, exportHedgeReportToCsv, matchHedgeTrades } from "./hedge";
import type {
  CheckerNetwork,
  CheckerSummaryMetrics,
  HedgePair,
  HedgeSummaryMetrics,
  ImportedTradesResult,
  LighterTrade,
  ParsedTradeView,
  StitchedTradesResult,
  UnhedgedTrade,
} from "./types";

export class CheckerController {
  // Mode: "solo" (single account) vs "hedge" (RH vs Core)
  private mode: "solo" | "hedge" = "solo";

  // Solo mode state
  private network: CheckerNetwork = "rh";
  private resolvedAccountIndex: number | null = null;
  private soloAccountIndices: number[] = [];
  private soloBatches: ImportedTradesResult[] = [];
  private soloStitched: StitchedTradesResult | null = null;
  private resolvedL1Address: string | null = null;
  private rawTrades: LighterTrade[] = [];
  private parsedTrades: ParsedTradeView[] = [];
  private filteredTrades: ParsedTradeView[] = [];
  private summaryMetrics: CheckerSummaryMetrics | null = null;
  private marketMap: Map<number, string> = new Map();
  private activeTab: "table" | "json" = "table";
  private searchQuery = "";

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
  private filteredHedgePairs: HedgePair[] = [];
  private filteredUnhedgedTrades: UnhedgedTrade[] = [];
  private hedgeMetrics: HedgeSummaryMetrics | null = null;
  private hedgeFilterTab: "all" | "unhedged" = "all";
  private hedgeSearchQuery = "";
  private rhMarketMap: Map<number, string> = getStaticMarketMap("rh");
  private coreMarketMap: Map<number, string> = getStaticMarketMap("mainnet");

  // Mode Switcher Elements
  private modeBtnSolo: HTMLButtonElement | null = null;
  private modeBtnHedge: HTMLButtonElement | null = null;
  private modeDescription: HTMLElement | null = null;
  private soloViewWrapper: HTMLElement | null = null;
  private hedgeViewWrapper: HTMLElement | null = null;

  // Bookmarklet DOM Elements
  private bookmarkletLink: HTMLAnchorElement | null = null;
  private copyBookmarkletBtn: HTMLButtonElement | null = null;
  private modalBookmarkletLink: HTMLAnchorElement | null = null;
  private modalCopyBookmarkletBtn: HTMLButtonElement | null = null;

  // Export Help Modal
  private exportModal: HTMLElement | null = null;
  private openExportHelpEmptyBtn: HTMLElement | null = null;
  private openExportHelpLoadedBtn: HTMLElement | null = null;
  private openExportHelpHedgeBtn: HTMLElement | null = null;
  private closeModalBtn: HTMLButtonElement | null = null;
  private dismissModalBtn: HTMLButtonElement | null = null;

  // Solo Two-State Panels
  private emptyStatePanel: HTMLElement | null = null;
  private loadedToolbar: HTMLElement | null = null;
  private loadedFileName: HTMLElement | null = null;
  private loadedFileDetails: HTMLElement | null = null;
  private loadedFileNetwork: HTMLElement | null = null;
  private reuploadBtn: HTMLButtonElement | null = null;
  private btnAddFilesSolo: HTMLButtonElement | null = null;
  private btnPasteJsonSolo: HTMLButtonElement | null = null;
  private btnPasteJsonLoadedSolo: HTMLButtonElement | null = null;
  private btnPasteClipboardSoloBox: HTMLButtonElement | null = null;
  private btnBrowseFileEmptyBox: HTMLButtonElement | null = null;
  private browseFileEmptyBtn: HTMLElement | null = null;
  private dropzone: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private downloadBtn: HTMLButtonElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private clearBtn: HTMLButtonElement | null = null;

  // Paste Modal Elements
  private pasteModal: HTMLElement | null = null;
  private btnClosePasteModal: HTMLButtonElement | null = null;
  private btnDismissPasteModal: HTMLButtonElement | null = null;
  private btnSubmitPasteJson: HTMLButtonElement | null = null;
  private textareaPasteJson: HTMLTextAreaElement | null = null;
  private selectPasteTarget: HTMLSelectElement | null = null;
  private pasteTargetWrapper: HTMLElement | null = null;

  // Solo Table & Results
  private tabTableBtn: HTMLButtonElement | null = null;
  private tabJsonBtn: HTMLButtonElement | null = null;
  private tableContainer: HTMLElement | null = null;
  private jsonContainer: HTMLElement | null = null;
  private tableBody: HTMLTableSectionElement | null = null;
  private jsonPre: HTMLPreElement | null = null;
  private searchFilterInput: HTMLInputElement | null = null;
  private tradeCountNotice: HTMLElement | null = null;

  // Solo Metric Elements
  private metricElements = {
    accountBadge: null as HTMLElement | null,
    networkBadge: null as HTMLElement | null,
    tradesCount: null as HTMLElement | null,
    totalVolume: null as HTMLElement | null,
    realizedPnl: null as HTMLElement | null,
    totalFees: null as HTMLElement | null,
    dateRange: null as HTMLElement | null,
  };

  // Status Notification Card (shared)
  private statusCard: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;
  private statusDot: HTMLElement | null = null;
  private statusCountdown: HTMLElement | null = null;
  private closeStatusBtn: HTMLButtonElement | null = null;
  private statusTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private statusIntervalId: ReturnType<typeof setInterval> | null = null;

  // Hedge Lead Strip Elements
  private hedgeMetricElements = {
    accountsBadge: null as HTMLElement | null,
    pairsCount: null as HTMLElement | null,
    hedgedVolume: null as HTMLElement | null,
    netPnl: null as HTMLElement | null,
    pnlBps: null as HTMLElement | null,
    slippage: null as HTMLElement | null,
    fees: null as HTMLElement | null,
    unhedgedCount: null as HTMLElement | null,
  };

  // Hedge Upload & Toolbar Elements
  private hedgeEmptyStatePanel: HTMLElement | null = null;
  private hedgeLoadedToolbar: HTMLElement | null = null;
  private dropzoneRh: HTMLElement | null = null;
  private dropzoneCore: HTMLElement | null = null;
  private fileInputRh: HTMLInputElement | null = null;
  private fileInputCore: HTMLInputElement | null = null;
  private btnBrowseRhFile: HTMLButtonElement | null = null;
  private btnBrowseCoreFile: HTMLButtonElement | null = null;
  private btnAddRhFile: HTMLButtonElement | null = null;
  private btnAddCoreFile: HTMLButtonElement | null = null;
  private btnPasteRhBox: HTMLButtonElement | null = null;
  private btnPasteCoreBox: HTMLButtonElement | null = null;
  private btnAddRhFileLoaded: HTMLButtonElement | null = null;
  private btnAddCoreFileLoaded: HTMLButtonElement | null = null;
  private btnPasteRhLoaded: HTMLButtonElement | null = null;
  private btnPasteCoreLoaded: HTMLButtonElement | null = null;
  private statusRhFile: HTMLElement | null = null;
  private statusCoreFile: HTMLElement | null = null;
  private labelRhAccount: HTMLElement | null = null;
  private labelCoreAccount: HTMLElement | null = null;
  private btnClearRh: HTMLButtonElement | null = null;
  private btnClearCore: HTMLButtonElement | null = null;
  private loadedRhFileName: HTMLElement | null = null;
  private loadedCoreFileName: HTMLElement | null = null;
  private btnHedgeExportCsv: HTMLButtonElement | null = null;
  private btnHedgeClear: HTMLButtonElement | null = null;
  private hedgeBookmarkletLink: HTMLAnchorElement | null = null;
  private copyBookmarkletHedgeBtn: HTMLButtonElement | null = null;
  private openExportHelpHedgeEmptyBtn: HTMLButtonElement | null = null;

  // Hedge Table & Results Elements
  private tabBtnHedgeAll: HTMLButtonElement | null = null;
  private tabBtnHedgeUnhedged: HTMLButtonElement | null = null;
  private hedgeAggregateMode: "aggregated" | "raw" = "aggregated";
  private btnHedgeModeAggregated: HTMLButtonElement | null = null;
  private btnHedgeModeRaw: HTMLButtonElement | null = null;
  private hedgeCountNotice: HTMLElement | null = null;
  private inputHedgeSearchFilter: HTMLInputElement | null = null;
  private hedgeTableBody: HTMLTableSectionElement | null = null;

  // Hedge Row Selection State & Elements
  private selectedHedgeRowIds: Set<string> = new Set();
  private lastClickedHedgeRowId: string | null = null;
  private hedgeSelectionCard: HTMLElement | null = null;
  private btnDeselectAllHedge: HTMLButtonElement | null = null;
  private checkAllHedge: HTMLInputElement | null = null;
  private hedgeSelectionMetricElements: HedgeSelectionMetricElements = {
    selectionCard: null,
    countBadge: null,
    pairsCount: null,
    volume: null,
    netPnl: null,
    pnlBps: null,
    slippage: null,
    fees: null,
    unhedgedCount: null,
  };

  public init(): void {
    this.cacheDomElements();
    this.initBookmarkletSection();
    this.bindEvents();
    this.bindHedgeEvents();
    this.updateExecutiveSummary();
    this.updateHedgeExecutiveSummary();
    this.loadMarketDefinitions();
  }

  private cacheDomElements(): void {
    // Mode Switcher
    this.modeBtnSolo = document.querySelector("#modeBtnSolo");
    this.modeBtnHedge = document.querySelector("#modeBtnHedge");
    this.modeDescription = document.querySelector("#modeDescription");
    this.soloViewWrapper = document.querySelector("#soloViewWrapper");
    this.hedgeViewWrapper = document.querySelector("#hedgeViewWrapper");

    // Bookmarklet & Modal
    this.bookmarkletLink = document.querySelector("#bookmarkletLink");
    this.copyBookmarkletBtn = document.querySelector("#btnCopyBookmarklet");
    this.modalBookmarkletLink = document.querySelector("#modalBookmarkletLink");
    this.modalCopyBookmarkletBtn = document.querySelector("#btnModalCopyBookmarklet");
    this.exportModal = document.querySelector("#exportModal");
    this.openExportHelpEmptyBtn = document.querySelector("#btnOpenExportHelpEmpty");
    this.openExportHelpLoadedBtn = document.querySelector("#btnOpenExportHelpLoaded");
    this.openExportHelpHedgeBtn = document.querySelector("#btnOpenExportHelpHedge");
    this.closeModalBtn = document.querySelector("#btnCloseModal");
    this.dismissModalBtn = document.querySelector("#btnDismissModal");

    // Solo Panels
    this.emptyStatePanel = document.querySelector("#emptyStatePanel");
    this.loadedToolbar = document.querySelector("#loadedToolbar");
    this.loadedFileName = document.querySelector("#loadedFileName");
    this.loadedFileDetails = document.querySelector("#loadedFileDetails");
    this.loadedFileNetwork = document.querySelector("#loadedFileNetwork");
    this.reuploadBtn = document.querySelector("#btnReupload");
    this.btnAddFilesSolo = document.querySelector("#btnAddFilesSolo");
    this.btnPasteJsonSolo = document.querySelector("#btnPasteJsonSolo");
    this.btnPasteJsonLoadedSolo = document.querySelector("#btnPasteJsonLoadedSolo");
    this.btnPasteClipboardSoloBox = document.querySelector("#btnPasteClipboardSoloBox");
    this.btnBrowseFileEmptyBox = document.querySelector("#btnBrowseFileEmptyBox");
    this.browseFileEmptyBtn = document.querySelector("#btnBrowseFileEmpty");
    this.dropzone = document.querySelector("#jsonDropzone");
    this.fileInput = document.querySelector("#jsonFileInput");
    this.downloadBtn = document.querySelector("#btnDownloadJson");
    this.copyBtn = document.querySelector("#btnCopyJson");
    this.clearBtn = document.querySelector("#btnClearTrades");

    // Paste Modal Elements
    this.pasteModal = document.querySelector("#pasteModal");
    this.btnClosePasteModal = document.querySelector("#btnClosePasteModal");
    this.btnDismissPasteModal = document.querySelector("#btnDismissPasteModal");
    this.btnSubmitPasteJson = document.querySelector("#btnSubmitPasteJson");
    this.textareaPasteJson = document.querySelector("#textareaPasteJson");
    this.selectPasteTarget = document.querySelector("#selectPasteTarget");
    this.pasteTargetWrapper = document.querySelector("#pasteTargetWrapper");

    // Solo Table & Results
    this.tabTableBtn = document.querySelector("#tabBtnTable");
    this.tabJsonBtn = document.querySelector("#tabBtnJson");
    this.tableContainer = document.querySelector("#tableContainer");
    this.jsonContainer = document.querySelector("#jsonContainer");
    this.tableBody = document.querySelector("#tradesTableBody");
    this.jsonPre = document.querySelector("#jsonViewerPre");
    this.searchFilterInput = document.querySelector("#inputSearchFilter");
    this.tradeCountNotice = document.querySelector("#tradeCountNotice");

    // Solo Metric Elements
    this.metricElements = {
      accountBadge: document.querySelector("#leadAccountBadge"),
      networkBadge: document.querySelector("#leadNetworkBadge"),
      tradesCount: document.querySelector("#leadTradesCount"),
      totalVolume: document.querySelector("#leadTotalVolume"),
      realizedPnl: document.querySelector("#leadRealizedPnl"),
      totalFees: document.querySelector("#leadTotalFees"),
      dateRange: document.querySelector("#leadDateRange"),
    };

    // Shared Status Notification Card
    this.statusCard = document.querySelector("#statusCard");
    this.statusText = document.querySelector("#statusText");
    this.statusDot = document.querySelector("#statusDot");
    this.statusCountdown = document.querySelector("#statusCountdown");
    this.closeStatusBtn = document.querySelector("#btnCloseStatus");

    // Hedge Lead Strip Elements
    this.hedgeMetricElements = {
      accountsBadge: document.querySelector("#leadHedgeAccountsBadge"),
      pairsCount: document.querySelector("#leadHedgePairsCount"),
      hedgedVolume: document.querySelector("#leadHedgeVolume"),
      netPnl: document.querySelector("#leadHedgeNetPnl"),
      pnlBps: document.querySelector("#leadHedgePnlBps"),
      slippage: document.querySelector("#leadHedgeSlippage"),
      fees: document.querySelector("#leadHedgeFees"),
      unhedgedCount: document.querySelector("#leadHedgeUnhedgedCount"),
    };

    // Hedge Upload & Toolbar Elements
    this.hedgeEmptyStatePanel = document.querySelector("#hedgeEmptyStatePanel");
    this.hedgeLoadedToolbar = document.querySelector("#hedgeLoadedToolbar");
    this.dropzoneRh = document.querySelector("#dropzoneRh");
    this.dropzoneCore = document.querySelector("#dropzoneCore");
    this.fileInputRh = document.querySelector("#fileInputRh");
    this.fileInputCore = document.querySelector("#fileInputCore");
    this.btnBrowseRhFile = document.querySelector("#btnBrowseRhFile");
    this.btnBrowseCoreFile = document.querySelector("#btnBrowseCoreFile");
    this.btnAddRhFile = document.querySelector("#btnAddRhFile");
    this.btnAddCoreFile = document.querySelector("#btnAddCoreFile");
    this.btnPasteRhBox = document.querySelector("#btnPasteRhBox");
    this.btnPasteCoreBox = document.querySelector("#btnPasteCoreBox");
    this.btnAddRhFileLoaded = document.querySelector("#btnAddRhFileLoaded");
    this.btnAddCoreFileLoaded = document.querySelector("#btnAddCoreFileLoaded");
    this.btnPasteRhLoaded = document.querySelector("#btnPasteRhLoaded");
    this.btnPasteCoreLoaded = document.querySelector("#btnPasteCoreLoaded");
    this.statusRhFile = document.querySelector("#statusRhFile");
    this.statusCoreFile = document.querySelector("#statusCoreFile");
    this.labelRhAccount = document.querySelector("#labelRhAccount");
    this.labelCoreAccount = document.querySelector("#labelCoreAccount");
    this.btnClearRh = document.querySelector("#btnClearRh");
    this.btnClearCore = document.querySelector("#btnClearCore");
    this.loadedRhFileName = document.querySelector("#loadedRhFileName");
    this.loadedCoreFileName = document.querySelector("#loadedCoreFileName");
    this.btnHedgeExportCsv = document.querySelector("#btnHedgeExportCsv");
    this.btnHedgeClear = document.querySelector("#btnHedgeClear");
    this.hedgeBookmarkletLink = document.querySelector("#hedgeBookmarkletLink");
    this.copyBookmarkletHedgeBtn = document.querySelector("#btnCopyBookmarkletHedge");
    this.openExportHelpHedgeEmptyBtn = document.querySelector("#btnOpenExportHelpHedgeEmpty");

    // Hedge Table & Results Elements
    this.tabBtnHedgeAll = document.querySelector("#tabBtnHedgeAll");
    this.tabBtnHedgeUnhedged = document.querySelector("#tabBtnHedgeUnhedged");
    this.btnHedgeModeAggregated = document.querySelector("#btnHedgeModeAggregated");
    this.btnHedgeModeRaw = document.querySelector("#btnHedgeModeRaw");
    this.hedgeCountNotice = document.querySelector("#hedgeCountNotice");
    this.inputHedgeSearchFilter = document.querySelector("#inputHedgeSearchFilter");
    this.hedgeTableBody = document.querySelector("#hedgeTableBody");

    // Hedge Selection Card Elements
    this.hedgeSelectionCard = document.querySelector("#hedgeSelectionCard");
    this.btnDeselectAllHedge = document.querySelector("#btnDeselectAllHedge");
    this.checkAllHedge = document.querySelector("#checkAllHedge");
    this.hedgeSelectionMetricElements = {
      selectionCard: this.hedgeSelectionCard,
      countBadge: document.querySelector("#selectedCountBadge"),
      pairsCount: document.querySelector("#selectedPairsCount"),
      volume: document.querySelector("#selectedVolume"),
      netPnl: document.querySelector("#selectedNetPnl"),
      pnlBps: document.querySelector("#selectedPnlBps"),
      slippage: document.querySelector("#selectedSlippage"),
      fees: document.querySelector("#selectedFees"),
      unhedgedCount: document.querySelector("#selectedUnhedgedCount"),
    };
  }

  private handleBookmarkletClick(e: MouseEvent): void {
    e.preventDefault();
    alert(
      "Drag this button directly to your browser's Bookmarks bar (or click 'Copy Code') to use it on robinhoodchain.lighter.xyz or app.lighter.xyz!",
    );
  }

  private initBookmarkletSection(): void {
    const bookmarkletHref = getBookmarkletHref();

    if (this.bookmarkletLink) {
      this.bookmarkletLink.href = bookmarkletHref;
      this.bookmarkletLink.addEventListener("click", (e) => this.handleBookmarkletClick(e));
    }

    if (this.hedgeBookmarkletLink) {
      this.hedgeBookmarkletLink.href = bookmarkletHref;
      this.hedgeBookmarkletLink.addEventListener("click", (e) => this.handleBookmarkletClick(e));
    }

    if (this.modalBookmarkletLink) {
      this.modalBookmarkletLink.href = bookmarkletHref;
      this.modalBookmarkletLink.addEventListener("click", (e) => this.handleBookmarkletClick(e));
    }
  }

  private async loadMarketDefinitions(): Promise<void> {
    try {
      const [rhMap, coreMap] = await Promise.all([fetchMarketMap("rh"), fetchMarketMap("mainnet")]);
      this.rhMarketMap = rhMap.size > 0 ? rhMap : getStaticMarketMap("rh");
      this.coreMarketMap = coreMap.size > 0 ? coreMap : getStaticMarketMap("mainnet");
      this.marketMap = this.network === "rh" ? this.rhMarketMap : this.coreMarketMap;

      if (this.rawTrades.length > 0 && this.resolvedAccountIndex !== null) {
        this.recalculateAndRender();
      }
      if (this.rhRawTrades.length > 0 && this.coreRawTrades.length > 0) {
        this.recalculateAndRenderHedge();
      }
    } catch {}
  }

  private bindEvents(): void {
    // 0. Mode switch
    this.modeBtnSolo?.addEventListener("click", () => this.switchMode("solo"));
    this.modeBtnHedge?.addEventListener("click", () => this.switchMode("hedge"));

    // 1. Bookmarklet copy
    this.copyBookmarkletBtn?.addEventListener("click", () => {
      if (this.copyBookmarkletBtn) {
        copyToClipboard(getBookmarkletHref(), this.copyBookmarkletBtn, "Copy Code");
      }
    });

    this.modalCopyBookmarkletBtn?.addEventListener("click", () => {
      if (this.modalCopyBookmarkletBtn) {
        copyToClipboard(getBookmarkletHref(), this.modalCopyBookmarkletBtn, "Copy Code");
      }
    });

    // 2. Export instructions modal open / close
    this.openExportHelpEmptyBtn?.addEventListener("click", () => this.openExportModal());
    this.openExportHelpLoadedBtn?.addEventListener("click", () => this.openExportModal());
    this.openExportHelpHedgeBtn?.addEventListener("click", () => this.openExportModal());
    this.closeModalBtn?.addEventListener("click", () => this.closeExportModal());
    this.dismissModalBtn?.addEventListener("click", () => this.closeExportModal());

    this.exportModal?.addEventListener("click", (e) => {
      if (e.target === this.exportModal) {
        this.closeExportModal();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        this.exportModal &&
        !this.exportModal.classList.contains("hidden")
      ) {
        this.closeExportModal();
      } else if (
        e.key === "Escape" &&
        this.pasteModal &&
        !this.pasteModal.classList.contains("hidden")
      ) {
        this.closePasteModal();
      } else if (e.key === "Escape" && this.selectedHedgeRowIds.size > 0) {
        this.selectedHedgeRowIds.clear();
        this.lastClickedHedgeRowId = null;
        this.onHedgeSelectionChanged();
      }
    });

    // 3. Solo file upload / browse events
    this.browseFileEmptyBtn?.addEventListener("click", () => {
      if (this.fileInput) this.fileInput.value = "";
      this.fileInput?.click();
    });

    this.reuploadBtn?.addEventListener("click", () => {
      this.soloBatches = [];
      if (this.fileInput) this.fileInput.value = "";
      this.fileInput?.click();
    });

    this.btnAddFilesSolo?.addEventListener("click", () => {
      if (this.fileInput) this.fileInput.value = "";
      this.fileInput?.click();
    });

    this.btnPasteJsonSolo?.addEventListener("click", () =>
      this.pasteFromClipboardOrOpenModal("rh"),
    );
    this.btnPasteJsonLoadedSolo?.addEventListener("click", () =>
      this.pasteFromClipboardOrOpenModal("rh"),
    );
    this.btnPasteClipboardSoloBox?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.pasteFromClipboardOrOpenModal("rh");
    });
    this.btnBrowseFileEmptyBox?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.fileInput) this.fileInput.value = "";
      this.fileInput?.click();
    });

    this.fileInput?.addEventListener("change", (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        this.handleFileUploads(Array.from(files), true);
      }
    });

    if (this.dropzone) {
      this.dropzone.addEventListener("click", () => {
        this.fileInput?.click();
      });

      this.dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.dropzone?.classList.add("border-terminal-emerald", "bg-terminal-emerald/5");
      });

      this.dropzone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.dropzone?.classList.remove("border-terminal-emerald", "bg-terminal-emerald/5");
      });

      this.dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.dropzone?.classList.remove("border-terminal-emerald", "bg-terminal-emerald/5");
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
          this.handleFileUploads(Array.from(files), true);
        }
      });
    }

    // Paste Modal Controls
    this.btnClosePasteModal?.addEventListener("click", () => this.closePasteModal());
    this.btnDismissPasteModal?.addEventListener("click", () => this.closePasteModal());
    this.btnSubmitPasteJson?.addEventListener("click", () => this.handlePasteSubmit());
    this.pasteModal?.addEventListener("click", (e) => {
      if (e.target === this.pasteModal) {
        this.closePasteModal();
      }
    });

    // 4. Status card close button
    this.closeStatusBtn?.addEventListener("click", () => {
      this.clearStatusTimers();
      this.statusCard?.classList.add("hidden");
    });

    // 5. Solo Action Buttons
    this.downloadBtn?.addEventListener("click", () => this.downloadJson());
    this.copyBtn?.addEventListener("click", () => this.copyJson());
    this.clearBtn?.addEventListener("click", () => this.clearAll());

    // 6. Solo Tabs Switcher
    this.tabTableBtn?.addEventListener("click", () => this.switchTab("table"));
    this.tabJsonBtn?.addEventListener("click", () => this.switchTab("json"));

    // 7. Solo Search filter
    this.searchFilterInput?.addEventListener("input", (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase().trim();
      this.applyFilter();
    });
  }

  private bindHedgeEvents(): void {
    // Bookmarklet copy and instructions
    this.copyBookmarkletHedgeBtn?.addEventListener("click", () => {
      if (this.copyBookmarkletHedgeBtn) {
        copyToClipboard(getBookmarkletHref(), this.copyBookmarkletHedgeBtn, "Copy Code");
      }
    });

    this.openExportHelpHedgeEmptyBtn?.addEventListener("click", () => this.openExportModal());

    // Browse buttons
    this.btnBrowseRhFile?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.fileInputRh) this.fileInputRh.value = "";
      this.fileInputRh?.click();
    });
    this.btnBrowseCoreFile?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.fileInputCore) this.fileInputCore.value = "";
      this.fileInputCore?.click();
    });

    this.btnAddRhFile?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.fileInputRh) this.fileInputRh.value = "";
      this.fileInputRh?.click();
    });
    this.btnAddCoreFile?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.fileInputCore) this.fileInputCore.value = "";
      this.fileInputCore?.click();
    });
    this.btnAddRhFileLoaded?.addEventListener("click", () => {
      if (this.fileInputRh) this.fileInputRh.value = "";
      this.fileInputRh?.click();
    });
    this.btnAddCoreFileLoaded?.addEventListener("click", () => {
      if (this.fileInputCore) this.fileInputCore.value = "";
      this.fileInputCore?.click();
    });
    this.btnPasteRhBox?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.pasteFromClipboardOrOpenModal("rh");
    });
    this.btnPasteCoreBox?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.pasteFromClipboardOrOpenModal("core");
    });
    this.btnPasteRhLoaded?.addEventListener("click", () =>
      this.pasteFromClipboardOrOpenModal("rh"),
    );
    this.btnPasteCoreLoaded?.addEventListener("click", () =>
      this.pasteFromClipboardOrOpenModal("core"),
    );

    // Clear individual slots
    this.btnClearRh?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clearHedgeSlot("rh");
    });
    this.btnClearCore?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clearHedgeSlot("core");
    });

    // File input changes
    this.fileInputRh?.addEventListener("change", (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        this.processHedgeUploadedFiles(Array.from(files), "rh");
      }
    });

    this.fileInputCore?.addEventListener("change", (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        this.processHedgeUploadedFiles(Array.from(files), "core");
      }
    });

    // Drag and drop for RH slot
    this.setupHedgeDropzone(this.dropzoneRh, "rh");
    this.setupHedgeDropzone(this.dropzoneCore, "core");

    // Hedge Actions
    this.btnHedgeExportCsv?.addEventListener("click", () => this.downloadHedgeCsv());
    this.btnHedgeClear?.addEventListener("click", () => this.clearHedge());

    // Hedge table tabs
    this.tabBtnHedgeAll?.addEventListener("click", () => this.switchHedgeFilterTab("all"));
    this.tabBtnHedgeUnhedged?.addEventListener("click", () =>
      this.switchHedgeFilterTab("unhedged"),
    );

    // Hedge aggregation mode (VWAP Orders vs Raw Fills)
    this.btnHedgeModeAggregated?.addEventListener("click", () =>
      this.switchHedgeAggregateMode("aggregated"),
    );
    this.btnHedgeModeRaw?.addEventListener("click", () => this.switchHedgeAggregateMode("raw"));

    // Hedge search filter
    this.inputHedgeSearchFilter?.addEventListener("input", (e) => {
      this.hedgeSearchQuery = (e.target as HTMLInputElement).value.toLowerCase().trim();
      this.applyHedgeFilter();
    });

    // Hedge selection events
    this.checkAllHedge?.addEventListener("click", () => this.toggleSelectAllVisibleHedge());
    this.btnDeselectAllHedge?.addEventListener("click", () => {
      this.selectedHedgeRowIds.clear();
      this.lastClickedHedgeRowId = null;
      this.onHedgeSelectionChanged();
    });
    this.hedgeTableBody?.addEventListener("click", (e) => this.handleHedgeTableClick(e));
  }

  private setupHedgeDropzone(dropzone: HTMLElement | null, defaultSlot: "rh" | "core"): void {
    if (!dropzone) return;

    const highlightBorder =
      defaultSlot === "rh" ? "border-terminal-accent" : "border-terminal-emerald";
    const highlightBg =
      defaultSlot === "rh" ? "bg-terminal-accent/10" : "bg-terminal-emerald/10";

    dropzone.addEventListener("click", () => {
      if (defaultSlot === "rh") this.fileInputRh?.click();
      else this.fileInputCore?.click();
    });

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add(highlightBorder, highlightBg);
    });

    dropzone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.relatedTarget && dropzone.contains(e.relatedTarget as Node)) {
        return;
      }
      dropzone.classList.remove(highlightBorder, highlightBg);
    });

    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove(highlightBorder, highlightBg);
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        this.processHedgeUploadedFiles(Array.from(files), defaultSlot);
      }
    });
  }

  private switchMode(newMode: "solo" | "hedge"): void {
    this.mode = newMode;
    if (newMode === "solo") {
      this.modeBtnSolo?.classList.add(
        "bg-terminal-surface",
        "text-white",
        "font-bold",
        "border",
        "border-terminal-border",
      );
      this.modeBtnSolo?.classList.remove("text-terminal-muted", "bg-transparent");
      this.modeBtnHedge?.classList.remove(
        "bg-terminal-surface",
        "text-white",
        "font-bold",
        "border",
        "border-terminal-border",
      );
      this.modeBtnHedge?.classList.add("text-terminal-muted", "bg-transparent");

      this.soloViewWrapper?.classList.remove("hidden");
      this.hedgeViewWrapper?.classList.add("hidden");

      if (this.modeDescription) {
        this.modeDescription.textContent = "Single account trade analysis (RH or Core)";
      }
    } else {
      this.modeBtnHedge?.classList.add(
        "bg-terminal-surface",
        "text-white",
        "font-bold",
        "border",
        "border-terminal-border",
      );
      this.modeBtnHedge?.classList.remove("text-terminal-muted", "bg-transparent");
      this.modeBtnSolo?.classList.remove(
        "bg-terminal-surface",
        "text-white",
        "font-bold",
        "border",
        "border-terminal-border",
      );
      this.modeBtnSolo?.classList.add("text-terminal-muted", "bg-transparent");

      this.hedgeViewWrapper?.classList.remove("hidden");
      this.soloViewWrapper?.classList.add("hidden");

      if (this.modeDescription) {
        this.modeDescription.textContent =
          "Round-trip hedge audit & slippage comparison (RH vs Core)";
      }
    }
  }

  private openExportModal(): void {
    this.exportModal?.classList.remove("hidden");
  }

  private closeExportModal(): void {
    this.exportModal?.classList.add("hidden");
  }

  // ==========================================
  // SOLO MODE IMPLEMENTATION
  // ==========================================

  public async handleFileUpload(file: File): Promise<void> {
    await this.handleFileUploads([file], false);
  }

  public async handleFileUploads(files: File[], append = false): Promise<void> {
    if (!append) {
      this.soloBatches = [];
    }

    const newBatches: ImportedTradesResult[] = [];
    for (const file of files) {
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
        if (!text.trim()) {
          this.showStatusError(`Skipped "${file.name}": file is empty.`);
          continue;
        }

        const result = parseImportedTradesJson(text, file.name);
        newBatches.push(result);
      } catch (err: any) {
        console.error("JSON Import Error:", err);
        this.showStatusError(`Error reading "${file.name}": ${err.message || String(err)}`);
      }
    }

    if (newBatches.length === 0) return;

    this.soloBatches = [...this.soloBatches, ...newBatches];
    this.applySoloBatches();
  }

  private applySoloBatches(): void {
    if (this.soloBatches.length === 0) {
      this.clearAll();
      return;
    }

    const stitched = stitchTradeBatches(this.soloBatches);
    this.soloStitched = stitched;
    this.rawTrades = sortTradesChronologicalDesc(stitched.trades);
    this.soloAccountIndices = stitched.accountIndices;
    this.resolvedAccountIndex =
      stitched.accountIndices.length > 0 ? stitched.accountIndices[0] : null;

    if (stitched.network) {
      this.network = stitched.network;
      this.marketMap = this.network === "rh" ? this.rhMarketMap : this.coreMarketMap;
    }
    if (stitched.l1Address) {
      this.resolvedL1Address = stitched.l1Address;
    }

    if (this.loadedFileName) {
      if (this.soloBatches.length === 1) {
        const rawName = this.soloBatches[0].fileName || "imported.json";
        this.loadedFileName.textContent = formatDisplayFileName(rawName, 32);
        this.loadedFileName.title = rawName;
      } else {
        this.loadedFileName.textContent = `${this.soloBatches.length} files stitched (${this.rawTrades.length.toLocaleString()} trades)`;
        this.loadedFileName.title = this.soloBatches.map((b) => b.fileName || "file").join(", ");
      }
    }

    if (this.loadedFileDetails) {
      const accStr =
        this.soloAccountIndices.length > 0
          ? `Accounts: ${this.soloAccountIndices.map((a) => `#${a}`).join(", ")}`
          : "Single Account";
      const filesStr = `${this.soloBatches.length} file${this.soloBatches.length > 1 ? "s" : ""}`;
      this.loadedFileDetails.textContent = `${filesStr} · ${accStr}`;
    }

    if (this.loadedFileNetwork) {
      this.loadedFileNetwork.textContent = this.network.toUpperCase();
    }

    this.emptyStatePanel?.classList.add("hidden");
    this.loadedToolbar?.classList.remove("hidden");

    this.recalculateAndRender();

    const accBadge =
      this.soloAccountIndices.length > 0
        ? `Account(s) ${this.soloAccountIndices.map((a) => `#${a}`).join(", ")}`
        : "Trades";
    this.showStatusSuccess(
      `Stitched ${this.rawTrades.length.toLocaleString()} deduplicated trades across ${this.soloBatches.length} file(s) (${accBadge}).`,
    );
  }

  private recalculateAndRender(): void {
    sortTradesChronologicalDesc(this.rawTrades);
    const accQuery =
      this.soloAccountIndices.length > 0
        ? this.soloAccountIndices
        : (this.resolvedAccountIndex ?? 0);

    this.parsedTrades = this.rawTrades.map((t) => parseTradeForView(t, accQuery, this.marketMap));
    sortParsedTradesChronologicalDesc(this.parsedTrades);
    this.summaryMetrics = calculateTradeMetrics(this.rawTrades, accQuery);

    this.updateExecutiveSummary();
    this.applyFilter();
    this.updateJsonViewer();

    const hasData = this.rawTrades.length > 0;
    if (this.downloadBtn) this.downloadBtn.disabled = !hasData;
    if (this.copyBtn) this.copyBtn.disabled = !hasData;
    if (this.clearBtn) this.clearBtn.disabled = !hasData;
  }

  private updateExecutiveSummary(): void {
    updateExecutiveMetrics(
      this.summaryMetrics,
      this.metricElements,
      this.resolvedAccountIndex,
      this.network,
      this.soloAccountIndices,
    );
  }

  private applyFilter(): void {
    if (!this.searchQuery) {
      this.filteredTrades = this.parsedTrades;
    } else {
      const q = this.searchQuery;
      this.filteredTrades = this.parsedTrades.filter(
        (t) =>
          t.marketSymbol.toLowerCase().includes(q) ||
          t.side.toLowerCase().includes(q) ||
          t.role.toLowerCase().includes(q) ||
          t.type.toLowerCase().includes(q) ||
          t.tradeId.includes(q) ||
          t.txHash.toLowerCase().includes(q),
      );
    }

    if (this.tableBody) {
      renderTradesTable(this.tableBody, this.filteredTrades);
    }

    if (this.tradeCountNotice) {
      if (this.searchQuery && this.parsedTrades.length > 0) {
        this.tradeCountNotice.textContent = `Showing ${this.filteredTrades.length} of ${this.parsedTrades.length} trades`;
        this.tradeCountNotice.className = "text-[11px] text-terminal-accent font-medium";
      } else {
        this.tradeCountNotice.textContent = "";
      }
    }
  }

  private updateJsonViewer(): void {
    if (!this.jsonPre) return;
    if (this.rawTrades.length === 0) {
      this.jsonPre.textContent = "// Raw JSON payload will appear here after importing trades...";
      return;
    }

    const payload = prepareExportPayload(
      this.rawTrades,
      this.network,
      this.resolvedAccountIndex ?? 0,
      this.resolvedL1Address || undefined,
    );

    this.jsonPre.textContent = JSON.stringify(payload, null, 2);
  }

  private switchTab(tab: "table" | "json"): void {
    this.activeTab = tab;
    if (tab === "table") {
      this.tabTableBtn?.classList.add("bg-terminal-surface", "text-white", "font-semibold");
      this.tabTableBtn?.classList.remove("text-terminal-muted");
      this.tabJsonBtn?.classList.remove("bg-terminal-surface", "text-white", "font-semibold");
      this.tabJsonBtn?.classList.add("text-terminal-muted");

      if (this.tableContainer) this.tableContainer.classList.remove("hidden");
      if (this.jsonContainer) this.jsonContainer.classList.add("hidden");
    } else {
      this.tabJsonBtn?.classList.add("bg-terminal-surface", "text-white", "font-semibold");
      this.tabJsonBtn?.classList.remove("text-terminal-muted");
      this.tabTableBtn?.classList.remove("bg-terminal-surface", "text-white", "font-semibold");
      this.tabTableBtn?.classList.add("text-terminal-muted");

      if (this.jsonContainer) this.jsonContainer.classList.remove("hidden");
      if (this.tableContainer) this.tableContainer.classList.add("hidden");
    }
  }

  public downloadJson(): void {
    if (this.rawTrades.length === 0) return;

    const acc = this.resolvedAccountIndex ?? 0;
    const accQuery = this.soloAccountIndices.length > 0 ? this.soloAccountIndices : acc;
    const payload = prepareExportPayload(
      this.rawTrades,
      this.network,
      accQuery,
      this.resolvedL1Address || undefined,
    );

    const dateStr = new Date().toISOString().slice(0, 10);
    const accLabel =
      this.soloAccountIndices.length > 1
        ? `accs-${this.soloAccountIndices.join("-")}`
        : `acc${acc}`;
    const filename = `lighter-trades-${this.network}-${accLabel}-${dateStr}.json`;
    downloadJsonFile(payload, filename);
  }

  public copyJson(): void {
    if (this.rawTrades.length === 0 || !this.copyBtn) return;

    const acc = this.resolvedAccountIndex ?? 0;
    const accQuery = this.soloAccountIndices.length > 0 ? this.soloAccountIndices : acc;
    const payload = prepareExportPayload(
      this.rawTrades,
      this.network,
      accQuery,
      this.resolvedL1Address || undefined,
    );

    const jsonStr = JSON.stringify(payload, null, 2);
    copyToClipboard(jsonStr, this.copyBtn, "Copy JSON");
  }

  public clearAll(): void {
    this.soloBatches = [];
    this.soloStitched = null;
    this.soloAccountIndices = [];
    this.rawTrades = [];
    this.parsedTrades = [];
    this.filteredTrades = [];
    this.summaryMetrics = null;
    this.resolvedAccountIndex = null;
    this.resolvedL1Address = null;

    if (this.fileInput) {
      this.fileInput.value = "";
    }
    if (this.loadedFileName) {
      this.loadedFileName.textContent = "--";
    }
    if (this.loadedFileDetails) {
      this.loadedFileDetails.textContent = "";
    }
    if (this.loadedFileNetwork) {
      this.loadedFileNetwork.textContent = "--";
    }

    this.loadedToolbar?.classList.add("hidden");
    this.emptyStatePanel?.classList.remove("hidden");

    this.updateExecutiveSummary();
    this.applyFilter();
    this.updateJsonViewer();

    if (this.downloadBtn) this.downloadBtn.disabled = true;
    if (this.copyBtn) this.copyBtn.disabled = true;
    if (this.clearBtn) this.clearBtn.disabled = true;

    this.clearStatusTimers();
    if (this.statusCard) this.statusCard.classList.add("hidden");
  }

  // ==========================================
  // PASTE JSON MODAL IMPLEMENTATION
  // ==========================================

  public async pasteFromClipboardOrOpenModal(
    target: "auto" | "rh" | "core" = "auto",
  ): Promise<void> {
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.readText === "function"
      ) {
        const text = await navigator.clipboard.readText();
        const trimmed = text?.trim();
        if (trimmed && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
          try {
            const parsed = parseImportedTradesJson(trimmed, "clipboard.json");
            let slotName = "dataset";
            if (this.mode === "solo") {
              this.soloBatches = [...this.soloBatches, parsed];
              this.applySoloBatches();
              slotName = "Solo dataset";
            } else {
              let slot: "rh" | "core" = "rh";
              if (target === "rh") {
                slot = "rh";
              } else if (target === "core") {
                slot = "core";
              } else {
                if (parsed.network === "mainnet") {
                  slot = "core";
                } else if (parsed.network === "rh") {
                  slot = "rh";
                } else {
                  slot = this.rhRawTrades.length > 0 ? "core" : "rh";
                }
              }

              if (slot === "rh") {
                this.rhBatches = [...this.rhBatches, parsed];
              } else {
                this.coreBatches = [...this.coreBatches, parsed];
              }
              this.applyHedgeBatches();
              slotName = slot === "core" ? "Lighter Core" : "Robinhood (RH)";
            }

            this.showStatusSuccess(
              `Pasted and added ${parsed.trades.length} trades to ${slotName}!`,
            );
            return;
          } catch {
            this.openPasteModal(target);
            if (this.textareaPasteJson) {
              this.textareaPasteJson.value = trimmed;
            }
            return;
          }
        }
      }
    } catch {
      // Permission denied or reading clipboard blocked
    }

    this.openPasteModal(target);
  }

  public openPasteModal(target: "auto" | "rh" | "core" = "auto"): void {
    if (this.selectPasteTarget) {
      this.selectPasteTarget.value = target;
    }
    if (this.textareaPasteJson) {
      this.textareaPasteJson.value = "";
    }
    this.pasteModal?.classList.remove("hidden");
    setTimeout(() => {
      this.textareaPasteJson?.focus();
    }, 50);
  }

  public closePasteModal(): void {
    this.pasteModal?.classList.add("hidden");
    if (this.textareaPasteJson) {
      this.textareaPasteJson.value = "";
    }
  }

  public handlePasteSubmit(): void {
    const rawText = this.textareaPasteJson?.value?.trim();
    if (!rawText) {
      this.showStatusError("Please paste valid JSON before submitting.");
      return;
    }

    const target = (this.selectPasteTarget?.value as "auto" | "rh" | "core") || "auto";

    try {
      const parsed = parseImportedTradesJson(rawText, "pasted-response.json");
      this.closePasteModal();

      if (this.mode === "solo") {
        this.soloBatches = [...this.soloBatches, parsed];
        this.applySoloBatches();
      } else {
        let slot: "rh" | "core" = "rh";
        if (target === "rh") {
          slot = "rh";
        } else if (target === "core") {
          slot = "core";
        } else {
          if (parsed.network === "mainnet") {
            slot = "core";
          } else if (parsed.network === "rh") {
            slot = "rh";
          } else {
            slot = this.rhRawTrades.length > 0 ? "core" : "rh";
          }
        }

        if (slot === "rh") {
          this.rhBatches = [...this.rhBatches, parsed];
        } else {
          this.coreBatches = [...this.coreBatches, parsed];
        }
        this.applyHedgeBatches();

        const slotName = slot === "rh" ? "Robinhood (RH)" : "Lighter Core";
        this.showStatusSuccess(
          `Imported and added ${parsed.trades.length} trades to ${slotName}!`,
        );
      }
    } catch (err: any) {
      console.error("Paste JSON parsing error:", err);
      this.showStatusError(`Failed to parse pasted JSON: ${err.message || String(err)}`);
    }
  }

  // ==========================================
  // HEDGE MODE IMPLEMENTATION
  // ==========================================

  private async processHedgeUploadedFiles(
    files: File[],
    defaultSlot: "rh" | "core",
  ): Promise<void> {
    for (const file of files) {
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
        if (!text.trim()) {
          this.showStatusError(`Skipped "${file.name}": file is empty.`);
          continue;
        }

        const parsed = parseImportedTradesJson(text, file.name);

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
        this.showStatusError(`Error reading "${file.name}": ${err.message || String(err)}`);
      }
    }

    this.applyHedgeBatches();
  }

  private applyHedgeBatches(): void {
    if (this.rhBatches.length > 0) {
      const rhStitched = stitchTradeBatches(this.rhBatches);
      this.rhRawTrades = sortTradesChronologicalDesc(rhStitched.trades);
      this.rhAccountIndices = rhStitched.accountIndices;
      this.rhAccountIndex =
        rhStitched.accountIndices.length > 0 ? rhStitched.accountIndices[0] : null;

      if (this.statusRhFile) {
        const rawFileName = this.rhBatches[0].fileName || "RH JSON";
        const fileCountText =
          this.rhBatches.length === 1
            ? formatDisplayFileName(rawFileName, 22)
            : `${this.rhBatches.length} files`;
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
      }
      if (this.btnClearRh) this.btnClearRh.classList.remove("hidden");
      if (this.loadedRhFileName) {
        const rawFileName = this.rhBatches[0].fileName || "RH file";
        this.loadedRhFileName.textContent =
          this.rhBatches.length === 1
            ? formatDisplayFileName(rawFileName, 24)
            : `${this.rhBatches.length} RH files (${this.rhRawTrades.length} trades)`;
        this.loadedRhFileName.title =
          this.rhBatches.length === 1 ? rawFileName : `${this.rhBatches.length} RH files`;
      }
    }

    if (this.coreBatches.length > 0) {
      const coreStitched = stitchTradeBatches(this.coreBatches);
      this.coreRawTrades = sortTradesChronologicalDesc(coreStitched.trades);
      this.coreAccountIndices = coreStitched.accountIndices;
      this.coreAccountIndex =
        coreStitched.accountIndices.length > 0 ? coreStitched.accountIndices[0] : null;

      if (this.statusCoreFile) {
        const rawFileName = this.coreBatches[0].fileName || "Core JSON";
        const fileCountText =
          this.coreBatches.length === 1
            ? formatDisplayFileName(rawFileName, 22)
            : `${this.coreBatches.length} files`;
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
      }
      if (this.btnClearCore) this.btnClearCore.classList.remove("hidden");
      if (this.loadedCoreFileName) {
        const rawFileName = this.coreBatches[0].fileName || "Core file";
        this.loadedCoreFileName.textContent =
          this.coreBatches.length === 1
            ? formatDisplayFileName(rawFileName, 24)
            : `${this.coreBatches.length} Core files (${this.coreRawTrades.length} trades)`;
        this.loadedCoreFileName.title =
          this.coreBatches.length === 1 ? rawFileName : `${this.coreBatches.length} Core files`;
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
        `Hedge audit ready: matched ${this.hedgePairs.length} pairs between RH (${rhAccStr}) and Core (${coreAccStr}).`,
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

    this.hedgePairs = result.pairs;
    this.unhedgedTrades = result.unhedged;
    this.hedgeMetrics = result.metrics;

    this.updateHedgeExecutiveSummary();
    this.applyHedgeFilter();
  }

  private updateHedgeExecutiveSummary(): void {
    updateHedgeExecutiveMetrics(this.hedgeMetrics, this.hedgeMetricElements);
  }

  private applyHedgeFilter(): void {
    const q = this.hedgeSearchQuery;

    if (!q) {
      this.filteredHedgePairs = this.hedgePairs;
      this.filteredUnhedgedTrades = this.unhedgedTrades;
    } else {
      this.filteredHedgePairs = this.hedgePairs.filter(
        (p) =>
          p.marketSymbol.toLowerCase().includes(q) ||
          p.rhSide.toLowerCase().includes(q) ||
          p.coreSide.toLowerCase().includes(q) ||
          p.rhTradeId.includes(q) ||
          p.coreTradeId.includes(q),
      );

      this.filteredUnhedgedTrades = this.unhedgedTrades.filter(
        (u) =>
          u.marketSymbol.toLowerCase().includes(q) ||
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
      pairsToExport = this.hedgePairs.filter((p) => this.selectedHedgeRowIds.has(p.id));
      unhedgedToExport = this.unhedgedTrades.filter((u) =>
        this.selectedHedgeRowIds.has(u.id || `unhedged-${u.network}-${u.tradeId}`),
      );
    }

    const csvContent = exportHedgeReportToCsv(pairsToExport, unhedgedToExport);
    const dateStr = new Date().toISOString().slice(0, 10);
    const selSuffix = this.selectedHedgeRowIds.size > 0 ? "-selected" : "";
    const rhAccStr =
      this.rhAccountIndices.length > 0
        ? this.rhAccountIndices.join("-")
        : (this.rhAccountIndex ?? "0");
    const coreAccStr =
      this.coreAccountIndices.length > 0
        ? this.coreAccountIndices.join("-")
        : (this.coreAccountIndex ?? "0");
    const filename = `lighter-hedge-audit-rh${rhAccStr}-core${coreAccStr}${selSuffix}-${dateStr}.csv`;
    downloadTextFile(csvContent, filename, "text/csv;charset=utf-8");
  }

  public clearHedgeSlot(slot: "rh" | "core"): void {
    if (slot === "rh") {
      this.rhBatches = [];
      this.rhRawTrades = [];
      this.rhParsedTrades = [];
      this.rhAccountIndex = null;
      this.rhAccountIndices = [];
      this.rhFileName = "";
      if (this.statusRhFile) {
        this.statusRhFile.innerHTML =
          'Drop <code class="text-terminal-accent">rh-*.json</code> or raw API';
        this.statusRhFile.title = "";
        this.statusRhFile.className =
          "text-[11px] text-terminal-secondary truncate w-full max-w-full px-1 text-center";
      }
      if (this.labelRhAccount) this.labelRhAccount.textContent = "No files loaded";
      if (this.btnClearRh) this.btnClearRh.classList.add("hidden");
      if (this.fileInputRh) this.fileInputRh.value = "";
      if (this.loadedRhFileName) this.loadedRhFileName.textContent = "--";
    } else {
      this.coreBatches = [];
      this.coreRawTrades = [];
      this.coreParsedTrades = [];
      this.coreAccountIndex = null;
      this.coreAccountIndices = [];
      this.coreFileName = "";
      if (this.statusCoreFile) {
        this.statusCoreFile.innerHTML =
          'Drop <code class="text-terminal-emerald">mainnet-*.json</code> or raw API';
        this.statusCoreFile.title = "";
        this.statusCoreFile.className =
          "text-[11px] text-terminal-secondary truncate w-full max-w-full px-1 text-center";
      }
      if (this.labelCoreAccount) this.labelCoreAccount.textContent = "No files loaded";
      if (this.btnClearCore) this.btnClearCore.classList.add("hidden");
      if (this.fileInputCore) this.fileInputCore.value = "";
      if (this.loadedCoreFileName) this.loadedCoreFileName.textContent = "--";
    }

    this.hedgePairs = [];
    this.unhedgedTrades = [];
    this.filteredHedgePairs = [];
    this.filteredUnhedgedTrades = [];
    this.hedgeMetrics = null;
    this.selectedHedgeRowIds.clear();
    this.lastClickedHedgeRowId = null;
    updateHedgeSelectionMetrics(null, this.hedgeSelectionMetricElements);

    if (this.rhRawTrades.length === 0 || this.coreRawTrades.length === 0) {
      this.hedgeLoadedToolbar?.classList.add("hidden");
      this.hedgeEmptyStatePanel?.classList.remove("hidden");
    }

    this.updateHedgeExecutiveSummary();
    this.applyHedgeFilter();
  }

  public clearHedge(): void {
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

  private handleHedgeRangeSelection(fromId: string, toId: string): void {
    const visibleIds = this.getVisibleHedgeRowIds();
    const fromIndex = visibleIds.indexOf(fromId);
    const toIndex = visibleIds.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) {
      this.selectedHedgeRowIds.add(toId);
      this.lastClickedHedgeRowId = toId;
      return;
    }

    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    for (let i = start; i <= end; i++) {
      this.selectedHedgeRowIds.add(visibleIds[i]);
    }
    this.lastClickedHedgeRowId = toId;
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

    // Ignore text selection
    const sel = window.getSelection();
    if (!isCheckbox && sel && sel.toString().trim().length > 0) return;

    if (e.shiftKey && this.lastClickedHedgeRowId) {
      this.handleHedgeRangeSelection(this.lastClickedHedgeRowId, id);
    } else {
      if (isCheckbox) {
        const cb = target as HTMLInputElement;
        if (cb.checked) {
          this.selectedHedgeRowIds.add(id);
        } else {
          this.selectedHedgeRowIds.delete(id);
        }
      } else {
        if (this.selectedHedgeRowIds.has(id)) {
          this.selectedHedgeRowIds.delete(id);
        } else {
          this.selectedHedgeRowIds.add(id);
        }
      }
      this.lastClickedHedgeRowId = id;
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
    const selectedPairs = this.hedgePairs.filter((p) => this.selectedHedgeRowIds.has(p.id));
    const selectedUnhedged = this.unhedgedTrades.filter((u) =>
      this.selectedHedgeRowIds.has(u.id || `unhedged-${u.network}-${u.tradeId}`),
    );

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
  // SHARED NOTIFICATIONS
  // ==========================================

  private clearStatusTimers(): void {
    if (this.statusTimeoutId) {
      clearTimeout(this.statusTimeoutId);
      this.statusTimeoutId = null;
    }
    if (this.statusIntervalId) {
      clearInterval(this.statusIntervalId);
      this.statusIntervalId = null;
    }
    if (this.statusCountdown) {
      this.statusCountdown.textContent = "";
    }
  }

  private showStatusSuccess(message: string, durationMs = 5000): void {
    this.clearStatusTimers();

    if (this.statusCard) this.statusCard.classList.remove("hidden");
    if (this.statusDot) {
      this.statusDot.className = "w-2 h-2 rounded-full bg-terminal-emerald";
    }
    if (this.statusText) {
      this.statusText.textContent = message;
      this.statusText.className = "text-xs font-mono text-terminal-emerald font-semibold";
    }

    if (durationMs > 0) {
      let secondsLeft = Math.ceil(durationMs / 1000);
      if (this.statusCountdown) {
        this.statusCountdown.textContent = `${secondsLeft}s`;
      }

      this.statusIntervalId = setInterval(() => {
        secondsLeft--;
        if (secondsLeft > 0) {
          if (this.statusCountdown) {
            this.statusCountdown.textContent = `${secondsLeft}s`;
          }
        } else {
          this.clearStatusTimers();
          this.statusCard?.classList.add("hidden");
        }
      }, 1000);
    }
  }

  private showStatusError(errorMsg: string): void {
    this.clearStatusTimers();

    if (this.statusCard) this.statusCard.classList.remove("hidden");
    if (this.statusDot) {
      this.statusDot.className = "w-2 h-2 rounded-full bg-terminal-coral";
    }
    if (this.statusText) {
      this.statusText.textContent = errorMsg;
      this.statusText.className = "text-xs font-mono text-terminal-coral font-semibold";
    }
  }
}
