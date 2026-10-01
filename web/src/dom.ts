import type { MarketInfo, MarketMetrics, RowDomCache } from "./types";
import { formatMoney, formatPrice, formatBps, formatDeltaMid } from "./formatters";
import { copyToClipboard } from "./clipboard";

export function createRowElement(
  r: MarketMetrics,
  onToggleExpand: (sym: string) => void,
): RowDomCache {
  const tr = document.createElement("tr");
  tr.className =
    "hover:bg-terminal-surfaceHover cursor-pointer select-none border-b border-terminal-borderSubtle";
  tr.dataset.symbol = r.symbol;

  tr.innerHTML = `
    <td class="py-2 px-3 sticky-symbol font-semibold text-white">
      <div class="flex items-center gap-2">
        <span class="symbol-name font-bold"></span>
        <span class="symbol-lev text-terminal-muted text-[11px]"></span>
        <button
          type="button"
          class="copy-qty-btn text-[11px] text-terminal-muted hover:text-terminal-accent hover:underline transition tabular-nums ml-1"
          title="Click to copy size"
        ></button>
      </div>
    </td>
    <td class="py-2 px-2 text-center">
      <span class="verdict-badge text-[11px] font-semibold text-terminal-emerald">● READY</span>
    </td>
    <td class="py-2 px-3 text-right tabular-nums">
      <div class="rt-loss-val font-bold text-terminal-emerald text-xs">$0.00</div>
    </td>
    <td class="py-2 px-3 text-right ptcost-cell tabular-nums font-medium text-terminal-primary text-xs">$0.00 / pt</td>
    <td class="py-2 px-2.5 text-right tabular-nums">
      <div class="turnover-drag-val font-medium text-terminal-primary text-xs">0.00 bps</div>
    </td>
    <td class="py-2 px-2.5 text-right tabular-nums">
      <div class="mid-price-val text-terminal-primary text-xs">$0.00</div>
      <div class="delta-mid-val text-[10px] text-terminal-muted tabular-nums">Δ $0.00</div>
    </td>
    <td class="py-2 px-3 text-right depth-cell tabular-nums text-terminal-muted text-xs">$0.00</td>
    <td class="py-2 px-3 text-right vol-cell tabular-nums text-terminal-secondary text-xs">
      <span>$0.00</span>
    </td>
    <td class="py-2 px-2 text-center text-terminal-muted chevron-cell">
      <svg class="w-3 h-3 inline-block transition-transform opacity-40 hover:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </td>
  `;

  tr.querySelector(".symbol-name")!.textContent = r.symbol;
  tr.querySelector(".symbol-lev")!.textContent = r.leverage;

  const copyBtn = tr.querySelector(".copy-qty-btn") as HTMLButtonElement;
  copyBtn.textContent = r.qtyLabel;
  copyBtn.dataset.rawQty = r.copyQty;
  copyBtn.dataset.label = r.qtyLabel;
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const raw = copyBtn.dataset.rawQty;
    if (!raw) return;
    copyToClipboard(raw, copyBtn, copyBtn.dataset.label || raw);
  });

  tr.addEventListener("click", () => onToggleExpand(r.symbol));

  return {
    tr,
    verdictEl: tr.querySelector(".verdict-badge") as HTMLElement,
    copyBtn,
    rtLossEl: tr.querySelector(".rt-loss-val") as HTMLElement,
    ptCostEl: tr.querySelector(".ptcost-cell") as HTMLElement,
    turnoverDragEl: tr.querySelector(".turnover-drag-val") as HTMLElement,
    midPriceEl: tr.querySelector(".mid-price-val") as HTMLElement,
    deltaMidEl: tr.querySelector(".delta-mid-val") as HTMLElement,
    depthEl: tr.querySelector(".depth-cell") as HTMLElement,
    volEl: tr.querySelector(".vol-cell span") as HTMLElement,
    chevronEl: tr.querySelector(".chevron-cell svg") as SVGElement | null,
    verdictText: "",
  };
}

export function applyRowMetricsToDom(cache: RowDomCache, row: MarketMetrics): void {
  // 1. Verdict indicator
  if (cache.verdictText !== row.status) {
    cache.verdictText = row.status;
    if (row.status === "READY") {
      cache.verdictEl.textContent = "● READY";
      cache.verdictEl.className = "verdict-badge text-[11px] font-semibold text-terminal-emerald";
    } else if (row.status === "SLIPPAGE") {
      cache.verdictEl.textContent = "▲ SLIP";
      cache.verdictEl.className = "verdict-badge text-[11px] font-semibold text-terminal-amber";
    } else if (row.status === "STALE") {
      cache.verdictEl.textContent = "● STALE";
      cache.verdictEl.className = "verdict-badge text-[11px] font-semibold text-terminal-amber";
    } else {
      cache.verdictEl.textContent = "✕ THIN";
      cache.verdictEl.className = "verdict-badge text-[11px] font-semibold text-terminal-coral";
    }
  }

  // 2. Base Asset Size Button
  if (cache.copyBtn) {
    cache.copyBtn.dataset.rawQty = row.copyQty;
    cache.copyBtn.dataset.label = row.qtyLabel;
    if (!cache.copyBtn.dataset.isCopied) {
      cache.copyBtn.textContent = row.qtyLabel;
    }
  }

  // 3. Round-Trip Loss ($)
  if (row.isStale) {
    cache.rtLossEl.textContent = "—";
    cache.rtLossEl.className = "rt-loss-val font-medium text-terminal-muted tabular-nums text-xs";
  } else if (!row.allFilled) {
    cache.rtLossEl.textContent = "N/A (< liq)";
    cache.rtLossEl.className = "rt-loss-val font-semibold text-terminal-coral tabular-nums text-xs";
  } else {
    cache.rtLossEl.textContent = formatMoney(row.costUsd);
    if (row.costUsd <= 3.0) {
      cache.rtLossEl.className = "rt-loss-val font-bold text-terminal-emerald tabular-nums text-xs";
    } else if (row.costUsd <= 7.0) {
      cache.rtLossEl.className = "rt-loss-val font-semibold text-terminal-primary tabular-nums text-xs";
    } else {
      cache.rtLossEl.className = "rt-loss-val font-medium text-terminal-secondary tabular-nums text-xs";
    }
  }

  // 4. Point Cost ($/pt)
  if (row.isStale) {
    cache.ptCostEl.textContent = "—";
    cache.ptCostEl.className = "py-2 px-3 text-right font-medium text-terminal-muted tabular-nums text-xs";
  } else if (!row.allFilled) {
    cache.ptCostEl.textContent = "N/A";
    cache.ptCostEl.className = "py-2 px-3 text-right font-medium text-terminal-muted tabular-nums text-xs";
  } else {
    cache.ptCostEl.textContent = `$${row.pointCostUsd.toFixed(2)} / pt`;
    if (row.pointCostUsd < 1.5) {
      cache.ptCostEl.className = "py-2 px-3 text-right font-bold text-terminal-emerald tabular-nums text-xs";
    } else if (row.pointCostUsd <= 3.0) {
      cache.ptCostEl.className = "py-2 px-3 text-right font-medium text-terminal-amber tabular-nums text-xs";
    } else {
      cache.ptCostEl.className = "py-2 px-3 text-right font-medium text-terminal-coral tabular-nums text-xs";
    }
  }

  // 5. Turnover Drag in bps
  if (row.isStale) {
    cache.turnoverDragEl.textContent = "—";
  } else if (!row.allFilled) {
    cache.turnoverDragEl.textContent = "N/A";
  } else {
    cache.turnoverDragEl.textContent = formatBps(row.vwapTotalDragBps);
  }

  // 6. Mid Price & Inter-Exchange Basis (Delta Mid)
  cache.midPriceEl.textContent = formatPrice(row.midPrice);
  if (cache.deltaMidEl) {
    cache.deltaMidEl.textContent = `Δ ${formatPrice(Math.abs(row.deltaMidUsd))}`;
    if (Math.abs(row.deltaMidBps) > 6.0) {
      cache.deltaMidEl.className = "delta-mid-val text-[10px] text-terminal-amber font-semibold tabular-nums";
    } else {
      cache.deltaMidEl.className = "delta-mid-val text-[10px] text-terminal-muted tabular-nums";
    }
  }

  // 7. Depth & 24h Vol
  cache.depthEl.textContent = formatMoney(row.minDepthUsd);
  if (cache.volEl) {
    cache.volEl.textContent = formatMoney(row.totalVolume24h);
  }
}

export function applyNullMetricsToDom(cache: RowDomCache, _m: MarketInfo): void {
  if (cache.verdictText !== "NO_DATA") {
    cache.verdictText = "NO_DATA";
    cache.verdictEl.textContent = "○ NO DATA";
    cache.verdictEl.className = "verdict-badge text-[11px] font-semibold text-terminal-muted";
  }
  if (cache.copyBtn && !cache.copyBtn.dataset.isCopied) {
    cache.copyBtn.textContent = "—";
    delete cache.copyBtn.dataset.rawQty;
    delete cache.copyBtn.dataset.label;
  }
  cache.rtLossEl.textContent = "—";
  cache.rtLossEl.className = "rt-loss-val font-medium text-terminal-muted tabular-nums text-xs";
  cache.ptCostEl.textContent = "—";
  cache.ptCostEl.className = "py-2 px-3 text-right font-medium text-terminal-muted tabular-nums text-xs";
  cache.turnoverDragEl.textContent = "—";
  cache.midPriceEl.textContent = "—";
  if (cache.deltaMidEl) {
    cache.deltaMidEl.textContent = "—";
    cache.deltaMidEl.className = "delta-mid-val text-[10px] text-terminal-muted tabular-nums";
  }
  cache.depthEl.textContent = "—";
}

export function createDetailRowElement(r: MarketMetrics, targetSizeUsd: number): HTMLTableRowElement {
  const detailTr = document.createElement("tr");
  detailTr.id = "expandedDetailRow";
  detailTr.className = "bg-terminal-surface/70 border-b border-terminal-border";

  detailTr.innerHTML = `
    <td colspan="9" class="py-2 sm:py-3 px-1 sm:px-2">
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

        <!-- 4 Leg Cards (4 вертикальные блока) -->
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
            <span>Size: <strong id="dtlFntSize" class="text-white"></strong></span>
            <span>@ Mid <strong id="dtlFntMid" class="text-white"></strong></span>
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

  updateDetailRow(r, targetSizeUsd);
  return detailTr;
}

function setElementText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

export function updateDetailRow(r: MarketMetrics, targetSizeUsd: number): void {
  const l = r.legs;

  // Header info
  setElementText("dtlSymbol", r.symbol);
  setElementText("dtlLev", `[Min Lev: ${r.leverage}]`);
  setElementText("dtlLevVenues", `(RH: ${r.rhLeverage} • Core: ${r.coreLeverage})`);
  setElementText("dtlSize", `Size: ${formatMoney(targetSizeUsd)}`);

  const basisEl = document.getElementById("dtlBasis");
  if (basisEl) {
    basisEl.textContent = formatDeltaMid(r.deltaMidUsd, r.deltaMidBps);
    basisEl.className =
      Math.abs(r.deltaMidBps) > 6
        ? "text-terminal-amber font-bold tabular-nums"
        : "text-white font-bold tabular-nums";
  }

  setElementText("dtlEntry", formatMoney(r.entryLossUsd));
  setElementText("dtlEntryDrag", `(${formatBps(r.entryDragBps, true)})`);
  setElementText("dtlExit", formatMoney(r.exitLossUsd));
  setElementText("dtlExitDrag", `(${formatBps(r.exitDragBps, true)})`);

  // Leg 1: RH LONG
  setElementText("dtlL1Top", formatPrice(l.rhBestAsk));
  setElementText("dtlL1Fill", formatPrice(l.entryRh.avgPrice));
  setElementText("dtlL1Slip", formatBps(l.entryRh.slippageBps, true));
  setElementText("dtlL1Swept", String(l.entryRh.levelsSwept));
  setElementText("dtlL1Depth", formatMoney(l.entryRh.totalAvailableUsd));

  // Leg 2: CORE SHORT
  setElementText("dtlL2Top", formatPrice(l.coreBestBid));
  setElementText("dtlL2Fill", formatPrice(l.entryCore.avgPrice));
  setElementText("dtlL2Slip", formatBps(l.entryCore.slippageBps, true));
  setElementText("dtlL2Swept", String(l.entryCore.levelsSwept));
  setElementText("dtlL2Depth", formatMoney(l.entryCore.totalAvailableUsd));

  // Leg 3: CLOSE RH
  setElementText("dtlL3Top", formatPrice(l.rhBestBid));
  setElementText("dtlL3Fill", formatPrice(l.exitRh.avgPrice));
  setElementText("dtlL3Slip", formatBps(l.exitRh.slippageBps, true));
  setElementText("dtlL3Swept", String(l.exitRh.levelsSwept));
  setElementText("dtlL3Depth", formatMoney(l.exitRh.totalAvailableUsd));

  // Leg 4: CLOSE CORE
  setElementText("dtlL4Top", formatPrice(l.coreBestAsk));
  setElementText("dtlL4Fill", formatPrice(l.exitCore.avgPrice));
  setElementText("dtlL4Slip", formatBps(l.exitCore.slippageBps, true));
  setElementText("dtlL4Swept", String(l.exitCore.levelsSwept));
  setElementText("dtlL4Depth", formatMoney(l.exitCore.totalAvailableUsd));

  // Footnote summary
  setElementText("dtlFntSize", `${r.copyQty} (${r.qtyLabel})`);
  setElementText("dtlFntMid", formatPrice(r.midPrice));

  const fntEntryCost = document.getElementById("dtlFntEntryCost");
  if (fntEntryCost) {
    fntEntryCost.textContent = formatMoney(r.entryLossUsd);
    fntEntryCost.className = r.entryLossUsd <= 0 ? "text-terminal-emerald" : "text-white";
  }

  setElementText("dtlFntDrag", formatBps(r.vwapTotalDragBps));
  setElementText("dtlFntRtLoss", formatMoney(r.costUsd));

  const fntPtCost = document.getElementById("dtlFntPtCost");
  if (fntPtCost) {
    fntPtCost.textContent = `$${r.pointCostUsd.toFixed(2)} / pt`;
    fntPtCost.className =
      r.pointCostUsd < 1.5 ? "text-terminal-emerald font-bold" : "text-terminal-amber font-bold";
  }
}

export function updateExecutiveSummary(r: MarketMetrics | null): void {
  const topQtyBtn = document.getElementById("topCopyQtyBtn") as HTMLButtonElement | null;
  const vBadge = document.getElementById("topVerdictBadge");

  if (!r) {
    setElementText("topSymbol", "--");
    setElementText("topLeverage", "--");
    setElementText("topLossUsd", "$--");
    setElementText("topEntryLossUsd", "");
    setElementText("topPointCost", "$--/pt");
    setElementText("topVwapDrag", "-- bps");
    setElementText("topLiquidity", "$--");
    if (topQtyBtn) {
      topQtyBtn.textContent = "-- sh";
      delete topQtyBtn.dataset.rawQty;
      delete topQtyBtn.dataset.label;
    }
    if (vBadge) {
      vBadge.textContent = "○ SCANNING";
      vBadge.className = "text-[11px] font-semibold text-terminal-muted";
    }
    return;
  }

  setElementText("topSymbol", r.symbol);
  setElementText("topLeverage", r.leverage);
  setElementText("topLossUsd", formatMoney(r.costUsd));
  const sign = r.entryLossUsd > 0 ? "+" : "";
  setElementText("topEntryLossUsd", `(${sign}${formatMoney(r.entryLossUsd)} entry)`);
  setElementText("topPointCost", `$${r.pointCostUsd.toFixed(2)}/pt`);
  setElementText("topVwapDrag", formatBps(r.vwapTotalDragBps));
  setElementText("topLiquidity", formatMoney(r.minDepthUsd));

  if (topQtyBtn) {
    topQtyBtn.dataset.rawQty = r.copyQty;
    topQtyBtn.dataset.label = r.qtyLabel;
    if (!topQtyBtn.dataset.isCopied) {
      topQtyBtn.textContent = r.qtyLabel;
    }
  }

  if (vBadge) {
    vBadge.textContent = "● READY";
    vBadge.className = "text-[11px] font-semibold text-terminal-emerald";
  }
}
