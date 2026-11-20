import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import {
  aggregateLevels,
  calculateCumulativeSizes,
  calculateSpread,
  calculateSweepMetrics,
  determinePriceDecimals,
  formatFastPrice,
  formatFastSize,
  formatFastSpreadPct,
  generateTickSteps,
  initOrderBookUI,
  roundPriceToStep,
  MAX_DEPTH,
} from "../src/analytics/orderbook_ui";
import { createEmptyBook, updateBookFromWs, FlatOrderBookSide } from "../src/shared/orderbook";

function createMockElement(tag: string = "div"): any {
  const children: any[] = [];
  const classListSet = new Set<string>();
  const listeners: Record<string, Function[]> = {};
  const dataset: Record<string, string> = {};
  let currentClassName = "";
  let currentInnerHTML = "";
  let text = "";
  let val = "";

  const el: any = {
    tagName: tag.toUpperCase(),
    id: "",
    dataset,
    parentElement: null,
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 120,
      left: 100,
      right: 300,
      width: 200,
      height: 20,
    }),
    querySelector: (sel: string) => {
      const findChild = (node: any): any => {
        if (sel.startsWith("#") && node.id === sel.slice(1)) return node;
        for (const c of node.children || []) {
          const res = findChild(c);
          if (res) return res;
        }
        return null;
      };
      return findChild(el);
    },
    closest: (sel: string) => {
      let cur: any = el;
      while (cur) {
        if (sel.startsWith(".") && cur.classList?.contains(sel.slice(1))) return cur;
        if (sel.startsWith("#") && cur.id === sel.slice(1)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    contains: (child: any) => {
      if (!child) return false;
      if (child === el) return true;
      const checkChildren = (node: any): boolean => {
        for (const c of node.children || []) {
          if (c === child || checkChildren(c)) return true;
        }
        return false;
      };
      return checkChildren(el);
    },
    remove: () => {
      if (el.parentElement) {
        const idx = el.parentElement.children.indexOf(el);
        if (idx >= 0) el.parentElement.children.splice(idx, 1);
        el.parentElement = null;
      }
    },
    get className() {
      return currentClassName;
    },
    set className(v: string) {
      currentClassName = v;
      classListSet.clear();
      v.split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classListSet.add(c));
    },
    get textContent() {
      return text;
    },
    set textContent(v: string) {
      text = String(v);
    },
    get value() {
      return val;
    },
    set value(v: any) {
      val = String(v);
    },
    get innerHTML() {
      return currentInnerHTML;
    },
    set innerHTML(html: string) {
      currentInnerHTML = html;
      children.length = 0;
      if (typeof html === "string") {
        const idMatches = html.matchAll(/id="([^"]+)"/g);
        for (const m of idMatches) {
          const childId = m[1];
          if (!children.some((c) => c.id === childId)) {
            const childEl = createMockElement("span");
            childEl.id = childId;
            childEl.parentElement = el;
            children.push(childEl);
          }
        }
      }
    },
    style: {
      background: "",
      display: "",
      opacity: "",
      top: "",
      left: "",
    },
    children,
    appendChild: (child: any) => {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    addEventListener: (evt: string, fn: Function) => {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    },
    dispatchEvent: (evt: string, customTarget?: any) => {
      const target = customTarget || el;
      if (listeners[evt]) {
        listeners[evt].forEach((fn) => fn({ target }));
      }
      if (!customTarget && el.parentElement) {
        el.parentElement.dispatchEvent(evt, el);
      }
    },
    querySelectorAll: (selector: string) => {
      const results: any[] = [];
      const traverse = (node: any) => {
        if (selector.startsWith(".") && node.classList?.contains(selector.slice(1))) {
          results.push(node);
        }
        for (const c of node.children || []) {
          traverse(c);
        }
      };
      traverse(el);
      return results;
    },
    classList: {
      contains: (cls: string) => classListSet.has(cls),
      add: (cls: string) => classListSet.add(cls),
      remove: (cls: string) => classListSet.delete(cls),
    },
  };
  return el;
}

describe("Analytics OrderBook UI & In-Memory Math", () => {
  const origDoc = (globalThis as any).document;

  afterAll(() => {
    (globalThis as any).document = origDoc;
  });

  describe("Cumulative Total and Spread Math", () => {
    it("correctly calculates cumulative sizes from spread outward", () => {
      const sizes = new Float64Array([10, 20, 30, 40]);
      const cum = calculateCumulativeSizes(sizes, 4);

      expect(cum[0]).toBe(10);
      expect(cum[1]).toBe(30);
      expect(cum[2]).toBe(60);
      expect(cum[3]).toBe(100);
    });

    it("calculates absolute and percentage spread correctly", () => {
      const bestBid = 100.0;
      const bestAsk = 100.02;
      const res = calculateSpread(bestBid, bestAsk);

      expect(res.isValid).toBe(true);
      expect(res.spreadUsd).toBeCloseTo(0.02, 6);
      const mid = 100.01;
      const expectedPct = (0.02 / mid) * 100;
      expect(res.spreadPct).toBeCloseTo(expectedPct, 6);
    });

    it("returns invalid spread for zero or crossed prices", () => {
      expect(calculateSpread(0, 100).isValid).toBe(false);
      expect(calculateSpread(100, 0).isValid).toBe(false);
      expect(calculateSpread(102, 101).isValid).toBe(false); // bestBid > bestAsk
    });

    it("determines correct price decimals depending on price magnitude", () => {
      expect(determinePriceDecimals(250.5)).toBe(2);
      expect(determinePriceDecimals(1.25)).toBe(2);
      expect(determinePriceDecimals(0.55)).toBe(3);
      expect(determinePriceDecimals(0.05)).toBe(4);
      expect(determinePriceDecimals(0.005)).toBe(6);
    });

    it("fast formats prices and sizes without NaN or crash", () => {
      expect(formatFastPrice(100.1, 2)).toBe("100.10");
      expect(formatFastSize(68.73482, 4)).toBe("68.7348");
      expect(formatFastSpreadPct(0.0064)).toBe("0.006%");
    });
  });

  describe("Tick Size & Bucketing Aggregation Logic", () => {
    it("rounds prices according to exchange standards (ceil for asks, floor for bids)", () => {
      // Step 0.05
      expect(roundPriceToStep(345.01, 0.05, true)).toBe(345.05);
      expect(roundPriceToStep(345.02, 0.05, true)).toBe(345.05);
      expect(roundPriceToStep(345.05, 0.05, true)).toBe(345.05);
      expect(roundPriceToStep(345.06, 0.05, true)).toBe(345.1);

      expect(roundPriceToStep(344.89, 0.05, false)).toBe(344.85);
      expect(roundPriceToStep(344.87, 0.05, false)).toBe(344.85);
      expect(roundPriceToStep(344.85, 0.05, false)).toBe(344.85);
      expect(roundPriceToStep(344.84, 0.05, false)).toBe(344.8);
    });

    it("aggregates raw levels into tickStep buckets with summed volumes (Asks ceil & Bids floor)", () => {
      const asks = new FlatOrderBookSide(true);
      asks.set(345.01, 10);
      asks.set(345.02, 20);
      asks.set(345.04, 30);
      asks.set(345.05, 40);
      asks.set(345.08, 50);

      const outPrices = new Float64Array(MAX_DEPTH);
      const outSizesBase = new Float64Array(MAX_DEPTH);
      const outSizesUsd = new Float64Array(MAX_DEPTH);
      const outCumBase = new Float64Array(MAX_DEPTH);
      const outCumUsd = new Float64Array(MAX_DEPTH);

      // Aggregate asks with step 0.05
      const askCount = aggregateLevels(
        asks,
        0.05,
        MAX_DEPTH,
        outPrices,
        outSizesBase,
        outSizesUsd,
        outCumBase,
        outCumUsd,
      );

      // 345.01, 345.02, 345.04, 345.05 -> collapse into 345.05 with volume 10 + 20 + 30 + 40 = 100
      // 345.08 -> collapses into 345.10 with volume 50
      expect(askCount).toBe(2);
      expect(outPrices[0]).toBe(345.05);
      expect(outSizesBase[0]).toBe(100);
      expect(outCumBase[0]).toBe(100);

      expect(outPrices[1]).toBe(345.1);
      expect(outSizesBase[1]).toBe(50);
      expect(outCumBase[1]).toBe(150);

      // Now aggregate bids with step 0.05
      const bids = new FlatOrderBookSide(false);
      bids.set(344.89, 15);
      bids.set(344.87, 25);
      bids.set(344.86, 35);
      bids.set(344.81, 45);

      const bidCount = aggregateLevels(
        bids,
        0.05,
        MAX_DEPTH,
        outPrices,
        outSizesBase,
        outSizesUsd,
        outCumBase,
        outCumUsd,
      );

      // 344.89, 344.87, 344.86 -> collapse into 344.85 with volume 15 + 25 + 35 = 75
      // 344.81 -> collapses into 344.80 with volume 45
      expect(bidCount).toBe(2);
      expect(outPrices[0]).toBe(344.85);
      expect(outSizesBase[0]).toBe(75);
      expect(outCumBase[0]).toBe(75);

      expect(outPrices[1]).toBe(344.8);
      expect(outSizesBase[1]).toBe(45);
      expect(outCumBase[1]).toBe(120);
    });

    it("aggregates volumes in USD correctly", () => {
      const asks = new FlatOrderBookSide(true);
      asks.set(100, 2); // USD = 200
      asks.set(100.5, 4); // USD = 402

      const outPrices = new Float64Array(MAX_DEPTH);
      const outSizesBase = new Float64Array(MAX_DEPTH);
      const outSizesUsd = new Float64Array(MAX_DEPTH);
      const outCumBase = new Float64Array(MAX_DEPTH);
      const outCumUsd = new Float64Array(MAX_DEPTH);

      const count = aggregateLevels(
        asks,
        1.0,
        MAX_DEPTH,
        outPrices,
        outSizesBase,
        outSizesUsd,
        outCumBase,
        outCumUsd,
      );

      // With step 1.0, both 100 and 100.5 round to 100 and 101
      expect(count).toBe(2);
      expect(outPrices[0]).toBe(100);
      expect(outSizesUsd[0]).toBe(200); // 100 * 2
      expect(outCumUsd[0]).toBe(200);

      expect(outPrices[1]).toBe(101);
      expect(outSizesUsd[1]).toBe(402); // 100.5 * 4
      expect(outCumUsd[1]).toBe(602);
    });

    it("generates adaptive tick sizes for various asset price scales", () => {
      const appleSteps = generateTickSteps(250);
      expect(appleSteps).toEqual([0.01, 0.05, 0.1, 0.5, 1]);

      const btcSteps = generateTickSteps(90000);
      expect(btcSteps).toEqual([0.1, 0.5, 1, 5, 10]);

      const pennySteps = generateTickSteps(0.05);
      expect(pennySteps).toEqual([0.0001, 0.0005, 0.001, 0.005, 0.01]);
    });

    it("calculates Sweep Metrics exactly matching benchmark math (VWAP, total fill, distance in bps and %)", () => {
      // Benchmark from Lighter terminal screenshot:
      // Best Ask = 344.44, Best Bid = 344.42 -> Mid Price = 344.43
      // Cursor hovering on Bid level 344.36 (index 4)
      // Liquidity from 344.42 down to 344.36:
      // 344.42 -> 0.0330 tokens ($11.36586)
      // 344.40 -> 23.7211 tokens ($8,169.54684)
      // 344.39 -> 70.2075 tokens ($24,178.16100)
      // 344.38 -> 16.5119 tokens ($5,686.36812)
      // 344.36 -> 58.5703 tokens ($20,169.96851)
      const aggPrices = new Float64Array([344.42, 344.4, 344.39, 344.38, 344.36]);
      const aggCumBase = new Float64Array([
        0.033,
        0.033 + 23.7211,
        0.033 + 23.7211 + 70.2075,
        0.033 + 23.7211 + 70.2075 + 16.5119,
        0.033 + 23.7211 + 70.2075 + 16.5119 + 58.5703, // 169.0438
      ]);
      const aggCumUsd = new Float64Array([
        11.36586,
        11.36586 + 8169.54684,
        11.36586 + 8169.54684 + 24178.161,
        11.36586 + 8169.54684 + 24178.161 + 5686.36812,
        11.36586 + 8169.54684 + 24178.161 + 5686.36812 + 20169.96851, // 58215.41033
      ]);
      const midPrice = 344.43;

      const metrics = calculateSweepMetrics(4, aggPrices, aggCumBase, aggCumUsd, midPrice);

      // Distance = |344.36 - 344.43| / 344.43 = 0.07 / 344.43 = 0.0203% = 2.03 bps
      expect(metrics.distanceBps).toBeCloseTo(2.03, 2);
      expect(metrics.distancePct).toBeCloseTo(0.0203, 4);

      // VWAP = 58215.41033 / 169.0438 = 344.3806 -> rounds to 344.38
      expect(metrics.avgPrice).toBeCloseTo(344.38, 2);
      expect(metrics.fillBase).toBeCloseTo(169.0438, 4);
      expect(metrics.fillUsd).toBeCloseTo(58215.41, 1);
      expect(metrics.bucketPrice).toBe(344.36);
    });
  });

  describe("Crossed Book Guard in updateBookFromWs", () => {
    it("removes crossed bids when new aggressive ask arrives", () => {
      const book = createEmptyBook(1);
      updateBookFromWs(
        book,
        {
          bids: [
            { price: 100.0, size: 5 },
            { price: 99.0, size: 10 },
          ],
          asks: [
            { price: 101.0, size: 5 },
            { price: 102.0, size: 10 },
          ],
        },
        true,
      );

      const asksSide = book.asks as any;
      const bidsSide = book.bids as any;
      expect(bidsSide.prices[0]).toBe(100.0);
      expect(asksSide.prices[0]).toBe(101.0);

      updateBookFromWs(
        book,
        {
          asks: [{ price: 99.5, size: 8 }],
        },
        false,
      );

      expect(asksSide.prices[0]).toBe(99.5);
      expect(bidsSide.prices[0]).toBe(99.0);
      expect(asksSide.prices[0] > bidsSide.prices[0]).toBe(true);
    });

    it("removes crossed asks when new aggressive bid arrives", () => {
      const book = createEmptyBook(1);
      updateBookFromWs(
        book,
        {
          bids: [
            { price: 100.0, size: 5 },
            { price: 99.0, size: 10 },
          ],
          asks: [
            { price: 101.0, size: 5 },
            { price: 102.0, size: 10 },
          ],
        },
        true,
      );

      const asksSide = book.asks as any;
      const bidsSide = book.bids as any;

      updateBookFromWs(
        book,
        {
          bids: [{ price: 101.5, size: 8 }],
        },
        false,
      );

      expect(bidsSide.prices[0]).toBe(101.5);
      expect(asksSide.prices[0]).toBe(102.0);
      expect(asksSide.prices[0] > bidsSide.prices[0]).toBe(true);
    });

    it("removes penetrated ask when aggressive bid arrives with an unrelated far ask update in same packet", () => {
      const book = createEmptyBook(1);
      updateBookFromWs(
        book,
        {
          bids: [
            { price: 100.0, size: 5 },
            { price: 99.0, size: 10 },
          ],
          asks: [
            { price: 101.0, size: 5 },
            { price: 102.0, size: 10 },
          ],
        },
        true,
      );

      const asksSide = book.asks as any;
      const bidsSide = book.bids as any;

      // New aggressive bid 101.5 + unrelated far ask 105.0 in the SAME WS packet
      updateBookFromWs(
        book,
        {
          bids: [{ price: 101.5, size: 8 }],
          asks: [{ price: 105.0, size: 2 }],
        },
        false,
      );

      // Best bid 101.5 MUST NOT be deleted; penetrated ask 101.0 MUST be removed
      expect(bidsSide.prices[0]).toBe(101.5);
      expect(asksSide.prices[0]).toBe(102.0);
      expect(asksSide.prices[0] > bidsSide.prices[0]).toBe(true);
    });

    it("removes penetrated bid when aggressive ask arrives with an unrelated far bid update in same packet", () => {
      const book = createEmptyBook(1);
      updateBookFromWs(
        book,
        {
          bids: [
            { price: 100.0, size: 5 },
            { price: 99.0, size: 10 },
          ],
          asks: [
            { price: 101.0, size: 5 },
            { price: 102.0, size: 10 },
          ],
        },
        true,
      );

      const asksSide = book.asks as any;
      const bidsSide = book.bids as any;

      // New aggressive ask 99.5 + unrelated far bid 95.0 in the SAME WS packet
      updateBookFromWs(
        book,
        {
          asks: [{ price: 99.5, size: 8 }],
          bids: [{ price: 95.0, size: 2 }],
        },
        false,
      );

      // Best ask 99.5 MUST NOT be deleted; penetrated bid 100.0 MUST be removed
      expect(asksSide.prices[0]).toBe(99.5);
      expect(bidsSide.prices[0]).toBe(99.0);
      expect(asksSide.prices[0] > bidsSide.prices[0]).toBe(true);
    });
  });

  describe("OrderBook UI Component & Selectors Integration", () => {
    let elementsMap: Record<string, any>;
    let symbolBadges: any[];

    beforeEach(() => {
      elementsMap = {};
      symbolBadges = [];

      const rhAsks = createMockElement("div");
      rhAsks.id = "rhOrderBookAsks";
      elementsMap["rhOrderBookAsks"] = rhAsks;

      const rhBids = createMockElement("div");
      rhBids.id = "rhOrderBookBids";
      elementsMap["rhOrderBookBids"] = rhBids;

      const coreAsks = createMockElement("div");
      coreAsks.id = "coreOrderBookAsks";
      elementsMap["coreOrderBookAsks"] = coreAsks;

      const coreBids = createMockElement("div");
      coreBids.id = "coreOrderBookBids";
      elementsMap["coreOrderBookBids"] = coreBids;

      elementsMap["rhOrderBookSpreadUsd"] = createMockElement("div");
      elementsMap["rhOrderBookSpreadPct"] = createMockElement("div");
      elementsMap["coreOrderBookSpreadUsd"] = createMockElement("div");
      elementsMap["coreOrderBookSpreadPct"] = createMockElement("div");

      elementsMap["rhOrderBookLoadingOverlay"] = createMockElement("div");
      elementsMap["rhOrderBookLoadingMessage"] = createMockElement("span");
      elementsMap["coreOrderBookLoadingOverlay"] = createMockElement("div");
      elementsMap["coreOrderBookLoadingMessage"] = createMockElement("span");

      elementsMap["rhObStepSelect"] = createMockElement("select");
      elementsMap["rhObUnitSelect"] = createMockElement("select");
      elementsMap["rhObDepthSelect"] = createMockElement("select");

      elementsMap["coreObStepSelect"] = createMockElement("select");
      elementsMap["coreObUnitSelect"] = createMockElement("select");
      elementsMap["coreObDepthSelect"] = createMockElement("select");

      const badge1 = createMockElement("span");
      badge1.className = "ob-symbol-badge";
      symbolBadges.push(badge1);

      const badge2 = createMockElement("span");
      badge2.className = "ob-symbol-badge";
      symbolBadges.push(badge2);

      const body = createMockElement("body");
      const mockDoc: any = {
        body,
        getElementById: (id: string) =>
          elementsMap[id] ||
          (id === "obSharedTooltip"
            ? body.children.find((c: any) => c.id === "obSharedTooltip") || null
            : null),
        createElement: (tag: string) => createMockElement(tag),
        querySelectorAll: (sel: string) => {
          if (sel === ".ob-symbol-badge") return symbolBadges;
          return [];
        },
      };

      (globalThis as any).document = mockDoc;
    });

    it("initializes pooled DOM rows (15 rows each for asks and bids)", () => {
      initOrderBookUI("AAPL");

      expect(elementsMap["rhOrderBookAsks"].children.length).toBe(MAX_DEPTH);
      expect(elementsMap["rhOrderBookBids"].children.length).toBe(MAX_DEPTH);
      expect(elementsMap["coreOrderBookAsks"].children.length).toBe(MAX_DEPTH);
      expect(elementsMap["coreOrderBookBids"].children.length).toBe(MAX_DEPTH);

      expect(symbolBadges[0].textContent).toBe("AAPL");
      expect(symbolBadges[1].textContent).toBe("AAPL");
    });

    it("shows order book loading overlays until the first snapshot and again on symbol change", () => {
      const ui = initOrderBookUI("AAPL");
      const rhOverlay = elementsMap["rhOrderBookLoadingOverlay"];
      const coreOverlay = elementsMap["coreOrderBookLoadingOverlay"];
      const rhMessage = elementsMap["rhOrderBookLoadingMessage"];

      expect(rhOverlay.classList.contains("hidden")).toBe(false);
      expect(coreOverlay.classList.contains("hidden")).toBe(false);
      expect(rhMessage.textContent).toBe("Loading AAPL order book from Robinhood Chain...");

      const book = createEmptyBook(1);
      updateBookFromWs(
        book,
        {
          asks: [{ price: 150.1, size: 10 }],
          bids: [{ price: 150.0, size: 5 }],
        },
        true,
      );

      ui.renderRh(book);
      expect(rhOverlay.classList.contains("hidden")).toBe(true);
      expect(coreOverlay.classList.contains("hidden")).toBe(false);

      ui.setSymbol("NVDA", 120);
      expect(rhOverlay.classList.contains("hidden")).toBe(false);
      expect(coreOverlay.classList.contains("hidden")).toBe(false);
      expect(rhMessage.textContent).toBe("Loading NVDA order book from Robinhood Chain...");
    });

    it("renders asks bottom-up and bids top-down correctly with cumulative total", () => {
      const ui = initOrderBookUI("AAPL");
      const book = createEmptyBook(1);

      updateBookFromWs(
        book,
        {
          asks: [
            { price: 150.1, size: 10 },
            { price: 150.2, size: 20 },
            { price: 150.3, size: 30 },
          ],
          bids: [
            { price: 150.0, size: 5 },
            { price: 149.9, size: 15 },
          ],
        },
        true,
      );

      ui.renderRh(book);

      // Asks: 3 levels.
      // Best ask 150.10 must be at bottom row (MAX_DEPTH - 1 = 14)
      const asksContainer = elementsMap["rhOrderBookAsks"];
      const bestAskRow = asksContainer.children[MAX_DEPTH - 1];
      expect(bestAskRow.children[0].textContent).toBe("150.10"); // price
      expect(bestAskRow.children[1].textContent).toBe("10.0000"); // size
      expect(bestAskRow.children[2].textContent).toBe("10.0000"); // cumulative total
      expect(bestAskRow.style.background).toContain("linear-gradient");

      // Worst visible ask 150.30 at row (MAX_DEPTH - 3 = 12)
      const worstAskRow = asksContainer.children[MAX_DEPTH - 3];
      expect(worstAskRow.children[0].textContent).toBe("150.30");
      expect(worstAskRow.children[1].textContent).toBe("30.0000");
      expect(worstAskRow.children[2].textContent).toBe("60.0000"); // 10 + 20 + 30 = 60

      // Empty ask rows above 12 (0..11) must have '—'
      const emptyAskRow = asksContainer.children[0];
      expect(emptyAskRow.children[0].textContent).toBe("—");
      expect(emptyAskRow.style.background).toBe("");

      // Bids: best bid 150.00 must be at top row (0)
      const bidsContainer = elementsMap["rhOrderBookBids"];
      const bestBidRow = bidsContainer.children[0];
      expect(bestBidRow.children[0].textContent).toBe("150.00");
      expect(bestBidRow.children[1].textContent).toBe("5.0000");
      expect(bestBidRow.children[2].textContent).toBe("5.0000");

      // Second bid 149.90 at row (1)
      const secondBidRow = bidsContainer.children[1];
      expect(secondBidRow.children[0].textContent).toBe("149.90");
      expect(secondBidRow.children[1].textContent).toBe("15.0000");
      expect(secondBidRow.children[2].textContent).toBe("20.0000"); // 5 + 15 = 20

      // Empty bid rows (2..14)
      expect(bidsContainer.children[2].children[0].textContent).toBe("—");

      // Spread bar
      expect(elementsMap["rhOrderBookSpreadUsd"].textContent).toBe("0.10");
      expect(elementsMap["rhOrderBookSpreadPct"].textContent).toContain("%");
      expect(bestAskRow.className).toContain("select-text");
    });

    it("respects depth selector (5 rows): best ask is at row 4 right above spread and rows 5..14 are hidden", () => {
      const ui = initOrderBookUI("AAPL");
      const book = createEmptyBook(1);

      updateBookFromWs(
        book,
        {
          asks: [
            { price: 100.1, size: 1 },
            { price: 100.2, size: 2 },
            { price: 100.3, size: 3 },
          ],
          bids: [
            { price: 100.0, size: 4 },
            { price: 99.9, size: 5 },
          ],
        },
        true,
      );

      // Switch depth to 5
      ui.setSettings({ depth: 5 });

      ui.renderRh(book);

      const asksContainer = elementsMap["rhOrderBookAsks"];
      const bidsContainer = elementsMap["rhOrderBookBids"];

      // Rows 0..4 must be visible (not hidden)
      for (let i = 0; i < 5; i++) {
        expect(asksContainer.children[i].classList.contains("hidden")).toBe(false);
        expect(bidsContainer.children[i].classList.contains("hidden")).toBe(false);
      }

      // Rows 5..14 must have class 'hidden'
      for (let i = 5; i < 15; i++) {
        expect(asksContainer.children[i].classList.contains("hidden")).toBe(true);
        expect(bidsContainer.children[i].classList.contains("hidden")).toBe(true);
      }

      // For depth = 5, best ask (100.10) must be at row (5 - 1) = row 4 right above SPREAD
      const bestAskRow = asksContainer.children[4];
      expect(bestAskRow.children[0].textContent).toBe("100.10");
      expect(bestAskRow.children[1].textContent).toBe("1.0000");

      // Best bid (100.00) must be at row 0 right below SPREAD
      const bestBidRow = bidsContainer.children[0];
      expect(bestBidRow.children[0].textContent).toBe("100.00");
      expect(bestBidRow.children[1].textContent).toBe("4.0000");
    });

    it("switches unit to USD: badges update to USD, sizes formatted with 2 decimals", () => {
      const ui = initOrderBookUI("AAPL");
      const book = createEmptyBook(1);

      updateBookFromWs(
        book,
        {
          asks: [{ price: 150.0, size: 10 }], // USD = 1500
          bids: [{ price: 140.0, size: 5 }], // USD = 700
        },
        true,
      );

      // Switch to USD
      ui.setSettings({ unit: "usd" });

      expect(symbolBadges[0].textContent).toBe("USD");
      expect(symbolBadges[1].textContent).toBe("USD");

      ui.renderRh(book);

      const asksContainer = elementsMap["rhOrderBookAsks"];
      const bestAskRow = asksContainer.children[MAX_DEPTH - 1];
      expect(bestAskRow.children[1].textContent).toBe("1500.00");
      expect(bestAskRow.children[2].textContent).toBe("1500.00");

      const bidsContainer = elementsMap["rhOrderBookBids"];
      const bestBidRow = bidsContainer.children[0];
      expect(bestBidRow.children[1].textContent).toBe("700.00");
      expect(bestBidRow.children[2].textContent).toBe("700.00");
    });

    it("clears state and updates ticker symbol badge when clear() is called", () => {
      const ui = initOrderBookUI("AAPL");
      const book = createEmptyBook(1);

      updateBookFromWs(
        book,
        {
          asks: [{ price: 150.1, size: 10 }],
          bids: [{ price: 150.0, size: 5 }],
        },
        true,
      );

      ui.renderRh(book);
      expect(elementsMap["rhOrderBookSpreadUsd"].textContent).toBe("0.10");

      // Now switch ticker
      ui.setSymbol("NVDA", 120);

      expect(symbolBadges[0].textContent).toBe("NVDA");
      expect(symbolBadges[1].textContent).toBe("NVDA");

      // Spread and rows must be cleared
      expect(elementsMap["rhOrderBookSpreadUsd"].textContent).toBe("--");
      expect(elementsMap["rhOrderBookSpreadPct"].textContent).toBe("--%");

      const asksContainer = elementsMap["rhOrderBookAsks"];
      for (const row of asksContainer.children) {
        expect(row.children[0].textContent).toBe("—");
        expect(row.style.background).toBe("");
      }
    });

    it("preserves stored tick step from localStorage when setSymbol matches valid steps for markPrice", () => {
      const store: Record<string, string> = {
        analytics_ob_step: "5",
      };
      const origGetItem = globalThis.localStorage?.getItem;
      (globalThis as any).localStorage = {
        getItem: (k: string) => store[k] || null,
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
      };

      try {
        const ui = initOrderBookUI("BTC", 90000);
        // Step 5 is valid for BTC (90000 -> [0.1, 0.5, 1, 5, 10])
        expect(ui.getSettings().tickStep).toBe(5);

        // When switching to AAPL with markPrice = 250 (steps: [0.01, 0.05, 0.1, 0.5, 1]), 5 is not valid -> fallback
        ui.setSymbol("AAPL", 250);
        expect(ui.getSettings().tickStep).toBe(0.01);

        // When switching back to BTC with markPrice = 90000, 5 is restored if still in localStorage
        store["analytics_ob_step"] = "5";
        ui.setSymbol("BTC", 90000);
        expect(ui.getSettings().tickStep).toBe(5);
      } finally {
        if (origGetItem) {
          (globalThis as any).localStorage.getItem = origGetItem;
        }
      }
    });

    it("does not use previous token cached book when symbol changes", () => {
      const ui = initOrderBookUI("AAPL");
      const book = createEmptyBook(1);
      updateBookFromWs(
        book,
        {
          asks: [{ price: 150.0, size: 10 }],
          bids: [{ price: 149.0, size: 5 }],
        },
        true,
      );
      ui.renderRh(book);

      // Now set symbol to a new one without markPrice
      ui.setSymbol("DOGE");
      // Default price 100 should be used (step 0.01), not AAPL's 150
      expect(ui.getSettings().tickStep).toBe(0.01);
    });

    it("resets activeHoverState and hides tooltip when depth or tickStep changes", () => {
      const ui = initOrderBookUI("AAPL");
      const book = createEmptyBook(1);
      updateBookFromWs(
        book,
        {
          asks: [
            { price: 100.1, size: 1 },
            { price: 100.2, size: 2 },
          ],
          bids: [
            { price: 100.0, size: 4 },
            { price: 99.9, size: 5 },
          ],
        },
        true,
      );
      ui.renderRh(book);

      // Simulate mouseover on bid row 0
      const bidContainer = elementsMap["rhOrderBookBids"];
      const row0 = bidContainer.children[0];

      // Dispatch mouseover which bubbles from row0 to bidContainer
      row0.dispatchEvent("mouseover");

      const tip = (globalThis as any).document.getElementById("obSharedTooltip");
      expect(tip).not.toBeNull();
      expect(tip.style.display).toBe("block");
      expect(tip.style.opacity).toBe("1");

      // Changing depth must reset hover and hide tooltip
      ui.setSettings({ depth: 5 });
      expect(tip.style.display).toBe("none");
      expect(tip.style.opacity).toBe("0");

      // Re-trigger hover and change tickStep
      row0.dispatchEvent("mouseover");
      expect(tip.style.display).toBe("block");
      expect(tip.style.opacity).toBe("1");

      ui.setSettings({ tickStep: 0.05 });
      expect(tip.style.display).toBe("none");
      expect(tip.style.opacity).toBe("0");
    });
  });
});
