import { copyToClipboard } from "../shared/clipboard";
import {
  calculateTradeMetrics,
  downloadJsonFile,
  fetchMarketMap,
  parseImportedTradesJson,
  parseTradeForView,
  prepareExportPayload,
} from "./api";
import { getBookmarkletHref } from "./bookmarklet";
import { renderTradesTable, updateExecutiveMetrics } from "./dom";
import type { CheckerNetwork, CheckerSummaryMetrics, LighterTrade, ParsedTradeView } from "./types";

export class CheckerController {
  private network: CheckerNetwork = "rh";
  private resolvedAccountIndex: number | null = null;
  private resolvedL1Address: string | null = null;

  private rawTrades: LighterTrade[] = [];
  private parsedTrades: ParsedTradeView[] = [];
  private filteredTrades: ParsedTradeView[] = [];
  private summaryMetrics: CheckerSummaryMetrics | null = null;
  private marketMap: Map<number, string> = new Map();

  private activeTab: "table" | "json" = "table";
  private searchQuery = "";

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

  // Two-State Panels
  private emptyStatePanel: HTMLElement | null = null;
  private loadedToolbar: HTMLElement | null = null;
  private loadedFileName: HTMLElement | null = null;
  private loadedFileNetwork: HTMLElement | null = null;
  private reuploadBtn: HTMLButtonElement | null = null;
  private browseFileEmptyBtn: HTMLElement | null = null;

  // Dropzone DOM Elements
  private dropzone: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;

  // Actions
  private downloadBtn: HTMLButtonElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private clearBtn: HTMLButtonElement | null = null;

  // Status Alert Card
  private statusCard: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;
  private statusDot: HTMLElement | null = null;
  private closeStatusBtn: HTMLButtonElement | null = null;
  private statusTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Tabs & Table View
  private tabTableBtn: HTMLButtonElement | null = null;
  private tabJsonBtn: HTMLButtonElement | null = null;
  private tableContainer: HTMLElement | null = null;
  private jsonContainer: HTMLElement | null = null;
  private tableBody: HTMLTableSectionElement | null = null;
  private jsonPre: HTMLPreElement | null = null;
  private searchFilterInput: HTMLInputElement | null = null;
  private tradeCountNotice: HTMLElement | null = null;

  // Executive Metrics Strip
  private metricElements = {
    accountBadge: null as HTMLElement | null,
    networkBadge: null as HTMLElement | null,
    tradesCount: null as HTMLElement | null,
    totalVolume: null as HTMLElement | null,
    realizedPnl: null as HTMLElement | null,
    totalFees: null as HTMLElement | null,
    dateRange: null as HTMLElement | null,
  };

  public init(): void {
    this.cacheDomElements();
    this.initBookmarkletSection();
    this.bindEvents();
    this.updateExecutiveSummary();
    this.loadMarketDefinitions();
  }

  private cacheDomElements(): void {
    // Bookmarklet
    this.bookmarkletLink = document.querySelector("#bookmarkletLink");
    this.copyBookmarkletBtn = document.querySelector("#btnCopyBookmarklet");
    this.modalBookmarkletLink = document.querySelector("#modalBookmarkletLink");
    this.modalCopyBookmarkletBtn = document.querySelector("#btnModalCopyBookmarklet");

    // Modal
    this.exportModal = document.querySelector("#exportModal");
    this.openExportHelpEmptyBtn = document.querySelector("#btnOpenExportHelpEmpty");
    this.openExportHelpLoadedBtn = document.querySelector("#btnOpenExportHelpLoaded");
    this.closeModalBtn = document.querySelector("#btnCloseModal");
    this.dismissModalBtn = document.querySelector("#btnDismissModal");

    // Two-state workflow containers
    this.emptyStatePanel = document.querySelector("#emptyStatePanel");
    this.loadedToolbar = document.querySelector("#loadedToolbar");
    this.loadedFileName = document.querySelector("#loadedFileName");
    this.loadedFileNetwork = document.querySelector("#loadedFileNetwork");
    this.reuploadBtn = document.querySelector("#btnReupload");
    this.browseFileEmptyBtn = document.querySelector("#btnBrowseFileEmpty");

    // Dropzone
    this.dropzone = document.querySelector("#jsonDropzone");
    this.fileInput = document.querySelector("#jsonFileInput");

    // Actions
    this.downloadBtn = document.querySelector("#btnDownloadJson");
    this.copyBtn = document.querySelector("#btnCopyJson");
    this.clearBtn = document.querySelector("#btnClearTrades");

    // Status Alert Card
    this.statusCard = document.querySelector("#statusCard");
    this.statusText = document.querySelector("#statusText");
    this.statusDot = document.querySelector("#statusDot");
    this.closeStatusBtn = document.querySelector("#btnCloseStatus");

    // Table & JSON
    this.tabTableBtn = document.querySelector("#tabBtnTable");
    this.tabJsonBtn = document.querySelector("#tabBtnJson");
    this.tableContainer = document.querySelector("#tableContainer");
    this.jsonContainer = document.querySelector("#jsonContainer");
    this.tableBody = document.querySelector("#tradesTableBody");
    this.jsonPre = document.querySelector("#jsonViewerPre");
    this.searchFilterInput = document.querySelector("#inputSearchFilter");
    this.tradeCountNotice = document.querySelector("#tradeCountNotice");

    this.metricElements = {
      accountBadge: document.querySelector("#leadAccountBadge"),
      networkBadge: document.querySelector("#leadNetworkBadge"),
      tradesCount: document.querySelector("#leadTradesCount"),
      totalVolume: document.querySelector("#leadTotalVolume"),
      realizedPnl: document.querySelector("#leadRealizedPnl"),
      totalFees: document.querySelector("#leadTotalFees"),
      dateRange: document.querySelector("#leadDateRange"),
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

    if (this.modalBookmarkletLink) {
      this.modalBookmarkletLink.href = bookmarkletHref;
      this.modalBookmarkletLink.addEventListener("click", (e) => this.handleBookmarkletClick(e));
    }
  }

  private async loadMarketDefinitions(): Promise<void> {
    try {
      this.marketMap = await fetchMarketMap(this.network);
      if (this.rawTrades.length > 0 && this.resolvedAccountIndex !== null) {
        this.recalculateAndRender();
      }
    } catch {}
  }

  private bindEvents(): void {
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
      }
    });

    // 3. File upload / browse events
    this.browseFileEmptyBtn?.addEventListener("click", () => {
      this.fileInput?.click();
    });

    this.reuploadBtn?.addEventListener("click", () => {
      this.fileInput?.click();
    });

    this.fileInput?.addEventListener("change", (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        this.handleFileUpload(files[0]);
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
          this.handleFileUpload(files[0]);
        }
      });
    }

    // 4. Status card close button
    this.closeStatusBtn?.addEventListener("click", () => {
      if (this.statusTimeoutId) {
        clearTimeout(this.statusTimeoutId);
        this.statusTimeoutId = null;
      }
      this.statusCard?.classList.add("hidden");
    });

    // 5. Action Buttons
    this.downloadBtn?.addEventListener("click", () => this.downloadJson());
    this.copyBtn?.addEventListener("click", () => this.copyJson());
    this.clearBtn?.addEventListener("click", () => this.clearAll());

    // 6. Tabs Switcher
    this.tabTableBtn?.addEventListener("click", () => this.switchTab("table"));
    this.tabJsonBtn?.addEventListener("click", () => this.switchTab("json"));

    // 7. Search filter
    this.searchFilterInput?.addEventListener("input", (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase().trim();
      this.applyFilter();
    });
  }

  private openExportModal(): void {
    this.exportModal?.classList.remove("hidden");
  }

  private closeExportModal(): void {
    this.exportModal?.classList.add("hidden");
  }

  /**
   * Handles user uploading / dropping a JSON trade file.
   */
  public handleFileUpload(file: File): void {
    if (!file.name.endsWith(".json") && file.type !== "application/json" && file.type !== "") {
      this.showStatusError("Please upload a valid .json file.");
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", (e) => {
      try {
        const text = (e.target as FileReader)?.result as string;
        if (!text) throw new Error("File is empty.");

        const result = parseImportedTradesJson(text);

        this.rawTrades = result.trades;
        if (result.accountIndex !== null) {
          this.resolvedAccountIndex = result.accountIndex;
        }
        if (result.network) {
          this.network = result.network;
        }
        if (result.l1Address) {
          this.resolvedL1Address = result.l1Address;
        }

        if (this.loadedFileName) {
          this.loadedFileName.textContent = file.name;
        }
        if (this.loadedFileNetwork) {
          this.loadedFileNetwork.textContent = this.network.toUpperCase();
        }

        this.emptyStatePanel?.classList.add("hidden");
        this.loadedToolbar?.classList.remove("hidden");

        this.recalculateAndRender();
        if (result.isTruncated) {
          const capText = result.rowCap ? result.rowCap.toLocaleString() : "150,000";
          this.showStatusSuccess(
            `Imported ${result.trades.length.toLocaleString()} trades from "${file.name}" (Account #${this.resolvedAccountIndex ?? "--"}). Notice: Dataset hit the ${capText} trade ceiling; earliest history was truncated.`,
          );
        } else {
          this.showStatusSuccess(
            `Imported ${result.trades.length.toLocaleString()} trades from "${file.name}" (Account #${this.resolvedAccountIndex ?? "--"}).`,
          );
        }
      } catch (err: any) {
        console.error("JSON Import Error:", err);
        this.showStatusError(`Failed to import JSON: ${err.message || String(err)}`);
      }
    });

    reader.addEventListener("error", () => {
      this.showStatusError("Failed to read the selected file.");
    });

    reader.readAsText(file);
  }

  private recalculateAndRender(): void {
    const acc = this.resolvedAccountIndex ?? 0;
    this.parsedTrades = this.rawTrades.map((t) => parseTradeForView(t, acc, this.marketMap));
    this.summaryMetrics = calculateTradeMetrics(this.rawTrades, acc);

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
    const payload = prepareExportPayload(
      this.rawTrades,
      this.network,
      acc,
      this.resolvedL1Address || undefined,
    );

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `lighter-trades-${this.network}-acc${acc}-${dateStr}.json`;
    downloadJsonFile(payload, filename);
  }

  public copyJson(): void {
    if (this.rawTrades.length === 0 || !this.copyBtn) return;

    const acc = this.resolvedAccountIndex ?? 0;
    const payload = prepareExportPayload(
      this.rawTrades,
      this.network,
      acc,
      this.resolvedL1Address || undefined,
    );

    const jsonStr = JSON.stringify(payload, null, 2);
    copyToClipboard(jsonStr, this.copyBtn, "Copy JSON");
  }

  public clearAll(): void {
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

    if (this.statusTimeoutId) {
      clearTimeout(this.statusTimeoutId);
      this.statusTimeoutId = null;
    }
    if (this.statusCard) this.statusCard.classList.add("hidden");
  }

  private showStatusSuccess(message: string, durationMs = 4000): void {
    if (this.statusTimeoutId) {
      clearTimeout(this.statusTimeoutId);
      this.statusTimeoutId = null;
    }

    if (this.statusCard) this.statusCard.classList.remove("hidden");
    if (this.statusDot) {
      this.statusDot.className = "w-2 h-2 rounded-full bg-terminal-emerald";
    }
    if (this.statusText) {
      this.statusText.textContent = message;
      this.statusText.className = "text-xs font-mono text-terminal-emerald font-semibold";
    }

    if (durationMs > 0) {
      this.statusTimeoutId = setTimeout(() => {
        this.statusCard?.classList.add("hidden");
        this.statusTimeoutId = null;
      }, durationMs);
    }
  }

  private showStatusError(errorMsg: string): void {
    if (this.statusTimeoutId) {
      clearTimeout(this.statusTimeoutId);
      this.statusTimeoutId = null;
    }

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
