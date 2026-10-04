import type { MarketInfo, MarketMetrics, RowDomCache } from "./types";
import { formatMoney, formatPrice, formatBps, formatDeltaMid } from "../shared/formatters";

export function createRowElement(
  r: MarketMetrics,
  onToggleExpand: (sym: string) => void,
): RowDomCache {
  const tr = document.createElement("tr");
  tr.className =
    "hover:bg-terminal-surfaceHover cursor-pointer select-none border-b border-terminal-borderSubtle";
  tr.dataset.symbol = r.symbol;

  tr.innerHTML = `
    <td class="py-1.5 sm:py-2 px-1.5 sm:px-2 md:px-2.5 sticky-symbol font-semibold text-white whitespace-nowrap">
      <div class="flex items-center gap-1 sm:gap-1.5">
        <span class="symbol-name font-bold text-xs"></span>
        <span class="symbol-lev text-terminal-muted text-[10px] sm:text-[11px]"></span>
      </div>
    </td>
    <td class="py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-center whitespace-nowrap">
      <span class="verdict-badge text-[10px] sm:text-[11px] font-semibold text-terminal-muted">○ NO DATA</span>
    </td>
    <td class="py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right size-cell col-opt-size tabular-nums font-semibold text-terminal-accent text-xs whitespace-nowrap">
      <span>—</span>
    </td>
    <td class="py-1.5 sm:py-2 px-1 sm:px-2 md:px-2.5 text-right tabular-nums whitespace-nowrap">
      <div class="rt-loss-val font-medium text-terminal-muted text-xs">—</div>
    </td>
    <td class="py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right ptcost-cell tabular-nums font-medium text-terminal-muted text-xs whitespace-nowrap">—</td>
    <td class="py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right tabular-nums whitespace-nowrap">
      <div class="turnover-drag-val font-medium text-terminal-muted text-xs">—</div>
    </td>
    <td class="py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right tabular-nums whitespace-nowrap">
      <div class="mid-price-val text-terminal-primary text-xs leading-tight">—</div>
      <div class="delta-mid-val text-[10px] text-terminal-muted tabular-nums leading-tight">—</div>
    </td>
    <td class="py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right vol-cell tabular-nums text-terminal-secondary text-xs whitespace-nowrap">
      <span>—</span>
    </td>
    <td class="py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right oi-cell tabular-nums text-terminal-secondary text-xs whitespace-nowrap">
      <span>—</span>
    </td>
    <td class="py-1.5 sm:py-2 px-0.5 sm:px-1 text-center text-terminal-muted chevron-cell w-5 sm:w-7">
      <svg class="w-3 h-3 inline-block transition-transform opacity-40 hover:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </td>
  `;

  tr.querySelector(".symbol-name")!.textContent = r.symbol;
  tr.querySelector(".symbol-lev")!.textContent = r.leverage;

  tr.addEventListener("click", () => onToggleExpand(r.symbol));

  return {
    tr,
    verdictEl: tr.querySelector(".verdict-badge") as HTMLElement,
    sizeEl: tr.querySelector(".size-cell span") as HTMLElement,
    rtLossEl: tr.querySelector(".rt-loss-val") as HTMLElement,
    ptCostEl: tr.querySelector(".ptcost-cell") as HTMLElement,
    turnoverDragEl: tr.querySelector(".turnover-drag-val") as HTMLElement,
    midPriceEl: tr.querySelector(".mid-price-val") as HTMLElement,
    deltaMidEl: tr.querySelector(".delta-mid-val") as HTMLElement,
    volEl: tr.querySelector(".vol-cell span") as HTMLElement,
    oiEl: tr.querySelector(".oi-cell span") as HTMLElement,
    chevronEl: tr.querySelector(".chevron-cell svg") as SVGElement | null,
    verdictText: "",
  };
}

function setTextIfChanged(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) {
    el.textContent = text;
  }
}

function setClassIfChanged(el: HTMLElement | null, className: string): void {
  if (el && el.className !== className) {
    el.className = className;
  }
}

export function applyRowMetricsToDom(cache: RowDomCache, row: MarketMetrics): void {
  // 1. Verdict indicator
  if (cache.verdictText !== row.status) {
    cache.verdictText = row.status;
    if (row.status === "READY") {
      setTextIfChanged(cache.verdictEl, "● READY");
      setClassIfChanged(
        cache.verdictEl,
        "verdict-badge text-[11px] font-semibold text-terminal-emerald",
      );
    } else if (row.status === "SLIPPAGE") {
      setTextIfChanged(cache.verdictEl, "▲ SLIP");
      setClassIfChanged(
        cache.verdictEl,
        "verdict-badge text-[11px] font-semibold text-terminal-amber",
      );
    } else if (row.status === "STALE") {
      setTextIfChanged(cache.verdictEl, "● STALE");
      setClassIfChanged(
        cache.verdictEl,
        "verdict-badge text-[11px] font-semibold text-terminal-amber",
      );
    } else {
      setTextIfChanged(cache.verdictEl, "✕ THIN");
      setClassIfChanged(
        cache.verdictEl,
        "verdict-badge text-[11px] font-semibold text-terminal-coral",
      );
    }
  }

  // 1.5. Target / Optimal Size ($)
  if (cache.sizeEl) {
    const sizeChanged =
      cache.lastTargetUsd === undefined ||
      cache.lastTargetUsd !== row.effectiveTargetUsd ||
      cache.lastIsDynamic !== row.isDynamic;
    if (sizeChanged) {
      cache.lastTargetUsd = row.effectiveTargetUsd;
      cache.lastIsDynamic = row.isDynamic;
      setTextIfChanged(
        cache.sizeEl,
        row.effectiveTargetUsd > 0 ? formatMoney(row.effectiveTargetUsd) : "—",
      );
      if (row.isDynamic) {
        setClassIfChanged(cache.sizeEl, "tabular-nums font-bold text-terminal-accent text-xs");
        if (cache.sizeEl.title !== "Dynamically optimized size from live order book") {
          cache.sizeEl.title = "Dynamically optimized size from live order book";
        }
      } else {
        setClassIfChanged(cache.sizeEl, "tabular-nums font-medium text-white text-xs");
        const title = `Fixed target size: ${formatMoney(row.effectiveTargetUsd)}`;
        if (cache.sizeEl.title !== title) {
          cache.sizeEl.title = title;
        }
      }
    }
  }

  // 2. Round-Trip Loss ($)
  if (cache.rtLossEl) {
    const costTier = row.isStale
      ? -2
      : !row.allFilled
        ? -1
        : row.costUsd <= 3.0
          ? 0
          : row.costUsd <= 7.0
            ? 1
            : 2;
    const costChanged =
      cache.lastCostUsd === undefined ||
      Math.abs(cache.lastCostUsd - row.costUsd) >= 0.005 ||
      cache.lastCostTier !== costTier;
    if (costChanged) {
      cache.lastCostUsd = row.costUsd;
      cache.lastCostTier = costTier;
      if (row.isStale) {
        setTextIfChanged(cache.rtLossEl, "—");
        setClassIfChanged(
          cache.rtLossEl,
          "rt-loss-val font-medium text-terminal-muted tabular-nums text-xs",
        );
      } else if (!row.allFilled) {
        setTextIfChanged(cache.rtLossEl, "N/A (< liq)");
        setClassIfChanged(
          cache.rtLossEl,
          "rt-loss-val font-semibold text-terminal-coral tabular-nums text-xs",
        );
      } else {
        setTextIfChanged(cache.rtLossEl, formatMoney(row.costUsd));
        if (costTier === 0) {
          setClassIfChanged(
            cache.rtLossEl,
            "rt-loss-val font-bold text-terminal-emerald tabular-nums text-xs",
          );
        } else if (costTier === 1) {
          setClassIfChanged(
            cache.rtLossEl,
            "rt-loss-val font-semibold text-terminal-primary tabular-nums text-xs",
          );
        } else {
          setClassIfChanged(
            cache.rtLossEl,
            "rt-loss-val font-medium text-terminal-secondary tabular-nums text-xs",
          );
        }
      }
    }
  }

  // 3. Point Cost ($/pt)
  if (cache.ptCostEl) {
    const ptTier = row.isStale
      ? -2
      : !row.allFilled
        ? -1
        : row.pointCostUsd < 1.5
          ? 0
          : row.pointCostUsd <= 3.0
            ? 1
            : 2;
    const ptChanged =
      cache.lastPointCostUsd === undefined ||
      Math.abs(cache.lastPointCostUsd - row.pointCostUsd) >= 0.005 ||
      cache.lastPointCostTier !== ptTier;
    if (ptChanged) {
      cache.lastPointCostUsd = row.pointCostUsd;
      cache.lastPointCostTier = ptTier;
      if (row.isStale) {
        setTextIfChanged(cache.ptCostEl, "—");
        setClassIfChanged(
          cache.ptCostEl,
          "py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right font-medium text-terminal-muted tabular-nums text-xs whitespace-nowrap",
        );
      } else if (!row.allFilled) {
        setTextIfChanged(cache.ptCostEl, "N/A");
        setClassIfChanged(
          cache.ptCostEl,
          "py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right font-medium text-terminal-muted tabular-nums text-xs whitespace-nowrap",
        );
      } else {
        setTextIfChanged(cache.ptCostEl, `$${row.pointCostUsd.toFixed(2)}/pt`);
        if (ptTier === 0) {
          setClassIfChanged(
            cache.ptCostEl,
            "py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right font-bold text-terminal-emerald tabular-nums text-xs whitespace-nowrap",
          );
        } else if (ptTier === 1) {
          setClassIfChanged(
            cache.ptCostEl,
            "py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right font-medium text-terminal-amber tabular-nums text-xs whitespace-nowrap",
          );
        } else {
          setClassIfChanged(
            cache.ptCostEl,
            "py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right font-medium text-terminal-coral tabular-nums text-xs whitespace-nowrap",
          );
        }
      }
    }
  }

  // 4. Turnover Drag in bps
  if (cache.turnoverDragEl) {
    const dragTier = row.isStale ? -2 : !row.allFilled ? -1 : 0;
    const dragChanged =
      cache.lastDragBps === undefined ||
      Math.abs(cache.lastDragBps - row.vwapTotalDragBps) >= 0.05 ||
      cache.lastDragTier !== dragTier;
    if (dragChanged) {
      cache.lastDragBps = row.vwapTotalDragBps;
      cache.lastDragTier = dragTier;
      if (row.isStale) {
        setTextIfChanged(cache.turnoverDragEl, "—");
      } else if (!row.allFilled) {
        setTextIfChanged(cache.turnoverDragEl, "N/A");
      } else {
        setTextIfChanged(cache.turnoverDragEl, formatBps(row.vwapTotalDragBps));
      }
    }
  }

  // 5. Mid Price & Inter-Exchange Basis (Delta Mid)
  if (cache.midPriceEl) {
    const midThreshold = row.midPrice >= 1 ? 0.005 : 0.0001;
    if (
      cache.lastMidPrice === undefined ||
      Math.abs(cache.lastMidPrice - row.midPrice) >= midThreshold
    ) {
      cache.lastMidPrice = row.midPrice;
      setTextIfChanged(cache.midPriceEl, row.midPrice > 0 ? formatPrice(row.midPrice) : "—");
    }
  }
  if (cache.deltaMidEl) {
    const deltaThreshold = row.midPrice >= 1 ? 0.005 : 0.0001;
    const deltaMidChanged =
      cache.lastDeltaMidUsd === undefined ||
      Math.abs(cache.lastDeltaMidUsd - row.deltaMidUsd) >= deltaThreshold ||
      cache.lastDeltaMidBps === undefined ||
      Math.abs(row.deltaMidBps) > 6.0 !== Math.abs(cache.lastDeltaMidBps) > 6.0;
    if (deltaMidChanged) {
      cache.lastDeltaMidUsd = row.deltaMidUsd;
      cache.lastDeltaMidBps = row.deltaMidBps;
      setTextIfChanged(
        cache.deltaMidEl,
        row.midPrice > 0 ? `Δ ${formatPrice(Math.abs(row.deltaMidUsd))}` : "—",
      );
      if (Math.abs(row.deltaMidBps) > 6.0) {
        setClassIfChanged(
          cache.deltaMidEl,
          "delta-mid-val text-[10px] text-terminal-amber font-semibold tabular-nums",
        );
      } else {
        setClassIfChanged(
          cache.deltaMidEl,
          "delta-mid-val text-[10px] text-terminal-muted tabular-nums",
        );
      }
    }
  }

  // 6. 24h Vol & 24h OI
  if (cache.volEl && cache.lastVol !== row.totalVolume24h) {
    cache.lastVol = row.totalVolume24h;
    setTextIfChanged(cache.volEl, formatMoney(row.totalVolume24h));
  }
  if (cache.oiEl && cache.lastOi !== row.totalOiUsd) {
    cache.lastOi = row.totalOiUsd;
    setTextIfChanged(cache.oiEl, formatMoney(row.totalOiUsd));
  }
}

export function applyNullMetricsToDom(cache: RowDomCache, m: MarketInfo): void {
  if (cache.verdictText !== "NO_DATA") {
    cache.verdictText = "NO_DATA";
    setTextIfChanged(cache.verdictEl, "○ NO DATA");
    setClassIfChanged(
      cache.verdictEl,
      "verdict-badge text-[11px] font-semibold text-terminal-muted",
    );
  }
  if (cache.sizeEl) {
    setTextIfChanged(cache.sizeEl, "—");
    setClassIfChanged(cache.sizeEl, "tabular-nums font-medium text-terminal-muted text-xs");
  }
  setTextIfChanged(cache.rtLossEl, "—");
  setClassIfChanged(
    cache.rtLossEl,
    "rt-loss-val font-medium text-terminal-muted tabular-nums text-xs",
  );
  setTextIfChanged(cache.ptCostEl, "—");
  setClassIfChanged(
    cache.ptCostEl,
    "py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right font-medium text-terminal-muted tabular-nums text-xs whitespace-nowrap",
  );
  setTextIfChanged(cache.turnoverDragEl, "—");
  setTextIfChanged(cache.midPriceEl, "—");
  if (cache.deltaMidEl) {
    setTextIfChanged(cache.deltaMidEl, "—");
    setClassIfChanged(
      cache.deltaMidEl,
      "delta-mid-val text-[10px] text-terminal-muted tabular-nums",
    );
  }
  if (cache.volEl) {
    setTextIfChanged(cache.volEl, m.totalVolume24h > 0 ? formatMoney(m.totalVolume24h) : "—");
  }
  if (cache.oiEl) {
    setTextIfChanged(cache.oiEl, m.totalOiUsd > 0 ? formatMoney(m.totalOiUsd) : "—");
  }
}

export function createDetailRowElement(
  r: MarketMetrics,
  targetSizeUsd: number,
): HTMLTableRowElement {
  const detailTr = document.createElement("tr");
  detailTr.id = "expandedDetailRow";
  detailTr.className = "bg-terminal-surface/70 border-b border-terminal-border";

  detailTr.innerHTML = `
    <td colspan="${r.isDynamic ? 10 : 9}" class="detail-row-cell py-2 sm:py-3 px-1 sm:px-2">
      <div class="detail-expanded-container mx-auto space-y-2 font-mono text-xs">
        <!-- Top Info Bar -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between border-b border-terminal-border pb-1.5 text-[11px] gap-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-white font-bold">Execution Breakdown (4 Legs):</span>
            <span id="dtlSymbol" class="text-terminal-secondary font-semibold"></span>
            <span id="dtlLev" class="text-terminal-accent font-semibold"></span>
            <span id="dtlLevVenues" class="text-terminal-muted text-[10px]"></span>
            <span id="dtlSize" class="text-white font-semibold"></span>
          </div>
          <div class="text-terminal-muted flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]">
            <div>Basis: <span id="dtlBasis" class="font-bold tabular-nums"></span></div>
            <div>Entry: <span id="dtlEntry" class="text-terminal-emerald font-bold tabular-nums"></span> <span id="dtlEntryDrag" class="text-terminal-muted tabular-nums"></span></div>
            <div>Exit: <span id="dtlExit" class="text-terminal-secondary font-bold tabular-nums"></span> <span id="dtlExitDrag" class="text-terminal-muted tabular-nums"></span></div>
          </div>
        </div>

        <!-- 4 Leg Cards (4 vertical blocks) -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 min-w-0">
          <!-- Leg 1: RH LONG -->
          <div class="bg-terminal-surface border border-terminal-emerald/30 p-2 sm:p-2.5 rounded space-y-1 min-w-0">
            <div class="flex items-center justify-between text-[11px] font-bold text-terminal-emerald">
              <span>LEG 1: RH LONG</span>
              <span class="text-[9px] px-1 py-0.2 rounded bg-terminal-emeraldMuted border border-terminal-emerald/30">Buy Ask</span>
            </div>
            <div class="text-[11px] space-y-0.5 text-terminal-secondary">
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Top Ask:</span> <span id="dtlL1Top" class="tabular-nums font-semibold text-terminal-primary shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">VWAP Fill:</span> <span id="dtlL1Fill" class="text-white font-bold tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Slippage:</span> <span id="dtlL1Slip" class="text-terminal-emerald tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Levels Swept:</span> <span id="dtlL1Swept" class="tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Asks Depth:</span> <span id="dtlL1Depth" class="tabular-nums shrink-0"></span></div>
            </div>
          </div>

          <!-- Leg 2: CORE SHORT -->
          <div class="bg-terminal-surface border border-terminal-coral/30 p-2 sm:p-2.5 rounded space-y-1 min-w-0">
            <div class="flex items-center justify-between text-[11px] font-bold text-terminal-coral">
              <span>LEG 2: CORE SHORT</span>
              <span class="text-[9px] px-1 py-0.2 rounded bg-terminal-coralMuted border border-terminal-coral/30">Sell Bid</span>
            </div>
            <div class="text-[11px] space-y-0.5 text-terminal-secondary">
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Top Bid:</span> <span id="dtlL2Top" class="tabular-nums font-semibold text-terminal-primary shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">VWAP Fill:</span> <span id="dtlL2Fill" class="text-white font-bold tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Slippage:</span> <span id="dtlL2Slip" class="text-terminal-coral tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Levels Swept:</span> <span id="dtlL2Swept" class="tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Bids Depth:</span> <span id="dtlL2Depth" class="tabular-nums shrink-0"></span></div>
            </div>
          </div>

          <!-- Leg 3: CLOSE RH -->
          <div class="bg-terminal-surface border border-terminal-border p-2 sm:p-2.5 rounded space-y-1 min-w-0">
            <div class="flex items-center justify-between text-[11px] font-bold text-terminal-secondary">
              <span>LEG 3: CLOSE RH</span>
              <span class="text-[9px] px-1 py-0.2 rounded bg-terminal-bg border border-terminal-border text-terminal-muted">Sell Bid</span>
            </div>
            <div class="text-[11px] space-y-0.5 text-terminal-secondary">
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Top Bid:</span> <span id="dtlL3Top" class="tabular-nums font-semibold text-terminal-primary shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">VWAP Fill:</span> <span id="dtlL3Fill" class="text-white font-bold tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Slippage:</span> <span id="dtlL3Slip" class="tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Levels Swept:</span> <span id="dtlL3Swept" class="tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Bids Depth:</span> <span id="dtlL3Depth" class="tabular-nums shrink-0"></span></div>
            </div>
          </div>

          <!-- Leg 4: CLOSE CORE -->
          <div class="bg-terminal-surface border border-terminal-border p-2 sm:p-2.5 rounded space-y-1 min-w-0">
            <div class="flex items-center justify-between text-[11px] font-bold text-terminal-secondary">
              <span>LEG 4: CLOSE CORE</span>
              <span class="text-[9px] px-1 py-0.2 rounded bg-terminal-bg border border-terminal-border text-terminal-muted">Buy Ask</span>
            </div>
            <div class="text-[11px] space-y-0.5 text-terminal-secondary">
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Top Ask:</span> <span id="dtlL4Top" class="tabular-nums font-semibold text-terminal-primary shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">VWAP Fill:</span> <span id="dtlL4Fill" class="text-white font-bold tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Slippage:</span> <span id="dtlL4Slip" class="tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Levels Swept:</span> <span id="dtlL4Swept" class="tabular-nums shrink-0"></span></div>
              <div class="flex justify-between items-center"><span class="text-terminal-muted shrink-0">Asks Depth:</span> <span id="dtlL4Depth" class="tabular-nums shrink-0"></span></div>
            </div>
          </div>
        </div>

        <!-- Summary Footnote -->
        <div class="p-1.5 sm:p-2 bg-terminal-surface rounded border border-terminal-borderSubtle text-[10px] text-terminal-muted flex flex-col sm:flex-row sm:items-center justify-between gap-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>Mid <strong id="dtlFntMid" class="text-white"></strong></span>
            <span>Entry: <strong id="dtlFntEntryCost" class="text-white"></strong></span>
          </div>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>Turnover Drag: <strong id="dtlFntDrag" class="text-terminal-primary"></strong></span>
            <span>(RT Loss: <strong id="dtlFntRtLoss" class="text-terminal-coral"></strong>)</span>
            <span>Cost/pt: <strong id="dtlFntPtCost"></strong></span>
          </div>
        </div>
      </div>
    </td>
  `;

  updateDetailRow(r, targetSizeUsd, detailTr);
  return detailTr;
}

interface DetailRowDomCache {
  dtlSymbol: HTMLElement | null;
  dtlLev: HTMLElement | null;
  dtlLevVenues: HTMLElement | null;
  dtlSize: HTMLElement | null;
  dtlBasis: HTMLElement | null;
  dtlEntry: HTMLElement | null;
  dtlEntryDrag: HTMLElement | null;
  dtlExit: HTMLElement | null;
  dtlExitDrag: HTMLElement | null;
  dtlL1Top: HTMLElement | null;
  dtlL1Fill: HTMLElement | null;
  dtlL1Slip: HTMLElement | null;
  dtlL1Swept: HTMLElement | null;
  dtlL1Depth: HTMLElement | null;
  dtlL2Top: HTMLElement | null;
  dtlL2Fill: HTMLElement | null;
  dtlL2Slip: HTMLElement | null;
  dtlL2Swept: HTMLElement | null;
  dtlL2Depth: HTMLElement | null;
  dtlL3Top: HTMLElement | null;
  dtlL3Fill: HTMLElement | null;
  dtlL3Slip: HTMLElement | null;
  dtlL3Swept: HTMLElement | null;
  dtlL3Depth: HTMLElement | null;
  dtlL4Top: HTMLElement | null;
  dtlL4Fill: HTMLElement | null;
  dtlL4Slip: HTMLElement | null;
  dtlL4Swept: HTMLElement | null;
  dtlL4Depth: HTMLElement | null;
  dtlFntMid: HTMLElement | null;
  dtlFntEntryCost: HTMLElement | null;
  dtlFntDrag: HTMLElement | null;
  dtlFntRtLoss: HTMLElement | null;
  dtlFntPtCost: HTMLElement | null;
}

const detailRowCacheMap = new WeakMap<HTMLElement, DetailRowDomCache>();

function getDetailRowCache(root: HTMLElement | Document): DetailRowDomCache {
  if (root instanceof HTMLElement) {
    let cache = detailRowCacheMap.get(root);
    if (!cache) {
      cache = {
        dtlSymbol: root.querySelector("#dtlSymbol"),
        dtlLev: root.querySelector("#dtlLev"),
        dtlLevVenues: root.querySelector("#dtlLevVenues"),
        dtlSize: root.querySelector("#dtlSize"),
        dtlBasis: root.querySelector("#dtlBasis"),
        dtlEntry: root.querySelector("#dtlEntry"),
        dtlEntryDrag: root.querySelector("#dtlEntryDrag"),
        dtlExit: root.querySelector("#dtlExit"),
        dtlExitDrag: root.querySelector("#dtlExitDrag"),
        dtlL1Top: root.querySelector("#dtlL1Top"),
        dtlL1Fill: root.querySelector("#dtlL1Fill"),
        dtlL1Slip: root.querySelector("#dtlL1Slip"),
        dtlL1Swept: root.querySelector("#dtlL1Swept"),
        dtlL1Depth: root.querySelector("#dtlL1Depth"),
        dtlL2Top: root.querySelector("#dtlL2Top"),
        dtlL2Fill: root.querySelector("#dtlL2Fill"),
        dtlL2Slip: root.querySelector("#dtlL2Slip"),
        dtlL2Swept: root.querySelector("#dtlL2Swept"),
        dtlL2Depth: root.querySelector("#dtlL2Depth"),
        dtlL3Top: root.querySelector("#dtlL3Top"),
        dtlL3Fill: root.querySelector("#dtlL3Fill"),
        dtlL3Slip: root.querySelector("#dtlL3Slip"),
        dtlL3Swept: root.querySelector("#dtlL3Swept"),
        dtlL3Depth: root.querySelector("#dtlL3Depth"),
        dtlL4Top: root.querySelector("#dtlL4Top"),
        dtlL4Fill: root.querySelector("#dtlL4Fill"),
        dtlL4Slip: root.querySelector("#dtlL4Slip"),
        dtlL4Swept: root.querySelector("#dtlL4Swept"),
        dtlL4Depth: root.querySelector("#dtlL4Depth"),
        dtlFntMid: root.querySelector("#dtlFntMid"),
        dtlFntEntryCost: root.querySelector("#dtlFntEntryCost"),
        dtlFntDrag: root.querySelector("#dtlFntDrag"),
        dtlFntRtLoss: root.querySelector("#dtlFntRtLoss"),
        dtlFntPtCost: root.querySelector("#dtlFntPtCost"),
      };
      detailRowCacheMap.set(root, cache);
    }
    return cache;
  }
  return {
    dtlSymbol: root.getElementById("dtlSymbol"),
    dtlLev: root.getElementById("dtlLev"),
    dtlLevVenues: root.getElementById("dtlLevVenues"),
    dtlSize: root.getElementById("dtlSize"),
    dtlBasis: root.getElementById("dtlBasis"),
    dtlEntry: root.getElementById("dtlEntry"),
    dtlEntryDrag: root.getElementById("dtlEntryDrag"),
    dtlExit: root.getElementById("dtlExit"),
    dtlExitDrag: root.getElementById("dtlExitDrag"),
    dtlL1Top: root.getElementById("dtlL1Top"),
    dtlL1Fill: root.getElementById("dtlL1Fill"),
    dtlL1Slip: root.getElementById("dtlL1Slip"),
    dtlL1Swept: root.getElementById("dtlL1Swept"),
    dtlL1Depth: root.getElementById("dtlL1Depth"),
    dtlL2Top: root.getElementById("dtlL2Top"),
    dtlL2Fill: root.getElementById("dtlL2Fill"),
    dtlL2Slip: root.getElementById("dtlL2Slip"),
    dtlL2Swept: root.getElementById("dtlL2Swept"),
    dtlL2Depth: root.getElementById("dtlL2Depth"),
    dtlL3Top: root.getElementById("dtlL3Top"),
    dtlL3Fill: root.getElementById("dtlL3Fill"),
    dtlL3Slip: root.getElementById("dtlL3Slip"),
    dtlL3Swept: root.getElementById("dtlL3Swept"),
    dtlL3Depth: root.getElementById("dtlL3Depth"),
    dtlL4Top: root.getElementById("dtlL4Top"),
    dtlL4Fill: root.getElementById("dtlL4Fill"),
    dtlL4Slip: root.getElementById("dtlL4Slip"),
    dtlL4Swept: root.getElementById("dtlL4Swept"),
    dtlL4Depth: root.getElementById("dtlL4Depth"),
    dtlFntMid: root.getElementById("dtlFntMid"),
    dtlFntEntryCost: root.getElementById("dtlFntEntryCost"),
    dtlFntDrag: root.getElementById("dtlFntDrag"),
    dtlFntRtLoss: root.getElementById("dtlFntRtLoss"),
    dtlFntPtCost: root.getElementById("dtlFntPtCost"),
  };
}

export function updateDetailRow(
  r: MarketMetrics,
  targetSizeUsd: number,
  root: HTMLElement | Document = document,
): void {
  const l = r.legs;
  const c = getDetailRowCache(root);

  // Header info
  setTextIfChanged(c.dtlSymbol, r.symbol);
  setTextIfChanged(c.dtlLev, `[Min Lev: ${r.leverage}]`);
  setTextIfChanged(c.dtlLevVenues, `(RH: ${r.rhLeverage} • Core: ${r.coreLeverage})`);
  setTextIfChanged(
    c.dtlSize,
    `Size: ${formatMoney(r.effectiveTargetUsd || targetSizeUsd)}${
      r.isDynamic ? (r.dynamicMode === "min_burn" ? " (Min Burn Opt)" : " (Max Vol Opt)") : ""
    }`,
  );

  if (c.dtlBasis) {
    setTextIfChanged(c.dtlBasis, formatDeltaMid(r.deltaMidUsd, r.deltaMidBps));
    setClassIfChanged(
      c.dtlBasis,
      Math.abs(r.deltaMidBps) > 6
        ? "text-terminal-amber font-bold tabular-nums"
        : "text-white font-bold tabular-nums",
    );
  }

  setTextIfChanged(c.dtlEntry, formatMoney(r.entryLossUsd));
  setTextIfChanged(c.dtlEntryDrag, `(${formatBps(r.entryDragBps, true)})`);
  setTextIfChanged(c.dtlExit, formatMoney(r.exitLossUsd));
  setTextIfChanged(c.dtlExitDrag, `(${formatBps(r.exitDragBps, true)})`);

  // Leg 1: RH LONG
  setTextIfChanged(c.dtlL1Top, formatPrice(l.rhBestAsk));
  setTextIfChanged(c.dtlL1Fill, formatPrice(l.entryRh.avgPrice));
  setTextIfChanged(c.dtlL1Slip, formatBps(l.entryRh.slippageBps, true));
  setTextIfChanged(c.dtlL1Swept, String(l.entryRh.levelsSwept));
  setTextIfChanged(c.dtlL1Depth, formatMoney(l.entryRh.totalAvailableUsd));

  // Leg 2: CORE SHORT
  setTextIfChanged(c.dtlL2Top, formatPrice(l.coreBestBid));
  setTextIfChanged(c.dtlL2Fill, formatPrice(l.entryCore.avgPrice));
  setTextIfChanged(c.dtlL2Slip, formatBps(l.entryCore.slippageBps, true));
  setTextIfChanged(c.dtlL2Swept, String(l.entryCore.levelsSwept));
  setTextIfChanged(c.dtlL2Depth, formatMoney(l.entryCore.totalAvailableUsd));

  // Leg 3: CLOSE RH
  setTextIfChanged(c.dtlL3Top, formatPrice(l.rhBestBid));
  setTextIfChanged(c.dtlL3Fill, formatPrice(l.exitRh.avgPrice));
  setTextIfChanged(c.dtlL3Slip, formatBps(l.exitRh.slippageBps, true));
  setTextIfChanged(c.dtlL3Swept, String(l.exitRh.levelsSwept));
  setTextIfChanged(c.dtlL3Depth, formatMoney(l.exitRh.totalAvailableUsd));

  // Leg 4: CLOSE CORE
  setTextIfChanged(c.dtlL4Top, formatPrice(l.coreBestAsk));
  setTextIfChanged(c.dtlL4Fill, formatPrice(l.exitCore.avgPrice));
  setTextIfChanged(c.dtlL4Slip, formatBps(l.exitCore.slippageBps, true));
  setTextIfChanged(c.dtlL4Swept, String(l.exitCore.levelsSwept));
  setTextIfChanged(c.dtlL4Depth, formatMoney(l.exitCore.totalAvailableUsd));

  // Footnote summary
  setTextIfChanged(c.dtlFntMid, formatPrice(r.midPrice));

  if (c.dtlFntEntryCost) {
    setTextIfChanged(c.dtlFntEntryCost, formatMoney(r.entryLossUsd));
    setClassIfChanged(
      c.dtlFntEntryCost,
      r.entryLossUsd <= 0 ? "text-terminal-emerald" : "text-white",
    );
  }

  setTextIfChanged(c.dtlFntDrag, formatBps(r.vwapTotalDragBps));
  setTextIfChanged(c.dtlFntRtLoss, formatMoney(r.costUsd));

  if (c.dtlFntPtCost) {
    setTextIfChanged(c.dtlFntPtCost, `$${r.pointCostUsd.toFixed(2)} / pt`);
    setClassIfChanged(
      c.dtlFntPtCost,
      r.pointCostUsd < 1.5 ? "text-terminal-emerald font-bold" : "text-terminal-amber font-bold",
    );
  }
}

interface ExecutiveSummaryDomElements {
  vBadge: HTMLElement | null;
  topSymbol: HTMLElement | null;
  topLeverage: HTMLElement | null;
  topSizeLabel: HTMLElement | null;
  topOptSize: HTMLElement | null;
  topLossUsd: HTMLElement | null;
  topEntryLossUsd: HTMLElement | null;
  topPointCost: HTMLElement | null;
  topVwapDrag: HTMLElement | null;
  topLiquidity: HTMLElement | null;
}

let cachedSummaryElements: ExecutiveSummaryDomElements | null = null;
let lastSummarySymbol: string | null = null;
let lastSummaryCost = -999999;
let lastSummaryTarget = -999999;
let lastSummaryPtCost = -999999;
let lastSummaryDynamicMode: string | boolean = "";

function getSummaryElements(): ExecutiveSummaryDomElements {
  if (!cachedSummaryElements) {
    cachedSummaryElements = {
      vBadge: document.getElementById("topVerdictBadge"),
      topSymbol: document.getElementById("topSymbol"),
      topLeverage: document.getElementById("topLeverage"),
      topSizeLabel: document.getElementById("topSizeLabel"),
      topOptSize: document.getElementById("topOptSize"),
      topLossUsd: document.getElementById("topLossUsd"),
      topEntryLossUsd: document.getElementById("topEntryLossUsd"),
      topPointCost: document.getElementById("topPointCost"),
      topVwapDrag: document.getElementById("topVwapDrag"),
      topLiquidity: document.getElementById("topLiquidity"),
    };
  }
  return cachedSummaryElements;
}

export function updateExecutiveSummary(
  r: MarketMetrics | null,
  dynamicMode: "none" | "min_burn" | "max_vol" | boolean = "none",
): void {
  const els = getSummaryElements();
  const isDynamic = typeof dynamicMode === "boolean" ? dynamicMode : dynamicMode !== "none";

  if (!r) {
    if (lastSummarySymbol === null) return;
    lastSummarySymbol = null;
    lastSummaryCost = -999999;
    lastSummaryTarget = -999999;
    lastSummaryPtCost = -999999;
    lastSummaryDynamicMode = dynamicMode;

    setTextIfChanged(els.topSymbol, "--");
    setTextIfChanged(els.topLeverage, "--");
    setTextIfChanged(els.topSizeLabel, isDynamic ? "OPT SIZE:" : "SIZE:");
    setTextIfChanged(els.topOptSize, "$--");
    setTextIfChanged(els.topLossUsd, "$--");
    setTextIfChanged(els.topEntryLossUsd, "");
    setTextIfChanged(els.topPointCost, "$--/pt");
    setTextIfChanged(els.topVwapDrag, "-- bps");
    setTextIfChanged(els.topLiquidity, "$--");
    if (els.vBadge) {
      setTextIfChanged(els.vBadge, "○ SCANNING");
      setClassIfChanged(els.vBadge, "text-[11px] font-semibold text-terminal-muted");
    }
    return;
  }

  // Dirty check: skip if leader and key metrics are unchanged
  if (
    r.symbol === lastSummarySymbol &&
    Math.abs(r.costUsd - lastSummaryCost) < 0.005 &&
    r.effectiveTargetUsd === lastSummaryTarget &&
    Math.abs(r.pointCostUsd - lastSummaryPtCost) < 0.005 &&
    dynamicMode === lastSummaryDynamicMode
  ) {
    return;
  }

  lastSummarySymbol = r.symbol;
  lastSummaryCost = r.costUsd;
  lastSummaryTarget = r.effectiveTargetUsd;
  lastSummaryPtCost = r.pointCostUsd;
  lastSummaryDynamicMode = dynamicMode;

  setTextIfChanged(els.topSymbol, r.symbol);
  setTextIfChanged(els.topLeverage, r.leverage);
  setTextIfChanged(els.topSizeLabel, isDynamic ? "OPT SIZE:" : "SIZE:");
  setTextIfChanged(els.topOptSize, formatMoney(r.effectiveTargetUsd));
  setTextIfChanged(els.topLossUsd, formatMoney(r.costUsd));
  const sign = r.entryLossUsd > 0 ? "+" : "";
  setTextIfChanged(els.topEntryLossUsd, `(${sign}${formatMoney(r.entryLossUsd)} entry)`);
  setTextIfChanged(els.topPointCost, `$${r.pointCostUsd.toFixed(2)}/pt`);
  setTextIfChanged(els.topVwapDrag, formatBps(r.vwapTotalDragBps));
  setTextIfChanged(els.topLiquidity, formatMoney(r.minDepthUsd));

  if (els.vBadge) {
    if (r.costUsd <= 0) {
      setTextIfChanged(els.vBadge, "● ARB EDGE");
      setClassIfChanged(els.vBadge, "text-[11px] font-semibold text-terminal-accent animate-pulse");
    } else if (dynamicMode === "min_burn" || (isDynamic && dynamicMode !== "max_vol")) {
      setTextIfChanged(els.vBadge, "● MIN BURN");
      setClassIfChanged(els.vBadge, "text-[11px] font-semibold text-terminal-accent");
    } else if (dynamicMode === "max_vol") {
      setTextIfChanged(els.vBadge, "● MAX VOL");
      setClassIfChanged(els.vBadge, "text-[11px] font-semibold text-terminal-accent");
    } else {
      setTextIfChanged(els.vBadge, "● READY");
      setClassIfChanged(els.vBadge, "text-[11px] font-semibold text-terminal-emerald");
    }
  }
}
