import {
  fetchMarketPairs,
  MarketModal,
  getHedgeSideConfig,
  formatPrice,
  formatPriceForInput,
  formatMoney,
  formatFee,
  type AnalyticsMarketPair,
} from "../shared";
import {
  calculateCalculatorResults,
  formatSignedBps,
  formatSignedCents,
  formatSignedMoney,
} from "./math";
import type { CalculatorResults, CalculatorState, SizeMode, SpreadMode } from "./types";

export interface MarketItem {
  symbol: string;
  price: number;
  categoryLabel: string;
}

export const CALC_STORAGE_KEYS = {
  SYMBOL: "calculator_symbol",
  PRICE: "calculator_price",
  SIZE_MODE: "calculator_size_mode",
  SIZE_VALUE: "calculator_size_value",
  ENTRY_SPREAD_MODE: "calculator_entry_spread_mode",
  ENTRY_SPREAD_VALUE: "calculator_entry_spread_value",
  ENTRY_CHEAPER_SIDE: "calculator_entry_cheaper_side",
  EXIT_SPREAD_MODE: "calculator_exit_spread_mode",
  EXIT_SPREAD_VALUE: "calculator_exit_spread_value",
  EXIT_CHEAPER_SIDE: "calculator_exit_cheaper_side",
  FEE_RATE_BPS: "calculator_fee_rate_bps",
  IS_CUSTOM_PRICE: "calculator_is_custom_price",
} as const;

const DEFAULT_MARKETS: MarketItem[] = [
  { symbol: "BTC", price: 95000, categoryLabel: "Crypto" },
  { symbol: "ETH", price: 2800, categoryLabel: "Crypto" },
  { symbol: "SOL", price: 180, categoryLabel: "Crypto" },
  { symbol: "NVDA", price: 135, categoryLabel: "Equities" },
  { symbol: "AAPL", price: 230, categoryLabel: "Equities" },
  { symbol: "TSLA", price: 260, categoryLabel: "Equities" },
  { symbol: "AMZN", price: 190, categoryLabel: "Equities" },
  { symbol: "MSFT", price: 420, categoryLabel: "Equities" },
  { symbol: "XAU", price: 2750, categoryLabel: "Commodities" },
  { symbol: "XAG", price: 32, categoryLabel: "Commodities" },
  { symbol: "SPY", price: 580, categoryLabel: "ETFs" },
  { symbol: "QQQ", price: 490, categoryLabel: "ETFs" },
];

export class CalculatorController {
  public state: CalculatorState = {
    symbol: "BTC",
    price: 95000,
    sizeMode: "usd",
    sizeValue: 10000,
    entrySpreadMode: "bps",
    entrySpreadValue: 5,
    entryCheaperSide: "core",
    exitSpreadMode: "bps",
    exitSpreadValue: 20,
    exitCheaperSide: "core",
    feeRateBps: 0,
  };

  public markets: Map<string, MarketItem> = new Map();
  public marketModal: MarketModal | null = null;
  private pairs: AnalyticsMarketPair[] = [];
  private fetchInFlight = false;
  private isCustomPrice = false;

  public init(): void {
    // 1. Initialize fallback markets
    for (const m of DEFAULT_MARKETS) {
      this.markets.set(m.symbol, m);
    }

    // 2. Load persisted state from localStorage so parameters persist on reload
    this.loadSettings();

    // 3. Read query params if present (URL params take precedence over storage)
    try {
      const url = new URL(window.location.href);
      const tokenParam = url.searchParams.get("token") || url.searchParams.get("symbol");
      if (tokenParam) {
        const clean = tokenParam.toUpperCase().trim();
        if (clean && clean !== this.state.symbol) {
          this.state.symbol = clean;
          this.isCustomPrice = false;
          this.state.price = 0;
        }
      }
      const sizeParam = url.searchParams.get("size");
      if (sizeParam && !isNaN(Number(sizeParam))) {
        this.state.sizeValue = Number(sizeParam);
      }
    } catch {}

    // 4. Initialize Shared Market Selection Modal (reused from /analytics)
    this.marketModal = new MarketModal({
      activeSymbol: this.state.symbol,
      onSelect: (pair) => {
        const mark = pair.markPrice || pair.rh.markPrice || pair.core.markPrice;
        this.setSymbol(pair.symbol, mark);
      },
    });
    this.marketModal.init();

    // 5. Bind DOM events & sync UI elements with loaded state
    this.bindEvents();
    this.syncInputsFromState();
    this.updatePriceFromSymbol();
    this.updateCheaperButtons();
    this.updateFeeButtons();
    this.renderQuickSpreadButtons();
    this.recalculate();

    // 6. Fetch live market pairs from Lighter APIs
    this.fetchLiveMarkets();
  }

  public saveSettings(): void {
    try {
      localStorage.setItem(CALC_STORAGE_KEYS.SYMBOL, this.state.symbol);
      localStorage.setItem(CALC_STORAGE_KEYS.PRICE, String(this.state.price));
      localStorage.setItem(CALC_STORAGE_KEYS.SIZE_MODE, this.state.sizeMode);
      localStorage.setItem(CALC_STORAGE_KEYS.SIZE_VALUE, String(this.state.sizeValue));
      localStorage.setItem(CALC_STORAGE_KEYS.ENTRY_SPREAD_MODE, this.state.entrySpreadMode);
      localStorage.setItem(
        CALC_STORAGE_KEYS.ENTRY_SPREAD_VALUE,
        String(this.state.entrySpreadValue),
      );
      localStorage.setItem(CALC_STORAGE_KEYS.ENTRY_CHEAPER_SIDE, this.state.entryCheaperSide);
      localStorage.setItem(CALC_STORAGE_KEYS.EXIT_SPREAD_MODE, this.state.exitSpreadMode);
      localStorage.setItem(CALC_STORAGE_KEYS.EXIT_SPREAD_VALUE, String(this.state.exitSpreadValue));
      localStorage.setItem(CALC_STORAGE_KEYS.EXIT_CHEAPER_SIDE, this.state.exitCheaperSide);
      localStorage.setItem(CALC_STORAGE_KEYS.FEE_RATE_BPS, String(this.state.feeRateBps));
      localStorage.setItem(CALC_STORAGE_KEYS.IS_CUSTOM_PRICE, String(this.isCustomPrice));
    } catch {}
  }

  public loadSettings(): void {
    try {
      const savedCustomPrice = localStorage.getItem(CALC_STORAGE_KEYS.IS_CUSTOM_PRICE);
      if (savedCustomPrice !== null) {
        this.isCustomPrice = savedCustomPrice === "true";
      }

      const savedSymbol = localStorage.getItem(CALC_STORAGE_KEYS.SYMBOL);
      if (savedSymbol && savedSymbol.trim()) {
        this.state.symbol = savedSymbol.toUpperCase().trim();
      }

      const savedPrice = localStorage.getItem(CALC_STORAGE_KEYS.PRICE);
      if (savedPrice) {
        const p = parseFloat(savedPrice);
        if (!isNaN(p) && p > 0) this.state.price = p;
      }

      const savedSizeMode = localStorage.getItem(CALC_STORAGE_KEYS.SIZE_MODE);
      if (savedSizeMode === "usd" || savedSizeMode === "tokens") {
        this.state.sizeMode = savedSizeMode;
      }

      const savedSizeVal = localStorage.getItem(CALC_STORAGE_KEYS.SIZE_VALUE);
      if (savedSizeVal) {
        const s = parseFloat(savedSizeVal);
        if (!isNaN(s) && s >= 0) this.state.sizeValue = s;
      }

      const savedEntryMode = localStorage.getItem(CALC_STORAGE_KEYS.ENTRY_SPREAD_MODE);
      if (savedEntryMode === "bps" || savedEntryMode === "cents") {
        this.state.entrySpreadMode = savedEntryMode;
      }

      const savedEntryVal = localStorage.getItem(CALC_STORAGE_KEYS.ENTRY_SPREAD_VALUE);
      if (savedEntryVal) {
        const ev = parseFloat(savedEntryVal);
        if (!isNaN(ev)) this.state.entrySpreadValue = ev;
      }

      const savedEntryCheaper = localStorage.getItem(CALC_STORAGE_KEYS.ENTRY_CHEAPER_SIDE);
      if (savedEntryCheaper === "rh" || savedEntryCheaper === "core") {
        this.state.entryCheaperSide = savedEntryCheaper;
      }

      const savedExitMode = localStorage.getItem(CALC_STORAGE_KEYS.EXIT_SPREAD_MODE);
      if (savedExitMode === "bps" || savedExitMode === "cents") {
        this.state.exitSpreadMode = savedExitMode;
      }

      const savedExitVal = localStorage.getItem(CALC_STORAGE_KEYS.EXIT_SPREAD_VALUE);
      if (savedExitVal) {
        const xv = parseFloat(savedExitVal);
        if (!isNaN(xv)) this.state.exitSpreadValue = xv;
      }

      const savedExitCheaper = localStorage.getItem(CALC_STORAGE_KEYS.EXIT_CHEAPER_SIDE);
      if (savedExitCheaper === "rh" || savedExitCheaper === "core") {
        this.state.exitCheaperSide = savedExitCheaper;
      }

      const savedFee = localStorage.getItem(CALC_STORAGE_KEYS.FEE_RATE_BPS);
      if (savedFee) {
        const f = parseFloat(savedFee);
        if (!isNaN(f) && f >= 0) this.state.feeRateBps = f;
      }
    } catch {}
  }

  public setSymbol(symbol: string, price?: number): void {
    const isNewSymbol = symbol !== this.state.symbol;
    this.state.symbol = symbol;
    if (isNewSymbol) {
      this.isCustomPrice = false;
    }

    if (price && price > 0) {
      this.state.price = price;
    } else {
      const m = this.markets.get(symbol);
      if (m && m.price > 0) {
        this.state.price = m.price;
      }
    }

    this.updatePriceInput(this.state.price);

    if (this.marketModal) {
      this.marketModal.setActiveSymbol(symbol);
    }

    this.saveSettings();
    this.recalculate();
  }

  private async fetchLiveMarkets(): Promise<void> {
    if (this.fetchInFlight) return;
    this.fetchInFlight = true;

    try {
      const pairs = await fetchMarketPairs();
      this.pairs = pairs;

      for (const p of pairs) {
        const mark = p.markPrice || p.rh.markPrice || p.core.markPrice;
        this.markets.set(p.symbol, {
          symbol: p.symbol,
          price: mark,
          categoryLabel: p.hedgeSideConfig.categoryLabel,
        });
      }

      if (this.marketModal) {
        this.marketModal.setPairs(pairs);
      }

      const activePair = pairs.find((p) => p.symbol === this.state.symbol);
      if (activePair && !this.isCustomPrice) {
        const mark = activePair.markPrice || activePair.rh.markPrice || activePair.core.markPrice;
        if (mark > 0) {
          this.state.price = mark;
          this.updatePriceInput(mark);
        }
      }

      this.saveSettings();
      this.recalculate();
    } catch (e) {
      console.warn("Failed to fetch live markets for calculator:", e);
    } finally {
      this.fetchInFlight = false;
    }
  }

  private syncInputsFromState(): void {
    // 1. Size mode buttons & input
    const btnSizeUsd = document.getElementById("btnSizeUsd");
    const btnSizeTokens = document.getElementById("btnSizeTokens");
    const inputSize = document.getElementById("inputSize") as HTMLInputElement | null;
    const labelSizePrefix = document.getElementById("labelSizePrefix");

    if (btnSizeUsd && btnSizeTokens) {
      if (this.state.sizeMode === "usd") {
        btnSizeUsd.className =
          "px-2.5 py-1 rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none";
        btnSizeTokens.className =
          "px-2.5 py-1 rounded bg-terminal-bg text-terminal-muted hover:text-white transition cursor-pointer select-none";
        if (labelSizePrefix) labelSizePrefix.textContent = "$";
        if (inputSize) inputSize.placeholder = "10,000";
      } else {
        btnSizeTokens.className =
          "px-2.5 py-1 rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none";
        btnSizeUsd.className =
          "px-2.5 py-1 rounded bg-terminal-bg text-terminal-muted hover:text-white transition cursor-pointer select-none";
        if (labelSizePrefix) labelSizePrefix.textContent = "QTY";
        if (inputSize) inputSize.placeholder = "1.5";
      }
    }

    if (inputSize) {
      inputSize.value =
        this.state.sizeMode === "usd"
          ? Math.round(this.state.sizeValue).toString()
          : this.state.sizeValue.toFixed(4).replace(/\.?0+$/, "");
    }

    // 2. Entry spread buttons & input
    const btnEntryCents = document.getElementById("btnEntryCents");
    const btnEntryBps = document.getElementById("btnEntryBps");
    const inputEntrySpread = document.getElementById("inputEntrySpread") as HTMLInputElement | null;
    const labelEntryUnit = document.getElementById("labelEntryUnit");

    if (btnEntryCents && btnEntryBps) {
      if (this.state.entrySpreadMode === "cents") {
        btnEntryCents.className =
          "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none text-center leading-none";
        btnEntryBps.className =
          "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none text-center leading-none border border-transparent";
        if (labelEntryUnit) labelEntryUnit.textContent = "¢";
      } else {
        btnEntryBps.className =
          "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none text-center leading-none";
        btnEntryCents.className =
          "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none text-center leading-none border border-transparent";
        if (labelEntryUnit) labelEntryUnit.textContent = "bps";
      }
    }

    if (inputEntrySpread) {
      inputEntrySpread.value = this.state.entrySpreadValue.toFixed(2).replace(/\.?0+$/, "");
    }

    // 3. Exit spread buttons & input
    const btnExitCents = document.getElementById("btnExitCents");
    const btnExitBps = document.getElementById("btnExitBps");
    const inputExitSpread = document.getElementById("inputExitSpread") as HTMLInputElement | null;
    const labelExitUnit = document.getElementById("labelExitUnit");

    if (btnExitCents && btnExitBps) {
      if (this.state.exitSpreadMode === "cents") {
        btnExitCents.className =
          "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none text-center leading-none";
        btnExitBps.className =
          "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none text-center leading-none border border-transparent";
        if (labelExitUnit) labelExitUnit.textContent = "¢";
      } else {
        btnExitBps.className =
          "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none text-center leading-none";
        btnExitCents.className =
          "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none text-center leading-none border border-transparent";
        if (labelExitUnit) labelExitUnit.textContent = "bps";
      }
    }

    if (inputExitSpread) {
      inputExitSpread.value = this.state.exitSpreadValue.toFixed(2).replace(/\.?0+$/, "");
    }

    // 4. Fee rate input
    const inputFeeRate = document.getElementById("inputFeeRate") as HTMLInputElement | null;
    if (inputFeeRate) {
      inputFeeRate.value = this.state.feeRateBps.toString();
    }

    // 5. Price input
    this.updatePriceInput(this.state.price);

    // 6. Quick Spread Buttons
    this.renderQuickSpreadButtons();
  }

  private updatePriceFromSymbol(force = false): void {
    if (force || this.state.price <= 0) {
      const m = this.markets.get(this.state.symbol);
      if (m && m.price > 0) {
        this.state.price = m.price;
      }
    }
    this.updatePriceInput(this.state.price);
    if (this.marketModal) {
      this.marketModal.setActiveSymbol(this.state.symbol);
    }
  }

  private updatePriceInput(price: number): void {
    const priceInput = document.getElementById("inputTokenPrice") as HTMLInputElement | null;
    if (priceInput && price > 0) {
      priceInput.value = formatPriceForInput(price);
    }
  }

  private updateCheaperButtons(): void {
    const btnEntryRh = document.getElementById("btnEntryCheaperRh");
    const btnEntryCore = document.getElementById("btnEntryCheaperCore");
    const isEntryRh =
      this.state.entrySpreadValue < 0 ||
      (this.state.entrySpreadValue === 0 && this.state.entryCheaperSide === "rh");

    if (btnEntryRh && btnEntryCore) {
      if (isEntryRh) {
        btnEntryRh.className =
          "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none leading-none";
        btnEntryCore.className =
          "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none leading-none border border-transparent";
      } else {
        btnEntryCore.className =
          "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none leading-none";
        btnEntryRh.className =
          "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none leading-none border border-transparent";
      }
    }

    const btnExitRh = document.getElementById("btnExitCheaperRh");
    const btnExitCore = document.getElementById("btnExitCheaperCore");
    const isExitRh =
      this.state.exitSpreadValue < 0 ||
      (this.state.exitSpreadValue === 0 && this.state.exitCheaperSide === "rh");

    if (btnExitRh && btnExitCore) {
      if (isExitRh) {
        btnExitRh.className =
          "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none leading-none";
        btnExitCore.className =
          "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none leading-none border border-transparent";
      } else {
        btnExitCore.className =
          "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none leading-none";
        btnExitRh.className =
          "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none leading-none border border-transparent";
      }
    }
  }

  private updateFeeButtons(): void {
    const feePresets = document.querySelectorAll<HTMLButtonElement>("[data-fee-bps]");
    feePresets.forEach((btn) => {
      const fee = parseFloat(btn.dataset.feeBps || "0");
      if (Math.abs(fee - this.state.feeRateBps) < 0.01) {
        btn.className =
          "px-2 py-0.5 rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none";
      } else {
        btn.className =
          "px-2 py-0.5 rounded bg-terminal-bg border border-terminal-border hover:border-terminal-muted text-terminal-secondary hover:text-white transition cursor-pointer select-none";
      }
    });
  }

  public renderQuickSpreadButtons(): void {
    this.renderQuickSpreadButtonsForTarget("entry");
    this.renderQuickSpreadButtonsForTarget("exit");
  }

  private renderQuickSpreadButtonsForTarget(target: "entry" | "exit"): void {
    const container = document.getElementById(
      target === "entry" ? "quickEntrySpreadButtons" : "quickExitSpreadButtons",
    );
    if (!container) return;

    const mode = target === "entry" ? this.state.entrySpreadMode : this.state.exitSpreadMode;
    const cheaperSide =
      target === "entry" ? this.state.entryCheaperSide : this.state.exitCheaperSide;
    const currentValue =
      target === "entry" ? this.state.entrySpreadValue : this.state.exitSpreadValue;

    const values = mode === "bps" ? [1, 2, 3, 4, 5] : [5, 10, 15, 20, 25];

    // Clear previous buttons safely
    container.innerHTML = "";

    values.forEach((val) => {
      const signedVal = cheaperSide === "rh" ? -val : val;
      const isActive = Math.abs(currentValue - signedVal) < 0.001;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = mode === "bps" ? `${val} bps` : `${val}¢`;
      btn.className = isActive
        ? "px-1.5 py-0.5 rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs text-[10px] font-mono cursor-pointer select-none"
        : "px-1.5 py-0.5 rounded bg-terminal-bg border border-terminal-border hover:border-terminal-muted text-[10px] font-mono text-terminal-secondary hover:text-white transition cursor-pointer select-none";

      btn.addEventListener("click", () => {
        if (target === "entry") {
          this.state.entrySpreadValue = signedVal;
          const input = document.getElementById("inputEntrySpread") as HTMLInputElement | null;
          if (input) input.value = signedVal.toString();
        } else {
          this.state.exitSpreadValue = signedVal;
          const input = document.getElementById("inputExitSpread") as HTMLInputElement | null;
          if (input) input.value = signedVal.toString();
        }

        this.renderQuickSpreadButtons();
        this.saveSettings();
        this.recalculate();
      });

      container.appendChild(btn);
    });
  }

  private formatLegHtml(venue: "RH" | "Core", side: "Long" | "Short" | "Buy" | "Sell"): string {
    const venueColor = venue === "RH" ? "text-terminal-emerald" : "text-terminal-accent";
    return `<span class="${venueColor}">${venue} ${side}</span>`;
  }

  private bindEvents(): void {
    // 1. Asset Price Input (Customizable)
    const priceInput = document.getElementById("inputTokenPrice") as HTMLInputElement | null;
    if (priceInput) {
      priceInput.addEventListener("input", () => {
        const val = parseFloat(priceInput.value);
        if (!isNaN(val) && val > 0) {
          this.state.price = val;
          this.isCustomPrice = true;
          this.saveSettings();
          this.recalculate();
        }
      });
    }

    // 2. Size Mode Switcher (USD vs Tokens)
    const btnSizeUsd = document.getElementById("btnSizeUsd");
    const btnSizeTokens = document.getElementById("btnSizeTokens");
    const inputSize = document.getElementById("inputSize") as HTMLInputElement | null;
    const labelSizePrefix = document.getElementById("labelSizePrefix");

    const setSizeMode = (mode: SizeMode) => {
      if (this.state.sizeMode === mode) return;
      if (mode === "tokens") {
        this.state.sizeValue = this.state.price > 0 ? this.state.sizeValue / this.state.price : 0;
      } else {
        this.state.sizeValue = this.state.sizeValue * this.state.price;
      }
      this.state.sizeMode = mode;

      if (btnSizeUsd && btnSizeTokens) {
        if (mode === "usd") {
          btnSizeUsd.className =
            "px-2.5 py-1 rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none";
          btnSizeTokens.className =
            "px-2.5 py-1 rounded bg-terminal-bg text-terminal-muted hover:text-white transition cursor-pointer select-none";
          if (labelSizePrefix) labelSizePrefix.textContent = "$";
          if (inputSize) inputSize.placeholder = "10,000";
        } else {
          btnSizeTokens.className =
            "px-2.5 py-1 rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none";
          btnSizeUsd.className =
            "px-2.5 py-1 rounded bg-terminal-bg text-terminal-muted hover:text-white transition cursor-pointer select-none";
          if (labelSizePrefix) labelSizePrefix.textContent = "QTY";
          if (inputSize) inputSize.placeholder = "1.5";
        }
      }

      if (inputSize) {
        inputSize.value =
          mode === "usd"
            ? Math.round(this.state.sizeValue).toString()
            : this.state.sizeValue.toFixed(4).replace(/\.?0+$/, "");
      }
      this.saveSettings();
      this.recalculate();
    };

    btnSizeUsd?.addEventListener("click", () => setSizeMode("usd"));
    btnSizeTokens?.addEventListener("click", () => setSizeMode("tokens"));

    if (inputSize) {
      inputSize.addEventListener("input", () => {
        const val = parseFloat(inputSize.value);
        this.state.sizeValue = isNaN(val) ? 0 : val;
        this.saveSettings();
        this.recalculate();
      });
    }

    // Quick Size Buttons
    const quickSizes = document.querySelectorAll<HTMLButtonElement>("[data-quick-size]");
    quickSizes.forEach((btn) => {
      btn.addEventListener("click", () => {
        const usdVal = parseFloat(btn.dataset.quickSize || "0");
        if (usdVal > 0) {
          if (this.state.sizeMode === "usd") {
            this.state.sizeValue = usdVal;
            if (inputSize) inputSize.value = usdVal.toString();
          } else {
            this.state.sizeValue = this.state.price > 0 ? usdVal / this.state.price : 0;
            if (inputSize) inputSize.value = this.state.sizeValue.toFixed(4).replace(/\.?0+$/, "");
          }
          this.saveSettings();
          this.recalculate();
        }
      });
    });

    // 3. Entry Spread Controls: bps vs Cents & RH vs Core cheaper
    const btnEntryCents = document.getElementById("btnEntryCents");
    const btnEntryBps = document.getElementById("btnEntryBps");
    const btnEntryCheaperRh = document.getElementById("btnEntryCheaperRh");
    const btnEntryCheaperCore = document.getElementById("btnEntryCheaperCore");
    const inputEntrySpread = document.getElementById("inputEntrySpread") as HTMLInputElement | null;
    const labelEntryUnit = document.getElementById("labelEntryUnit");

    const setEntrySpreadMode = (mode: SpreadMode) => {
      if (this.state.entrySpreadMode === mode) return;
      if (mode === "cents") {
        this.state.entrySpreadValue =
          this.state.price > 0 ? (this.state.entrySpreadValue / 10000) * this.state.price * 100 : 0;
      } else {
        this.state.entrySpreadValue =
          this.state.price > 0 ? (this.state.entrySpreadValue / 100 / this.state.price) * 10000 : 0;
      }
      this.state.entrySpreadMode = mode;

      if (btnEntryCents && btnEntryBps) {
        if (mode === "cents") {
          btnEntryCents.className =
            "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none text-center leading-none";
          btnEntryBps.className =
            "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none text-center leading-none border border-transparent";
          if (labelEntryUnit) labelEntryUnit.textContent = "¢";
          if (inputEntrySpread) inputEntrySpread.placeholder = "10.0";
        } else {
          btnEntryBps.className =
            "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none text-center leading-none";
          btnEntryCents.className =
            "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none text-center leading-none border border-transparent";
          if (labelEntryUnit) labelEntryUnit.textContent = "bps";
          if (inputEntrySpread) inputEntrySpread.placeholder = "5.0";
        }
      }

      if (inputEntrySpread) {
        inputEntrySpread.value = this.state.entrySpreadValue.toFixed(2).replace(/\.?0+$/, "");
      }
      this.renderQuickSpreadButtons();
      this.saveSettings();
      this.recalculate();
    };

    btnEntryCents?.addEventListener("click", () => setEntrySpreadMode("cents"));
    btnEntryBps?.addEventListener("click", () => setEntrySpreadMode("bps"));

    btnEntryCheaperRh?.addEventListener("click", () => {
      this.state.entryCheaperSide = "rh";
      if (this.state.entrySpreadValue > 0) {
        this.state.entrySpreadValue = -Math.abs(this.state.entrySpreadValue);
      }
      if (inputEntrySpread) {
        inputEntrySpread.value = this.state.entrySpreadValue.toString();
      }
      this.updateCheaperButtons();
      this.renderQuickSpreadButtons();
      this.saveSettings();
      this.recalculate();
    });

    btnEntryCheaperCore?.addEventListener("click", () => {
      this.state.entryCheaperSide = "core";
      if (this.state.entrySpreadValue < 0) {
        this.state.entrySpreadValue = Math.abs(this.state.entrySpreadValue);
      }
      if (inputEntrySpread) {
        inputEntrySpread.value = this.state.entrySpreadValue.toString();
      }
      this.updateCheaperButtons();
      this.renderQuickSpreadButtons();
      this.saveSettings();
      this.recalculate();
    });

    if (inputEntrySpread) {
      inputEntrySpread.addEventListener("input", () => {
        const raw = inputEntrySpread.value.trim();
        const val = parseFloat(raw);
        if (isNaN(val)) {
          this.state.entrySpreadValue = 0;
        } else if (raw.startsWith("-") || val < 0) {
          this.state.entryCheaperSide = "rh";
          this.state.entrySpreadValue = -Math.abs(val);
        } else if (raw.startsWith("+")) {
          this.state.entryCheaperSide = "core";
          this.state.entrySpreadValue = Math.abs(val);
        } else {
          const mag = Math.abs(val);
          this.state.entrySpreadValue = this.state.entryCheaperSide === "rh" ? -mag : mag;
        }
        this.updateCheaperButtons();
        this.renderQuickSpreadButtons();
        this.saveSettings();
        this.recalculate();
      });
    }

    // 4. Exit Spread Controls: bps vs Cents & RH vs Core cheaper
    const btnExitCents = document.getElementById("btnExitCents");
    const btnExitBps = document.getElementById("btnExitBps");
    const btnExitCheaperRh = document.getElementById("btnExitCheaperRh");
    const btnExitCheaperCore = document.getElementById("btnExitCheaperCore");
    const inputExitSpread = document.getElementById("inputExitSpread") as HTMLInputElement | null;
    const labelExitUnit = document.getElementById("labelExitUnit");

    const setExitSpreadMode = (mode: SpreadMode) => {
      if (this.state.exitSpreadMode === mode) return;
      if (mode === "cents") {
        this.state.exitSpreadValue =
          this.state.price > 0 ? (this.state.exitSpreadValue / 10000) * this.state.price * 100 : 0;
      } else {
        this.state.exitSpreadValue =
          this.state.price > 0 ? (this.state.exitSpreadValue / 100 / this.state.price) * 10000 : 0;
      }
      this.state.exitSpreadMode = mode;

      if (btnExitCents && btnExitBps) {
        if (mode === "cents") {
          btnExitCents.className =
            "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none text-center leading-none";
          btnExitBps.className =
            "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none text-center leading-none border border-transparent";
          if (labelExitUnit) labelExitUnit.textContent = "¢";
          if (inputExitSpread) inputExitSpread.placeholder = "30.0";
        } else {
          btnExitBps.className =
            "px-2 py-1 flex items-center justify-center rounded bg-terminal-surface text-white font-bold border border-terminal-border shadow-xs cursor-pointer select-none text-center leading-none";
          btnExitCents.className =
            "px-2 py-1 flex items-center justify-center rounded text-terminal-muted hover:text-white transition cursor-pointer select-none text-center leading-none border border-transparent";
          if (labelExitUnit) labelExitUnit.textContent = "bps";
          if (inputExitSpread) inputExitSpread.placeholder = "20.0";
        }
      }

      if (inputExitSpread) {
        inputExitSpread.value = this.state.exitSpreadValue.toFixed(2).replace(/\.?0+$/, "");
      }
      this.renderQuickSpreadButtons();
      this.saveSettings();
      this.recalculate();
    };

    btnExitCents?.addEventListener("click", () => setExitSpreadMode("cents"));
    btnExitBps?.addEventListener("click", () => setExitSpreadMode("bps"));

    btnExitCheaperRh?.addEventListener("click", () => {
      this.state.exitCheaperSide = "rh";
      if (this.state.exitSpreadValue > 0) {
        this.state.exitSpreadValue = -Math.abs(this.state.exitSpreadValue);
      }
      if (inputExitSpread) {
        inputExitSpread.value = this.state.exitSpreadValue.toString();
      }
      this.updateCheaperButtons();
      this.renderQuickSpreadButtons();
      this.saveSettings();
      this.recalculate();
    });

    btnExitCheaperCore?.addEventListener("click", () => {
      this.state.exitCheaperSide = "core";
      if (this.state.exitSpreadValue < 0) {
        this.state.exitSpreadValue = Math.abs(this.state.exitSpreadValue);
      }
      if (inputExitSpread) {
        inputExitSpread.value = this.state.exitSpreadValue.toString();
      }
      this.updateCheaperButtons();
      this.renderQuickSpreadButtons();
      this.saveSettings();
      this.recalculate();
    });

    if (inputExitSpread) {
      inputExitSpread.addEventListener("input", () => {
        const raw = inputExitSpread.value.trim();
        const val = parseFloat(raw);
        if (isNaN(val)) {
          this.state.exitSpreadValue = 0;
        } else if (raw.startsWith("-") || val < 0) {
          this.state.exitCheaperSide = "rh";
          this.state.exitSpreadValue = -Math.abs(val);
        } else if (raw.startsWith("+")) {
          this.state.exitCheaperSide = "core";
          this.state.exitSpreadValue = Math.abs(val);
        } else {
          const mag = Math.abs(val);
          this.state.exitSpreadValue = this.state.exitCheaperSide === "rh" ? -mag : mag;
        }
        this.updateCheaperButtons();
        this.renderQuickSpreadButtons();
        this.saveSettings();
        this.recalculate();
      });
    }

    // 5. Exchange Fees (Free, Premium, Taker presets & custom input)
    const inputFeeRate = document.getElementById("inputFeeRate") as HTMLInputElement | null;
    if (inputFeeRate) {
      inputFeeRate.addEventListener("input", () => {
        const val = parseFloat(inputFeeRate.value);
        this.state.feeRateBps = isNaN(val) ? 0 : val;
        this.updateFeeButtons();
        this.saveSettings();
        this.recalculate();
      });
    }

    const feePresets = document.querySelectorAll<HTMLButtonElement>("[data-fee-bps]");
    feePresets.forEach((btn) => {
      btn.addEventListener("click", () => {
        const fee = parseFloat(btn.dataset.feeBps || "0");
        this.state.feeRateBps = fee;
        if (inputFeeRate) inputFeeRate.value = fee.toString();
        this.updateFeeButtons();
        this.saveSettings();
        this.recalculate();
      });
    });
  }

  public recalculate(): CalculatorResults {
    const res = calculateCalculatorResults(this.state);
    this.renderResults(res);
    return res;
  }

  private renderResults(r: CalculatorResults): void {
    // 1. Sync inline helpers below input fields
    const labelSizeEquiv = document.getElementById("labelSizeEquivalent");
    if (labelSizeEquiv) {
      if (this.state.sizeMode === "usd") {
        labelSizeEquiv.textContent = `≈ ${r.sizeTokens.toFixed(4)} ${this.state.symbol}`;
      } else {
        labelSizeEquiv.textContent = `≈ ${formatMoney(r.sizeUsd)}`;
      }
    }

    const labelEntryEquiv = document.getElementById("labelEntryEquivalent");
    if (labelEntryEquiv) {
      if (this.state.entrySpreadMode === "cents") {
        labelEntryEquiv.textContent = `≈ ${formatSignedBps(r.entrySpreadBps)}`;
      } else {
        labelEntryEquiv.textContent = `≈ ${formatSignedCents(r.entrySpreadCents)} ($${r.entrySpreadUsd.toFixed(4)})`;
      }
    }

    const labelExitEquiv = document.getElementById("labelExitEquivalent");
    if (labelExitEquiv) {
      if (this.state.exitSpreadMode === "cents") {
        labelExitEquiv.textContent = `≈ ${formatSignedBps(r.exitSpreadBps)}`;
      } else {
        labelExitEquiv.textContent = `≈ ${formatSignedCents(r.exitSpreadCents)} ($${r.exitSpreadUsd.toFixed(4)})`;
      }
    }

    // 2. Execution Route Badge (using getHedgeSideConfig)
    const hedgeCfg = getHedgeSideConfig(this.state.symbol);
    const badgeCategory = document.getElementById("badgeCategory");
    const badgeOpenSides = document.getElementById("badgeOpenSides");
    const badgeCloseSides = document.getElementById("badgeCloseSides");

    if (badgeCategory) {
      badgeCategory.textContent = hedgeCfg.categoryLabel;
    }

    if (badgeOpenSides) {
      badgeOpenSides.innerHTML = `${this.formatLegHtml("RH", r.openRhSide)} <span class="text-white">·</span> ${this.formatLegHtml("Core", r.openCoreSide)}`;
    }
    if (badgeCloseSides) {
      badgeCloseSides.innerHTML = `${this.formatLegHtml("RH", r.closeRhSide)} <span class="text-white">·</span> ${this.formatLegHtml("Core", r.closeCoreSide)}`;
    }

    // 3. LEAD KPI STRIP (Matches /checker lead strip)
    const kpiToken = document.getElementById("kpiToken");
    if (kpiToken) {
      kpiToken.textContent = `${this.state.symbol} · $${formatPrice(this.state.price).replace("$", "")}`;
    }

    const kpiSpent = document.getElementById("kpiSpent");
    const kpiSpentSub = document.getElementById("kpiSpentSub");
    if (kpiSpent) {
      kpiSpent.textContent = formatMoney(r.sizeUsd);
    }
    if (kpiSpentSub) {
      kpiSpentSub.textContent = `${r.sizeTokens.toFixed(4)} ${this.state.symbol}`;
    }

    const kpiSpreadDelta = document.getElementById("kpiSpreadDelta");
    const kpiSpreadDeltaSub = document.getElementById("kpiSpreadDeltaSub");
    if (kpiSpreadDelta) {
      kpiSpreadDelta.textContent = formatSignedBps(r.spreadDeltaBps);
      kpiSpreadDelta.className = `font-mono font-bold text-sm tabular-nums mt-0.5 ${
        r.spreadDeltaBps > 0
          ? "text-terminal-emerald"
          : r.spreadDeltaBps < 0
            ? "text-terminal-coral"
            : "text-terminal-muted"
      }`;
    }
    if (kpiSpreadDeltaSub) {
      kpiSpreadDeltaSub.textContent = formatSignedCents(r.spreadDeltaCents);
    }

    const kpiSpreadPnl = document.getElementById("kpiSpreadPnl");
    if (kpiSpreadPnl) {
      kpiSpreadPnl.textContent = formatSignedMoney(r.spreadPnlUsd);
      kpiSpreadPnl.className = `font-mono font-bold text-sm tabular-nums mt-0.5 ${
        r.spreadPnlUsd > 0
          ? "text-terminal-emerald"
          : r.spreadPnlUsd < 0
            ? "text-terminal-coral"
            : "text-terminal-muted"
      }`;
    }

    const kpiFees = document.getElementById("kpiFees");
    const kpiFeesSub = document.getElementById("kpiFeesSub");
    if (kpiFees) {
      kpiFees.textContent = formatFee(r.totalFeesUsd);
    }
    if (kpiFeesSub) {
      kpiFeesSub.textContent =
        this.state.feeRateBps === 0 ? "0.0 bps" : `2× ${this.state.feeRateBps.toFixed(1)} bps`;
    }

    const kpiNetPnl = document.getElementById("kpiNetPnl");
    const kpiNetPnlSub = document.getElementById("kpiNetPnlSub");
    if (kpiNetPnl) {
      kpiNetPnl.textContent = formatSignedMoney(r.netPnlUsd);
      kpiNetPnl.className = `font-mono font-bold text-sm tabular-nums mt-0.5 ${
        r.netPnlUsd > 0
          ? "text-terminal-emerald"
          : r.netPnlUsd < 0
            ? "text-terminal-coral"
            : "text-terminal-muted"
      }`;
    }
    if (kpiNetPnlSub) {
      kpiNetPnlSub.textContent = `${formatSignedBps(r.netReturnBps)} (${r.netReturnPercent >= 0 ? "+" : ""}${r.netReturnPercent.toFixed(2)}%)`;
    }

    // 4. BREAKDOWN CARD 1: SPREAD DETAILS
    const valEntrySpreadFull = document.getElementById("valEntrySpreadFull");
    if (valEntrySpreadFull) {
      valEntrySpreadFull.textContent = `${formatSignedBps(r.entrySpreadBps)} (${formatSignedCents(r.entrySpreadCents)})`;
    }

    const valExitSpreadFull = document.getElementById("valExitSpreadFull");
    if (valExitSpreadFull) {
      valExitSpreadFull.textContent = `${formatSignedBps(r.exitSpreadBps)} (${formatSignedCents(r.exitSpreadCents)})`;
    }

    const valSpreadDeltaFull = document.getElementById("valSpreadDeltaFull");
    if (valSpreadDeltaFull) {
      valSpreadDeltaFull.textContent = `${formatSignedBps(r.spreadDeltaBps)} (${formatSignedCents(r.spreadDeltaCents)})`;
      valSpreadDeltaFull.className = `font-mono font-bold tabular-nums text-right ${
        r.spreadDeltaBps > 0
          ? "text-terminal-emerald"
          : r.spreadDeltaBps < 0
            ? "text-terminal-coral"
            : "text-terminal-muted"
      }`;
    }

    const valPerTokenGain = document.getElementById("valPerTokenGain");
    if (valPerTokenGain) {
      valPerTokenGain.textContent = `${formatSignedMoney(r.spreadDeltaUsd)} / token`;
      valPerTokenGain.className = `font-mono font-bold tabular-nums text-right ${
        r.spreadDeltaUsd > 0
          ? "text-terminal-emerald"
          : r.spreadDeltaUsd < 0
            ? "text-terminal-coral"
            : "text-terminal-muted"
      }`;
    }

    const valGrossSpreadPnl = document.getElementById("valGrossSpreadPnl");
    if (valGrossSpreadPnl) {
      valGrossSpreadPnl.textContent = formatSignedMoney(r.spreadPnlUsd);
      valGrossSpreadPnl.className = `font-mono font-bold tabular-nums text-right ${
        r.spreadPnlUsd > 0
          ? "text-terminal-emerald"
          : r.spreadPnlUsd < 0
            ? "text-terminal-coral"
            : "text-terminal-muted"
      }`;
    }

    // 5. BREAKDOWN CARD 2: CAPITAL & VOLUME (SPENT)
    const valPositionUsd = document.getElementById("valPositionUsd");
    if (valPositionUsd) {
      valPositionUsd.textContent = formatMoney(r.sizeUsd);
    }

    const valPositionTokens = document.getElementById("valPositionTokens");
    if (valPositionTokens) {
      valPositionTokens.textContent = `${r.sizeTokens.toFixed(4)} ${this.state.symbol}`;
    }

    const valAssetPrice = document.getElementById("valAssetPrice");
    if (valAssetPrice) {
      valAssetPrice.textContent = `$${formatPrice(this.state.price).replace("$", "")}`;
    }

    const valEstimatedMargin = document.getElementById("valEstimatedMargin");
    if (valEstimatedMargin) {
      valEstimatedMargin.textContent = `~${formatMoney(r.sizeUsd * 0.1)} (at 10x)`;
    }

    const valRoundTripVolume = document.getElementById("valRoundTripVolume");
    if (valRoundTripVolume) {
      valRoundTripVolume.textContent = formatMoney(r.sizeUsd * 4);
    }

    // 6. BREAKDOWN CARD 3: FINANCIAL SUMMARY & NET
    const valGrossPnlSummary = document.getElementById("valGrossPnlSummary");
    if (valGrossPnlSummary) {
      valGrossPnlSummary.textContent = formatSignedMoney(r.spreadPnlUsd);
      valGrossPnlSummary.className = `font-mono font-bold tabular-nums text-right ${
        r.spreadPnlUsd > 0
          ? "text-terminal-emerald"
          : r.spreadPnlUsd < 0
            ? "text-terminal-coral"
            : "text-terminal-muted"
      }`;
    }

    const valTotalFees = document.getElementById("valTotalFees");
    if (valTotalFees) {
      valTotalFees.textContent = formatFee(r.totalFeesUsd);
    }

    const valNetPnlFull = document.getElementById("valNetPnlFull");
    if (valNetPnlFull) {
      valNetPnlFull.textContent = formatSignedMoney(r.netPnlUsd);
      valNetPnlFull.className = `font-mono font-bold tabular-nums text-right ${
        r.netPnlUsd > 0
          ? "text-terminal-emerald"
          : r.netPnlUsd < 0
            ? "text-terminal-coral"
            : "text-terminal-muted"
      }`;
    }

    const valNetReturnRate = document.getElementById("valNetReturnRate");
    if (valNetReturnRate) {
      valNetReturnRate.textContent = `${formatSignedBps(r.netReturnBps)} (${r.netReturnPercent >= 0 ? "+" : ""}${r.netReturnPercent.toFixed(2)}%)`;
      valNetReturnRate.className = `font-mono font-semibold tabular-nums text-right ${
        r.netReturnBps > 0
          ? "text-terminal-emerald"
          : r.netReturnBps < 0
            ? "text-terminal-coral"
            : "text-terminal-muted"
      }`;
    }

    const valBreakEven = document.getElementById("valBreakEven");
    if (valBreakEven) {
      valBreakEven.textContent = `${formatSignedBps(r.breakEvenExitSpreadBps)} (${formatSignedCents(r.breakEvenExitSpreadCents)})`;
    }
  }
}
