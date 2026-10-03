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

export function setTextIfChanged(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) {
    el.textContent = text;
  }
}

export function setClassIfChanged(el: HTMLElement | null, className: string): void {
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

  // 2. Round-Trip Loss ($)
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
    if (row.costUsd <= 3.0) {
      setClassIfChanged(
        cache.rtLossEl,
        "rt-loss-val font-bold text-terminal-emerald tabular-nums text-xs",
      );
    } else if (row.costUsd <= 7.0) {
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

  // 3. Point Cost ($/pt)
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
    if (row.pointCostUsd < 1.5) {
      setClassIfChanged(
        cache.ptCostEl,
        "py-1.5 sm:py-2 px-1 sm:px-1.5 md:px-2 text-right font-bold text-terminal-emerald tabular-nums text-xs whitespace-nowrap",
      );
    } else if (row.pointCostUsd <= 3.0) {
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

  // 4. Turnover Drag in bps
  if (row.isStale) {
    setTextIfChanged(cache.turnoverDragEl, "—");
  } else if (!row.allFilled) {
    setTextIfChanged(cache.turnoverDragEl, "N/A");
  } else {
    setTextIfChanged(cache.turnoverDragEl, formatBps(row.vwapTotalDragBps));
  }

  // 5. Mid Price & Inter-Exchange Basis (Delta Mid)
  setTextIfChanged(cache.midPriceEl, row.midPrice > 0 ? formatPrice(row.midPrice) : "—");
  if (cache.deltaMidEl) {
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

function setElementText(
  id: string,
  text: string,
  root: HTMLElement | Document = document,
): void {
  const el =
    root instanceof Document
      ? root.getElementById(id)
      : (root.querySelector(`#${id}`) as HTMLElement | null);
  if (el && el.textContent !== text) el.textContent = text;
}

export function updateDetailRow(
  r: MarketMetrics,
  targetSizeUsd: number,
  root: HTMLElement | Document = document,
): void {
  const l = r.legs;

  // Header info
  setElementText("dtlSymbol", r.symbol, root);
  setElementText("dtlLev", `[Min Lev: ${r.leverage}]`, root);
  setElementText("dtlLevVenues", `(RH: ${r.rhLeverage} • Core: ${r.coreLeverage})`, root);
  setElementText(
    "dtlSize",
    `Size: ${formatMoney(r.effectiveTargetUsd || targetSizeUsd)}${
      r.isDynamic ? (r.dynamicMode === "min_burn" ? " (Min Burn Opt)" : " (Max Vol Opt)") : ""
    }`,
    root,
  );

  const basisEl =
    root instanceof Document
      ? root.getElementById("dtlBasis")
      : (root.querySelector("#dtlBasis") as HTMLElement | null);
  if (basisEl) {
    basisEl.textContent = formatDeltaMid(r.deltaMidUsd, r.deltaMidBps);
    basisEl.className =
      Math.abs(r.deltaMidBps) > 6
        ? "text-terminal-amber font-bold tabular-nums"
        : "text-white font-bold tabular-nums";
  }

  setElementText("dtlEntry", formatMoney(r.entryLossUsd), root);
  setElementText("dtlEntryDrag", `(${formatBps(r.entryDragBps, true)})`, root);
  setElementText("dtlExit", formatMoney(r.exitLossUsd), root);
  setElementText("dtlExitDrag", `(${formatBps(r.exitDragBps, true)})`, root);

  // Leg 1: RH LONG
  setElementText("dtlL1Top", formatPrice(l.rhBestAsk), root);
  setElementText("dtlL1Fill", formatPrice(l.entryRh.avgPrice), root);
  setElementText("dtlL1Slip", formatBps(l.entryRh.slippageBps, true), root);
  setElementText("dtlL1Swept", String(l.entryRh.levelsSwept), root);
  setElementText("dtlL1Depth", formatMoney(l.entryRh.totalAvailableUsd), root);

  // Leg 2: CORE SHORT
  setElementText("dtlL2Top", formatPrice(l.coreBestBid), root);
  setElementText("dtlL2Fill", formatPrice(l.entryCore.avgPrice), root);
  setElementText("dtlL2Slip", formatBps(l.entryCore.slippageBps, true), root);
  setElementText("dtlL2Swept", String(l.entryCore.levelsSwept), root);
  setElementText("dtlL2Depth", formatMoney(l.entryCore.totalAvailableUsd), root);

  // Leg 3: CLOSE RH
  setElementText("dtlL3Top", formatPrice(l.rhBestBid), root);
  setElementText("dtlL3Fill", formatPrice(l.exitRh.avgPrice), root);
  setElementText("dtlL3Slip", formatBps(l.exitRh.slippageBps, true), root);
  setElementText("dtlL3Swept", String(l.exitRh.levelsSwept), root);
  setElementText("dtlL3Depth", formatMoney(l.exitRh.totalAvailableUsd), root);

  // Leg 4: CLOSE CORE
  setElementText("dtlL4Top", formatPrice(l.coreBestAsk), root);
  setElementText("dtlL4Fill", formatPrice(l.exitCore.avgPrice), root);
  setElementText("dtlL4Slip", formatBps(l.exitCore.slippageBps, true), root);
  setElementText("dtlL4Swept", String(l.exitCore.levelsSwept), root);
  setElementText("dtlL4Depth", formatMoney(l.exitCore.totalAvailableUsd), root);

  // Footnote summary
  setElementText("dtlFntMid", formatPrice(r.midPrice), root);

  const fntEntryCost =
    root instanceof Document
      ? root.getElementById("dtlFntEntryCost")
      : (root.querySelector("#dtlFntEntryCost") as HTMLElement | null);
  if (fntEntryCost) {
    fntEntryCost.textContent = formatMoney(r.entryLossUsd);
    fntEntryCost.className = r.entryLossUsd <= 0 ? "text-terminal-emerald" : "text-white";
  }

  setElementText("dtlFntDrag", formatBps(r.vwapTotalDragBps), root);
  setElementText("dtlFntRtLoss", formatMoney(r.costUsd), root);

  const fntPtCost =
    root instanceof Document
      ? root.getElementById("dtlFntPtCost")
      : (root.querySelector("#dtlFntPtCost") as HTMLElement | null);
  if (fntPtCost) {
    fntPtCost.textContent = `$${r.pointCostUsd.toFixed(2)} / pt`;
    fntPtCost.className =
      r.pointCostUsd < 1.5 ? "text-terminal-emerald font-bold" : "text-terminal-amber font-bold";
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
