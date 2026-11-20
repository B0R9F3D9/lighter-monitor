import type { FlatOrderBookSide, OrderBook } from "../shared/orderbook";

export const MAX_DEPTH = 15;
export const VISIBLE_ROWS = MAX_DEPTH;
export const DEFAULT_DEPTH = 15;

export const ASK_BRIGHT_COLOR = "rgba(244, 63, 94, 0.28)";
export const ASK_DIM_COLOR = "rgba(244, 63, 94, 0.12)";
export const BID_BRIGHT_COLOR = "rgba(16, 185, 129, 0.28)";
export const BID_DIM_COLOR = "rgba(16, 185, 129, 0.12)";

export type OrderBookUnit = "base" | "usd";

export interface OrderBookSettings {
  unit: OrderBookUnit;
  depth: number;
  tickStep: number;
}

export interface OrderBookRowUi {
  rowEl: HTMLElement;
  priceEl: HTMLElement;
  sizeEl: HTMLElement;
  totalEl: HTMLElement;
  prevPrice: string;
  prevSize: string;
  prevTotal: string;
  prevBg: string;
}

export interface SingleBookUi {
  venue: "rh" | "core";
  cardEl: HTMLElement | null;
  asksContainer: HTMLElement | null;
  bidsContainer: HTMLElement | null;
  spreadUsdEl: HTMLElement | null;
  spreadPctEl: HTMLElement | null;
  loadingOverlayEl: HTMLElement | null;
  loadingMessageEl: HTMLElement | null;
  stepSelect: HTMLSelectElement | null;
  unitSelect: HTMLSelectElement | null;
  depthSelect: HTMLSelectElement | null;
  asksRows: OrderBookRowUi[];
  bidsRows: OrderBookRowUi[];
  asksPrices: Float64Array;
  asksSizesBase: Float64Array;
  asksSizesUsd: Float64Array;
  asksCumBase: Float64Array;
  asksCumUsd: Float64Array;
  bidsPrices: Float64Array;
  bidsSizesBase: Float64Array;
  bidsSizesUsd: Float64Array;
  bidsCumBase: Float64Array;
  bidsCumUsd: Float64Array;
  asksActualCount: number;
  bidsActualCount: number;
  midPrice: number;
  prevSpreadUsd: string;
  prevSpreadPct: string;
}

export interface SweepMetrics {
  fillUsd: number;
  fillBase: number;
  avgPrice: number;
  distanceBps: number;
  distancePct: number;
  bucketPrice: number;
}

export interface HoverState {
  venue: "rh" | "core";
  isAsk: boolean;
  bucketIdx: number;
  domRow: number;
  rowEl: HTMLElement;
}

export interface OrderBookUI {
  renderRh(book: OrderBook | null, force?: boolean): void;
  renderCore(book: OrderBook | null, force?: boolean): void;
  renderBoth(rhBook: OrderBook | null, coreBook: OrderBook | null, force?: boolean): void;
  setSymbol(symbol: string, markPrice?: number): void;
  clear(symbol?: string): void;
  destroy(): void;
  getSettings(): OrderBookSettings;
  setSettings(settings: Partial<OrderBookSettings>): void;
}

let sharedOrderBookTooltip: {
  container: HTMLElement;
  distBpsEl: HTMLElement;
  avgPriceEl: HTMLElement;
  totalFillEl: HTMLElement;
} | null = null;

export function getOrCreateOrderBookTooltip(): NonNullable<typeof sharedOrderBookTooltip> {
  const isDetached =
    typeof document?.body?.contains === "function" &&
    sharedOrderBookTooltip &&
    !document.body.contains(sharedOrderBookTooltip.container);

  if (!sharedOrderBookTooltip || isDetached) {
    const existing = document.getElementById("obSharedTooltip");
    if (existing) {
      const distBpsEl = existing.querySelector("#obTipDistBps") as HTMLElement;
      const avgPriceEl = existing.querySelector("#obTipAvgPrice") as HTMLElement;
      const totalFillEl = existing.querySelector("#obTipTotalFill") as HTMLElement;
      if (distBpsEl && avgPriceEl && totalFillEl) {
        sharedOrderBookTooltip = { container: existing, distBpsEl, avgPriceEl, totalFillEl };
        return sharedOrderBookTooltip;
      }
      existing.remove();
    }

    const container = document.createElement("div");
    container.id = "obSharedTooltip";
    container.className =
      "fixed z-50 pointer-events-none whitespace-nowrap bg-terminal-bg/95 backdrop-blur-xs border border-terminal-border px-3 py-2 rounded shadow-2xl text-xs font-mono text-terminal-secondary opacity-0 transition-opacity duration-75 select-none";
    container.style.display = "none";

    container.innerHTML = `
      <div class="flex flex-col gap-1.5 min-w-56">
        <div class="flex items-center justify-between gap-4">
          <span class="text-terminal-muted text-xs uppercase tracking-wider">Distance from mid</span>
          <span id="obTipDistBps" class="text-white font-bold tabular-nums">-- bps</span>
        </div>
        <div class="flex items-center justify-between gap-4">
          <span class="text-terminal-muted text-xs uppercase tracking-wider">Avg. Price</span>
          <span id="obTipAvgPrice" class="text-white font-bold tabular-nums">--</span>
        </div>
        <div class="flex items-center justify-between gap-4 border-t border-terminal-borderSubtle pt-1 mt-0.5">
          <span class="text-terminal-muted text-xs uppercase tracking-wider">Total Fill</span>
          <span id="obTipTotalFill" class="text-terminal-accent font-bold tabular-nums">--</span>
        </div>
      </div>
    `;

    document.body.appendChild(container);

    const distBpsEl = container.querySelector("#obTipDistBps") as HTMLElement;
    const avgPriceEl = container.querySelector("#obTipAvgPrice") as HTMLElement;
    const totalFillEl = container.querySelector("#obTipTotalFill") as HTMLElement;

    sharedOrderBookTooltip = { container, distBpsEl, avgPriceEl, totalFillEl };

    const hideTip = () => {
      if (sharedOrderBookTooltip) {
        sharedOrderBookTooltip.container.style.opacity = "0";
        sharedOrderBookTooltip.container.style.display = "none";
      }
    };
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("scroll", hideTip, { passive: true });
      window.addEventListener("resize", hideTip, { passive: true });
    }
  }

  return sharedOrderBookTooltip;
}

export function hideOrderBookTooltip(): void {
  if (sharedOrderBookTooltip) {
    sharedOrderBookTooltip.container.style.opacity = "0";
    sharedOrderBookTooltip.container.style.display = "none";
  }
}

export function getStepDecimals(step: number): number {
  if (!step || !isFinite(step) || step <= 0) return 2;
  const s = step.toString();
  const dot = s.indexOf(".");
  if (dot === -1) return 0;
  return Math.min(8, s.length - dot - 1);
}

export function roundPriceToStep(
  price: number,
  tickStep: number,
  isAsk: boolean,
  factor?: number,
): number {
  if (tickStep <= 0) return price;
  let raw: number;
  if (isAsk) {
    raw = Math.ceil(price / tickStep - 1e-9) * tickStep;
  } else {
    raw = Math.floor(price / tickStep + 1e-9) * tickStep;
  }
  const f = factor !== undefined ? factor : 10 ** getStepDecimals(tickStep);
  return Math.round(raw * f) / f;
}

export function determineBaseTick(price: number): number {
  if (price >= 1000) return 0.1;
  if (price >= 10) return 0.01;
  if (price >= 1) return 0.005;
  if (price >= 0.1) return 0.001;
  return 0.0001;
}

export function generateTickSteps(price: number): number[] {
  const base = determineBaseTick(price > 0 ? price : 100);
  const multipliers = [1, 5, 10, 50, 100];
  const dec = getStepDecimals(base);
  return multipliers.map((m) => {
    const s = m * base;
    return Number(s.toFixed(dec > 0 ? dec : 0));
  });
}

export function aggregateLevels(
  side: FlatOrderBookSide | null,
  tickStep: number,
  depth: number,
  outPrices: Float64Array,
  outSizesBase: Float64Array,
  outSizesUsd: Float64Array,
  outCumBase: Float64Array,
  outCumUsd: Float64Array,
): number {
  if (!side || !("prices" in side) || side.count === 0) {
    return 0;
  }

  const isAsk = side.isAsk;
  const count = side.count;
  const prices = side.prices;
  const sizes = side.sizes;
  const usds = side.totalUsds;

  const decimals = getStepDecimals(tickStep);
  const factor = 10 ** decimals;

  let bIdx = -1;

  for (let i = 0; i < count; i++) {
    const p = prices[i]!;
    const s = sizes[i]!;
    const u = usds[i]!;
    if (s <= 0) continue;

    const bucketPrice = roundPriceToStep(p, tickStep, isAsk, factor);

    if (bIdx === -1) {
      bIdx = 0;
      outPrices[0] = bucketPrice;
      outSizesBase[0] = s;
      outSizesUsd[0] = u;
    } else if (outPrices[bIdx] === bucketPrice) {
      outSizesBase[bIdx] += s;
      outSizesUsd[bIdx] += u;
    } else {
      if (bIdx + 1 >= depth) break;
      bIdx++;
      outPrices[bIdx] = bucketPrice;
      outSizesBase[bIdx] = s;
      outSizesUsd[bIdx] = u;
    }
  }

  const actualCount = bIdx >= 0 ? Math.min(bIdx + 1, depth) : 0;
  let cumB = 0;
  let cumU = 0;
  for (let j = 0; j < actualCount; j++) {
    cumB += outSizesBase[j]!;
    cumU += outSizesUsd[j]!;
    outCumBase[j] = cumB;
    outCumUsd[j] = cumU;
  }

  return actualCount;
}

export function calculateSweepMetrics(
  bucketIdx: number,
  aggPrices: Float64Array,
  aggCumBase: Float64Array,
  aggCumUsd: Float64Array,
  midPrice: number,
): SweepMetrics {
  const bucketPrice = aggPrices[bucketIdx] || 0;
  const fillBase = aggCumBase[bucketIdx] || 0;
  const fillUsd = aggCumUsd[bucketIdx] || 0;
  const avgPrice = fillBase > 0 ? fillUsd / fillBase : 0;

  let distanceBps = 0;
  let distancePct = 0;
  if (midPrice > 0 && bucketPrice > 0) {
    distancePct = (Math.abs(bucketPrice - midPrice) / midPrice) * 100;
    distanceBps = distancePct * 100;
  }

  return {
    fillUsd,
    fillBase,
    avgPrice,
    distanceBps,
    distancePct,
    bucketPrice,
  };
}

export function calculateCumulativeSizes(
  sizes: Float64Array | number[],
  count: number,
  out?: Float64Array,
): Float64Array {
  const result = out || new Float64Array(count);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += sizes[i]!;
    result[i] = sum;
  }
  return result;
}

export function calculateSpread(
  bestBid: number,
  bestAsk: number,
): { spreadUsd: number; spreadPct: number; isValid: boolean } {
  if (bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) {
    return { spreadUsd: 0, spreadPct: 0, isValid: false };
  }
  const spreadUsd = bestAsk - bestBid;
  const mid = (bestAsk + bestBid) / 2;
  const spreadPct = mid > 0 ? (spreadUsd / mid) * 100 : 0;
  return { spreadUsd, spreadPct, isValid: true };
}

export function determinePriceDecimals(price: number): number {
  if (price >= 1) return 2;
  if (price >= 0.1) return 3;
  if (price >= 0.01) return 4;
  return 6;
}

export function formatFastPrice(price: number, decimals: number): string {
  return price.toFixed(decimals);
}

export function formatFastSize(size: number, decimals: number): string {
  return size.toFixed(decimals);
}

export function formatFastSpreadPct(pct: number): string {
  return pct.toFixed(3) + "%";
}

export function formatUsdWithCommas(val: number): string {
  const parts = val.toFixed(2).split(".");
  const intPart = parts[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return "$" + intPart + "." + parts[1];
}

function createRowElement(venue: "rh" | "core", isAsk: boolean, domRow: number): OrderBookRowUi {
  const rowEl = document.createElement("div");
  rowEl.className =
    "ob-level-row grid grid-cols-3 px-3 py-0.5 items-center text-xs font-mono leading-tight cursor-default tabular-nums select-text border-l-2 border-transparent transition-colors";
  rowEl.dataset.venue = venue;
  rowEl.dataset.isAsk = isAsk ? "true" : "false";
  rowEl.dataset.domRow = String(domRow);

  const priceEl = document.createElement("span");
  priceEl.className = isAsk
    ? "text-left font-medium text-terminal-coral select-text"
    : "text-left font-medium text-terminal-emerald select-text";
  priceEl.textContent = "—";

  const sizeEl = document.createElement("span");
  sizeEl.className = "text-center text-white/90 font-normal select-text";
  sizeEl.textContent = "—";

  const totalEl = document.createElement("span");
  totalEl.className = "text-right text-terminal-secondary font-normal select-text";
  totalEl.textContent = "—";

  rowEl.appendChild(priceEl);
  rowEl.appendChild(sizeEl);
  rowEl.appendChild(totalEl);

  return {
    rowEl,
    priceEl,
    sizeEl,
    totalEl,
    prevPrice: "—",
    prevSize: "—",
    prevTotal: "—",
    prevBg: "",
  };
}

function clearRow(row: OrderBookRowUi): void {
  if (row.prevPrice !== "—") {
    row.priceEl.textContent = "—";
    row.prevPrice = "—";
  }
  if (row.prevSize !== "—") {
    row.sizeEl.textContent = "—";
    row.prevSize = "—";
  }
  if (row.prevTotal !== "—") {
    row.totalEl.textContent = "—";
    row.prevTotal = "—";
  }
  if (row.prevBg !== "") {
    row.rowEl.style.background = "";
    row.prevBg = "";
  }
}

function clearSweepHighlight(ui: SingleBookUi): void {
  for (const r of ui.asksRows) {
    r.rowEl.classList.remove(
      "bg-white/[0.04]",
      "border-terminal-coral",
      "border-terminal-emerald",
      "text-white",
      "font-bold",
    );
    r.rowEl.classList.add("border-transparent");
  }
  for (const r of ui.bidsRows) {
    r.rowEl.classList.remove(
      "bg-white/[0.04]",
      "border-terminal-coral",
      "border-terminal-emerald",
      "text-white",
      "font-bold",
    );
    r.rowEl.classList.add("border-transparent");
  }
}

function applySweepHighlight(
  ui: SingleBookUi,
  isAsk: boolean,
  domRow: number,
  depth: number,
  actualCount: number,
): void {
  clearSweepHighlight(ui);

  const rows = isAsk ? ui.asksRows : ui.bidsRows;
  if (isAsk) {
    const k = depth - 1 - domRow;
    if (k < 0 || k >= actualCount) return;

    for (let r = domRow; r < depth; r++) {
      const row = rows[r];
      if (row) {
        row.rowEl.classList.add("bg-white/[0.04]");
      }
    }
    const targetRow = rows[domRow];
    if (targetRow) {
      targetRow.rowEl.classList.remove("border-transparent");
      targetRow.rowEl.classList.add("border-terminal-coral", "text-white", "font-bold");
    }
  } else {
    const k = domRow;
    if (k < 0 || k >= actualCount) return;

    for (let r = 0; r <= domRow && r < depth; r++) {
      const row = rows[r];
      if (row) {
        row.rowEl.classList.add("bg-white/[0.04]");
      }
    }
    const targetRow = rows[domRow];
    if (targetRow) {
      targetRow.rowEl.classList.remove("border-transparent");
      targetRow.rowEl.classList.add("border-terminal-emerald", "text-white", "font-bold");
    }
  }
}

function positionTooltip(
  tip: NonNullable<typeof sharedOrderBookTooltip>,
  rowEl: HTMLElement,
  cardEl: HTMLElement | null,
): void {
  const rowRect = rowEl.getBoundingClientRect();
  const cardRect = cardEl ? cardEl.getBoundingClientRect() : rowRect;
  const tipRect = tip.container.getBoundingClientRect();

  const winH = typeof window !== "undefined" ? window.innerHeight || 800 : 800;
  const winW = typeof window !== "undefined" ? window.innerWidth || 1200 : 1200;

  let top = rowRect.top + (rowRect.height - tipRect.height) / 2;
  const maxTop = winH - tipRect.height - 8;
  top = Math.max(8, Math.min(maxTop, top));

  let left = cardRect.left - tipRect.width - 8;
  if (left < 8) {
    left = cardRect.right + 8;
    const maxLeft = winW - tipRect.width - 8;
    if (left > maxLeft) {
      left = Math.max(8, maxLeft);
    }
  }

  tip.container.style.top = `${Math.round(top)}px`;
  tip.container.style.left = `${Math.round(left)}px`;
  tip.container.style.display = "block";
  tip.container.style.opacity = "1";
}

function updateTooltipForHover(
  ui: SingleBookUi,
  hover: HoverState,
  symbol: string,
  tickStep: number,
  depth: number,
): void {
  const actualCount = hover.isAsk ? ui.asksActualCount : ui.bidsActualCount;
  if (hover.bucketIdx < 0 || hover.bucketIdx >= actualCount) {
    hideOrderBookTooltip();
    clearSweepHighlight(ui);
    return;
  }

  const prices = hover.isAsk ? ui.asksPrices : ui.bidsPrices;
  const cumBase = hover.isAsk ? ui.asksCumBase : ui.bidsCumBase;
  const cumUsd = hover.isAsk ? ui.asksCumUsd : ui.bidsCumUsd;

  const metrics = calculateSweepMetrics(hover.bucketIdx, prices, cumBase, cumUsd, ui.midPrice);
  const tip = getOrCreateOrderBookTooltip();

  const priceDecimals = Math.max(2, getStepDecimals(tickStep));
  tip.distBpsEl.textContent = `${metrics.distanceBps.toFixed(2)} bps (${metrics.distancePct.toFixed(3)}%)`;
  tip.avgPriceEl.textContent = `$${formatFastPrice(metrics.avgPrice, priceDecimals)}`;
  tip.totalFillEl.textContent = `${formatUsdWithCommas(metrics.fillUsd)} (${formatFastSize(metrics.fillBase, 4)} ${symbol})`;

  positionTooltip(tip, hover.rowEl, ui.cardEl);
  applySweepHighlight(ui, hover.isAsk, hover.domRow, depth, actualCount);
}

function renderSide(
  side: FlatOrderBookSide | null,
  isAsk: boolean,
  rows: OrderBookRowUi[],
  depth: number,
  tickStep: number,
  unit: OrderBookUnit,
  aggPrices: Float64Array,
  aggSizesBase: Float64Array,
  aggSizesUsd: Float64Array,
  aggCumBase: Float64Array,
  aggCumUsd: Float64Array,
  force = false,
): number {
  const rawCount = aggregateLevels(
    side,
    tickStep,
    depth,
    aggPrices,
    aggSizesBase,
    aggSizesUsd,
    aggCumBase,
    aggCumUsd,
  );
  const count = Math.min(rawCount, depth);
  const brightColor = isAsk ? ASK_BRIGHT_COLOR : BID_BRIGHT_COLOR;
  const dimColor = isAsk ? ASK_DIM_COLOR : BID_DIM_COLOR;
  const priceDecimals = getStepDecimals(tickStep);
  const isUsd = unit === "usd";
  const sizeDecimals = isUsd ? 2 : 4;

  if (count <= 0 || !side) {
    for (let r = 0; r < depth; r++) {
      if (rows[r]) clearRow(rows[r]!);
    }
    return 0;
  }

  const sizes = isUsd ? aggSizesUsd : aggSizesBase;
  const totals = isUsd ? aggCumUsd : aggCumBase;
  const maxCumTotal = count > 0 ? totals[count - 1]! : 0;

  if (isAsk) {
    const emptyCount = depth - count;
    for (let r = 0; r < emptyCount; r++) {
      if (rows[r]) clearRow(rows[r]!);
    }

    for (let dataIdx = 0; dataIdx < count; dataIdx++) {
      const domRow = depth - 1 - dataIdx;
      if (domRow < 0 || domRow >= depth) continue;
      const row = rows[domRow];
      if (!row) continue;

      const price = aggPrices[dataIdx]!;
      const size = sizes[dataIdx]!;
      const cumTotal = totals[dataIdx]!;

      const pStr = formatFastPrice(price, priceDecimals);
      const sStr = formatFastSize(size, sizeDecimals);
      const tStr = formatFastSize(cumTotal, sizeDecimals);

      if (force || row.prevPrice !== pStr) {
        row.priceEl.textContent = pStr;
        row.prevPrice = pStr;
      }
      if (force || row.prevSize !== sStr) {
        row.sizeEl.textContent = sStr;
        row.prevSize = sStr;
      }
      if (force || row.prevTotal !== tStr) {
        row.totalEl.textContent = tStr;
        row.prevTotal = tStr;
      }

      if (maxCumTotal > 0 && size > 0) {
        const sizePct = Math.min(100, Math.max(0, (size / maxCumTotal) * 100));
        const totalPct = Math.min(100, Math.max(sizePct, (cumTotal / maxCumTotal) * 100));
        const bg = `linear-gradient(to right, ${brightColor} 0%, ${brightColor} ${sizePct.toFixed(1)}%, ${dimColor} ${sizePct.toFixed(1)}%, ${dimColor} ${totalPct.toFixed(1)}%, transparent ${totalPct.toFixed(1)}%)`;
        if (force || row.prevBg !== bg) {
          row.rowEl.style.background = bg;
          row.prevBg = bg;
        }
      } else if (row.prevBg !== "") {
        row.rowEl.style.background = "";
        row.prevBg = "";
      }
    }
  } else {
    for (let dataIdx = 0; dataIdx < count; dataIdx++) {
      if (dataIdx >= depth) break;
      const row = rows[dataIdx];
      if (!row) continue;

      const price = aggPrices[dataIdx]!;
      const size = sizes[dataIdx]!;
      const cumTotal = totals[dataIdx]!;

      const pStr = formatFastPrice(price, priceDecimals);
      const sStr = formatFastSize(size, sizeDecimals);
      const tStr = formatFastSize(cumTotal, sizeDecimals);

      if (force || row.prevPrice !== pStr) {
        row.priceEl.textContent = pStr;
        row.prevPrice = pStr;
      }
      if (force || row.prevSize !== sStr) {
        row.sizeEl.textContent = sStr;
        row.prevSize = sStr;
      }
      if (force || row.prevTotal !== tStr) {
        row.totalEl.textContent = tStr;
        row.prevTotal = tStr;
      }

      if (maxCumTotal > 0 && size > 0) {
        const sizePct = Math.min(100, Math.max(0, (size / maxCumTotal) * 100));
        const totalPct = Math.min(100, Math.max(sizePct, (cumTotal / maxCumTotal) * 100));
        const bg = `linear-gradient(to right, ${brightColor} 0%, ${brightColor} ${sizePct.toFixed(1)}%, ${dimColor} ${sizePct.toFixed(1)}%, ${dimColor} ${totalPct.toFixed(1)}%, transparent ${totalPct.toFixed(1)}%)`;
        if (force || row.prevBg !== bg) {
          row.rowEl.style.background = bg;
          row.prevBg = bg;
        }
      } else if (row.prevBg !== "") {
        row.rowEl.style.background = "";
        row.prevBg = "";
      }
    }

    for (let r = count; r < depth; r++) {
      if (rows[r]) clearRow(rows[r]!);
    }
  }

  return count;
}

function updateRowVisibility(rows: OrderBookRowUi[], depth: number): void {
  for (let i = 0; i < MAX_DEPTH; i++) {
    const row = rows[i]!;
    if (i < depth) {
      row.rowEl.classList.remove("hidden");
    } else {
      row.rowEl.classList.add("hidden");
    }
  }
}

function setSingleBookLoading(ui: SingleBookUi, isLoading: boolean): void {
  const el = ui.loadingOverlayEl;
  if (!el) return;
  if (isLoading) {
    if (!el.classList.contains("hidden")) return;
    el.classList.remove("hidden");
    el.classList.add("flex");
  } else {
    if (el.classList.contains("hidden")) return;
    el.classList.add("hidden");
    el.classList.remove("flex");
  }
}

function renderSingleBook(
  ui: SingleBookUi,
  book: OrderBook | null,
  settings: OrderBookSettings,
  symbol: string,
  hoverState: HoverState | null,
  force = false,
): void {
  const depth = settings.depth;

  if (!book || !book.isSnapshotReceived) {
    setSingleBookLoading(ui, true);
    ui.asksActualCount = 0;
    ui.bidsActualCount = 0;
    ui.midPrice = 0;
    for (let i = 0; i < depth; i++) {
      if (ui.asksRows[i]) clearRow(ui.asksRows[i]!);
      if (ui.bidsRows[i]) clearRow(ui.bidsRows[i]!);
    }
    if (ui.prevSpreadUsd !== "--") {
      if (ui.spreadUsdEl) ui.spreadUsdEl.textContent = "--";
      ui.prevSpreadUsd = "--";
    }
    if (ui.prevSpreadPct !== "--%") {
      if (ui.spreadPctEl) ui.spreadPctEl.textContent = "--%";
      ui.prevSpreadPct = "--%";
    }
    if (hoverState && hoverState.venue === ui.venue) {
      hideOrderBookTooltip();
      clearSweepHighlight(ui);
    }
    return;
  }

  setSingleBookLoading(ui, false);

  const asks = "prices" in book.asks ? (book.asks as FlatOrderBookSide) : null;
  const bids = "prices" in book.bids ? (book.bids as FlatOrderBookSide) : null;

  const bestAsk = asks && asks.count > 0 ? asks.prices[0]! : 0;
  const bestBid = bids && bids.count > 0 ? bids.prices[0]! : 0;

  ui.asksActualCount = renderSide(
    asks,
    true,
    ui.asksRows,
    depth,
    settings.tickStep,
    settings.unit,
    ui.asksPrices,
    ui.asksSizesBase,
    ui.asksSizesUsd,
    ui.asksCumBase,
    ui.asksCumUsd,
    force,
  );

  ui.bidsActualCount = renderSide(
    bids,
    false,
    ui.bidsRows,
    depth,
    settings.tickStep,
    settings.unit,
    ui.bidsPrices,
    ui.bidsSizesBase,
    ui.bidsSizesUsd,
    ui.bidsCumBase,
    ui.bidsCumUsd,
    force,
  );

  const spread = calculateSpread(bestBid, bestAsk);
  if (spread.isValid) {
    ui.midPrice = (bestAsk + bestBid) / 2;
    const spreadDecimals = Math.max(2, getStepDecimals(settings.tickStep));
    const spreadUsdStr = formatFastPrice(spread.spreadUsd, spreadDecimals);
    const spreadPctStr = formatFastSpreadPct(spread.spreadPct);
    if (force || ui.prevSpreadUsd !== spreadUsdStr) {
      if (ui.spreadUsdEl) ui.spreadUsdEl.textContent = spreadUsdStr;
      ui.prevSpreadUsd = spreadUsdStr;
    }
    if (force || ui.prevSpreadPct !== spreadPctStr) {
      if (ui.spreadPctEl) ui.spreadPctEl.textContent = spreadPctStr;
      ui.prevSpreadPct = spreadPctStr;
    }
  } else {
    ui.midPrice = 0;
    if (ui.prevSpreadUsd !== "--") {
      if (ui.spreadUsdEl) ui.spreadUsdEl.textContent = "--";
      ui.prevSpreadUsd = "--";
    }
    if (ui.prevSpreadPct !== "--%") {
      if (ui.spreadPctEl) ui.spreadPctEl.textContent = "--%";
      ui.prevSpreadPct = "--%";
    }
  }

  // Reactive hover update for HFT ticks
  if (hoverState && hoverState.venue === ui.venue) {
    updateTooltipForHover(ui, hoverState, symbol, settings.tickStep, depth);
  }
}

function clearSingleBook(ui: SingleBookUi, depth: number): void {
  ui.asksActualCount = 0;
  ui.bidsActualCount = 0;
  ui.midPrice = 0;
  for (let i = 0; i < depth; i++) {
    if (ui.asksRows[i]) clearRow(ui.asksRows[i]!);
    if (ui.bidsRows[i]) clearRow(ui.bidsRows[i]!);
  }
  if (ui.spreadUsdEl) ui.spreadUsdEl.textContent = "--";
  if (ui.spreadPctEl) ui.spreadPctEl.textContent = "--%";
  ui.prevSpreadUsd = "--";
  ui.prevSpreadPct = "--%";
  clearSweepHighlight(ui);
}

export function initOrderBookUI(initialSymbol: string, initialMarkPrice = 100): OrderBookUI {
  const rhCard = document.getElementById("rhOrderBookCard");
  const coreCard = document.getElementById("coreOrderBookCard");

  const rhAsksContainer = document.getElementById("rhOrderBookAsks");
  const rhBidsContainer = document.getElementById("rhOrderBookBids");
  const coreAsksContainer = document.getElementById("coreOrderBookAsks");
  const coreBidsContainer = document.getElementById("coreOrderBookBids");

  const rhStepSelect = document.getElementById("rhObStepSelect") as HTMLSelectElement | null;
  const rhUnitSelect = document.getElementById("rhObUnitSelect") as HTMLSelectElement | null;
  const rhDepthSelect = document.getElementById("rhObDepthSelect") as HTMLSelectElement | null;

  const coreStepSelect = document.getElementById("coreObStepSelect") as HTMLSelectElement | null;
  const coreUnitSelect = document.getElementById("coreObUnitSelect") as HTMLSelectElement | null;
  const coreDepthSelect = document.getElementById("coreObDepthSelect") as HTMLSelectElement | null;

  let savedUnit: OrderBookUnit = "base";
  try {
    const u = localStorage.getItem("analytics_ob_unit");
    if (u === "base" || u === "usd") savedUnit = u;
  } catch {}

  let savedDepth = DEFAULT_DEPTH;
  try {
    const d = parseInt(localStorage.getItem("analytics_ob_depth") || "", 10);
    if (d === 5 || d === 10 || d === 15) savedDepth = d;
  } catch {}

  const steps = generateTickSteps(initialMarkPrice);
  let initialStep = steps[0]!;
  try {
    const s = parseFloat(localStorage.getItem("analytics_ob_step") || "");
    if (!isNaN(s) && steps.includes(s)) initialStep = s;
  } catch {}

  const settings: OrderBookSettings = {
    unit: savedUnit,
    depth: savedDepth,
    tickStep: initialStep,
  };

  const rhUi: SingleBookUi = {
    venue: "rh",
    cardEl: rhCard,
    asksContainer: rhAsksContainer,
    bidsContainer: rhBidsContainer,
    spreadUsdEl: document.getElementById("rhOrderBookSpreadUsd"),
    spreadPctEl: document.getElementById("rhOrderBookSpreadPct"),
    loadingOverlayEl: document.getElementById("rhOrderBookLoadingOverlay"),
    loadingMessageEl: document.getElementById("rhOrderBookLoadingMessage"),
    stepSelect: rhStepSelect,
    unitSelect: rhUnitSelect,
    depthSelect: rhDepthSelect,
    asksRows: [],
    bidsRows: [],
    asksPrices: new Float64Array(MAX_DEPTH),
    asksSizesBase: new Float64Array(MAX_DEPTH),
    asksSizesUsd: new Float64Array(MAX_DEPTH),
    asksCumBase: new Float64Array(MAX_DEPTH),
    asksCumUsd: new Float64Array(MAX_DEPTH),
    bidsPrices: new Float64Array(MAX_DEPTH),
    bidsSizesBase: new Float64Array(MAX_DEPTH),
    bidsSizesUsd: new Float64Array(MAX_DEPTH),
    bidsCumBase: new Float64Array(MAX_DEPTH),
    bidsCumUsd: new Float64Array(MAX_DEPTH),
    asksActualCount: 0,
    bidsActualCount: 0,
    midPrice: 0,
    prevSpreadUsd: "--",
    prevSpreadPct: "--%",
  };

  const coreUi: SingleBookUi = {
    venue: "core",
    cardEl: coreCard,
    asksContainer: coreAsksContainer,
    bidsContainer: coreBidsContainer,
    spreadUsdEl: document.getElementById("coreOrderBookSpreadUsd"),
    spreadPctEl: document.getElementById("coreOrderBookSpreadPct"),
    loadingOverlayEl: document.getElementById("coreOrderBookLoadingOverlay"),
    loadingMessageEl: document.getElementById("coreOrderBookLoadingMessage"),
    stepSelect: coreStepSelect,
    unitSelect: coreUnitSelect,
    depthSelect: coreDepthSelect,
    asksRows: [],
    bidsRows: [],
    asksPrices: new Float64Array(MAX_DEPTH),
    asksSizesBase: new Float64Array(MAX_DEPTH),
    asksSizesUsd: new Float64Array(MAX_DEPTH),
    asksCumBase: new Float64Array(MAX_DEPTH),
    asksCumUsd: new Float64Array(MAX_DEPTH),
    bidsPrices: new Float64Array(MAX_DEPTH),
    bidsSizesBase: new Float64Array(MAX_DEPTH),
    bidsSizesUsd: new Float64Array(MAX_DEPTH),
    bidsCumBase: new Float64Array(MAX_DEPTH),
    bidsCumUsd: new Float64Array(MAX_DEPTH),
    asksActualCount: 0,
    bidsActualCount: 0,
    midPrice: 0,
    prevSpreadUsd: "--",
    prevSpreadPct: "--%",
  };

  // Pre-create pooled DOM rows up to MAX_DEPTH = 15
  if (rhAsksContainer) {
    rhAsksContainer.innerHTML = "";
    for (let i = 0; i < MAX_DEPTH; i++) {
      const r = createRowElement("rh", true, i);
      rhUi.asksRows.push(r);
      rhAsksContainer.appendChild(r.rowEl);
    }
  }

  if (rhBidsContainer) {
    rhBidsContainer.innerHTML = "";
    for (let i = 0; i < MAX_DEPTH; i++) {
      const r = createRowElement("rh", false, i);
      rhUi.bidsRows.push(r);
      rhBidsContainer.appendChild(r.rowEl);
    }
  }

  if (coreAsksContainer) {
    coreAsksContainer.innerHTML = "";
    for (let i = 0; i < MAX_DEPTH; i++) {
      const r = createRowElement("core", true, i);
      coreUi.asksRows.push(r);
      coreAsksContainer.appendChild(r.rowEl);
    }
  }

  if (coreBidsContainer) {
    coreBidsContainer.innerHTML = "";
    for (let i = 0; i < MAX_DEPTH; i++) {
      const r = createRowElement("core", false, i);
      coreUi.bidsRows.push(r);
      coreBidsContainer.appendChild(r.rowEl);
    }
  }

  updateRowVisibility(rhUi.asksRows, settings.depth);
  updateRowVisibility(rhUi.bidsRows, settings.depth);
  updateRowVisibility(coreUi.asksRows, settings.depth);
  updateRowVisibility(coreUi.bidsRows, settings.depth);

  let currentSymbol = initialSymbol;
  let cachedRhBook: OrderBook | null = null;
  let cachedCoreBook: OrderBook | null = null;
  let activeHoverState: HoverState | null = null;

  const updateBadges = () => {
    const badgeText = settings.unit === "usd" ? "USD" : currentSymbol;
    const badges = document.querySelectorAll(".ob-symbol-badge");
    badges.forEach((b) => {
      b.textContent = badgeText;
    });
  };

  const updateLoadingMessages = () => {
    if (rhUi.loadingMessageEl) {
      rhUi.loadingMessageEl.textContent = `Loading ${currentSymbol} order book from Robinhood Chain...`;
    }
    if (coreUi.loadingMessageEl) {
      coreUi.loadingMessageEl.textContent = `Loading ${currentSymbol} order book from Lighter Core...`;
    }
  };

  const populateStepSelects = (newSteps: number[], chosenStep: number) => {
    const populate = (sel: HTMLSelectElement | null) => {
      if (!sel) return;
      sel.innerHTML = "";
      for (const s of newSteps) {
        const opt = document.createElement("option");
        opt.value = String(s);
        opt.textContent = String(s);
        if (s === chosenStep) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.value = String(chosenStep);
    };
    populate(rhStepSelect);
    populate(coreStepSelect);
  };

  const populateUnitSelects = (sym: string, chosenUnit: OrderBookUnit) => {
    const populate = (sel: HTMLSelectElement | null) => {
      if (!sel) return;
      sel.innerHTML = "";
      const baseOpt = document.createElement("option");
      baseOpt.value = "base";
      baseOpt.textContent = sym;
      baseOpt.className = "ob-unit-token-opt";
      if (chosenUnit === "base") baseOpt.selected = true;

      const usdOpt = document.createElement("option");
      usdOpt.value = "usd";
      usdOpt.textContent = "USD";
      if (chosenUnit === "usd") usdOpt.selected = true;

      sel.appendChild(baseOpt);
      sel.appendChild(usdOpt);
      sel.value = chosenUnit;
    };
    populate(rhUnitSelect);
    populate(coreUnitSelect);
  };

  const syncDepthSelects = (d: number) => {
    if (rhDepthSelect) rhDepthSelect.value = String(d);
    if (coreDepthSelect) coreDepthSelect.value = String(d);
  };

  populateStepSelects(steps, settings.tickStep);
  populateUnitSelects(currentSymbol, settings.unit);
  syncDepthSelects(settings.depth);
  updateBadges();
  updateLoadingMessages();

  const handleUnitChange = (newUnit: OrderBookUnit) => {
    settings.unit = newUnit;
    try {
      localStorage.setItem("analytics_ob_unit", newUnit);
    } catch {}
    if (rhUnitSelect) rhUnitSelect.value = newUnit;
    if (coreUnitSelect) coreUnitSelect.value = newUnit;
    updateBadges();
    renderSingleBook(rhUi, cachedRhBook, settings, currentSymbol, activeHoverState, true);
    renderSingleBook(coreUi, cachedCoreBook, settings, currentSymbol, activeHoverState, true);
  };

  const handleDepthChange = (newDepth: number) => {
    activeHoverState = null;
    hideOrderBookTooltip();
    clearSweepHighlight(rhUi);
    clearSweepHighlight(coreUi);

    settings.depth = newDepth;
    try {
      localStorage.setItem("analytics_ob_depth", String(newDepth));
    } catch {}
    syncDepthSelects(newDepth);
    updateRowVisibility(rhUi.asksRows, newDepth);
    updateRowVisibility(rhUi.bidsRows, newDepth);
    updateRowVisibility(coreUi.asksRows, newDepth);
    updateRowVisibility(coreUi.bidsRows, newDepth);
    renderSingleBook(rhUi, cachedRhBook, settings, currentSymbol, activeHoverState, true);
    renderSingleBook(coreUi, cachedCoreBook, settings, currentSymbol, activeHoverState, true);
  };

  const handleStepChange = (newStep: number) => {
    activeHoverState = null;
    hideOrderBookTooltip();
    clearSweepHighlight(rhUi);
    clearSweepHighlight(coreUi);

    settings.tickStep = newStep;
    try {
      localStorage.setItem("analytics_ob_step", String(newStep));
    } catch {}
    if (rhStepSelect) rhStepSelect.value = String(newStep);
    if (coreStepSelect) coreStepSelect.value = String(newStep);
    renderSingleBook(rhUi, cachedRhBook, settings, currentSymbol, activeHoverState, true);
    renderSingleBook(coreUi, cachedCoreBook, settings, currentSymbol, activeHoverState, true);
  };

  rhUnitSelect?.addEventListener("change", (e) => {
    handleUnitChange((e.target as HTMLSelectElement).value as OrderBookUnit);
  });
  coreUnitSelect?.addEventListener("change", (e) => {
    handleUnitChange((e.target as HTMLSelectElement).value as OrderBookUnit);
  });

  rhDepthSelect?.addEventListener("change", (e) => {
    handleDepthChange(parseInt((e.target as HTMLSelectElement).value, 10));
  });
  coreDepthSelect?.addEventListener("change", (e) => {
    handleDepthChange(parseInt((e.target as HTMLSelectElement).value, 10));
  });

  rhStepSelect?.addEventListener("change", (e) => {
    handleStepChange(parseFloat((e.target as HTMLSelectElement).value));
  });
  coreStepSelect?.addEventListener("change", (e) => {
    handleStepChange(parseFloat((e.target as HTMLSelectElement).value));
  });

  // Event delegation for Order Book Sweep Hover Preview
  const attachHoverListeners = (
    ui: SingleBookUi,
    container: HTMLElement | null,
    isAsk: boolean,
  ) => {
    if (!container) return;

    container.addEventListener("mouseover", (e) => {
      const target = e.target as HTMLElement | null;
      const row = target?.closest(".ob-level-row") as HTMLElement | null;
      if (!row || !container.contains(row)) return;

      const domRow = parseInt(row.dataset.domRow || "", 10);
      if (isNaN(domRow)) return;

      const depth = settings.depth;
      const actualCount = isAsk ? ui.asksActualCount : ui.bidsActualCount;
      const bucketIdx = isAsk ? depth - 1 - domRow : domRow;

      if (bucketIdx < 0 || bucketIdx >= actualCount) {
        hideOrderBookTooltip();
        clearSweepHighlight(ui);
        activeHoverState = null;
        return;
      }

      activeHoverState = {
        venue: ui.venue,
        isAsk,
        bucketIdx,
        domRow,
        rowEl: row,
      };

      updateTooltipForHover(ui, activeHoverState, currentSymbol, settings.tickStep, depth);
    });

    container.addEventListener("mouseleave", () => {
      if (
        activeHoverState &&
        activeHoverState.venue === ui.venue &&
        activeHoverState.isAsk === isAsk
      ) {
        hideOrderBookTooltip();
        clearSweepHighlight(ui);
        activeHoverState = null;
      }
    });
  };

  attachHoverListeners(rhUi, rhAsksContainer, true);
  attachHoverListeners(rhUi, rhBidsContainer, false);
  attachHoverListeners(coreUi, coreAsksContainer, true);
  attachHoverListeners(coreUi, coreBidsContainer, false);

  const api: OrderBookUI = {
    renderRh(book: OrderBook | null, force = false): void {
      cachedRhBook = book;
      renderSingleBook(rhUi, book, settings, currentSymbol, activeHoverState, force);
    },
    renderCore(book: OrderBook | null, force = false): void {
      cachedCoreBook = book;
      renderSingleBook(coreUi, book, settings, currentSymbol, activeHoverState, force);
    },
    renderBoth(rhBook: OrderBook | null, coreBook: OrderBook | null, force = false): void {
      cachedRhBook = rhBook;
      cachedCoreBook = coreBook;
      renderSingleBook(rhUi, rhBook, settings, currentSymbol, activeHoverState, force);
      renderSingleBook(coreUi, coreBook, settings, currentSymbol, activeHoverState, force);
    },
    setSymbol(symbol: string, markPrice?: number): void {
      const isSameSymbol = symbol === currentSymbol;
      currentSymbol = symbol;
      activeHoverState = null;
      hideOrderBookTooltip();
      clearSweepHighlight(rhUi);
      clearSweepHighlight(coreUi);

      const asksSide =
        isSameSymbol && cachedRhBook && "prices" in cachedRhBook.asks
          ? (cachedRhBook.asks as FlatOrderBookSide)
          : null;
      const refPrice =
        markPrice && markPrice > 0
          ? markPrice
          : asksSide && asksSide.count > 0
            ? asksSide.prices[0]!
            : 100;
      const newSteps = generateTickSteps(refPrice);
      let chosenStep = newSteps[0]!;
      try {
        const savedStep = parseFloat(localStorage.getItem("analytics_ob_step") || "");
        if (!isNaN(savedStep) && newSteps.includes(savedStep)) {
          chosenStep = savedStep;
        }
      } catch {}
      settings.tickStep = chosenStep;
      populateStepSelects(newSteps, settings.tickStep);
      populateUnitSelects(currentSymbol, settings.unit);
      updateBadges();
      api.clear(symbol);
    },
    clear(symbol?: string): void {
      if (symbol) {
        currentSymbol = symbol;
        populateUnitSelects(currentSymbol, settings.unit);
        updateBadges();
        updateLoadingMessages();
      }
      activeHoverState = null;
      hideOrderBookTooltip();
      cachedRhBook = null;
      cachedCoreBook = null;
      clearSingleBook(rhUi, settings.depth);
      clearSingleBook(coreUi, settings.depth);
      setSingleBookLoading(rhUi, true);
      setSingleBookLoading(coreUi, true);
    },
    destroy(): void {
      activeHoverState = null;
      hideOrderBookTooltip();
      clearSingleBook(rhUi, settings.depth);
      clearSingleBook(coreUi, settings.depth);
    },
    getSettings(): OrderBookSettings {
      return { ...settings };
    },
    setSettings(newSettings: Partial<OrderBookSettings>): void {
      if (newSettings.unit !== undefined) handleUnitChange(newSettings.unit);
      if (newSettings.depth !== undefined) handleDepthChange(newSettings.depth);
      if (newSettings.tickStep !== undefined) handleStepChange(newSettings.tickStep);
    },
  };

  return api;
}
