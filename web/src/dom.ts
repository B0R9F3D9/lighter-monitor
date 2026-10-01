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
    <td colspan="9" class="p-3">
      <div class="rounded border border-terminal-border bg-terminal-bg p-3">
        <div class="flex items-center justify-between border-b border-terminal-border pb-2.5 mb-2.5 text-xs">
          <div class="flex items-center gap-3">
            <span id="dtlHeader" class="font-bold text-white uppercase tracking-wider"></span>
            <span id="dtlSize" class="text-terminal-secondary"></span>
            <span id="dtlLev" class="text-terminal-muted font-mono"></span>
          </div>
          <div class="flex items-center gap-4">
            <div class="text-[11px]"><span class="text-terminal-muted">Basis:</span> <span id="dtlBasis" class="font-mono font-semibold"></span></div>
            <div class="text-[11px]"><span class="text-terminal-muted">RT Drag:</span> <span id="dtlRtDrag" class="font-mono text-terminal-accent font-semibold"></span></div>
            <div class="text-[11px]"><span class="text-terminal-muted">Net RT Loss:</span> <span id="dtlNetLoss" class="font-mono text-terminal-coral font-bold"></span></div>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-xs font-mono">
            <thead>
              <tr class="border-b border-terminal-borderSubtle text-[10px] text-terminal-muted uppercase">
                <th class="py-1 px-2 text-left">Leg / Action</th>
                <th class="py-1 px-2 text-left">Venue & Side</th>
                <th class="py-1 px-2 text-right">Top of Book</th>
                <th class="py-1 px-2 text-right">VWAP Fill</th>
                <th class="py-1 px-2 text-right">Slippage</th>
                <th class="py-1 px-2 text-right">Levels</th>
                <th class="py-1 px-2 text-right">Avail. Depth</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-terminal-borderSubtle/50 text-[11px]">
              <tr>
                <td class="py-1.5 px-2 font-bold text-terminal-emerald">LEG 1: Open Long</td>
                <td class="py-1.5 px-2 text-terminal-secondary">Robinhood (Buy Ask)</td>
                <td id="dtlL1Top" class="py-1.5 px-2 text-right text-terminal-muted"></td>
                <td id="dtlL1Fill" class="py-1.5 px-2 text-right text-white font-semibold"></td>
                <td id="dtlL1Slip" class="py-1.5 px-2 text-right"></td>
                <td id="dtlL1Swept" class="py-1.5 px-2 text-right text-terminal-secondary"></td>
                <td id="dtlL1Depth" class="py-1.5 px-2 text-right text-terminal-muted"></td>
              </tr>
              <tr>
                <td class="py-1.5 px-2 font-bold text-terminal-coral">LEG 2: Open Short</td>
                <td class="py-1.5 px-2 text-terminal-secondary">Lighter Core (Sell Bid)</td>
                <td id="dtlL2Top" class="py-1.5 px-2 text-right text-terminal-muted"></td>
                <td id="dtlL2Fill" class="py-1.5 px-2 text-right text-white font-semibold"></td>
                <td id="dtlL2Slip" class="py-1.5 px-2 text-right"></td>
                <td id="dtlL2Swept" class="py-1.5 px-2 text-right text-terminal-secondary"></td>
                <td id="dtlL2Depth" class="py-1.5 px-2 text-right text-terminal-muted"></td>
              </tr>
              <tr>
                <td class="py-1.5 px-2 font-medium text-terminal-secondary">LEG 3: Close Long</td>
                <td class="py-1.5 px-2 text-terminal-muted">Robinhood (Sell Bid)</td>
                <td id="dtlL3Top" class="py-1.5 px-2 text-right text-terminal-muted"></td>
                <td id="dtlL3Fill" class="py-1.5 px-2 text-right text-white"></td>
                <td id="dtlL3Slip" class="py-1.5 px-2 text-right text-terminal-muted"></td>
                <td id="dtlL3Swept" class="py-1.5 px-2 text-right text-terminal-secondary"></td>
                <td id="dtlL3Depth" class="py-1.5 px-2 text-right text-terminal-muted"></td>
              </tr>
              <tr>
                <td class="py-1.5 px-2 font-medium text-terminal-secondary">LEG 4: Close Short</td>
                <td class="py-1.5 px-2 text-terminal-muted">Lighter Core (Buy Ask)</td>
                <td id="dtlL4Top" class="py-1.5 px-2 text-right text-terminal-muted"></td>
                <td id="dtlL4Fill" class="py-1.5 px-2 text-right text-white"></td>
                <td id="dtlL4Slip" class="py-1.5 px-2 text-right text-terminal-muted"></td>
                <td id="dtlL4Swept" class="py-1.5 px-2 text-right text-terminal-secondary"></td>
                <td id="dtlL4Depth" class="py-1.5 px-2 text-right text-terminal-muted"></td>
              </tr>
            </tbody>
          </table>
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

  setElementText("dtlHeader", `${r.symbol} 4-LEG EXECUTION BLOTTER`);
  setElementText("dtlSize", `${formatMoney(targetSizeUsd)} (${r.qtyLabel})`);
  setElementText("dtlLev", `RH ${r.rhLeverage} / Core ${r.coreLeverage}`);

  const basisEl = document.getElementById("dtlBasis");
  if (basisEl) {
    basisEl.textContent = formatDeltaMid(r.deltaMidUsd, r.deltaMidBps);
    basisEl.className = Math.abs(r.deltaMidBps) > 6 ? "text-terminal-amber" : "text-terminal-primary";
  }

  setElementText("dtlRtDrag", formatBps(r.vwapTotalDragBps));
  setElementText("dtlNetLoss", formatMoney(r.costUsd));

  // Leg 1
  setElementText("dtlL1Top", formatPrice(l.rhBestAsk));
  setElementText("dtlL1Fill", formatPrice(l.entryRh.avgPrice));
  const l1Slip = document.getElementById("dtlL1Slip");
  if (l1Slip) {
    l1Slip.textContent = formatBps(l.entryRh.slippageBps, true);
    l1Slip.className =
      l.entryRh.slippageBps > 5
        ? "py-1.5 px-2 text-right text-terminal-coral"
        : "py-1.5 px-2 text-right text-terminal-secondary";
  }
  setElementText("dtlL1Swept", String(l.entryRh.levelsSwept));
  setElementText("dtlL1Depth", formatMoney(l.entryRh.totalAvailableUsd));

  // Leg 2
  setElementText("dtlL2Top", formatPrice(l.coreBestBid));
  setElementText("dtlL2Fill", formatPrice(l.entryCore.avgPrice));
  const l2Slip = document.getElementById("dtlL2Slip");
  if (l2Slip) {
    l2Slip.textContent = formatBps(l.entryCore.slippageBps, true);
    l2Slip.className =
      l.entryCore.slippageBps > 5
        ? "py-1.5 px-2 text-right text-terminal-coral"
        : "py-1.5 px-2 text-right text-terminal-secondary";
  }
  setElementText("dtlL2Swept", String(l.entryCore.levelsSwept));
  setElementText("dtlL2Depth", formatMoney(l.entryCore.totalAvailableUsd));

  // Leg 3
  setElementText("dtlL3Top", formatPrice(l.rhBestBid));
  setElementText("dtlL3Fill", formatPrice(l.exitRh.avgPrice));
  setElementText("dtlL3Slip", formatBps(l.exitRh.slippageBps, true));
  setElementText("dtlL3Swept", String(l.exitRh.levelsSwept));
  setElementText("dtlL3Depth", formatMoney(l.exitRh.totalAvailableUsd));

  // Leg 4
  setElementText("dtlL4Top", formatPrice(l.coreBestAsk));
  setElementText("dtlL4Fill", formatPrice(l.exitCore.avgPrice));
  setElementText("dtlL4Slip", formatBps(l.exitCore.slippageBps, true));
  setElementText("dtlL4Swept", String(l.exitCore.levelsSwept));
  setElementText("dtlL4Depth", formatMoney(l.exitCore.totalAvailableUsd));
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
