import {
  getTokenIcon,
  getTokenImageUrl,
  formatMarketPrice,
  getCategoryBadge,
  matchesCategory,
  normalizeCategoryFilter,
  MARKET_CATEGORIES_WITH_FAVORITES,
  type MarketCategoryFilter,
} from "./tokens";
import { formatMoney } from "./formatters";
import type { AnalyticsMarketPair, AnalyticsVenue } from "./market_pairs";

export type SortField = "volume" | "oi" | "change" | "price" | "symbol";
export type SortDirection = "asc" | "desc";

export interface MarketModalOptions {
  activeSymbol: string;
  defaultVenue?: AnalyticsVenue;
  getHref?: (symbol: string) => string;
  onSelect: (pair: AnalyticsMarketPair) => void;
  onVenueChange?: (venue: AnalyticsVenue) => void;
}

export class MarketModal {
  private pairs: AnalyticsMarketPair[] = [];
  private activeSymbol: string;
  private activeVenue: AnalyticsVenue = "rh";
  private activeCategory: MarketCategoryFilter = "all";
  private currentSortField: SortField = "volume";
  private currentSortDirection: SortDirection = "desc";
  private searchQuery = "";
  private favorites = new Set<string>();
  private recents: string[] = [];
  private focusedModalRowIndex = 0;
  private options: MarketModalOptions;

  private cleanupFns: Array<() => void> = [];

  constructor(options: MarketModalOptions) {
    this.options = options;
    this.activeSymbol = options.activeSymbol;
    if (options.defaultVenue) {
      this.activeVenue = options.defaultVenue;
    }
  }

  public init(): void {
    this.loadSettings();
    this.initCategoryTabs();
    this.setupEventListeners();
    this.updateSortIndicators();
    this.updateVenueButtons();
    this.renderRecents();
    this.render();
  }

  public destroy(): void {
    for (const fn of this.cleanupFns) {
      fn();
    }
    this.cleanupFns = [];
  }

  public setPairs(pairs: AnalyticsMarketPair[]): void {
    this.pairs = pairs;
    this.applyVenueStats();
    this.renderRecents();
    this.render();
    const activePair = this.pairs.find((p) => p.symbol === this.activeSymbol);
    if (activePair) {
      this.updateTriggerButton(null, activePair);
    }
  }

  public setActiveSymbol(symbol: string): void {
    this.activeSymbol = symbol;
    this.addToRecents(symbol);
    this.renderRecents();
    this.render();
    const pair = this.pairs.find((p) => p.symbol === symbol);
    this.updateTriggerButton(null, pair);
  }

  public getActiveSymbol(): string {
    return this.activeSymbol;
  }

  public getActiveVenue(): AnalyticsVenue {
    return this.activeVenue;
  }

  public open(): void {
    const modal = document.getElementById("tickerModal");
    const input = document.getElementById("tickerSearchInput") as HTMLInputElement | null;
    modal?.classList.remove("hidden");
    input?.focus();
    input?.select();
    this.focusedModalRowIndex = 0;
    this.renderRecents();
    this.render();
  }

  public close(): void {
    const modal = document.getElementById("tickerModal");
    modal?.classList.add("hidden");
  }

  public updateTriggerButton(btnEl?: HTMLElement | null, pair?: AnalyticsMarketPair | null): void {
    const btn = btnEl || document.getElementById("tickerSelectBtn");
    if (!btn) return;

    const sym = pair ? pair.symbol : this.activeSymbol;
    const targetPair = pair || this.pairs.find((p) => p.symbol === sym);

    const imgEl = btn.querySelector("#tickerTokenImg") as HTMLImageElement | null;
    const iconEl = btn.querySelector("#tickerTokenIcon") as HTMLElement | null;
    const symEl = btn.querySelector("#headerSymbol") as HTMLElement | null;
    const levEl = btn.querySelector("#headerLeverage") as HTMLElement | null;

    if (symEl) symEl.textContent = sym;
    if (levEl) levEl.textContent = targetPair ? targetPair.leverage : "--";

    if (imgEl) {
      imgEl.src = getTokenImageUrl(sym);
      imgEl.alt = sym;
      imgEl.style.display = "block";
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      imgEl.onerror = () => {
        imgEl.style.display = "none";
        if (iconEl) {
          iconEl.style.display = "flex";
          iconEl.textContent = getTokenIcon(sym);
        }
      };
    }
    if (iconEl) {
      iconEl.textContent = getTokenIcon(sym);
      iconEl.style.display = "none";
    }
  }

  private loadSettings(): void {
    try {
      const savedVenue = localStorage.getItem("analytics_venue");
      if (savedVenue === "core" || savedVenue === "rh") {
        this.activeVenue = savedVenue;
      }

      const savedSort = localStorage.getItem("analytics_sort");
      if (savedSort) {
        const [field, dir] = savedSort.split(":");
        if (["volume", "oi", "change", "price", "symbol"].includes(field)) {
          this.currentSortField = field as SortField;
        }
        if (dir === "asc" || dir === "desc") {
          this.currentSortDirection = dir;
        }
      }

      const savedRecents = localStorage.getItem("analytics_recents");
      if (savedRecents) {
        const parsed = JSON.parse(savedRecents);
        if (Array.isArray(parsed)) this.recents = parsed;
      }

      const savedFavs = localStorage.getItem("analytics_favorites");
      if (savedFavs) {
        const parsed = JSON.parse(savedFavs);
        if (Array.isArray(parsed)) this.favorites = new Set(parsed);
      }

      const savedCat = localStorage.getItem("analytics_category");
      if (savedCat) {
        this.activeCategory = normalizeCategoryFilter(savedCat, true);
        this.updateCategoryTabsUi();
      }
    } catch {}
  }

  private saveSettings(): void {
    try {
      localStorage.setItem("analytics_venue", this.activeVenue);
      localStorage.setItem(
        "analytics_sort",
        `${this.currentSortField}:${this.currentSortDirection}`,
      );
      localStorage.setItem("analytics_recents", JSON.stringify(this.recents));
      localStorage.setItem("analytics_favorites", JSON.stringify(Array.from(this.favorites)));
      localStorage.setItem("analytics_category", this.activeCategory);
    } catch {}
  }

  private initCategoryTabs(): void {
    const container = document.getElementById("categoryTabs");
    if (!container) return;

    container.innerHTML = MARKET_CATEGORIES_WITH_FAVORITES.map(
      (cat) => `
        <button
          type="button"
          data-cat="${cat.id}"
          class="cat-tab px-2.5 py-0.5 rounded ${
            this.activeCategory === cat.id
              ? "bg-terminal-border text-white font-bold"
              : "text-terminal-muted hover:text-white"
          } transition cursor-pointer text-[11px] whitespace-nowrap"
        >
          ${cat.shortLabel}
        </button>
      `,
    ).join("");

    container.querySelectorAll(".cat-tab").forEach((tab) => {
      const handler = () => {
        const cat = (tab as HTMLElement).dataset.cat as MarketCategoryFilter;
        if (cat) {
          this.activeCategory = cat;
          this.saveSettings();
          this.updateCategoryTabsUi();
          this.focusedModalRowIndex = 0;
          this.render();
        }
      };
      tab.addEventListener("click", handler);
      this.cleanupFns.push(() => tab.removeEventListener("click", handler));
    });
  }

  private updateCategoryTabsUi(): void {
    document.querySelectorAll(".cat-tab").forEach((t) => {
      const cat = (t as HTMLElement).dataset.cat;
      if (cat === this.activeCategory) {
        t.className =
          "cat-tab px-2.5 py-0.5 rounded bg-terminal-border text-white font-bold transition cursor-pointer text-[11px] whitespace-nowrap";
      } else {
        t.className =
          "cat-tab px-2.5 py-0.5 rounded text-terminal-muted hover:text-white transition cursor-pointer text-[11px] whitespace-nowrap";
      }
    });
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
    }
  }

  private updateVenueButtons(): void {
    const rhBtn = document.getElementById("venueBtnRh");
    const coreBtn = document.getElementById("venueBtnCore");

    const activeModalClass =
      "venue-btn px-2 py-0.5 rounded bg-terminal-accent text-terminal-bg font-bold cursor-pointer transition flex items-center gap-1";
    const inactiveModalClass =
      "venue-btn px-2 py-0.5 rounded text-terminal-muted hover:text-white cursor-pointer transition flex items-center gap-1";

    if (rhBtn) {
      rhBtn.className = this.activeVenue === "rh" ? activeModalClass : inactiveModalClass;
      const dot = rhBtn.querySelector("span:first-child");
      if (dot)
        dot.className = `w-1.5 h-1.5 rounded-full ${this.activeVenue === "rh" ? "bg-terminal-bg" : "bg-terminal-emerald"}`;
    }
    if (coreBtn) {
      coreBtn.className = this.activeVenue === "core" ? activeModalClass : inactiveModalClass;
      const dot = coreBtn.querySelector("span:first-child");
      if (dot)
        dot.className = `w-1.5 h-1.5 rounded-full ${this.activeVenue === "core" ? "bg-terminal-bg" : "bg-terminal-accent"}`;
    }

    const tag = this.activeVenue.toUpperCase();
    const colPrice = document.getElementById("colVenueTagPrice");
    const colVol = document.getElementById("colVenueTagVol");
    const colOi = document.getElementById("colVenueTagOi");
    if (colPrice) colPrice.textContent = tag;
    if (colVol) colVol.textContent = tag;
    if (colOi) colOi.textContent = tag;
  }

  public setVenue(venue: AnalyticsVenue): void {
    if (this.activeVenue === venue) return;
    this.activeVenue = venue;
    this.applyVenueStats();
    this.saveSettings();
    this.updateVenueButtons();
    this.focusedModalRowIndex = 0;
    this.render();
    this.options.onVenueChange?.(venue);
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
    this.render();
  }

  private updateSortIndicators(): void {
    const labelEl = document.getElementById("currentSortLabel");
    const arrowEl = document.getElementById("currentSortArrow");

    const labels: Record<SortField, string> = {
      volume: "Volume",
      oi: "OI",
      change: "24h %",
      price: "Price",
      symbol: "Name",
    };

    if (labelEl) labelEl.textContent = labels[this.currentSortField] || "Volume";
    if (arrowEl) {
      arrowEl.textContent = this.currentSortDirection === "asc" ? "↑" : "↓";
      arrowEl.className = "text-[9px] text-terminal-accent font-bold";
    }

    const fields: SortField[] = ["symbol", "price", "change", "volume", "oi"];
    for (const f of fields) {
      const iconId = `sortIcon${f.charAt(0).toUpperCase() + f.slice(1)}`;
      const el = document.getElementById(iconId);
      if (!el) continue;

      if (this.currentSortField === f) {
        el.textContent = this.currentSortDirection === "asc" ? "↑" : "↓";
        el.className = "text-[9px] text-terminal-accent font-bold";
      } else {
        el.textContent = "↕";
        el.className = "text-[9px] text-terminal-muted opacity-40";
      }
    }
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
      chip.href = this.options.getHref ? this.options.getHref(sym) : "#";
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
        const p = this.pairs.find((item) => item.symbol === sym);
        if (p) {
          this.options.onSelect(p);
          this.setActiveSymbol(sym);
          this.close();
        }
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
    this.render();
  }

  private getFilteredPairs(): AnalyticsMarketPair[] {
    const list = this.pairs.filter((p) => {
      if (!matchesCategory(p.symbol, this.activeCategory, this.favorites)) {
        return false;
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

  public render(): void {
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
      const catInfo = getCategoryBadge(p.symbol);

      const changeSign = p.dailyPriceChange >= 0 ? "+" : "";
      const changeColor = p.dailyPriceChange >= 0 ? "text-terminal-emerald" : "text-terminal-coral";

      const row = document.createElement("a");
      row.href = this.options.getHref ? this.options.getHref(p.symbol) : "#";
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
          <span class="text-[9px] text-terminal-muted px-1 py-0.5 rounded bg-terminal-bg border border-terminal-border/70 shrink-0 hidden sm:inline" title="${catInfo.label}">${catInfo.shortLabel}</span>
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
        this.options.onSelect(p);
        this.addToRecents(p.symbol);
        this.close();
      });

      row.addEventListener("mouseenter", () => {
        this.focusedModalRowIndex = idx;
        this.highlightFocusedRow();
      });

      listEl.appendChild(row);
    });
  }

  private setupEventListeners(): void {
    // Ticker select button click to open
    const openBtn = document.getElementById("tickerSelectBtn");
    if (openBtn) {
      const handler = () => this.open();
      openBtn.addEventListener("click", handler);
      this.cleanupFns.push(() => openBtn.removeEventListener("click", handler));
    }

    // Modal close button
    const closeBtn = document.getElementById("closeTickerModalBtn");
    if (closeBtn) {
      const handler = () => this.close();
      closeBtn.addEventListener("click", handler);
      this.cleanupFns.push(() => closeBtn.removeEventListener("click", handler));
    }

    // Modal backdrop click
    const backdrop = document.getElementById("tickerModalBackdrop");
    if (backdrop) {
      const handler = () => this.close();
      backdrop.addEventListener("click", handler);
      this.cleanupFns.push(() => backdrop.removeEventListener("click", handler));
    }

    // Search input
    const searchInput = document.getElementById("tickerSearchInput") as HTMLInputElement | null;
    const clearBtn = document.getElementById("clearSearchBtn");

    if (searchInput) {
      const onInput = (e: Event) => {
        this.searchQuery = (e.target as HTMLInputElement).value.trim();
        if (clearBtn) {
          if (this.searchQuery) {
            clearBtn.classList.remove("hidden");
          } else {
            clearBtn.classList.add("hidden");
          }
        }
        this.focusedModalRowIndex = 0;
        this.render();
      };
      searchInput.addEventListener("input", onInput);
      this.cleanupFns.push(() => searchInput.removeEventListener("input", onInput));

      const onKeydown = (e: KeyboardEvent) => {
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
            const p = filtered[this.focusedModalRowIndex];
            this.options.onSelect(p);
            this.addToRecents(p.symbol);
            this.close();
          }
        } else if (e.key === "Escape") {
          this.close();
        }
      };
      searchInput.addEventListener("keydown", onKeydown);
      this.cleanupFns.push(() => searchInput.removeEventListener("keydown", onKeydown));
    }

    if (clearBtn) {
      const handler = () => {
        if (searchInput) searchInput.value = "";
        this.searchQuery = "";
        clearBtn.classList.add("hidden");
        this.focusedModalRowIndex = 0;
        this.render();
        searchInput?.focus();
      };
      clearBtn.addEventListener("click", handler);
      this.cleanupFns.push(() => clearBtn.removeEventListener("click", handler));
    }

    // Global '/' hotkey to open search modal (when not inside an input)
    const onDocKeydown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInput =
        activeEl?.tagName === "INPUT" ||
        activeEl?.tagName === "TEXTAREA" ||
        activeEl?.tagName === "SELECT";
      if (e.key === "/" && !isInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.open();
      }
    };
    document.addEventListener("keydown", onDocKeydown);
    this.cleanupFns.push(() => document.removeEventListener("keydown", onDocKeydown));

    // Sort column headers
    document.querySelectorAll(".sort-col-btn").forEach((btn) => {
      const handler = () => {
        const sort = (btn as HTMLElement).dataset.sort as SortField;
        if (sort) {
          this.setSort(sort);
        }
      };
      btn.addEventListener("click", handler);
      this.cleanupFns.push(() => btn.removeEventListener("click", handler));
    });

    // Sort dropdown menu button
    const sortMenuBtn = document.getElementById("modalSortMenuBtn");
    const sortDropdown = document.getElementById("modalSortDropdown");

    if (sortMenuBtn && sortDropdown) {
      const toggleHandler = (e: MouseEvent) => {
        e.stopPropagation();
        sortDropdown.classList.toggle("hidden");
      };
      sortMenuBtn.addEventListener("click", toggleHandler);
      this.cleanupFns.push(() => sortMenuBtn.removeEventListener("click", toggleHandler));

      document.querySelectorAll(".sort-option").forEach((opt) => {
        const optHandler = (e: Event) => {
          e.stopPropagation();
          const sort = (opt as HTMLElement).dataset.sort as SortField;
          if (sort) {
            this.setSort(sort);
            sortDropdown.classList.add("hidden");
          }
        };
        opt.addEventListener("click", optHandler);
        this.cleanupFns.push(() => opt.removeEventListener("click", optHandler));
      });

      const outsideHandler = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!target.closest("#modalSortMenuBtn") && !target.closest("#modalSortDropdown")) {
          sortDropdown.classList.add("hidden");
        }
      };
      document.addEventListener("click", outsideHandler);
      this.cleanupFns.push(() => document.removeEventListener("click", outsideHandler));
    }

    // Venue switcher toggle buttons
    const rhBtn = document.getElementById("venueBtnRh");
    if (rhBtn) {
      const handler = () => this.setVenue("rh");
      rhBtn.addEventListener("click", handler);
      this.cleanupFns.push(() => rhBtn.removeEventListener("click", handler));
    }

    const coreBtn = document.getElementById("venueBtnCore");
    if (coreBtn) {
      const handler = () => this.setVenue("core");
      coreBtn.addEventListener("click", handler);
      this.cleanupFns.push(() => coreBtn.removeEventListener("click", handler));
    }
  }
}
