import { describe, expect, it } from "bun:test";
import {
  calculateCalculatorResults,
  formatSignedBps,
  formatSignedCents,
  formatSignedMoney,
} from "../src/calculator/math";
import { formatPriceForInput } from "../src/shared";
import type { CalculatorState } from "../src/calculator/types";

function createMockContainer() {
  const children: any[] = [];
  return {
    children,
    set innerHTML(val: string) {
      if (val === "") children.length = 0;
    },
    get innerHTML() {
      return children.map((c) => c.textContent).join("");
    },
    appendChild(child: any) {
      children.push(child);
      return child;
    },
  };
}

function createMockBadge() {
  let htmlContent = "";
  let textContentVal = "";
  return {
    set innerHTML(val: string) {
      htmlContent = val;
      textContentVal = val.replace(/<[^>]*>/g, "");
    },
    get innerHTML() {
      return htmlContent;
    },
    set textContent(val: string) {
      textContentVal = val;
      htmlContent = val;
    },
    get textContent() {
      return textContentVal;
    },
  };
}

describe("Calculator Math Engine", () => {
  it("calculates basic trade metrics with size in USD and spreads in bps for Crypto (RH Long)", () => {
    const state: CalculatorState = {
      symbol: "BTC",
      price: 100000,
      sizeMode: "usd",
      sizeValue: 10000, // $10,000 USD
      entrySpreadMode: "bps",
      entrySpreadValue: 5, // entered at +5 bps
      entryCheaperSide: "core",
      exitSpreadMode: "bps",
      exitSpreadValue: 20, // exit at +20 bps
      exitCheaperSide: "core",
      feeRateBps: 0, // 0 fee
    };

    const res = calculateCalculatorResults(state);

    expect(res.sizeUsd).toBe(10000);
    expect(res.sizeTokens).toBeCloseTo(0.1, 6);

    expect(res.isRhLong).toBe(true);
    expect(res.openRhSide).toBe("Long");
    expect(res.openCoreSide).toBe("Short");
    expect(res.closeRhSide).toBe("Short");
    expect(res.closeCoreSide).toBe("Long");

    expect(res.entrySpreadBps).toBe(5);
    expect(res.entrySpreadUsd).toBeCloseTo(50, 4); // 5 bps of 100k = $50
    expect(res.entrySpreadCents).toBeCloseTo(5000, 2);

    expect(res.exitSpreadBps).toBe(20);
    expect(res.exitSpreadUsd).toBeCloseTo(200, 4); // 20 bps of 100k = $200

    expect(res.spreadDeltaBps).toBe(15); // 20 - 5 = 15 bps
    expect(res.spreadDeltaUsd).toBeCloseTo(150, 4); // 200 - 50 = $150 per token

    // Spread PnL = 15 bps of $10,000 = $15.00
    expect(res.spreadPnlUsd).toBeCloseTo(15.0, 4);
    expect(res.totalFeesUsd).toBe(0);
    expect(res.netPnlUsd).toBeCloseTo(15.0, 4);
    expect(res.netReturnBps).toBeCloseTo(15.0, 4);
  });

  it("calculates trade metrics for Equities (RH Short / Core Long)", () => {
    const state: CalculatorState = {
      symbol: "NVDA",
      price: 200,
      sizeMode: "tokens",
      sizeValue: 50, // 50 shares
      entrySpreadMode: "cents",
      entrySpreadValue: 40, // entered when spread was +40 cents ($0.40)
      entryCheaperSide: "core",
      exitSpreadMode: "cents",
      exitSpreadValue: 10, // exited when spread compressed to +10 cents ($0.10)
      exitCheaperSide: "core",
      feeRateBps: 1.2, // 1.2 bps (Premium tier)
    };

    const res = calculateCalculatorResults(state);

    expect(res.sizeTokens).toBe(50);
    expect(res.sizeUsd).toBe(10000); // 50 * 200 = $10,000

    expect(res.isRhLong).toBe(false);
    expect(res.openRhSide).toBe("Short");
    expect(res.openCoreSide).toBe("Long");
    expect(res.closeRhSide).toBe("Long");
    expect(res.closeCoreSide).toBe("Short");

    expect(res.entrySpreadCents).toBe(40);
    expect(res.entrySpreadUsd).toBeCloseTo(0.4, 4);
    expect(res.entrySpreadBps).toBeCloseTo(20.0, 4);

    expect(res.exitSpreadCents).toBe(10);
    expect(res.exitSpreadUsd).toBeCloseTo(0.1, 4);
    expect(res.exitSpreadBps).toBeCloseTo(5.0, 4);

    // For Equities: spread delta is entry - exit (compression of spread) = 40 - 10 = 30 cents
    expect(res.spreadDeltaCents).toBe(30);
    expect(res.spreadDeltaUsd).toBeCloseTo(0.3, 4);
    expect(res.spreadDeltaBps).toBeCloseTo(15.0, 4);

    // Spread PnL = 0.30 * 50 = $15.00
    expect(res.spreadPnlUsd).toBeCloseTo(15.0, 4);

    // Total fees: 10,000 * 2 * (1.2 / 10000) = $2.40 (open + close on RH)
    expect(res.totalFeesUsd).toBeCloseTo(2.4, 4);

    // Net PnL = 15.00 - 2.40 = $12.60
    expect(res.netPnlUsd).toBeCloseTo(12.6, 4);

    // Break-even exit spread: Entry ($0.40) - Fees per token ($2.40 / 50 = $0.048) = $0.352 (35.2¢)
    expect(res.breakEvenExitSpreadUsd).toBeCloseTo(0.352, 4);
    expect(res.breakEvenExitSpreadCents).toBeCloseTo(35.2, 2);
  });

  it("calculates fees accurately for 3.5 bps taker tier across open and close", () => {
    const state: CalculatorState = {
      symbol: "BTC",
      price: 100000,
      sizeMode: "usd",
      sizeValue: 10000,
      entrySpreadMode: "bps",
      entrySpreadValue: 0,
      entryCheaperSide: "core",
      exitSpreadMode: "bps",
      exitSpreadValue: 10,
      exitCheaperSide: "core",
      feeRateBps: 3.5, // 3.5 bps premium taker
    };

    const res = calculateCalculatorResults(state);
    // 10,000 * 2 legs * (3.5 / 10000) = $7.00 total fees
    expect(res.totalFeesUsd).toBeCloseTo(7.0, 4);
    // Spread PnL = 10 bps of $10,000 = $10.00
    expect(res.spreadPnlUsd).toBeCloseTo(10.0, 4);
    // Net PnL = 10.00 - 7.00 = $3.00
    expect(res.netPnlUsd).toBeCloseTo(3.0, 4);
  });

  it("handles negative entry spread (RH cheaper) and exiting at positive (Core cheaper)", () => {
    const state: CalculatorState = {
      symbol: "ETH",
      price: 3000,
      sizeMode: "usd",
      sizeValue: 6000,
      entrySpreadMode: "bps",
      entrySpreadValue: -10, // entered at -10 bps (RH cheaper)
      entryCheaperSide: "rh",
      exitSpreadMode: "bps",
      exitSpreadValue: 5, // exited at +5 bps (Core cheaper)
      exitCheaperSide: "core",
      feeRateBps: 0,
    };

    const res = calculateCalculatorResults(state);

    expect(res.spreadDeltaBps).toBe(15); // 5 - (-10) = 15 bps
    expect(res.spreadPnlUsd).toBeCloseTo(9.0, 4); // 15 bps of $6,000 = $9.00
    expect(res.netPnlUsd).toBeCloseTo(9.0, 4);
  });

  it("handles zero price and zero size gracefully without throwing or NaN", () => {
    const state: CalculatorState = {
      symbol: "BTC",
      price: 0,
      sizeMode: "usd",
      sizeValue: 0,
      entrySpreadMode: "cents",
      entrySpreadValue: 0,
      entryCheaperSide: "core",
      exitSpreadMode: "bps",
      exitSpreadValue: 0,
      exitCheaperSide: "core",
      feeRateBps: 0,
    };

    const res = calculateCalculatorResults(state);
    expect(res.sizeUsd).toBe(0);
    expect(res.sizeTokens).toBe(0);
    expect(res.spreadPnlUsd).toBe(0);
    expect(res.netPnlUsd).toBe(0);
    expect(isNaN(res.netPnlUsd)).toBe(false);
  });

  it("formats signed numbers cleanly", () => {
    expect(formatSignedMoney(15.5)).toBe("+$15.50");
    expect(formatSignedMoney(-3.25)).toBe("-$3.25");
    expect(formatSignedMoney(0)).toBe("$0.00");
    expect(formatSignedMoney(1500)).toBe("+$1.50K");
    expect(formatSignedMoney(-10000)).toBe("-$10.00K");
    expect(formatSignedMoney(2500000)).toBe("+$2.50M");
    expect(formatSignedMoney(1200000000)).toBe("+$1.20B");

    expect(formatSignedCents(12.5)).toBe("+12.50¢");
    expect(formatSignedCents(-5)).toBe("-5.00¢");
    expect(formatSignedCents(0)).toBe("0.00¢");

    expect(formatSignedBps(10.25)).toBe("+10.25 bps");
    expect(formatSignedBps(-4.5)).toBe("-4.50 bps");
    expect(formatSignedBps(0)).toBe("0.00 bps");

    expect(formatPriceForInput(0.00001234)).toBe("0.00001234");
    expect(formatPriceForInput(1.2345)).toBe("1.2345");
    expect(formatPriceForInput(95000)).toBe("95000.00");
    expect(formatPriceForInput(0)).toBe("");
  });

  describe("CalculatorController DOM & State Synchronization", () => {
    it("initializes default state and correctly recalculates metrics", async () => {
      const { CalculatorController } = await import("../src/calculator/controller");

      // Setup minimal DOM mocks
      const domElements: Record<string, any> = {
        tickerSelectBtn: { addEventListener: () => {}, querySelector: () => null },
        tickerTokenImg: { src: "", alt: "", style: {} },
        tickerTokenIcon: { textContent: "", style: {} },
        headerSymbol: { textContent: "" },
        headerLeverage: { textContent: "" },
        inputTokenPrice: { value: "95000", addEventListener: () => {} },
        btnSizeUsd: { className: "", addEventListener: () => {} },
        btnSizeTokens: { className: "", addEventListener: () => {} },
        inputSize: { value: "10000", placeholder: "", addEventListener: () => {} },
        labelSizePrefix: { textContent: "$" },
        labelSizeEquivalent: { textContent: "" },
        btnEntryBps: { className: "", addEventListener: () => {} },
        btnEntryCents: { className: "", addEventListener: () => {} },
        btnEntryCheaperRh: { className: "", addEventListener: () => {} },
        btnEntryCheaperCore: { className: "", addEventListener: () => {} },
        inputEntrySpread: { value: "5", placeholder: "", addEventListener: () => {} },
        labelEntryUnit: { textContent: "bps" },
        labelEntryEquivalent: { textContent: "" },
        quickEntrySpreadButtons: createMockContainer(),
        btnExitBps: { className: "", addEventListener: () => {} },
        btnExitCents: { className: "", addEventListener: () => {} },
        btnExitCheaperRh: { className: "", addEventListener: () => {} },
        btnExitCheaperCore: { className: "", addEventListener: () => {} },
        inputExitSpread: { value: "20", placeholder: "", addEventListener: () => {} },
        labelExitUnit: { textContent: "bps" },
        labelExitEquivalent: { textContent: "" },
        quickExitSpreadButtons: createMockContainer(),
        inputFeeRate: { value: "0", addEventListener: () => {} },
        badgeCategory: { textContent: "" },
        badgeOpenSides: createMockBadge(),
        badgeCloseSides: createMockBadge(),
        kpiToken: { textContent: "" },
        kpiSpent: { textContent: "" },
        kpiSpentSub: { textContent: "" },
        kpiSpreadDelta: { textContent: "", className: "" },
        kpiSpreadDeltaSub: { textContent: "" },
        kpiSpreadPnl: { textContent: "", className: "" },
        kpiFees: { textContent: "" },
        kpiFeesSub: { textContent: "" },
        kpiNetPnl: { textContent: "", className: "" },
        kpiNetPnlSub: { textContent: "" },
        valEntrySpreadFull: { textContent: "" },
        valExitSpreadFull: { textContent: "" },
        valSpreadDeltaFull: { textContent: "" },
        valPerTokenGain: { textContent: "" },
        valGrossSpreadPnl: { textContent: "", className: "" },
        valPositionUsd: { textContent: "" },
        valPositionTokens: { textContent: "" },
        valAssetPrice: { textContent: "" },
        valEstimatedMargin: { textContent: "" },
        valRoundTripVolume: { textContent: "" },
        valGrossPnlSummary: { textContent: "" },
        valTotalFees: { textContent: "" },
        valNetPnlFull: { textContent: "", className: "" },
        valNetReturnRate: { textContent: "", className: "" },
        valBreakEven: { textContent: "" },
      };

      const origDoc = (globalThis as any).document;
      const origWin = (globalThis as any).window;
      const origLocalStorage = (globalThis as any).localStorage;

      (globalThis as any).localStorage = {
        getItem: () => null,
        setItem: () => {},
      };

      (globalThis as any).document = {
        getElementById: (id: string) => domElements[id] || null,
        querySelectorAll: () => [],
        createElement: (tag: string) => ({
          tagName: tag,
          value: "",
          textContent: "",
          className: "",
          addEventListener: () => {},
        }),
        addEventListener: () => {},
        removeEventListener: () => {},
      };

      (globalThis as any).window = {
        location: { href: "https://worker.dev/calculator" },
      };

      try {
        const controller = new CalculatorController();
        controller.init();

        expect(controller.state.symbol).toBe("BTC");
        expect(controller.state.price).toBe(95000);
        expect(controller.state.sizeValue).toBe(10000);

        const results = controller.recalculate();
        expect(results.sizeUsd).toBe(10000);
        expect(results.spreadDeltaBps).toBe(15);
        expect(results.spreadPnlUsd).toBeCloseTo(15.0, 4);

        expect(domElements.kpiSpent.textContent).toBe("$10.0K");
        expect(domElements.kpiSpreadDelta.textContent).toBe("+15.00 bps");
        expect(domElements.kpiNetPnl.textContent).toBe("+$15.00");
        expect(domElements.badgeCategory.textContent).toBe("Crypto");
        expect(domElements.badgeOpenSides.textContent).toBe("RH Long · Core Short");
        expect(domElements.badgeOpenSides.innerHTML).toContain("text-terminal-emerald");
        expect(domElements.badgeOpenSides.innerHTML).toContain("text-terminal-accent");
        expect(domElements.badgeOpenSides.innerHTML).toContain("text-white");
        expect(domElements.valRoundTripVolume.textContent).toBe("$40.0K");
      } finally {
        (globalThis as any).document = origDoc;
        (globalThis as any).window = origWin;
        (globalThis as any).localStorage = origLocalStorage;
      }
    });

    it("persists parameters to localStorage and restores them on page reload", async () => {
      const { CalculatorController, CALC_STORAGE_KEYS } =
        await import("../src/calculator/controller");

      const storage: Record<string, string> = {};

      const domElements: Record<string, any> = {
        tickerSelectBtn: { addEventListener: () => {}, querySelector: () => null },
        tickerTokenImg: { src: "", alt: "", style: {} },
        tickerTokenIcon: { textContent: "", style: {} },
        headerSymbol: { textContent: "" },
        headerLeverage: { textContent: "" },
        inputTokenPrice: { value: "0", addEventListener: () => {} },
        btnSizeUsd: { className: "", addEventListener: () => {} },
        btnSizeTokens: { className: "", addEventListener: () => {} },
        inputSize: { value: "0", placeholder: "", addEventListener: () => {} },
        labelSizePrefix: { textContent: "$" },
        labelSizeEquivalent: { textContent: "" },
        btnEntryBps: { className: "", addEventListener: () => {} },
        btnEntryCents: { className: "", addEventListener: () => {} },
        btnEntryCheaperRh: { className: "", addEventListener: () => {} },
        btnEntryCheaperCore: { className: "", addEventListener: () => {} },
        inputEntrySpread: { value: "0", placeholder: "", addEventListener: () => {} },
        labelEntryUnit: { textContent: "bps" },
        labelEntryEquivalent: { textContent: "" },
        quickEntrySpreadButtons: createMockContainer(),
        btnExitBps: { className: "", addEventListener: () => {} },
        btnExitCents: { className: "", addEventListener: () => {} },
        btnExitCheaperRh: { className: "", addEventListener: () => {} },
        btnExitCheaperCore: { className: "", addEventListener: () => {} },
        inputExitSpread: { value: "0", placeholder: "", addEventListener: () => {} },
        labelExitUnit: { textContent: "bps" },
        labelExitEquivalent: { textContent: "" },
        quickExitSpreadButtons: createMockContainer(),
        inputFeeRate: { value: "0", addEventListener: () => {} },
        badgeCategory: { textContent: "" },
        badgeOpenSides: createMockBadge(),
        badgeCloseSides: createMockBadge(),
        kpiToken: { textContent: "" },
        kpiSpent: { textContent: "" },
        kpiSpentSub: { textContent: "" },
        kpiSpreadDelta: { textContent: "", className: "" },
        kpiSpreadDeltaSub: { textContent: "" },
        kpiSpreadPnl: { textContent: "", className: "" },
        kpiFees: { textContent: "" },
        kpiFeesSub: { textContent: "" },
        kpiNetPnl: { textContent: "", className: "" },
        kpiNetPnlSub: { textContent: "" },
        valEntrySpreadFull: { textContent: "" },
        valExitSpreadFull: { textContent: "" },
        valSpreadDeltaFull: { textContent: "" },
        valPerTokenGain: { textContent: "" },
        valGrossSpreadPnl: { textContent: "", className: "" },
        valPositionUsd: { textContent: "" },
        valPositionTokens: { textContent: "" },
        valAssetPrice: { textContent: "" },
        valEstimatedMargin: { textContent: "" },
        valRoundTripVolume: { textContent: "" },
        valGrossPnlSummary: { textContent: "" },
        valTotalFees: { textContent: "" },
        valNetPnlFull: { textContent: "", className: "" },
        valNetReturnRate: { textContent: "", className: "" },
        valBreakEven: { textContent: "" },
      };

      const origDoc = (globalThis as any).document;
      const origWin = (globalThis as any).window;
      const origLocalStorage = (globalThis as any).localStorage;

      (globalThis as any).localStorage = {
        getItem: (k: string) => storage[k] ?? null,
        setItem: (k: string, v: string) => {
          storage[k] = v;
        },
      };

      (globalThis as any).document = {
        getElementById: (id: string) => domElements[id] || null,
        querySelectorAll: () => [],
        createElement: (tag: string) => ({
          tagName: tag,
          value: "",
          textContent: "",
          className: "",
          addEventListener: () => {},
        }),
        addEventListener: () => {},
        removeEventListener: () => {},
      };

      (globalThis as any).window = {
        location: { href: "https://worker.dev/calculator" },
      };

      try {
        // First session: user sets custom parameters
        const c1 = new CalculatorController();
        c1.init();

        c1.state.symbol = "SOL";
        c1.state.price = 185;
        c1.state.sizeMode = "tokens";
        c1.state.sizeValue = 50;
        c1.state.entrySpreadMode = "cents";
        c1.state.entrySpreadValue = -12.5;
        c1.state.entryCheaperSide = "rh";
        c1.state.exitSpreadMode = "cents";
        c1.state.exitSpreadValue = 25.0;
        c1.state.exitCheaperSide = "core";
        c1.state.feeRateBps = 1.2;

        c1.saveSettings();

        expect(storage[CALC_STORAGE_KEYS.SYMBOL]).toBe("SOL");
        expect(storage[CALC_STORAGE_KEYS.PRICE]).toBe("185");
        expect(storage[CALC_STORAGE_KEYS.SIZE_MODE]).toBe("tokens");
        expect(storage[CALC_STORAGE_KEYS.SIZE_VALUE]).toBe("50");
        expect(storage[CALC_STORAGE_KEYS.ENTRY_SPREAD_VALUE]).toBe("-12.5");
        expect(storage[CALC_STORAGE_KEYS.ENTRY_CHEAPER_SIDE]).toBe("rh");
        expect(storage[CALC_STORAGE_KEYS.EXIT_SPREAD_VALUE]).toBe("25");
        expect(storage[CALC_STORAGE_KEYS.EXIT_CHEAPER_SIDE]).toBe("core");
        expect(storage[CALC_STORAGE_KEYS.FEE_RATE_BPS]).toBe("1.2");

        // Second session: page reload with brand new controller instance
        const c2 = new CalculatorController();
        c2.init();

        expect(c2.state.symbol).toBe("SOL");
        expect(c2.state.price).toBe(185);
        expect(c2.state.sizeMode).toBe("tokens");
        expect(c2.state.sizeValue).toBe(50);
        expect(c2.state.entrySpreadMode).toBe("cents");
        expect(c2.state.entrySpreadValue).toBe(-12.5);
        expect(c2.state.entryCheaperSide).toBe("rh");
        expect(c2.state.exitSpreadMode).toBe("cents");
        expect(c2.state.exitSpreadValue).toBe(25.0);
        expect(c2.state.exitCheaperSide).toBe("core");
        expect(c2.state.feeRateBps).toBe(1.2);

        // Verify inputs in DOM were restored
        expect(domElements.labelSizePrefix.textContent).toBe("QTY");
        expect(domElements.inputSize.value).toBe("50");
        expect(domElements.labelEntryUnit.textContent).toBe("¢");
        expect(domElements.inputEntrySpread.value).toBe("-12.5");
        expect(domElements.inputFeeRate.value).toBe("1.2");
      } finally {
        (globalThis as any).document = origDoc;
        (globalThis as any).window = origWin;
        (globalThis as any).localStorage = origLocalStorage;
      }
    });

    it("renders quick spread buttons for bps (1..5) and cents (5..25), respecting RH/Core cheaper sign", async () => {
      const { CalculatorController } = await import("../src/calculator/controller");

      const entryButtonsContainer = createMockContainer();
      const exitButtonsContainer = createMockContainer();

      const listeners: Record<string, Record<string, Function[]>> = {};
      const registerListener = (id: string, evt: string, fn: Function) => {
        listeners[id] = listeners[id] || {};
        listeners[id][evt] = listeners[id][evt] || [];
        listeners[id][evt].push(fn);
      };
      const trigger = (id: string, evt: string) => {
        listeners[id]?.[evt]?.forEach((fn) => fn());
      };

      const domElements: Record<string, any> = {
        tickerSelectBtn: {
          addEventListener: (e: string, fn: Function) => registerListener("tickerSelectBtn", e, fn),
          querySelector: () => null,
        },
        tickerTokenImg: { src: "", alt: "", style: {} },
        tickerTokenIcon: { textContent: "", style: {} },
        headerSymbol: { textContent: "" },
        headerLeverage: { textContent: "" },
        inputTokenPrice: {
          value: "100",
          addEventListener: (e: string, fn: Function) => registerListener("inputTokenPrice", e, fn),
        },
        btnSizeUsd: {
          className: "",
          addEventListener: (e: string, fn: Function) => registerListener("btnSizeUsd", e, fn),
        },
        btnSizeTokens: {
          className: "",
          addEventListener: (e: string, fn: Function) => registerListener("btnSizeTokens", e, fn),
        },
        inputSize: {
          value: "1000",
          placeholder: "",
          addEventListener: (e: string, fn: Function) => registerListener("inputSize", e, fn),
        },
        labelSizePrefix: { textContent: "$" },
        labelSizeEquivalent: { textContent: "" },
        btnEntryBps: {
          className: "",
          addEventListener: (e: string, fn: Function) => registerListener("btnEntryBps", e, fn),
        },
        btnEntryCents: {
          className: "",
          addEventListener: (e: string, fn: Function) => registerListener("btnEntryCents", e, fn),
        },
        btnEntryCheaperRh: {
          className: "",
          addEventListener: (e: string, fn: Function) =>
            registerListener("btnEntryCheaperRh", e, fn),
        },
        btnEntryCheaperCore: {
          className: "",
          addEventListener: (e: string, fn: Function) =>
            registerListener("btnEntryCheaperCore", e, fn),
        },
        inputEntrySpread: {
          value: "5",
          placeholder: "",
          addEventListener: (e: string, fn: Function) =>
            registerListener("inputEntrySpread", e, fn),
        },
        labelEntryUnit: { textContent: "bps" },
        labelEntryEquivalent: { textContent: "" },
        quickEntrySpreadButtons: entryButtonsContainer,
        btnExitBps: {
          className: "",
          addEventListener: (e: string, fn: Function) => registerListener("btnExitBps", e, fn),
        },
        btnExitCents: {
          className: "",
          addEventListener: (e: string, fn: Function) => registerListener("btnExitCents", e, fn),
        },
        btnExitCheaperRh: {
          className: "",
          addEventListener: (e: string, fn: Function) =>
            registerListener("btnExitCheaperRh", e, fn),
        },
        btnExitCheaperCore: {
          className: "",
          addEventListener: (e: string, fn: Function) =>
            registerListener("btnExitCheaperCore", e, fn),
        },
        inputExitSpread: {
          value: "20",
          placeholder: "",
          addEventListener: (e: string, fn: Function) => registerListener("inputExitSpread", e, fn),
        },
        labelExitUnit: { textContent: "bps" },
        labelExitEquivalent: { textContent: "" },
        quickExitSpreadButtons: exitButtonsContainer,
        inputFeeRate: {
          value: "0",
          addEventListener: (e: string, fn: Function) => registerListener("inputFeeRate", e, fn),
        },
        badgeCategory: { textContent: "" },
        badgeOpenSides: createMockBadge(),
        badgeCloseSides: createMockBadge(),
        kpiToken: { textContent: "" },
        kpiSpent: { textContent: "" },
        kpiSpentSub: { textContent: "" },
        kpiSpreadDelta: { textContent: "", className: "" },
        kpiSpreadDeltaSub: { textContent: "" },
        kpiSpreadPnl: { textContent: "", className: "" },
        kpiFees: { textContent: "" },
        kpiFeesSub: { textContent: "" },
        kpiNetPnl: { textContent: "", className: "" },
        kpiNetPnlSub: { textContent: "" },
        valEntrySpreadFull: { textContent: "" },
        valExitSpreadFull: { textContent: "" },
        valSpreadDeltaFull: { textContent: "" },
        valPerTokenGain: { textContent: "" },
        valGrossSpreadPnl: { textContent: "", className: "" },
        valPositionUsd: { textContent: "" },
        valPositionTokens: { textContent: "" },
        valAssetPrice: { textContent: "" },
        valEstimatedMargin: { textContent: "" },
        valRoundTripVolume: { textContent: "" },
        valGrossPnlSummary: { textContent: "" },
        valTotalFees: { textContent: "" },
        valNetPnlFull: { textContent: "", className: "" },
        valNetReturnRate: { textContent: "", className: "" },
        valBreakEven: { textContent: "" },
      };

      const origDoc = (globalThis as any).document;
      const origWin = (globalThis as any).window;
      const origLocalStorage = (globalThis as any).localStorage;

      (globalThis as any).localStorage = {
        getItem: () => null,
        setItem: () => {},
      };

      (globalThis as any).document = {
        getElementById: (id: string) => domElements[id] || null,
        querySelectorAll: () => [],
        createElement: (tag: string) => {
          const btnListeners: Record<string, Function[]> = {};
          return {
            tagName: tag,
            type: "",
            value: "",
            textContent: "",
            className: "",
            addEventListener: (evt: string, fn: Function) => {
              btnListeners[evt] = btnListeners[evt] || [];
              btnListeners[evt].push(fn);
            },
            click: () => {
              btnListeners["click"]?.forEach((fn) => fn());
            },
          };
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      };

      (globalThis as any).window = {
        location: { href: "https://worker.dev/calculator" },
      };

      try {
        const c = new CalculatorController();
        c.init();

        // 1. Initial mode is bps -> 5 buttons: 1 bps, 2 bps, 3 bps, 4 bps, 5 bps
        expect(entryButtonsContainer.children.length).toBe(5);
        expect(entryButtonsContainer.children.map((b: any) => b.textContent)).toEqual([
          "1 bps",
          "2 bps",
          "3 bps",
          "4 bps",
          "5 bps",
        ]);

        // In Core cheaper mode, clicking 3 bps sets positive +3
        c.state.entryCheaperSide = "core";
        c.renderQuickSpreadButtons();
        entryButtonsContainer.children[2].click();
        expect(c.state.entrySpreadValue).toBe(3);
        expect(domElements.inputEntrySpread.value).toBe("3");

        // Switch to RH cheaper mode: clicking 2 bps sets negative -2
        trigger("btnEntryCheaperRh", "click");
        expect(c.state.entryCheaperSide as string).toBe("rh");
        entryButtonsContainer.children[1].click();
        expect(c.state.entrySpreadValue).toBe(-2);
        expect(domElements.inputEntrySpread.value).toBe("-2");

        // 2. Switch Entry spread to cents mode -> 5 buttons: 5¢, 10¢, 15¢, 20¢, 25¢
        trigger("btnEntryCents", "click");
        expect(c.state.entrySpreadMode).toBe("cents");
        expect(entryButtonsContainer.children.length).toBe(5);
        expect(entryButtonsContainer.children.map((b: any) => b.textContent)).toEqual([
          "5¢",
          "10¢",
          "15¢",
          "20¢",
          "25¢",
        ]);

        // Clicking 15¢ while RH cheaper sets -15
        entryButtonsContainer.children[2].click();
        expect(c.state.entrySpreadValue).toBe(-15);
        expect(domElements.inputEntrySpread.value).toBe("-15");

        // 3. Test Exit Spread quick buttons
        expect(exitButtonsContainer.children.length).toBe(5);
        expect(exitButtonsContainer.children.map((b: any) => b.textContent)).toEqual([
          "1 bps",
          "2 bps",
          "3 bps",
          "4 bps",
          "5 bps",
        ]);

        // Core cheaper (default exitCheaperSide is core), click 4 bps
        exitButtonsContainer.children[3].click();
        expect(c.state.exitSpreadValue).toBe(4);
        expect(domElements.inputExitSpread.value).toBe("4");

        // Switch exit to cents mode
        trigger("btnExitCents", "click");
        expect(c.state.exitSpreadMode).toBe("cents");
        expect(exitButtonsContainer.children.map((b: any) => b.textContent)).toEqual([
          "5¢",
          "10¢",
          "15¢",
          "20¢",
          "25¢",
        ]);
        exitButtonsContainer.children[4].click(); // 25¢
        expect(c.state.exitSpreadValue).toBe(25);
        expect(domElements.inputExitSpread.value).toBe("25");
      } finally {
        (globalThis as any).document = origDoc;
        (globalThis as any).window = origWin;
        (globalThis as any).localStorage = origLocalStorage;
      }
    });

    it("preserves RH cheaper toggle when user types positive number in spread input", async () => {
      const { CalculatorController } = await import("../src/calculator/controller");
      const eventListeners = new Map<string, Function>();
      const registerListener = (name: string, event: string, fn: Function) => {
        eventListeners.set(`${name}:${event}`, fn);
      };
      const trigger = (name: string, event: string) => {
        const fn = eventListeners.get(`${name}:${event}`);
        if (fn) fn();
      };

      const domElements: Record<string, any> = {
        tickerSelectBtn: { addEventListener: () => {}, querySelector: () => null },
        btnSizeUsd: { className: "", addEventListener: () => {} },
        btnSizeTokens: { className: "", addEventListener: () => {} },
        inputSize: { value: "10000", placeholder: "", addEventListener: () => {} },
        labelSizePrefix: { textContent: "$" },
        labelSizeEquivalent: { textContent: "" },
        btnEntryBps: { className: "", addEventListener: () => {} },
        btnEntryCents: { className: "", addEventListener: () => {} },
        btnEntryCheaperRh: {
          className: "",
          addEventListener: (e: string, fn: Function) =>
            registerListener("btnEntryCheaperRh", e, fn),
        },
        btnEntryCheaperCore: {
          className: "",
          addEventListener: (e: string, fn: Function) =>
            registerListener("btnEntryCheaperCore", e, fn),
        },
        inputEntrySpread: {
          value: "5",
          placeholder: "",
          addEventListener: (e: string, fn: Function) =>
            registerListener("inputEntrySpread", e, fn),
        },
        labelEntryUnit: { textContent: "bps" },
        labelEntryEquivalent: { textContent: "" },
        quickEntrySpreadButtons: createMockContainer(),
        btnExitBps: { className: "", addEventListener: () => {} },
        btnExitCents: { className: "", addEventListener: () => {} },
        btnExitCheaperRh: { className: "", addEventListener: () => {} },
        btnExitCheaperCore: { className: "", addEventListener: () => {} },
        inputExitSpread: { value: "20", placeholder: "", addEventListener: () => {} },
        labelExitUnit: { textContent: "bps" },
        labelExitEquivalent: { textContent: "" },
        quickExitSpreadButtons: createMockContainer(),
        inputFeeRate: { value: "0", addEventListener: () => {} },
        badgeCategory: { textContent: "" },
        badgeOpenSides: createMockBadge(),
        badgeCloseSides: createMockBadge(),
        kpiToken: { textContent: "" },
        kpiSpent: { textContent: "" },
        kpiSpentSub: { textContent: "" },
        kpiSpreadDelta: { textContent: "", className: "" },
        kpiSpreadDeltaSub: { textContent: "" },
        kpiSpreadPnl: { textContent: "", className: "" },
        kpiFees: { textContent: "" },
        kpiFeesSub: { textContent: "" },
        kpiNetPnl: { textContent: "", className: "" },
        kpiNetPnlSub: { textContent: "" },
        valEntrySpreadFull: { textContent: "" },
        valExitSpreadFull: { textContent: "" },
        valSpreadDeltaFull: { textContent: "", className: "" },
        valPerTokenGain: { textContent: "", className: "" },
        valGrossSpreadPnl: { textContent: "", className: "" },
        valPositionUsd: { textContent: "" },
        valPositionTokens: { textContent: "" },
        valAssetPrice: { textContent: "" },
        valEstimatedMargin: { textContent: "" },
        valRoundTripVolume: { textContent: "" },
        valGrossPnlSummary: { textContent: "", className: "" },
        valTotalFees: { textContent: "" },
        valNetPnlFull: { textContent: "", className: "" },
        valNetReturnRate: { textContent: "", className: "" },
        valBreakEven: { textContent: "" },
      };

      const origDoc = (globalThis as any).document;
      const origWin = (globalThis as any).window;
      const origLocalStorage = (globalThis as any).localStorage;

      try {
        (globalThis as any).document = {
          getElementById: (id: string) => domElements[id] || null,
          querySelectorAll: () => [],
          createElement: (tag: string) => ({
            tagName: tag,
            value: "",
            textContent: "",
            className: "",
            addEventListener: () => {},
          }),
          addEventListener: () => {},
          removeEventListener: () => {},
        };
        (globalThis as any).window = {
          location: { href: "https://lighter.local/calculator", search: "" },
        };
        (globalThis as any).localStorage = {
          getItem: () => null,
          setItem: () => {},
        };

        const c = new CalculatorController();
        c.init();

        // 1. Click RH cheaper (-)
        trigger("btnEntryCheaperRh", "click");
        expect(c.state.entryCheaperSide as string).toBe("rh");

        // 2. User focuses input and types "12" (without minus, e.g. on mobile numeric keypad)
        domElements.inputEntrySpread.value = "12";
        trigger("inputEntrySpread", "input");

        // Cheaper side must remain "rh", and spread value must be -12
        expect(c.state.entryCheaperSide as string).toBe("rh");
        expect(c.state.entrySpreadValue).toBe(-12);

        // 3. User types "+15" -> switches to core cheaper (+15)
        domElements.inputEntrySpread.value = "+15";
        trigger("inputEntrySpread", "input");
        expect(c.state.entryCheaperSide as string).toBe("core");
        expect(c.state.entrySpreadValue).toBe(15);

        // 4. User types "-8" -> switches to rh cheaper (-8)
        domElements.inputEntrySpread.value = "-8";
        trigger("inputEntrySpread", "input");
        expect(c.state.entryCheaperSide as string).toBe("rh");
        expect(c.state.entrySpreadValue).toBe(-8);
      } finally {
        (globalThis as any).document = origDoc;
        (globalThis as any).window = origWin;
        (globalThis as any).localStorage = origLocalStorage;
      }
    });

    it("updates price when tokenParam is passed in URL even when localStorage has a different token", async () => {
      const { CalculatorController, CALC_STORAGE_KEYS } =
        await import("../src/calculator/controller");

      const storage: Record<string, string> = {
        [CALC_STORAGE_KEYS.SYMBOL]: "BTC",
        [CALC_STORAGE_KEYS.PRICE]: "95000",
      };

      const domElements: Record<string, any> = {
        tickerSelectBtn: { addEventListener: () => {}, querySelector: () => null },
        btnSizeUsd: { className: "", addEventListener: () => {} },
        btnSizeTokens: { className: "", addEventListener: () => {} },
        inputSize: { value: "10000", placeholder: "", addEventListener: () => {} },
        labelSizePrefix: { textContent: "$" },
        labelSizeEquivalent: { textContent: "" },
        btnEntryBps: { className: "", addEventListener: () => {} },
        btnEntryCents: { className: "", addEventListener: () => {} },
        btnEntryCheaperRh: { className: "", addEventListener: () => {} },
        btnEntryCheaperCore: { className: "", addEventListener: () => {} },
        inputEntrySpread: { value: "5", placeholder: "", addEventListener: () => {} },
        labelEntryUnit: { textContent: "bps" },
        labelEntryEquivalent: { textContent: "" },
        quickEntrySpreadButtons: createMockContainer(),
        btnExitBps: { className: "", addEventListener: () => {} },
        btnExitCents: { className: "", addEventListener: () => {} },
        btnExitCheaperRh: { className: "", addEventListener: () => {} },
        btnExitCheaperCore: { className: "", addEventListener: () => {} },
        inputExitSpread: { value: "20", placeholder: "", addEventListener: () => {} },
        labelExitUnit: { textContent: "bps" },
        labelExitEquivalent: { textContent: "" },
        quickExitSpreadButtons: createMockContainer(),
        inputFeeRate: { value: "0", addEventListener: () => {} },
        badgeCategory: { textContent: "" },
        badgeOpenSides: createMockBadge(),
        badgeCloseSides: createMockBadge(),
        kpiToken: { textContent: "" },
        kpiSpent: { textContent: "" },
        kpiSpentSub: { textContent: "" },
        kpiSpreadDelta: { textContent: "", className: "" },
        kpiSpreadDeltaSub: { textContent: "" },
        kpiSpreadPnl: { textContent: "", className: "" },
        kpiFees: { textContent: "" },
        kpiFeesSub: { textContent: "" },
        kpiNetPnl: { textContent: "", className: "" },
        kpiNetPnlSub: { textContent: "" },
        valEntrySpreadFull: { textContent: "" },
        valExitSpreadFull: { textContent: "" },
        valSpreadDeltaFull: { textContent: "", className: "" },
        valPerTokenGain: { textContent: "", className: "" },
        valGrossSpreadPnl: { textContent: "", className: "" },
        valPositionUsd: { textContent: "" },
        valPositionTokens: { textContent: "" },
        valAssetPrice: { textContent: "" },
        valEstimatedMargin: { textContent: "" },
        valRoundTripVolume: { textContent: "" },
        valGrossPnlSummary: { textContent: "", className: "" },
        valTotalFees: { textContent: "" },
        valNetPnlFull: { textContent: "", className: "" },
        valNetReturnRate: { textContent: "", className: "" },
        valBreakEven: { textContent: "" },
      };

      const origDoc = (globalThis as any).document;
      const origWin = (globalThis as any).window;
      const origLocalStorage = (globalThis as any).localStorage;

      try {
        (globalThis as any).document = {
          getElementById: (id: string) => domElements[id] || null,
          querySelectorAll: () => [],
          createElement: (tag: string) => ({
            tagName: tag,
            value: "",
            textContent: "",
            className: "",
            addEventListener: () => {},
          }),
          addEventListener: () => {},
          removeEventListener: () => {},
        };
        (globalThis as any).window = {
          location: { href: "https://lighter.local/calculator?token=ETH" },
        };
        (globalThis as any).localStorage = {
          getItem: (key: string) => storage[key] ?? null,
          setItem: (key: string, val: string) => {
            storage[key] = val;
          },
        };

        const c = new CalculatorController();
        c.init();

        expect(c.state.symbol).toBe("ETH");
        // Must be ETH's default price ($2800), NOT BTC's $95,000 from localStorage!
        expect(c.state.price).toBe(2800);
      } finally {
        (globalThis as any).document = origDoc;
        (globalThis as any).window = origWin;
        (globalThis as any).localStorage = origLocalStorage;
      }
    });

    it("dynamically updates color classes to text-terminal-coral for negative PnL", async () => {
      const { CalculatorController } = await import("../src/calculator/controller");

      const domElements: Record<string, any> = {
        tickerSelectBtn: { addEventListener: () => {}, querySelector: () => null },
        btnSizeUsd: { className: "", addEventListener: () => {} },
        btnSizeTokens: { className: "", addEventListener: () => {} },
        inputSize: { value: "10000", placeholder: "", addEventListener: () => {} },
        labelSizePrefix: { textContent: "$" },
        labelSizeEquivalent: { textContent: "" },
        btnEntryBps: { className: "", addEventListener: () => {} },
        btnEntryCents: { className: "", addEventListener: () => {} },
        btnEntryCheaperRh: { className: "", addEventListener: () => {} },
        btnEntryCheaperCore: { className: "", addEventListener: () => {} },
        inputEntrySpread: { value: "20", placeholder: "", addEventListener: () => {} },
        labelEntryUnit: { textContent: "bps" },
        labelEntryEquivalent: { textContent: "" },
        quickEntrySpreadButtons: createMockContainer(),
        btnExitBps: { className: "", addEventListener: () => {} },
        btnExitCents: { className: "", addEventListener: () => {} },
        btnExitCheaperRh: { className: "", addEventListener: () => {} },
        btnExitCheaperCore: { className: "", addEventListener: () => {} },
        inputExitSpread: { value: "5", placeholder: "", addEventListener: () => {} },
        labelExitUnit: { textContent: "bps" },
        labelExitEquivalent: { textContent: "" },
        quickExitSpreadButtons: createMockContainer(),
        inputFeeRate: { value: "0", addEventListener: () => {} },
        badgeCategory: { textContent: "" },
        badgeOpenSides: createMockBadge(),
        badgeCloseSides: createMockBadge(),
        kpiToken: { textContent: "" },
        kpiSpent: { textContent: "" },
        kpiSpentSub: { textContent: "" },
        kpiSpreadDelta: { textContent: "", className: "" },
        kpiSpreadDeltaSub: { textContent: "" },
        kpiSpreadPnl: { textContent: "", className: "" },
        kpiFees: { textContent: "" },
        kpiFeesSub: { textContent: "" },
        kpiNetPnl: { textContent: "", className: "" },
        kpiNetPnlSub: { textContent: "" },
        valEntrySpreadFull: { textContent: "" },
        valExitSpreadFull: { textContent: "" },
        valSpreadDeltaFull: { textContent: "", className: "" },
        valPerTokenGain: { textContent: "", className: "" },
        valGrossSpreadPnl: { textContent: "", className: "" },
        valPositionUsd: { textContent: "" },
        valPositionTokens: { textContent: "" },
        valAssetPrice: { textContent: "" },
        valEstimatedMargin: { textContent: "" },
        valRoundTripVolume: { textContent: "" },
        valGrossPnlSummary: { textContent: "", className: "" },
        valTotalFees: { textContent: "" },
        valNetPnlFull: { textContent: "", className: "" },
        valNetReturnRate: { textContent: "", className: "" },
        valBreakEven: { textContent: "" },
      };

      const origDoc = (globalThis as any).document;
      const origWin = (globalThis as any).window;
      const origLocalStorage = (globalThis as any).localStorage;

      try {
        (globalThis as any).document = {
          getElementById: (id: string) => domElements[id] || null,
          querySelectorAll: () => [],
          createElement: (tag: string) => ({
            tagName: tag,
            value: "",
            textContent: "",
            className: "",
            addEventListener: () => {},
          }),
          addEventListener: () => {},
          removeEventListener: () => {},
        };
        (globalThis as any).window = {
          location: { href: "https://lighter.local/calculator", search: "" },
        };
        (globalThis as any).localStorage = {
          getItem: () => null,
          setItem: () => {},
        };

        const c = new CalculatorController();
        c.init();

        // Entry spread: +20 bps, Exit spread: +5 bps -> Loss (-15 bps delta)
        c.state.entrySpreadValue = 20;
        c.state.exitSpreadValue = 5;
        c.recalculate();

        expect(domElements.valSpreadDeltaFull.textContent).toContain("-15.00 bps");
        expect(domElements.valSpreadDeltaFull.className).toContain("text-terminal-coral");
        expect(domElements.valPerTokenGain.className).toContain("text-terminal-coral");
        expect(domElements.valGrossPnlSummary.className).toContain("text-terminal-coral");
        expect(domElements.valGrossSpreadPnl.className).toContain("text-terminal-coral");
        expect(domElements.valNetPnlFull.className).toContain("text-terminal-coral");
      } finally {
        (globalThis as any).document = origDoc;
        (globalThis as any).window = origWin;
        (globalThis as any).localStorage = origLocalStorage;
      }
    });
  });
});
