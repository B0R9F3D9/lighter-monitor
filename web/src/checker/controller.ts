import { copyToClipboard } from "../shared/clipboard";
import {
  calculateTradeMetrics,
  downloadJsonFile,
  fetchMarketMap,
  getStaticMarketMap,
  normalizeTimestampMs,
  parseImportedTradesJson,
  parseTradeForView,
  prepareExportPayload,
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
import { formatDisplayFileName, renderTradesTable, updateExecutiveMetrics } from "./dom";
import type {
  CheckerNetwork,
  CheckerSummaryMetrics,
  ImportedTradesResult,
  LighterTrade,
  ParsedTradeView,
  StitchedTradesResult,
} from "./types";

export class CheckerController {
  // Solo mode state
  private network: CheckerNetwork = "rh";
  private resolvedAccountIndex: number | null = null;
  private soloAccountIndices: number[] = [];
  private soloBatches: ImportedTradesResult[] = [];
  private soloStitched: StitchedTradesResult | null = null;
  private resolvedL1Address: string | null = null;
  private allRawTrades: LighterTrade[] = [];
  private rawTrades: LighterTrade[] = [];
  private parsedTrades: ParsedTradeView[] = [];
  private filteredTrades: ParsedTradeView[] = [];
  private summaryMetrics: CheckerSummaryMetrics | null = null;
  private marketMap: Map<number, string> = new Map();
  private activeTab: "table" | "json" = "table";
  private searchQuery = "";
  private filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private jsonViewerDirty = true;
  private uploadSessionId = 0;
  private activeDateFilter: ActiveDateFilter | null = null;

  // Bookmarklet DOM Elements
  private bookmarkletLink: HTMLAnchorElement | null = null;
  private copyBookmarkletBtn: HTMLButtonElement | null = null;
  private modalBookmarkletLink: HTMLAnchorElement | null = null;
  private modalCopyBookmarkletBtn: HTMLButtonElement | null = null;

  // Export Help Modal
  private exportModal: HTMLElement | null = null;
  private openExportHelpEmptyBtn: HTMLElement | null = null;
  private openExportHelpLoadedBtn: HTMLElement | null = null;
  private closeModalBtn: HTMLButtonElement | null = null;
  private dismissModalBtn: HTMLButtonElement | null = null;

  // Notification Status Card
  private statusCard: HTMLElement | null = null;
  private statusDot: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;
  private statusCountdown: HTMLElement | null = null;
  private closeStatusBtn: HTMLButtonElement | null = null;
  private statusTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private countdownIntervalId: ReturnType<typeof setInterval> | null = null;

  // Lead Strip Elements
  private metricElements = {
    accountBadge: null as HTMLElement | null,
    networkBadge: null as HTMLElement | null,
    tradesCount: null as HTMLElement | null,
    totalVolume: null as HTMLElement | null,
    realizedPnl: null as HTMLElement | null,
    totalFees: null as HTMLElement | null,
    dateRange: null as HTMLElement | null,
  };

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

  // Tab & Action Buttons
  private tabTableBtn: HTMLButtonElement | null = null;
  private tabJsonBtn: HTMLButtonElement | null = null;
  private tableContainer: HTMLElement | null = null;
  private jsonContainer: HTMLElement | null = null;
  private downloadBtn: HTMLButtonElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private clearBtn: HTMLButtonElement | null = null;

  // Table Body & Viewer
  private tableBody: HTMLTableSectionElement | null = null;
  private jsonPre: HTMLElement | null = null;
  private searchFilterInput: HTMLInputElement | null = null;
  private tradeCountNotice: HTMLElement | null = null;

  // Paste JSON Modal
  private pasteModal: HTMLElement | null = null;
  private textareaPasteJson: HTMLTextAreaElement | null = null;
  private btnClosePasteModal: HTMLButtonElement | null = null;
  private btnDismissPasteModal: HTMLButtonElement | null = null;
  private btnSubmitPasteJson: HTMLButtonElement | null = null;

  // Date Filter & Promo Modal Elements
  private selectDatePreset: HTMLSelectElement | null = null;
  private customDateRangeContainer: HTMLElement | null = null;
  private inputCustomDateFrom: HTMLInputElement | null = null;
  private inputCustomDateTo: HTMLInputElement | null = null;
  private btnApplyCustomDate: HTMLButtonElement | null = null;
  private activeDateBadge: HTMLElement | null = null;
  private activeDateBadgeText: HTMLElement | null = null;
  private btnClearDateFilter: HTMLButtonElement | null = null;
  private btnOpenPromoModal: HTMLButtonElement | null = null;
  private promoModal: HTMLElement | null = null;
  private btnClosePromoModal: HTMLButtonElement | null = null;
  private btnDismissPromoModal: HTMLButtonElement | null = null;
  private btnPromoSelectAll: HTMLButtonElement | null = null;
  private promoWeeksGrid: HTMLElement | null = null;

  public init(): void {
    this.cacheDomElements();
    this.initDateFilterSection();
    this.initBookmarkletSection();
    this.bindEvents();
    this.loadMarketDefinitions();
  }

  private initDateFilterSection(): void {
    if (this.selectDatePreset) {
      populatePresetSelect(this.selectDatePreset, this.activeDateFilter?.presetId || "all");
    }
  }

  private async loadMarketDefinitions(): Promise<void> {
    try {
      this.marketMap = await fetchMarketMap(this.network);
    } catch {
      this.marketMap = getStaticMarketMap(this.network === "rh" ? "rh" : "mainnet");
    }
  }

  private cacheDomElements(): void {
    // Bookmarklet
    this.bookmarkletLink = document.querySelector("#bookmarkletLink");
    this.copyBookmarkletBtn = document.querySelector("#btnCopyBookmarklet");
    this.modalBookmarkletLink = document.querySelector("#modalBookmarkletLink");
    this.modalCopyBookmarkletBtn = document.querySelector("#btnModalCopyBookmarklet");

    // Export Modal
    this.exportModal = document.querySelector("#exportModal");
    this.openExportHelpEmptyBtn = document.querySelector("#btnOpenExportHelpEmpty");
    this.openExportHelpLoadedBtn = document.querySelector("#btnOpenExportHelpLoaded");
    this.closeModalBtn = document.querySelector("#btnCloseModal");
    this.dismissModalBtn = document.querySelector("#btnDismissModal");

    // Notification Status Card
    this.statusCard = document.querySelector("#statusCard");
    this.statusDot = document.querySelector("#statusDot");
    this.statusText = document.querySelector("#statusText");
    this.statusCountdown = document.querySelector("#statusCountdown");
    this.closeStatusBtn = document.querySelector("#btnCloseStatus");

    // Lead Strip
    this.metricElements = {
      accountBadge: document.querySelector("#leadAccountBadge"),
      networkBadge: document.querySelector("#leadNetworkBadge"),
      tradesCount: document.querySelector("#leadTradesCount"),
      totalVolume: document.querySelector("#leadTotalVolume"),
      realizedPnl: document.querySelector("#leadRealizedPnl"),
      totalFees: document.querySelector("#leadTotalFees"),
      dateRange: document.querySelector("#leadDateRange"),
    };

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

    // Solo Table & Results
    this.tabTableBtn = document.querySelector("#tabBtnTable");
    this.tabJsonBtn = document.querySelector("#tabBtnJson");
    this.tableContainer = document.querySelector("#tableContainer");
    this.jsonContainer = document.querySelector("#jsonContainer");
    this.tableBody = document.querySelector("#tradesTableBody");
    this.jsonPre = document.querySelector("#jsonViewerPre");
    this.searchFilterInput = document.querySelector("#inputSearchFilter");
    this.tradeCountNotice = document.querySelector("#tradeCountNotice");

    // Paste Modal Elements
    this.pasteModal = document.querySelector("#pasteModal");
    this.btnClosePasteModal = document.querySelector("#btnClosePasteModal");
    this.btnDismissPasteModal = document.querySelector("#btnDismissPasteModal");
    this.btnSubmitPasteJson = document.querySelector("#btnSubmitPasteJson");
    this.textareaPasteJson = document.querySelector("#textareaPasteJson");

    // Date Filter & Promo Modal Elements
    this.selectDatePreset = document.querySelector("#selectDatePreset");
    this.customDateRangeContainer = document.querySelector("#customDateRangeContainer");
    this.inputCustomDateFrom = document.querySelector("#inputCustomDateFrom");
    this.inputCustomDateTo = document.querySelector("#inputCustomDateTo");
    this.btnApplyCustomDate = document.querySelector("#btnApplyCustomDate");
    this.activeDateBadge = document.querySelector("#activeDateBadge");
    this.activeDateBadgeText = document.querySelector("#activeDateBadgeText");
    this.btnClearDateFilter = document.querySelector("#btnClearDateFilter");
    this.btnOpenPromoModal = document.querySelector("#btnOpenPromoModal");
    this.promoModal = document.querySelector("#promoModal");
    this.btnClosePromoModal = document.querySelector("#btnClosePromoModal");
    this.btnDismissPromoModal = document.querySelector("#btnDismissPromoModal");
    this.btnPromoSelectAll = document.querySelector("#btnPromoSelectAll");
    this.promoWeeksGrid = document.querySelector("#promoWeeksGrid");
  }

  private handleBookmarkletClick(e: MouseEvent): void {
    e.preventDefault();
    this.openExportModal();
  }

  private initBookmarkletSection(): void {
    const bookmarkletHref = getBookmarkletHref();

    if (this.bookmarkletLink) {
      this.bookmarkletLink.href = bookmarkletHref;
      this.bookmarkletLink.addEventListener("click", (e) => this.handleBookmarkletClick(e));
    }
    if (this.modalBookmarkletLink) {
      this.modalBookmarkletLink.href = bookmarkletHref;
      this.modalBookmarkletLink.addEventListener("click", (e) => this.handleBookmarkletClick(e));
    }

    if (this.copyBookmarkletBtn) {
      const btn = this.copyBookmarkletBtn;
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
    // Export instructions modal open / close
    this.openExportHelpEmptyBtn?.addEventListener("click", () => this.openExportModal());
    this.openExportHelpLoadedBtn?.addEventListener("click", () => this.openExportModal());
    this.closeModalBtn?.addEventListener("click", () => this.closeExportModal());
    this.dismissModalBtn?.addEventListener("click", () => this.closeExportModal());

    this.exportModal?.addEventListener("click", (e) => {
      if (e.target === this.exportModal) this.closeExportModal();
    });

    // Paste Modal Controls
    this.btnClosePasteModal?.addEventListener("click", () => this.closePasteModal());
    this.btnDismissPasteModal?.addEventListener("click", () => this.closePasteModal());
    this.btnSubmitPasteJson?.addEventListener("click", () => this.handlePasteSubmit());
    this.pasteModal?.addEventListener("click", (e) => {
      if (e.target === this.pasteModal) this.closePasteModal();
    });

    // Notification close
    this.closeStatusBtn?.addEventListener("click", () => {
      this.clearStatusTimers();
      this.statusCard?.classList.add("hidden");
    });

    // Global keyboard hotkeys
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!this.exportModal?.classList.contains("hidden")) this.closeExportModal();
        if (!this.pasteModal?.classList.contains("hidden")) this.closePasteModal();
        if (!this.promoModal?.classList.contains("hidden")) this.closePromoModal();
      }
    });

    // Date filter presets
    this.selectDatePreset?.addEventListener("change", () => {
      const val = this.selectDatePreset?.value || "all";
      if (val === "custom") {
        this.customDateRangeContainer?.classList.remove("hidden");
        this.inputCustomDateFrom?.focus();
        return;
      }
      this.customDateRangeContainer?.classList.add("hidden");
      if (val === "all") {
        this.activeDateFilter = null;
      } else {
        const preset = findPresetById(val);
        if (preset) {
          this.activeDateFilter = createPresetDateFilter(preset);
          if (preset.startDateFormatted && this.inputCustomDateFrom) {
            this.inputCustomDateFrom.value = preset.startDateFormatted;
          }
          if (preset.endDateFormatted && this.inputCustomDateTo) {
            this.inputCustomDateTo.value = preset.endDateFormatted;
          }
        }
      }
      this.recalculateAndRender();
    });

    // Custom Date Range Apply
    this.btnApplyCustomDate?.addEventListener("click", () => {
      const from = this.inputCustomDateFrom?.value;
      const to = this.inputCustomDateTo?.value;
      if (!from && !to) {
        this.activeDateFilter = null;
        if (this.selectDatePreset) this.selectDatePreset.value = "all";
      } else {
        this.activeDateFilter = parseCustomDateRange(from, to);
      }
      this.recalculateAndRender();
    });

    // Clear Date Filter
    this.btnClearDateFilter?.addEventListener("click", () => {
      this.activeDateFilter = null;
      if (this.selectDatePreset) this.selectDatePreset.value = "all";
      if (this.inputCustomDateFrom) this.inputCustomDateFrom.value = "";
      if (this.inputCustomDateTo) this.inputCustomDateTo.value = "";
      this.customDateRangeContainer?.classList.add("hidden");
      this.recalculateAndRender();
    });

    // 20-Weeks Promo Modal Controls
    this.btnOpenPromoModal?.addEventListener("click", () => this.openPromoModal());
    this.btnClosePromoModal?.addEventListener("click", () => this.closePromoModal());
    this.btnDismissPromoModal?.addEventListener("click", () => this.closePromoModal());
    this.promoModal?.addEventListener("click", (e) => {
      if (e.target === this.promoModal) this.closePromoModal();
    });
    this.btnPromoSelectAll?.addEventListener("click", () => {
      this.activeDateFilter = null;
      if (this.selectDatePreset) this.selectDatePreset.value = "all";
      this.closePromoModal();
      this.recalculateAndRender();
    });

    // File browse / upload buttons
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

    this.btnPasteJsonSolo?.addEventListener("click", () => this.pasteFromClipboardOrOpenModal());
    this.btnPasteJsonLoadedSolo?.addEventListener("click", () =>
      this.pasteFromClipboardOrOpenModal(),
    );
    this.btnPasteClipboardSoloBox?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.pasteFromClipboardOrOpenModal();
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

    // Dropzone drag & drop
    if (this.dropzone) {
      const dropzone = this.dropzone;
      const highlight = () => {
        dropzone.classList.add("border-terminal-emerald", "bg-terminal-bg");
        dropzone.classList.remove("border-terminal-border");
      };
      const unhighlight = () => {
        dropzone.classList.remove("border-terminal-emerald", "bg-terminal-bg");
        dropzone.classList.add("border-terminal-border");
      };

      dropzone.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        this.fileInput?.click();
      });

      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        highlight();
      });
      dropzone.addEventListener("dragenter", (e) => {
        e.preventDefault();
        e.stopPropagation();
        highlight();
      });
      dropzone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        e.stopPropagation();
        unhighlight();
      });
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        unhighlight();
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
          this.handleFileUploads(Array.from(files), true);
        }
      });
    }

    // Action buttons
    this.downloadBtn?.addEventListener("click", () => this.downloadJson());
    this.copyBtn?.addEventListener("click", () => this.copyJson());
    this.clearBtn?.addEventListener("click", () => this.clearAll());

    // Tabs
    this.tabTableBtn?.addEventListener("click", () => this.switchTab("table"));
    this.tabJsonBtn?.addEventListener("click", () => this.switchTab("json"));

    // Filter with 150ms debounce to prevent UI freezes on typing
    this.searchFilterInput?.addEventListener("input", (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase().trim();
      if (this.filterDebounceTimer) {
        clearTimeout(this.filterDebounceTimer);
      }
      this.filterDebounceTimer = setTimeout(() => {
        this.applyFilter();
      }, 150);
    });
  }

  public openExportModal(): void {
    this.exportModal?.classList.remove("hidden");
  }

  public closeExportModal(): void {
    this.exportModal?.classList.add("hidden");
  }

  public async pasteFromClipboardOrOpenModal(): Promise<void> {
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.readText === "function"
      ) {
        const sessionId = ++this.uploadSessionId;
        const text = await navigator.clipboard.readText();
        if (sessionId !== this.uploadSessionId) return;

        const trimmed = text?.trim();
        if (trimmed && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
          try {
            const parsed = parseImportedTradesJson(trimmed, "clipboard.json");
            if (sessionId !== this.uploadSessionId) return;

            this.soloBatches = [...this.soloBatches, parsed];
            this.applySoloBatches();
            this.showStatusSuccess(`Pasted and added ${parsed.trades.length} trades!`);
            return;
          } catch {
            this.openPasteModal();
            if (this.textareaPasteJson) {
              this.textareaPasteJson.value = trimmed;
            }
            return;
          }
        }
      }
    } catch {}

    this.openPasteModal();
  }

  public openPasteModal(): void {
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
      this.soloBatches = [...this.soloBatches, parsed];
      this.closePasteModal();
      this.applySoloBatches();
    } catch (err: any) {
      this.showStatusError(`Failed to parse pasted JSON: ${err.message || String(err)}`);
    }
  }

  public async handleFileUploads(files: File[], append = false): Promise<void> {
    const sessionId = ++this.uploadSessionId;

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
        if (sessionId !== this.uploadSessionId) return;

        if (!/\S/.test(text)) {
          this.showStatusError(`Skipped "${file.name}": file is empty.`);
          continue;
        }

        this.showStatusSuccess(`Parsing "${file.name}"...`);
        await new Promise((r) => setTimeout(r, 0));
        if (sessionId !== this.uploadSessionId) return;

        const result = parseImportedTradesJson(text, file.name);
        if (sessionId !== this.uploadSessionId) return;

        newBatches.push(result);
      } catch (err: any) {
        if (sessionId === this.uploadSessionId) {
          console.error("JSON Import Error:", err);
          this.showStatusError(`Error reading "${file.name}": ${err.message || String(err)}`);
        }
      }
    }

    if (sessionId !== this.uploadSessionId) return;
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
    this.allRawTrades = sortTradesChronologicalDesc(stitched.trades);
    this.rawTrades = this.allRawTrades;
    this.soloAccountIndices = stitched.accountIndices;
    this.resolvedAccountIndex =
      stitched.accountIndices.length > 0 ? stitched.accountIndices[0] : null;

    if (stitched.network) {
      this.network = stitched.network;
      this.marketMap =
        this.network === "rh" ? getStaticMarketMap("rh") : getStaticMarketMap("mainnet");
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
        this.loadedFileName.textContent = `${this.soloBatches.length} files stitched (${this.allRawTrades.length.toLocaleString()} trades)`;
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
      `Stitched ${this.allRawTrades.length.toLocaleString()} deduplicated trades across ${this.soloBatches.length} file(s) (${accBadge}).`,
    );
  }

  private recalculateAndRender(): void {
    if (this.activeDateFilter) {
      this.rawTrades = this.allRawTrades.filter((t) =>
        isTradeInDateRange(normalizeTimestampMs(t.timestamp), this.activeDateFilter),
      );
    } else {
      this.rawTrades = this.allRawTrades;
    }

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
    this.updateDateFilterUi();

    // Mark JSON viewer as needing update without building/rendering giant JSON on table tab
    this.jsonViewerDirty = true;
    if (this.activeTab === "json") {
      this.updateJsonViewer();
    }

    const hasData = this.rawTrades.length > 0;
    if (this.downloadBtn) this.downloadBtn.disabled = !hasData;
    if (this.copyBtn) this.copyBtn.disabled = !hasData;
    if (this.clearBtn) this.clearBtn.disabled = !hasData;
  }

  public openPromoModal(): void {
    if (this.promoWeeksGrid) {
      renderPromoWeeksGrid(
        this.promoWeeksGrid,
        (preset) => {
          this.activeDateFilter = createPresetDateFilter(preset);
          if (this.selectDatePreset) this.selectDatePreset.value = preset.id;
          if (preset.startDateFormatted && this.inputCustomDateFrom) {
            this.inputCustomDateFrom.value = preset.startDateFormatted;
          }
          if (preset.endDateFormatted && this.inputCustomDateTo) {
            this.inputCustomDateTo.value = preset.endDateFormatted;
          }
          this.closePromoModal();
          this.recalculateAndRender();
        },
        this.activeDateFilter?.presetId,
      );
    }
    this.promoModal?.classList.remove("hidden");
  }

  public closePromoModal(): void {
    this.promoModal?.classList.add("hidden");
  }

  private updateDateFilterUi(): void {
    if (this.selectDatePreset) {
      this.selectDatePreset.value = this.activeDateFilter?.presetId || "all";
    }

    if (this.activeDateFilter && this.activeDateFilter.presetId !== "all") {
      this.activeDateBadge?.classList.remove("hidden");
      if (this.activeDateBadgeText) {
        this.activeDateBadgeText.textContent = formatDateRangeFilterLabel(this.activeDateFilter);
      }
    } else {
      this.activeDateBadge?.classList.add("hidden");
    }

    if (this.activeDateFilter?.isCustom) {
      this.customDateRangeContainer?.classList.remove("hidden");
    } else if (this.selectDatePreset?.value !== "custom") {
      this.customDateRangeContainer?.classList.add("hidden");
    }
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
      this.filteredTrades = this.parsedTrades.filter((t) =>
        t.searchIndex
          ? t.searchIndex.includes(q)
          : t.marketSymbol.toLowerCase().includes(q) ||
            t.side.toLowerCase().includes(q) ||
            t.role.toLowerCase().includes(q) ||
            t.tradeId.toLowerCase().includes(q) ||
            t.txHash.toLowerCase().includes(q),
      );
    }

    if (this.tableBody) {
      renderTradesTable(this.tableBody, this.filteredTrades);
    }

    if (this.tradeCountNotice) {
      const parts: string[] = [];
      if (this.activeDateFilter && this.activeDateFilter.presetId !== "all") {
        parts.push(formatDateRangeFilterLabel(this.activeDateFilter));
      }
      if (this.searchQuery) {
        parts.push(`matching "${this.searchQuery}"`);
      }

      if (parts.length > 0) {
        this.tradeCountNotice.textContent = `Showing ${this.filteredTrades.length} of ${this.allRawTrades.length} trades (${parts.join(", ")})`;
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
      this.jsonViewerDirty = false;
      return;
    }

    const acc = this.resolvedAccountIndex ?? 0;
    const accQuery = this.soloAccountIndices.length > 0 ? this.soloAccountIndices : acc;

    // For large datasets (> 50 trades), render a truncated preview to prevent browser DOM lock and OOM freezes
    const PREVIEW_LIMIT = 50;
    if (this.rawTrades.length > PREVIEW_LIMIT) {
      const previewTrades = this.rawTrades.slice(0, PREVIEW_LIMIT);
      const previewPayload = prepareExportPayload(
        previewTrades,
        this.network,
        accQuery,
        this.resolvedL1Address || undefined,
        true,
        this.rawTrades.length,
      );
      this.jsonPre.textContent = JSON.stringify(
        {
          _notice: `Showing preview of first ${PREVIEW_LIMIT} of ${this.rawTrades.length.toLocaleString()} trades to keep UI fast. Click "Download JSON" or "Copy JSON" for full payload.`,
          ...previewPayload,
        },
        null,
        2,
      );
    } else {
      const payload = prepareExportPayload(
        this.rawTrades,
        this.network,
        accQuery,
        this.resolvedL1Address || undefined,
      );
      this.jsonPre.textContent = JSON.stringify(payload, null, 2);
    }

    this.jsonViewerDirty = false;
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

      if (this.jsonViewerDirty) {
        this.updateJsonViewer();
      }
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
    const isLarge = this.rawTrades.length > 5000;
    const jsonStr = isLarge ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);

    copyToClipboard(jsonStr, this.copyBtn, "Copy JSON");
  }

  public clearAll(): void {
    this.uploadSessionId++;
    this.soloBatches = [];
    this.soloStitched = null;
    this.allRawTrades = [];
    this.rawTrades = [];
    this.parsedTrades = [];
    this.filteredTrades = [];
    this.summaryMetrics = null;
    this.resolvedAccountIndex = null;
    this.soloAccountIndices = [];
    this.resolvedL1Address = null;
    this.searchQuery = "";
    this.activeDateFilter = null;
    if (this.selectDatePreset) this.selectDatePreset.value = "all";
    if (this.inputCustomDateFrom) this.inputCustomDateFrom.value = "";
    if (this.inputCustomDateTo) this.inputCustomDateTo.value = "";
    this.updateDateFilterUi();
    if (this.filterDebounceTimer) {
      clearTimeout(this.filterDebounceTimer);
      this.filterDebounceTimer = null;
    }

    if (this.fileInput) this.fileInput.value = "";
    if (this.searchFilterInput) this.searchFilterInput.value = "";
    if (this.loadedFileName) this.loadedFileName.textContent = "--";
    if (this.loadedFileDetails) this.loadedFileDetails.textContent = "";
    if (this.loadedFileNetwork) this.loadedFileNetwork.textContent = "--";

    this.loadedToolbar?.classList.add("hidden");
    this.emptyStatePanel?.classList.remove("hidden");

    this.updateExecutiveSummary();
    this.applyFilter();
    this.updateJsonViewer();

    if (this.downloadBtn) this.downloadBtn.disabled = true;
    if (this.copyBtn) this.copyBtn.disabled = true;
    if (this.clearBtn) this.clearBtn.disabled = true;

    this.showStatusSuccess("Trade data cleared.");
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
