import { formatFee, formatMoney, formatPrice } from "../shared/formatters";
import { formatShortMonthDay } from "./date_filter";
import {
  calculateWeeklyPointsAnalysis,
  calculateWeeklyPointsTotalStats,
  type WeekActivityStats,
  type WeeklyPointsTotalStats,
} from "./hedge";
import type {
  AccountDailyStat,
  HedgePair,
  HedgeSummaryMetrics,
  IndividualAccountMetrics,
  MarketSummarySortColumn,
  MarketSummaryStat,
  SelectedHedgeMetrics,
  UnhedgedTrade,
  WeeklyPointsSortColumn,
} from "./types";

function formatSmartSize(size: number): string {
  if (size === 0 || isNaN(size)) return "0.0";
  if (size >= 100) return size.toFixed(1);
  if (size >= 1) return size.toFixed(3);
  return size.toFixed(4);
}

function padZero(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Formats a timestamp in milliseconds into local browser timezone YYYY-MM-DD HH:MM:SS.
 */
export function formatTimestampLocal(ms: number | undefined | null): string {
  if (!ms || isNaN(ms)) return "--";
  const d = new Date(ms);
  return `${d.getFullYear()}-${padZero(d.getMonth() + 1)}-${padZero(d.getDate())} ${padZero(d.getHours())}:${padZero(d.getMinutes())}:${padZero(d.getSeconds())}`;
}

/**
 * Formats a USD notional amount compactly in thousands/millions (e.g. 0.1K, 1.5K, 25K, 1.2M)
 * without extra cents, stripping trailing zero decimals for whole numbers.
 */
export function formatCompactK(val: number | undefined | null): string {
  if (val === undefined || val === null || isNaN(val) || val <= 0) return "0K";
  const abs = Math.abs(val);
  if (abs >= 1e6) {
    const m = abs / 1e6;
    if (abs >= 1e8) return Math.round(m) + "M";
    const str = m.toFixed(1);
    return (str.endsWith(".0") ? str.slice(0, -2) : str) + "M";
  }
  if (abs >= 1e5) {
    return Math.round(abs / 1e3) + "K";
  }
  const k = abs / 1e3;
  if (k < 0.05) return "<0.1K";
  const str = k.toFixed(1);
  return (str.endsWith(".0") && abs >= 1e3 ? str.slice(0, -2) : str) + "K";
}

function createHedgeRow(pair: HedgePair, index: number, isSelected = false): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const baseClass =
    "hover:bg-terminal-surfaceHover transition-colors text-xs font-mono select-none cursor-pointer";
  tr.className = isSelected ? `${baseClass} bg-white/10 hover:bg-white/[0.13]` : baseClass;
  tr.dataset.id = pair.id;
  tr.dataset.index = index.toString();
  tr.title = "Click or drag to select (Shift+Click for range)";

  const rhIsBuy = pair.rhSide === "BUY";
  const coreIsBuy = pair.coreSide === "BUY";

  const rhSideColor = rhIsBuy ? "text-terminal-emerald" : "text-terminal-coral";
  const coreSideColor = coreIsBuy ? "text-terminal-emerald" : "text-terminal-coral";

  let priceDeltaHtml = `<span class="text-terminal-muted tabular-nums">$0.00</span>`;
  if (pair.priceDelta > 0.0001) {
    priceDeltaHtml = `<span class="text-terminal-secondary font-medium tabular-nums">+${formatPrice(pair.priceDelta)}</span>`;
  } else if (pair.priceDelta < -0.0001) {
    priceDeltaHtml = `<span class="text-terminal-secondary font-medium tabular-nums">${formatPrice(pair.priceDelta)}</span>`;
  }

  let netPnlStr = "$0.00";
  let netPnlColor = "text-terminal-muted";
  if (pair.netPnlUsd > 0.0001) {
    netPnlStr = `+${formatMoney(pair.netPnlUsd)}`;
    netPnlColor = "text-terminal-emerald";
  } else if (pair.netPnlUsd < -0.0001) {
    netPnlStr = formatMoney(pair.netPnlUsd);
    netPnlColor = "text-terminal-coral";
  }

  let slippageStr = "$0.00";
  if (pair.pricePnlUsd > 0.0001) {
    slippageStr = `+${formatMoney(pair.pricePnlUsd)}`;
  } else if (pair.pricePnlUsd < -0.0001) {
    slippageStr = formatMoney(pair.pricePnlUsd);
  }

  const statusBadge =
    pair.status === "HEDGED"
      ? `<span class="text-terminal-emerald font-semibold text-[11px]">HEDGED</span>`
      : `<span class="text-terminal-amber font-semibold text-[11px]">PARTIAL</span>`;

  const timeDeltaStr = (pair.timeDeltaSec >= 0 ? "+" : "") + pair.timeDeltaSec.toFixed(1) + "s";
  const localTime = pair.rhTimestampMs
    ? formatTimestampLocal(pair.rhTimestampMs)
    : pair.rhTimeFormatted;
  const notionalK = formatCompactK(pair.notionalUsd);

  const rhFund = pair.rhFundingUsd;
  const coreFund = pair.coreFundingUsd;
  const totalFund = pair.totalFundingUsd;
  let fundingHtml = `<span class="text-terminal-muted tabular-nums">—</span>`;
  let fundingTooltip = "No funding history available";
  if (totalFund !== null && totalFund !== undefined) {
    if (totalFund > 0.0001) {
      fundingHtml = `<span class="text-white tabular-nums">+${formatMoney(totalFund)}</span>`;
    } else if (totalFund < -0.0001) {
      fundingHtml = `<span class="text-white tabular-nums">${formatMoney(totalFund)}</span>`;
    } else {
      fundingHtml = `<span class="text-terminal-muted tabular-nums">$0.00</span>`;
    }
    const rhFundStr =
      rhFund !== null && rhFund !== undefined
        ? `${rhFund >= 0 ? "+" : ""}${formatMoney(rhFund)}`
        : "—";
    const coreFundStr =
      coreFund !== null && coreFund !== undefined
        ? `${coreFund >= 0 ? "+" : ""}${formatMoney(coreFund)}`
        : "—";
    fundingTooltip = `Net Funding: ${totalFund >= 0 ? "+" : ""}${formatMoney(totalFund)} | RH: ${rhFundStr} | Core: ${coreFundStr}`;
  }

  tr.innerHTML = `
    <td class="py-1.5 px-2 text-center w-7">
      <input
        type="checkbox"
        class="hedge-row-cb hedge-cb"
        data-id="${pair.id}"
        ${isSelected ? "checked" : ""}
        title="Select pair (drag or Shift+Click for range)"
      />
    </td>
    <td class="py-1.5 px-2 text-terminal-muted tabular-nums text-[11px]">${index}</td>
    <td class="py-1.5 px-2 text-white whitespace-nowrap text-[11px]" title="Local: ${localTime} | UTC: ${pair.rhTimeFormatted}">${localTime}</td>
    <td class="py-1.5 px-2 whitespace-nowrap">
      <span class="font-bold text-white">${pair.marketSymbol}</span>
    </td>
    <td class="py-1.5 px-2 whitespace-nowrap text-[11px]">
      <span class="font-bold ${rhSideColor}">${pair.rhSide}</span>
      <span class="text-white tabular-nums ml-1">@ ${formatPrice(pair.rhPrice)}</span>
      ${pair.rhFillsCount && pair.rhFillsCount > 1 ? `<span class="text-terminal-muted text-[10px] ml-1">(${pair.rhFillsCount} fills)</span>` : ""}
    </td>
    <td class="py-1.5 px-2 whitespace-nowrap text-[11px]">
      <span class="font-bold ${coreSideColor}">${pair.coreSide}</span>
      <span class="text-white tabular-nums ml-1">@ ${formatPrice(pair.corePrice)}</span>
      ${pair.coreFillsCount && pair.coreFillsCount > 1 ? `<span class="text-terminal-muted text-[10px] ml-1">(${pair.coreFillsCount} fills)</span>` : ""}
    </td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap tabular-nums" title="Size: ${formatSmartSize(pair.matchedSize)} | Notional: ${formatMoney(pair.notionalUsd)}">
      <span class="text-white font-medium">${formatSmartSize(pair.matchedSize)}</span>
      <span class="text-terminal-muted text-[10px] font-normal ml-1">(${notionalK})</span>
    </td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap">${priceDeltaHtml}</td>
    <td class="py-1.5 px-2 text-right text-white text-[11px] tabular-nums">${formatFee(pair.totalFeesUsd)}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap text-[11px]" title="${fundingTooltip}">${fundingHtml}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap" title="Net Hedge PnL: ${netPnlStr} (${pair.pnlBps.toFixed(2)} bps) | Gross Slippage: ${slippageStr} | Fees: ${formatFee(pair.totalFeesUsd)}">
      <span class="${netPnlColor} font-bold tabular-nums">${netPnlStr}</span>
      <span class="text-terminal-muted text-[10px] tabular-nums font-normal ml-1">(${slippageStr})</span>
    </td>
    <td class="py-1.5 px-2 text-right text-terminal-muted text-[11px] tabular-nums">${timeDeltaStr}</td>
    <td class="py-1.5 px-2 text-center whitespace-nowrap">${statusBadge}</td>
  `;

  return tr;
}

function createUnhedgedRow(
  trade: UnhedgedTrade,
  index: number,
  isSelected = false,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const id = trade.id || `unhedged-${trade.network}-${trade.tradeId}`;
  const baseClass =
    "hover:bg-terminal-surfaceHover transition-colors text-xs font-mono select-none cursor-pointer";
  tr.className = isSelected
    ? `${baseClass} bg-white/10 hover:bg-white/[0.13]`
    : `${baseClass} bg-terminal-coral/5`;
  tr.dataset.id = id;
  tr.dataset.index = index.toString();
  tr.title = "Click or drag to select (Shift+Click for range)";

  const isBuy = trade.side === "BUY";
  const sideColor = isBuy ? "text-terminal-emerald" : "text-terminal-coral";

  const rhLegHtml =
    trade.network === "RH"
      ? `<span class="font-bold ${sideColor}">${trade.side}</span> <span class="text-white tabular-nums">@ ${formatPrice(trade.price)}</span>${trade.fillsCount && trade.fillsCount > 1 ? ` <span class="text-terminal-muted text-[10px]">(${trade.fillsCount} fills)</span>` : ""}`
      : `<span class="text-terminal-muted">--</span>`;

  const coreLegHtml =
    trade.network === "CORE"
      ? `<span class="font-bold ${sideColor}">${trade.side}</span> <span class="text-white tabular-nums">@ ${formatPrice(trade.price)}</span>${trade.fillsCount && trade.fillsCount > 1 ? ` <span class="text-terminal-muted text-[10px]">(${trade.fillsCount} fills)</span>` : ""}`
      : `<span class="text-terminal-muted">--</span>`;

  const localTime = trade.timestampMs
    ? formatTimestampLocal(trade.timestampMs)
    : trade.timeFormatted;
  const notionalK = formatCompactK(trade.usdValue);

  const uFund = trade.fundingUsd;
  let uFundingHtml = `<span class="text-terminal-muted tabular-nums">—</span>`;
  let uFundingTooltip = `${trade.network} Funding: —`;
  if (uFund !== null && uFund !== undefined) {
    if (uFund > 0.0001) {
      uFundingHtml = `<span class="text-white tabular-nums">+${formatMoney(uFund)}</span>`;
    } else if (uFund < -0.0001) {
      uFundingHtml = `<span class="text-white tabular-nums">${formatMoney(uFund)}</span>`;
    } else {
      uFundingHtml = `<span class="text-terminal-muted tabular-nums">$0.00</span>`;
    }
    uFundingTooltip = `${trade.network} Funding: ${uFund >= 0 ? "+" : ""}${formatMoney(uFund)}`;
  }

  tr.innerHTML = `
    <td class="py-1.5 px-2 text-center w-7">
      <input
        type="checkbox"
        class="hedge-row-cb hedge-cb"
        data-id="${id}"
        ${isSelected ? "checked" : ""}
        title="Select trade (drag or Shift+Click for range)"
      />
    </td>
    <td class="py-1.5 px-2 text-terminal-muted tabular-nums text-[11px]">${index}</td>
    <td class="py-1.5 px-2 text-white whitespace-nowrap text-[11px]" title="Local: ${localTime} | UTC: ${trade.timeFormatted}">${localTime}</td>
    <td class="py-1.5 px-2 whitespace-nowrap">
      <span class="font-bold text-white">${trade.marketSymbol}</span>
    </td>
    <td class="py-1.5 px-2 whitespace-nowrap text-[11px]">${rhLegHtml}</td>
    <td class="py-1.5 px-2 whitespace-nowrap text-[11px]">${coreLegHtml}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap tabular-nums" title="Unhedged Size: ${formatSmartSize(trade.unhedgedSize)} | Notional: ${formatMoney(trade.usdValue)}">
      <span class="text-terminal-coral font-semibold">${formatSmartSize(trade.unhedgedSize)}</span>
      <span class="text-terminal-muted text-[10px] font-normal ml-1">(${notionalK})</span>
    </td>
    <td class="py-1.5 px-2 text-right text-terminal-muted">--</td>
    <td class="py-1.5 px-2 text-right text-white text-[11px] tabular-nums">${formatFee(trade.feeUsd)}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap text-[11px]" title="${uFundingTooltip}">${uFundingHtml}</td>
    <td class="py-1.5 px-2 text-right text-terminal-muted font-bold">--</td>
    <td class="py-1.5 px-2 text-right text-terminal-muted">--</td>
    <td class="py-1.5 px-2 text-center whitespace-nowrap">
      <span class="text-terminal-coral font-bold text-[11px]">UNHEDGED (${trade.network})</span>
    </td>
  `;

  return tr;
}

export function renderHedgeTable(
  container: HTMLTableSectionElement,
  pairs: HedgePair[],
  unhedged: UnhedgedTrade[],
  filterMode: "all" | "unhedged" = "all",
  limit = 100,
  selectedIds: Set<string> = new Set(),
  onLoadMore?: () => void,
): void {
  container.innerHTML = "";

  const showPairs = filterMode === "all";
  const totalItems = (showPairs ? pairs.length : 0) + unhedged.length;

  if (totalItems === 0) {
    const emptyRow = document.createElement("tr");
    emptyRow.innerHTML = `
      <td colspan="13" class="py-12 text-center text-terminal-muted">
        <div class="flex flex-col items-center justify-center gap-1.5 font-sans">
          <span class="text-terminal-secondary font-medium">No hedge pairs to display</span>
          <span class="text-[11px] text-terminal-muted">Configure Read-Only tokens above and click "Sync New Data" to compare and audit your hedge efficiency.</span>
        </div>
      </td>
    `;
    container.appendChild(emptyRow);
    return;
  }

  const frag = document.createDocumentFragment();
  let rowCount = 0;

  if (showPairs) {
    for (const pair of pairs) {
      if (rowCount >= limit) break;
      frag.appendChild(createHedgeRow(pair, ++rowCount, selectedIds.has(pair.id)));
    }
  }

  for (const item of unhedged) {
    if (rowCount >= limit) break;
    const uId = item.id || `unhedged-${item.network}-${item.tradeId}`;
    frag.appendChild(createUnhedgedRow(item, ++rowCount, selectedIds.has(uId)));
  }

  if (totalItems > limit) {
    const noticeRow = document.createElement("tr");
    noticeRow.className = "load-more-row select-none";
    const remaining = totalItems - limit;
    const addCount = Math.min(100, remaining);
    noticeRow.innerHTML = `
      <td colspan="13" class="py-3 px-4 text-center bg-terminal-surface/30 border-t border-terminal-borderSubtle">
        <div class="flex flex-col sm:flex-row items-center justify-center gap-2.5 text-xs font-sans">
          <span class="text-terminal-muted text-[11px]">
            Showing <span class="font-mono text-terminal-secondary">${limit}</span> of <span class="font-mono text-terminal-secondary">${totalItems.toLocaleString()}</span> records
          </span>
          <button
            type="button"
            id="btnLoadMoreHedge"
            data-action="load-more"
            class="px-3 py-1 rounded bg-terminal-bg border border-terminal-border hover:border-terminal-muted text-terminal-primary hover:text-white transition cursor-pointer select-none text-xs font-medium inline-flex items-center gap-1.5 shadow-xs hover:bg-terminal-surface active:scale-95"
            title="Load ${addCount} more records"
          >
            <svg class="w-3.5 h-3.5 text-terminal-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Show More (+${addCount})</span>
          </button>
        </div>
      </td>
    `;
    if (onLoadMore) {
      const btn = noticeRow.querySelector<HTMLButtonElement>("#btnLoadMoreHedge");
      if (btn) {
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          onLoadMore();
        });
      }
    }
    frag.appendChild(noticeRow);
  }

  container.appendChild(frag);
}

export interface HedgeMetricElements {
  accountsBadge?: HTMLElement | null;
  pairsCount: HTMLElement | null;
  hedgedVolume: HTMLElement | null;
  netPnl: HTMLElement | null;
  pnlBps?: HTMLElement | null;
  slippage: HTMLElement | null;
  fees: HTMLElement | null;
  funding?: HTMLElement | null;
  withdrawals?: HTMLElement | null;
  unhedgedCount: HTMLElement | null;
  avgOi?: HTMLElement | null;
}

export function updateHedgeExecutiveMetrics(
  metrics: HedgeSummaryMetrics | null,
  elements: HedgeMetricElements,
): void {
  if (!metrics || (metrics.totalPairs === 0 && metrics.totalUnhedgedTrades === 0)) {
    if (elements.accountsBadge) {
      elements.accountsBadge.innerHTML = `<span class="text-terminal-emerald font-bold">RH</span> <span class="text-terminal-muted font-normal">vs</span> <span class="text-terminal-accent font-bold">Core</span>`;
    }
    if (elements.pairsCount) elements.pairsCount.textContent = "0";
    if (elements.hedgedVolume) elements.hedgedVolume.textContent = "$0.00";
    if (elements.netPnl) {
      elements.netPnl.textContent = "$0.00";
      elements.netPnl.className = "font-bold text-terminal-muted tabular-nums";
    }
    if (elements.pnlBps) elements.pnlBps.textContent = "(0.0 bps)";
    if (elements.slippage) elements.slippage.textContent = "$0.00";
    if (elements.fees) {
      elements.fees.textContent = "$0.00";
      elements.fees.className = "font-bold text-terminal-muted tabular-nums";
    }
    if (elements.funding) {
      elements.funding.textContent = "—";
      elements.funding.className = "font-bold text-terminal-muted tabular-nums";
      elements.funding.title = "No funding data";
    }
    if (elements.withdrawals) {
      elements.withdrawals.textContent = "RH: 0 / Core: 0";
      elements.withdrawals.className = "font-bold text-white tabular-nums";
      elements.withdrawals.title = "No withdrawals data";
    }
    if (elements.unhedgedCount) elements.unhedgedCount.textContent = "0";
    if (elements.avgOi) {
      elements.avgOi.textContent = "$0.00";
      elements.avgOi.className = "font-bold text-terminal-muted tabular-nums";
    }
    return;
  }

  const rhAcc =
    metrics.rhAccountIndices && metrics.rhAccountIndices.length > 1
      ? metrics.rhAccountIndices.map((a) => `#${a}`).join(", ")
      : metrics.rhAccountIndex
        ? `#${metrics.rhAccountIndex}`
        : "RH";
  const coreAcc =
    metrics.coreAccountIndices && metrics.coreAccountIndices.length > 1
      ? metrics.coreAccountIndices.map((a) => `#${a}`).join(", ")
      : metrics.coreAccountIndex
        ? `#${metrics.coreAccountIndex}`
        : "CORE";
  if (elements.accountsBadge) {
    elements.accountsBadge.innerHTML = `<span class="text-terminal-emerald font-bold">${rhAcc}</span> <span class="text-terminal-muted font-normal">vs</span> <span class="text-terminal-accent font-bold">${coreAcc}</span>`;
  }

  if (elements.pairsCount) {
    elements.pairsCount.textContent = metrics.totalPairs.toLocaleString();
  }

  if (elements.hedgedVolume) {
    elements.hedgedVolume.textContent = formatMoney(metrics.totalHedgedVolumeUsd);
  }

  if (elements.netPnl) {
    const sign = metrics.totalNetPnlUsd > 0.0001 ? "+" : "";
    elements.netPnl.textContent = `${sign}${formatMoney(metrics.totalNetPnlUsd)}`;
    if (metrics.totalNetPnlUsd > 0.001) {
      elements.netPnl.className = "font-bold text-terminal-emerald tabular-nums";
    } else if (metrics.totalNetPnlUsd < -0.001) {
      elements.netPnl.className = "font-bold text-terminal-coral tabular-nums";
    } else {
      elements.netPnl.className = "font-bold text-terminal-muted tabular-nums";
    }
    const fund = metrics.totalFundingUsd ?? 0;
    const fundSign = fund > 0.0001 ? "+" : "";
    const slipSign = metrics.totalPricePnlUsd > 0.0001 ? "+" : "";
    const wFeeTotal = metrics.totalWithdrawalFeesUsd ?? 0;
    const wStr = wFeeTotal > 0.0001 ? ` - Withdraw Fees: ${formatFee(wFeeTotal)}` : "";
    elements.netPnl.title = `Net PnL: ${sign}${formatMoney(metrics.totalNetPnlUsd)} = Slippage: ${slipSign}${formatMoney(metrics.totalPricePnlUsd)} + Funding: ${fundSign}${formatMoney(fund)} - Fees: ${formatFee(metrics.totalFeesUsd)}${wStr}`;
  }

  if (elements.pnlBps) {
    const sign = metrics.avgPnlBps > 0.001 ? "+" : "";
    elements.pnlBps.textContent = `(${sign}${metrics.avgPnlBps.toFixed(2)} bps)`;
    if (metrics.avgPnlBps > 0.01) {
      elements.pnlBps.className = "text-[10px] text-terminal-emerald tabular-nums ml-1";
    } else if (metrics.avgPnlBps < -0.01) {
      elements.pnlBps.className = "text-[10px] text-terminal-coral tabular-nums ml-1";
    } else {
      elements.pnlBps.className = "text-[10px] text-terminal-muted tabular-nums ml-1";
    }
  }

  if (elements.slippage) {
    const sign = metrics.totalPricePnlUsd > 0.0001 ? "+" : "";
    elements.slippage.textContent = `${sign}${formatMoney(metrics.totalPricePnlUsd)}`;
    elements.slippage.className =
      metrics.totalPricePnlUsd !== 0
        ? "font-bold text-white tabular-nums"
        : "font-bold text-terminal-muted tabular-nums";
  }

  if (elements.fees) {
    elements.fees.textContent = formatFee(metrics.totalFeesUsd);
    elements.fees.className =
      metrics.totalFeesUsd > 0.0001
        ? "font-bold text-white tabular-nums"
        : "font-bold text-terminal-muted tabular-nums";
  }

  if (elements.withdrawals) {
    const rhCount = metrics.rhWithdrawalsCount ?? 0;
    const coreCount = metrics.coreWithdrawalsCount ?? 0;
    elements.withdrawals.textContent = `RH: ${rhCount} / Core: ${coreCount}`;
    elements.withdrawals.className = "font-bold text-white tabular-nums";
    const wFeeTotal = metrics.totalWithdrawalFeesUsd ?? 0;
    const feeStr = wFeeTotal > 0.0001 ? ` · Total Fee: ${formatFee(wFeeTotal)}` : "";
    elements.withdrawals.title = `Withdrawals: RH: ${rhCount}, Core: ${coreCount}${feeStr}`;
  }

  if (elements.funding) {
    if (metrics.totalFundingUsd === null || metrics.totalFundingUsd === undefined) {
      elements.funding.textContent = "—";
      elements.funding.className = "font-bold text-terminal-muted tabular-nums";
      elements.funding.title = "No funding history in uploaded datasets";
    } else {
      const totalFunding = metrics.totalFundingUsd;
      const rhFunding = metrics.rhTotalFundingUsd ?? 0;
      const coreFunding = metrics.coreTotalFundingUsd ?? 0;
      const sign = totalFunding > 0 ? "+" : "";
      elements.funding.textContent = `${sign}${formatMoney(totalFunding)}`;
      elements.funding.className =
        totalFunding !== 0
          ? "font-bold text-white tabular-nums"
          : "font-bold text-terminal-muted tabular-nums";
      elements.funding.title = `Net Funding: ${totalFunding >= 0 ? "+" : ""}${formatMoney(totalFunding)} (RH: ${rhFunding >= 0 ? "+" : ""}${formatMoney(rhFunding)} / Core: ${coreFunding >= 0 ? "+" : ""}${formatMoney(coreFunding)})`;
    }
  }

  if (elements.unhedgedCount) {
    elements.unhedgedCount.textContent = metrics.totalUnhedgedTrades.toLocaleString();
    elements.unhedgedCount.className =
      metrics.totalUnhedgedTrades > 0
        ? "font-bold text-terminal-coral tabular-nums"
        : "font-bold text-terminal-secondary tabular-nums";
  }

  if (elements.avgOi) {
    const avgOi = metrics.rhAvgOiUsd ?? metrics.totalAvgOiUsd ?? 0;
    elements.avgOi.textContent = formatMoney(avgOi);
    elements.avgOi.className =
      avgOi > 0
        ? "font-bold text-white tabular-nums"
        : "font-bold text-terminal-muted tabular-nums";
    if (metrics.rhAvgOiUsd !== undefined) {
      const coreOi = metrics.coreAvgOiUsd ?? 0;
      elements.avgOi.title = `RH Avg OI: ${formatMoney(avgOi)}${coreOi > 0 ? ` (Core: ${formatMoney(coreOi)})` : ""}`;
    }
  }
}

export interface IndividualAccountMetricElements {
  accountBadge: HTMLElement | null;
  tradesCount: HTMLElement | null;
  volume: HTMLElement | null;
  realizedPnl: HTMLElement | null;
  fees: HTMLElement | null;
  funding?: HTMLElement | null;
  withdrawals?: HTMLElement | null;
  unhedgedCount: HTMLElement | null;
  avgOi?: HTMLElement | null;
  dailySummary?: HTMLElement | null;
}

export function formatCompactDuration(ms: number | undefined | null): string {
  if (!ms || isNaN(ms) || ms <= 0) return "—";
  if (ms < 1000) return "<1s";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) {
    return min < 10 && remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) {
    return hr < 10 && remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  }
  return "24h";
}

export function formatCompactUsd(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num) || num <= 0) return "$0";
  const abs = Math.abs(num);
  if (abs >= 1e6) return "$" + (abs / 1e6).toFixed(abs >= 1e8 ? 0 : 1) + "M";
  if (abs >= 1e3) return "$" + (abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1) + "k";
  return "$" + Math.round(abs);
}

export function updateScrollMask(container: HTMLElement | null | undefined): void {
  if (!container || !container.classList) return;
  const scrollLeft = container.scrollLeft ?? 0;
  const scrollWidth = container.scrollWidth ?? 0;
  const clientWidth = container.clientWidth ?? 0;
  const maxScroll = scrollWidth - clientWidth;

  container.classList.remove("scroll-mask-left", "scroll-mask-right", "scroll-mask-both");

  if (maxScroll <= 2) {
    return;
  }

  const hasLeft = scrollLeft > 3;
  const hasRight = scrollLeft < maxScroll - 3;

  if (hasLeft && hasRight) {
    container.classList.add("scroll-mask-both");
  } else if (hasLeft) {
    container.classList.add("scroll-mask-left");
  } else if (hasRight) {
    container.classList.add("scroll-mask-right");
  }
}

export function renderDailySummary(
  container: HTMLElement,
  dailyStats: AccountDailyStat[] | undefined,
): void {
  if (!dailyStats || dailyStats.length === 0) {
    container.innerHTML = "";
    updateScrollMask(container);
    return;
  }

  const html = dailyStats
    .map((day) => {
      const hasActivity = day.tradesCount > 0 || day.avgHoldingDurationMs > 0;
      const compactHold =
        day.avgHoldingDurationMs > 0 ? formatCompactDuration(day.avgHoldingDurationMs) : "—";
      const compactVol = day.totalVolumeUsd > 0 ? formatCompactUsd(day.totalVolumeUsd) : "$0";

      const tooltipLines = [
        `${day.dayOfWeek.toUpperCase()} (${day.shortDate})`,
        day.avgHoldingDurationMs > 0
          ? `Avg Hold: ${formatCompactDuration(day.avgHoldingDurationMs)}`
          : null,
        `Volume: ${formatMoney(day.totalVolumeUsd)}`,
        day.realizedPnlUsd !== 0
          ? `PnL: ${day.realizedPnlUsd > 0 ? "+" : ""}${formatMoney(day.realizedPnlUsd)}`
          : null,
        day.totalFeesUsd > 0 ? `Fees: ${formatFee(day.totalFeesUsd)}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      const colClass = hasActivity
        ? `flex-1 min-w-14 sm:min-w-15.5 py-1 px-1 rounded flex flex-col items-center justify-between text-center bg-terminal-bg/80 border border-terminal-border/80 hover:border-terminal-muted transition-colors cursor-default`
        : `flex-1 min-w-14 sm:min-w-15.5 py-1 px-1 rounded flex flex-col items-center justify-between text-center bg-terminal-bg/20 border border-terminal-borderSubtle/40 opacity-40 cursor-default`;

      return `<div class="${colClass}" title="${tooltipLines}"><div class="flex items-center justify-center gap-0.5 mb-1 leading-none whitespace-nowrap"><span class="text-[10px] font-semibold ${hasActivity ? "text-terminal-secondary" : "text-terminal-muted"} tracking-tight uppercase leading-none font-sans">${day.dayOfWeek.toUpperCase()}</span><span class="text-[8.5px] sm:text-[9px] text-terminal-muted leading-none font-sans">(${day.shortDate})</span></div><div class="flex flex-col items-center gap-0.5 w-full leading-none"><span class="text-[9px] ${day.avgHoldingDurationMs > 0 ? "text-white font-medium" : "text-terminal-muted"} tabular-nums leading-none font-mono">${compactHold}</span><span class="text-[9px] ${day.totalVolumeUsd > 0 ? "text-terminal-secondary" : "text-terminal-muted"} tabular-nums leading-none font-mono">${compactVol}</span></div></div>`;
    })
    .join("");

  container.innerHTML = html;
  updateScrollMask(container);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => updateScrollMask(container));
  }
}

export function updateIndividualAccountMetrics(
  metrics: IndividualAccountMetrics | null,
  elements: IndividualAccountMetricElements,
): void {
  if (!metrics || metrics.tradesCount === 0) {
    if (elements.accountBadge) {
      if (metrics?.accountIndices && metrics.accountIndices.length > 1) {
        elements.accountBadge.textContent = metrics.accountIndices.map((a) => `#${a}`).join(", ");
        elements.accountBadge.className =
          "font-mono font-bold text-sm tracking-tight text-white select-text cursor-text";
      } else if (metrics?.accountIndex) {
        elements.accountBadge.textContent = `#${metrics.accountIndex}`;
        elements.accountBadge.className =
          "font-mono font-bold text-sm tracking-tight text-white select-text cursor-text";
      } else {
        elements.accountBadge.textContent = "--";
        elements.accountBadge.className =
          "font-mono font-bold text-sm tracking-tight text-terminal-muted select-text cursor-text";
      }
    }
    if (elements.tradesCount) elements.tradesCount.textContent = "0";
    if (elements.volume) elements.volume.textContent = "$0.00";
    if (elements.realizedPnl) {
      elements.realizedPnl.textContent = "$0.00";
      elements.realizedPnl.className = "font-bold text-terminal-muted tabular-nums";
    }
    if (elements.fees) {
      elements.fees.textContent = "$0.00";
      elements.fees.className = "font-bold text-terminal-muted tabular-nums";
    }
    if (elements.funding) {
      elements.funding.textContent = "—";
      elements.funding.className = "font-bold text-terminal-muted tabular-nums";
      elements.funding.title = "No funding data";
    }
    if (elements.withdrawals) {
      elements.withdrawals.textContent = "0";
      elements.withdrawals.className = "font-bold text-white tabular-nums";
      elements.withdrawals.title = "No withdrawals data";
    }
    if (elements.unhedgedCount) {
      elements.unhedgedCount.textContent = "0";
      elements.unhedgedCount.className = "font-bold text-terminal-muted tabular-nums";
    }
    if (elements.avgOi) {
      elements.avgOi.textContent = "$0.00";
      elements.avgOi.className = "font-bold text-terminal-muted tabular-nums";
      elements.avgOi.title = "";
    }
    if (elements.dailySummary) {
      if (metrics?.dailyStats && metrics.dailyStats.length > 0) {
        renderDailySummary(elements.dailySummary, metrics.dailyStats);
      } else {
        elements.dailySummary.innerHTML = "";
      }
    }
    return;
  }

  if (elements.accountBadge) {
    if (metrics.accountIndices && metrics.accountIndices.length > 1) {
      elements.accountBadge.textContent = metrics.accountIndices.map((a) => `#${a}`).join(", ");
    } else if (metrics.accountIndex) {
      elements.accountBadge.textContent = `#${metrics.accountIndex}`;
    } else {
      elements.accountBadge.textContent = "--";
    }
    elements.accountBadge.className =
      "font-mono font-bold text-sm tracking-tight text-white select-text cursor-text";
  }

  if (elements.tradesCount) {
    elements.tradesCount.textContent = metrics.tradesCount.toLocaleString();
  }

  if (elements.volume) {
    elements.volume.textContent = formatMoney(metrics.totalVolumeUsd);
  }

  if (elements.realizedPnl) {
    const pnl = metrics.realizedPnlUsd;
    const sign = pnl > 0.0001 ? "+" : "";
    elements.realizedPnl.textContent = `${sign}${formatMoney(pnl)}`;
    if (pnl > 0.001) {
      elements.realizedPnl.className = "font-bold text-terminal-emerald tabular-nums";
    } else if (pnl < -0.001) {
      elements.realizedPnl.className = "font-bold text-terminal-coral tabular-nums";
    } else {
      elements.realizedPnl.className = "font-bold text-terminal-muted tabular-nums";
    }
  }

  if (elements.fees) {
    elements.fees.textContent = formatFee(metrics.totalFeesUsd);
    elements.fees.className =
      metrics.totalFeesUsd > 0.0001
        ? "font-bold text-white tabular-nums"
        : "font-bold text-terminal-muted tabular-nums";
  }

  if (elements.withdrawals) {
    const count = metrics.withdrawalsCount ?? 0;
    elements.withdrawals.textContent = String(count);
    elements.withdrawals.className = "font-bold text-white tabular-nums";
    const wFeeTotal = metrics.totalWithdrawalFeesUsd ?? 0;
    const feeStr = wFeeTotal > 0.0001 ? ` (Fee: ${formatFee(wFeeTotal)})` : "";
    elements.withdrawals.title = `${metrics.network} Withdrawals: ${count}${feeStr}`;
  }

  if (elements.funding) {
    if (metrics.totalFundingUsd === null || metrics.totalFundingUsd === undefined) {
      elements.funding.textContent = "—";
      elements.funding.className = "font-bold text-terminal-muted tabular-nums";
      elements.funding.title = `${metrics.network} No funding history available`;
    } else {
      const funding = metrics.totalFundingUsd;
      const sign = funding > 0 ? "+" : "";
      elements.funding.textContent = `${sign}${formatMoney(funding)}`;
      if (funding > 0.001) {
        elements.funding.className = "font-bold text-white tabular-nums";
        elements.funding.title = `${metrics.network} Net funding received: +${formatMoney(funding)}`;
      } else if (funding < -0.001) {
        elements.funding.className = "font-bold text-white tabular-nums";
        elements.funding.title = `${metrics.network} Net funding paid: ${formatMoney(funding)}`;
      } else {
        elements.funding.className = "font-bold text-terminal-muted tabular-nums";
        elements.funding.title = `${metrics.network} No funding paid/received`;
      }
    }
  }

  if (elements.unhedgedCount) {
    elements.unhedgedCount.textContent = metrics.unhedgedCount.toLocaleString();
    elements.unhedgedCount.className =
      metrics.unhedgedCount > 0
        ? "font-bold text-terminal-coral tabular-nums"
        : "font-bold text-terminal-muted tabular-nums";
  }

  if (elements.avgOi) {
    const avgOi = metrics.avgOiUsd || 0;
    elements.avgOi.textContent = formatMoney(avgOi);
    elements.avgOi.className =
      avgOi > 0
        ? "font-bold text-white tabular-nums"
        : "font-bold text-terminal-muted tabular-nums";

    if (metrics.avgOiDetails && avgOi > 0) {
      const d = metrics.avgOiDetails;
      const hours = (d.periodDurationMs / (1000 * 3600)).toFixed(1);
      const days = (d.periodDurationMs / (1000 * 86400)).toFixed(2);
      let title = `Time-Weighted Average OI: ${formatMoney(avgOi)} (over ${days}d / ${hours}h)`;
      if (d.currentOpenOiUsd > 0) {
        title += `\nCurrently Open Position: ${formatMoney(d.currentOpenOiUsd)}`;
      }
      if (
        d.projectedFullPeriodAvgOiUsd !== undefined &&
        Math.abs(d.projectedFullPeriodAvgOiUsd - avgOi) > 0.01
      ) {
        title += `\nProjected Full-Period Average: ${formatMoney(d.projectedFullPeriodAvgOiUsd)}`;
      }
      elements.avgOi.title = title;
    } else {
      elements.avgOi.title =
        "Time-weighted average open interest (notional position size with leverage)";
    }
  }

  if (elements.dailySummary) {
    if (metrics.dailyStats && metrics.dailyStats.length > 0) {
      renderDailySummary(elements.dailySummary, metrics.dailyStats);
    } else {
      elements.dailySummary.innerHTML = "";
    }
  }
}

export interface HedgeSelectionMetricElements {
  selectionCard: HTMLElement | null;
  countBadge: HTMLElement | null;
  pairsCount?: HTMLElement | null;
  volume: HTMLElement | null;
  netPnl: HTMLElement | null;
  pnlBps: HTMLElement | null;
  weightedDelta: HTMLElement | null;
  weightedDeltaBps: HTMLElement | null;
  slippage: HTMLElement | null;
  fees: HTMLElement | null;
  funding?: HTMLElement | null;
  unhedgedCount?: HTMLElement | null;
}

export function updateHedgeSelectionMetrics(
  metrics: SelectedHedgeMetrics | null,
  elements: HedgeSelectionMetricElements,
): void {
  if (!metrics || metrics.selectedCount === 0) {
    if (elements.selectionCard) {
      elements.selectionCard.classList.add("hidden");
    }
    return;
  }

  if (elements.selectionCard) {
    elements.selectionCard.classList.remove("hidden");
  }

  if (elements.countBadge) {
    elements.countBadge.textContent = String(metrics.selectedCount);
  }

  if (elements.pairsCount) {
    elements.pairsCount.textContent = metrics.pairsCount.toLocaleString();
  }

  if (elements.volume) {
    elements.volume.textContent = formatMoney(metrics.totalVolumeUsd);
  }

  if (elements.weightedDelta) {
    if (metrics.pairsCount === 0) {
      elements.weightedDelta.textContent = "—";
      elements.weightedDelta.className = "font-bold text-terminal-muted tabular-nums";
      elements.weightedDelta.title = "No hedge pairs selected";
    } else {
      const delta = metrics.weightedPriceDelta;
      const sign = delta > 0.0001 ? "+" : "";
      elements.weightedDelta.textContent = `${sign}${formatPrice(delta)}`;
      elements.weightedDelta.className = "font-bold text-white tabular-nums";

      const marketLabel =
        metrics.isSingleMarket && metrics.marketSymbol ? ` (${metrics.marketSymbol})` : "";
      elements.weightedDelta.title = `Weighted Δ Price${marketLabel}: Sell avg ${formatPrice(metrics.weightedSellPrice)} - Buy avg ${formatPrice(metrics.weightedBuyPrice)} (Matched Size: ${metrics.totalMatchedSize.toLocaleString(undefined, { maximumFractionDigits: 4 })})`;
    }
  }

  if (elements.weightedDeltaBps) {
    if (metrics.pairsCount === 0) {
      elements.weightedDeltaBps.textContent = "";
      elements.weightedDeltaBps.className =
        "text-[10px] text-terminal-secondary tabular-nums ml-0.5";
    } else {
      const bps = metrics.weightedPriceDeltaBps;
      const sign = bps > 0.001 ? "+" : "";
      elements.weightedDeltaBps.textContent = `(${sign}${bps.toFixed(2)} bps)`;
      elements.weightedDeltaBps.className =
        "text-[10px] text-terminal-secondary tabular-nums ml-0.5";
    }
  }

  if (elements.netPnl) {
    const sign = metrics.totalNetPnlUsd > 0.0001 ? "+" : "";
    elements.netPnl.textContent = `${sign}${formatMoney(metrics.totalNetPnlUsd)}`;
    if (metrics.totalNetPnlUsd > 0.001) {
      elements.netPnl.className = "font-bold text-terminal-emerald tabular-nums";
    } else if (metrics.totalNetPnlUsd < -0.001) {
      elements.netPnl.className = "font-bold text-terminal-coral tabular-nums";
    } else {
      elements.netPnl.className = "font-bold text-terminal-muted tabular-nums";
    }
    const fund = metrics.totalFundingUsd ?? 0;
    const fundSign = fund > 0.0001 ? "+" : "";
    const slipSign = metrics.totalPricePnlUsd > 0.0001 ? "+" : "";
    elements.netPnl.title = `Net PnL: ${sign}${formatMoney(metrics.totalNetPnlUsd)} = Slippage: ${slipSign}${formatMoney(metrics.totalPricePnlUsd)} + Funding: ${fundSign}${formatMoney(fund)} - Fees: ${formatFee(metrics.totalFeesUsd)}`;
  }

  if (elements.pnlBps) {
    const sign = metrics.avgPnlBps > 0.001 ? "+" : "";
    elements.pnlBps.textContent = `(${sign}${metrics.avgPnlBps.toFixed(2)} bps)`;
    if (metrics.avgPnlBps > 0.01) {
      elements.pnlBps.className = "text-[10px] text-terminal-emerald tabular-nums ml-0.5";
    } else if (metrics.avgPnlBps < -0.01) {
      elements.pnlBps.className = "text-[10px] text-terminal-coral tabular-nums ml-0.5";
    } else {
      elements.pnlBps.className = "text-[10px] text-terminal-muted tabular-nums ml-0.5";
    }
  }

  if (elements.slippage) {
    const sign = metrics.totalPricePnlUsd > 0.0001 ? "+" : "";
    elements.slippage.textContent = `${sign}${formatMoney(metrics.totalPricePnlUsd)}`;
    elements.slippage.className = "font-bold text-white tabular-nums";
  }

  if (elements.fees) {
    elements.fees.textContent = formatFee(metrics.totalFeesUsd);
    elements.fees.className =
      metrics.totalFeesUsd > 0.0001
        ? "font-bold text-white tabular-nums"
        : "font-bold text-terminal-muted tabular-nums";
  }

  if (elements.funding) {
    if (metrics.totalFundingUsd === null || metrics.totalFundingUsd === undefined) {
      elements.funding.textContent = "—";
      elements.funding.className = "font-bold text-terminal-muted tabular-nums";
      elements.funding.title = "Selected items have no funding history";
    } else {
      const funding = metrics.totalFundingUsd;
      const sign = funding > 0 ? "+" : "";
      elements.funding.textContent = `${sign}${formatMoney(funding)}`;
      elements.funding.className =
        funding !== 0
          ? "font-bold text-white tabular-nums"
          : "font-bold text-terminal-muted tabular-nums";
      elements.funding.title = `Selected Net Funding: ${sign}${formatMoney(funding)}`;
    }
  }

  if (elements.unhedgedCount) {
    elements.unhedgedCount.textContent = metrics.unhedgedCount.toLocaleString();
    elements.unhedgedCount.className =
      metrics.unhedgedCount > 0
        ? "font-bold text-terminal-coral tabular-nums"
        : "font-bold text-terminal-secondary tabular-nums";
  }
}

/**
 * Truncates long file names with an ellipsis in the middle, preserving the file extension.
 * E.g. "rh-trades-history-account-31704-2026-10-02T18-29-31.json" -> "rh-trades...9-31.json"
 */
export function formatDisplayFileName(fileName: string, maxLen = 22): string {
  if (!fileName) return "";
  if (fileName.length <= maxLen) return fileName;
  const dotIdx = fileName.lastIndexOf(".");
  const ext = dotIdx > 0 ? fileName.slice(dotIdx) : "";
  const name = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
  const avail = maxLen - ext.length - 3;
  if (avail <= 4) return fileName.slice(0, maxLen - 3) + "...";
  const head = Math.ceil(avail * 0.55);
  const tail = Math.floor(avail * 0.45);
  return `${name.slice(0, head)}...${name.slice(-tail)}${ext}`;
}

/**
 * Renders per-token / per-market summary cards showing:
 * - Ticker (marketSymbol)
 * - Volume (RH) (volumeUsd)
 * - Avg Hold (avgHoldingDurationMs)
 * - Slippage PnL (slippagePnlUsd)
 * - Funding PnL (fundingPnlUsd)
 * - Fees (feeUsd)
 * - Net PnL (netPnlUsd)
 * Grouped by token / market for the selected date filter period.
 */
export function renderMarketSummaryCards(
  container: HTMLElement,
  stats: MarketSummaryStat[],
  activeMarketFilter?: string | null,
  onMarketClick?: (marketSymbol: string) => void,
  sortColumn: MarketSummarySortColumn = "volumeUsd",
  sortDirection: "asc" | "desc" = "desc",
  onSortClick?: (column: MarketSummarySortColumn) => void,
): void {
  if (!stats || stats.length === 0) {
    container.innerHTML = `
      <div class="py-6 text-center text-terminal-muted text-xs w-full flex-1 flex items-center justify-center gap-1.5 my-auto">
        <span class="text-terminal-secondary font-medium">No token activity for selected period</span>
        <span class="text-[11px] text-terminal-muted">— Select a different date preset or import trade history to view market metrics.</span>
      </div>
    `;
    return;
  }

  const renderSortIndicator = (col: MarketSummarySortColumn) => {
    if (sortColumn !== col)
      return `<span class="sort-indicator text-terminal-accent ml-0.5"></span>`;
    return `<span class="sort-indicator text-terminal-accent ml-0.5">${sortDirection === "asc" ? "▲" : "▼"}</span>`;
  };

  const rowsHtml = stats
    .map((stat, idx) => {
      const isActive =
        Boolean(activeMarketFilter) &&
        activeMarketFilter!.toUpperCase() === stat.marketSymbol.toUpperCase();

      const rowClass = isActive
        ? "bg-white/10 hover:bg-white/[0.13]"
        : "hover:bg-terminal-surfaceHover/80";

      const holdDurationFormatted =
        (stat.avgHoldingDurationMs ?? 0) > 0
          ? formatCompactDuration(stat.avgHoldingDurationMs)
          : "—";

      const slip = stat.slippagePnlUsd ?? 0;
      const slipClass =
        slip > 0.001
          ? "text-terminal-emerald font-semibold"
          : slip < -0.001
            ? "text-terminal-coral font-semibold"
            : "text-terminal-muted";
      const slipSign = slip > 0.0001 ? "+" : "";
      const slipFormatted = `${slipSign}${formatMoney(slip)}`;

      const fund = stat.fundingPnlUsd ?? 0;
      const fundClass =
        fund > 0.001
          ? "text-terminal-emerald font-semibold"
          : fund < -0.001
            ? "text-terminal-coral font-semibold"
            : "text-terminal-muted";
      const fundSign = fund > 0.0001 ? "+" : "";
      const fundFormatted = `${fundSign}${formatMoney(fund)}`;

      const fee = stat.feeUsd ?? 0;
      const feeFormatted = formatFee(fee);
      const feeClass = fee > 0.0001 ? "text-white" : "text-terminal-muted";

      const net = stat.netPnlUsd ?? stat.realizedPnlUsd ?? 0;
      const netClass =
        net > 0.001
          ? "text-terminal-emerald font-semibold"
          : net < -0.001
            ? "text-terminal-coral font-semibold"
            : "text-terminal-muted";
      const netSign = net > 0.0001 ? "+" : "";
      const netFormatted = `${netSign}${formatMoney(net)}`;

      const tooltipLines = [
        `Ticker: ${stat.marketSymbol}`,
        `Volume (RH): ${formatMoney(stat.volumeUsd)}`,
        stat.avgHoldingDurationMs
          ? `Avg Hold: ${formatCompactDuration(stat.avgHoldingDurationMs)}`
          : null,
        `Slippage: ${slipFormatted}`,
        `Funding: ${fundFormatted}`,
        `Fees: ${feeFormatted}`,
        `Net PnL: ${netFormatted}`,
        "Click to select trades and view summary for this market",
      ]
        .filter(Boolean)
        .join("\n");

      return `
        <tr
          class="h-8 border-b border-terminal-borderSubtle/60 transition-colors cursor-pointer select-none text-xs font-mono group ${rowClass}"
          title="${tooltipLines}"
          data-market="${stat.marketSymbol}"
        >
          <td class="h-8 py-0 px-2 sm:px-3 text-center text-terminal-muted tabular-nums text-[11px] w-8">
            ${idx + 1}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 whitespace-nowrap">
            <span class="font-bold text-white transition-colors">
              ${stat.marketSymbol}
            </span>
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right font-bold text-white tabular-nums whitespace-nowrap">
            ${formatMoney(stat.volumeUsd)}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right tabular-nums whitespace-nowrap ${(stat.avgHoldingDurationMs ?? 0) > 0 ? "text-terminal-secondary" : "text-terminal-muted"}" title="Avg Hold: ${formatCompactDuration(stat.avgHoldingDurationMs)}">
            ${holdDurationFormatted}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right tabular-nums whitespace-nowrap ${slipClass}">
            ${slipFormatted}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right tabular-nums whitespace-nowrap ${fundClass}">
            ${fundFormatted}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right tabular-nums whitespace-nowrap ${feeClass}">
            ${feeFormatted}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right tabular-nums whitespace-nowrap ${netClass}">
            ${netFormatted}
          </td>
        </tr>
      `;
    })
    .join("");

  const totalVolumeUsd = stats.reduce((acc, s) => acc + (s.volumeUsd || 0), 0);
  const totalTransactions = stats.reduce((acc, s) => acc + (s.transactionsCount || 0), 0);
  const totalHoldingWeight = stats.reduce(
    (acc, s) =>
      acc +
      (s.avgHoldingDurationMs || 0) * (s.transactionsCount || (s.avgHoldingDurationMs ? 1 : 0)),
    0,
  );
  const totalHoldingCount =
    totalTransactions > 0
      ? totalTransactions
      : stats.reduce((acc, s) => acc + (s.avgHoldingDurationMs ? 1 : 0), 0);
  const overallAvgHoldingMs = totalHoldingCount > 0 ? totalHoldingWeight / totalHoldingCount : 0;

  const totalSlippageUsd = stats.reduce((acc, s) => acc + (s.slippagePnlUsd || 0), 0);
  const totalFundingUsd = stats.reduce((acc, s) => acc + (s.fundingPnlUsd || 0), 0);
  const totalFeeUsd = stats.reduce((acc, s) => acc + (s.feeUsd || 0), 0);
  const totalNetPnlUsd = stats.reduce((acc, s) => acc + (s.netPnlUsd ?? s.realizedPnlUsd ?? 0), 0);

  const totalSlipClass =
    totalSlippageUsd > 0.001
      ? "text-terminal-emerald font-semibold"
      : totalSlippageUsd < -0.001
        ? "text-terminal-coral font-semibold"
        : "text-terminal-muted";
  const totalSlipSign = totalSlippageUsd > 0.0001 ? "+" : "";
  const totalSlipFormatted = `${totalSlipSign}${formatMoney(totalSlippageUsd)}`;

  const totalFundClass =
    totalFundingUsd > 0.001
      ? "text-terminal-emerald font-semibold"
      : totalFundingUsd < -0.001
        ? "text-terminal-coral font-semibold"
        : "text-terminal-muted";
  const totalFundSign = totalFundingUsd > 0.0001 ? "+" : "";
  const totalFundFormatted = `${totalFundSign}${formatMoney(totalFundingUsd)}`;

  const totalFeeFormatted = formatFee(totalFeeUsd);
  const totalFeeClass = totalFeeUsd > 0.0001 ? "text-white" : "text-terminal-muted";

  const totalNetClass =
    totalNetPnlUsd > 0.001
      ? "text-terminal-emerald font-semibold"
      : totalNetPnlUsd < -0.001
        ? "text-terminal-coral font-semibold"
        : "text-terminal-muted";
  const totalNetSign = totalNetPnlUsd > 0.0001 ? "+" : "";
  const totalNetFormatted = `${totalNetSign}${formatMoney(totalNetPnlUsd)}`;

  const isTotalActive = !activeMarketFilter;
  const totalRowClass = isTotalActive
    ? "bg-white/[0.08] hover:bg-white/[0.12]"
    : "hover:bg-terminal-surfaceHover/80";

  const totalTooltipLines = [
    `Total: ${stats.length} markets`,
    `Volume (RH): ${formatMoney(totalVolumeUsd)}`,
    overallAvgHoldingMs > 0 ? `Avg Hold: ${formatCompactDuration(overallAvgHoldingMs)}` : null,
    `Slippage: ${totalSlipFormatted}`,
    `Funding: ${totalFundFormatted}`,
    `Fees: ${totalFeeFormatted}`,
    `Net PnL: ${totalNetFormatted}`,
    "Click to view all markets",
  ]
    .filter(Boolean)
    .join("\n");

  container.innerHTML = `
    <table class="w-full h-full border-collapse text-left text-xs font-mono">
      <thead>
        <tr class="h-8 border-b border-terminal-border bg-terminal-surface/95 text-terminal-muted text-[11px] select-none sticky top-0 z-10 backdrop-blur-xs font-sans">
          <th class="h-8 py-0 px-2 sm:px-3 font-semibold w-8 text-center">#</th>
          <th class="h-8 py-0 px-2 sm:px-3 font-semibold cursor-pointer hover:text-white whitespace-nowrap" data-sort="marketSymbol">
            Ticker ${renderSortIndicator("marketSymbol")}
          </th>
          <th class="h-8 py-0 px-2 sm:px-3 font-semibold text-right cursor-pointer hover:text-white whitespace-nowrap" data-sort="volumeUsd" title="Robinhood (RH) volume over selected period">
            Volume (RH) ${renderSortIndicator("volumeUsd")}
          </th>
          <th class="h-8 py-0 px-2 sm:px-3 font-semibold text-right cursor-pointer hover:text-white whitespace-nowrap" data-sort="avgHoldingDurationMs" title="Average position holding duration (FIFO)">
            Avg Hold ${renderSortIndicator("avgHoldingDurationMs")}
          </th>
          <th class="h-8 py-0 px-2 sm:px-3 font-semibold text-right cursor-pointer hover:text-white whitespace-nowrap" data-sort="slippagePnlUsd" title="Gross slippage PnL">
            Slippage ${renderSortIndicator("slippagePnlUsd")}
          </th>
          <th class="h-8 py-0 px-2 sm:px-3 font-semibold text-right cursor-pointer hover:text-white whitespace-nowrap" data-sort="fundingPnlUsd" title="Net funding paid or received (RH + Core)">
            Funding ${renderSortIndicator("fundingPnlUsd")}
          </th>
          <th class="h-8 py-0 px-2 sm:px-3 font-semibold text-right cursor-pointer hover:text-white whitespace-nowrap" data-sort="feeUsd" title="Trading fees (RH + Core)">
            Fees ${renderSortIndicator("feeUsd")}
          </th>
          <th class="h-8 py-0 px-2 sm:px-3 font-semibold text-right cursor-pointer hover:text-white whitespace-nowrap" data-sort="netPnlUsd" title="Net PnL = Slippage + Funding - Fees">
            Net PnL ${renderSortIndicator("netPnlUsd")}
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-terminal-borderSubtle/60">
        ${rowsHtml}
        <tr class="h-full border-0 pointer-events-none spacer-row">
          <td colspan="8" class="p-0 border-0 bg-transparent"></td>
        </tr>
      </tbody>
      <tfoot class="border-t border-terminal-border bg-terminal-surface font-semibold select-none sticky bottom-0 z-10">
        <tr
          class="h-8 transition-colors cursor-pointer text-xs font-mono group ${totalRowClass}"
          data-market-total="true"
          title="${totalTooltipLines}"
        >
          <td class="h-8 py-0 px-2 sm:px-3 text-center text-terminal-accent font-bold tabular-nums text-xs w-8">
            Σ
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 whitespace-nowrap">
            <span class="font-bold text-white transition-colors">
              Total (${stats.length})
            </span>
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right font-bold text-white tabular-nums whitespace-nowrap">
            ${formatMoney(totalVolumeUsd)}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right tabular-nums whitespace-nowrap ${overallAvgHoldingMs > 0 ? "text-terminal-secondary" : "text-terminal-muted"}" title="Avg Hold: ${formatCompactDuration(overallAvgHoldingMs)}">
            ${overallAvgHoldingMs > 0 ? formatCompactDuration(overallAvgHoldingMs) : "—"}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right tabular-nums whitespace-nowrap ${totalSlipClass}">
            ${totalSlipFormatted}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right tabular-nums whitespace-nowrap ${totalFundClass}">
            ${totalFundFormatted}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right tabular-nums whitespace-nowrap ${totalFeeClass}">
            ${totalFeeFormatted}
          </td>
          <td class="h-8 py-0 px-2 sm:px-3 text-right tabular-nums whitespace-nowrap ${totalNetClass}">
            ${totalNetFormatted}
          </td>
        </tr>
      </tfoot>
    </table>
  `;

  if (onSortClick) {
    const headers = container.querySelectorAll<HTMLElement>("th[data-sort]");
    headers.forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.getAttribute("data-sort") as MarketSummarySortColumn;
        if (col) {
          onSortClick(col);
        }
      });
    });
  }

  if (onMarketClick) {
    const rows = container.querySelectorAll<HTMLElement>("tbody tr[data-market]");
    rows.forEach((row) => {
      row.addEventListener("click", () => {
        const sym = row.getAttribute("data-market");
        if (sym) {
          onMarketClick(sym);
        }
      });
    });

    const totalRowEl =
      typeof container.querySelector === "function"
        ? container.querySelector<HTMLElement>("tr[data-market-total]")
        : null;
    if (totalRowEl) {
      totalRowEl.addEventListener("click", () => {
        onMarketClick("");
      });
    }
  }
}

function formatUnitPointPrice(p: number | undefined | null): string {
  if (p === undefined || p === null || isNaN(p) || p <= 0) return "$0.00";
  if (p < 0.0001) return "$" + p.toFixed(6);
  return formatPrice(p);
}

export interface WeeklyPointsElements {
  container: HTMLElement | null;
  title: HTMLElement | null;
  inputPoints: HTMLInputElement | null;
  volPerPoint: HTMLElement | null;
  oiPerPoint: HTMLElement | null;
  costPerPoint: HTMLElement | null;
  feesPerPoint: HTMLElement | null;
  ratePer1k: HTMLElement | null;
}

export function updateWeeklyPointsCard(
  weekNumber: number | null | undefined,
  metrics: {
    rhVolumeUsd: number;
    rhAvgOiUsd: number;
    totalNetPnlUsd: number;
    totalFeesUsd: number;
  } | null,
  points: number | null | undefined,
  elements: WeeklyPointsElements,
): void {
  if (!weekNumber || weekNumber <= 0 || !metrics) {
    elements.container?.classList.add("hidden");
    return;
  }

  elements.container?.classList.remove("hidden");
  if (elements.title) {
    elements.title.textContent = `Week ${weekNumber}:`;
  }

  const analysis = calculateWeeklyPointsAnalysis(metrics, points);

  if (analysis.volPerPoint === null) {
    if (elements.volPerPoint) elements.volPerPoint.textContent = "--";
    if (elements.oiPerPoint) elements.oiPerPoint.textContent = "--";
    if (elements.costPerPoint) {
      elements.costPerPoint.textContent = "--";
      elements.costPerPoint.className = "font-bold text-terminal-muted tabular-nums";
      elements.costPerPoint.title = "Point price based on net PnL (-Net PnL / Points)";
    }
    if (elements.feesPerPoint) elements.feesPerPoint.textContent = "--";
    if (elements.ratePer1k) elements.ratePer1k.textContent = "--";
    return;
  }

  // Volume per point
  if (elements.volPerPoint) {
    elements.volPerPoint.textContent =
      analysis.volPerPoint !== null && analysis.volPerPoint > 0
        ? formatMoney(analysis.volPerPoint)
        : "$0.00";
    elements.volPerPoint.title = `Robinhood volume per point: ${formatMoney(metrics.rhVolumeUsd)} / ${points?.toLocaleString()} pts`;
  }

  // Average OI per point
  if (elements.oiPerPoint) {
    elements.oiPerPoint.textContent =
      analysis.oiPerPoint !== null && analysis.oiPerPoint > 0
        ? analysis.oiPerPoint >= 1
          ? formatMoney(analysis.oiPerPoint)
          : formatUnitPointPrice(analysis.oiPerPoint)
        : "$0.00";
    elements.oiPerPoint.title = `Average open interest per point: ${formatMoney(metrics.rhAvgOiUsd)} / ${points?.toLocaleString()} pts`;
  }

  // Cost per point (Price)
  if (elements.costPerPoint) {
    if (Math.abs(metrics.totalNetPnlUsd) <= 0.0001 || analysis.costPerPoint === null) {
      elements.costPerPoint.textContent = "$0.0000";
      elements.costPerPoint.className = "font-bold text-terminal-muted tabular-nums";
      elements.costPerPoint.title = "Net hedge PnL was $0.00";
    } else if (analysis.isProfitable) {
      elements.costPerPoint.textContent = `+${formatUnitPointPrice(analysis.costPerPoint)}`;
      elements.costPerPoint.className = "font-bold text-terminal-emerald tabular-nums";
      elements.costPerPoint.title = `Net profit per point: +${formatMoney(metrics.totalNetPnlUsd)} / ${points?.toLocaleString()} pts`;
    } else {
      elements.costPerPoint.textContent = formatUnitPointPrice(analysis.costPerPoint);
      elements.costPerPoint.className = "font-bold text-white tabular-nums";
      elements.costPerPoint.title = `Net cost per point: ${formatMoney(metrics.totalNetPnlUsd)} / ${points?.toLocaleString()} pts`;
    }
  }

  // Fees per point
  if (elements.feesPerPoint) {
    elements.feesPerPoint.textContent =
      analysis.feesPerPoint !== null && analysis.feesPerPoint > 0
        ? formatUnitPointPrice(analysis.feesPerPoint)
        : "$0.00";
    elements.feesPerPoint.title = `Total fees per point: ${formatFee(metrics.totalFeesUsd)} / ${points?.toLocaleString()} pts`;
  }

  // Rate (pts / $1k RH volume)
  if (elements.ratePer1k) {
    if (analysis.ratePer1kVol !== null) {
      const r = analysis.ratePer1kVol;
      const formatted = r >= 10 ? r.toFixed(1) : r >= 1 ? r.toFixed(2) : r.toFixed(3);
      elements.ratePer1k.textContent = formatted;
      elements.ratePer1k.title = `Points per $1,000 RH volume: (${points?.toLocaleString()} / ${formatMoney(metrics.rhVolumeUsd)}) * 1,000`;
    } else {
      elements.ratePer1k.textContent = "--";
      elements.ratePer1k.title = "No RH volume recorded for this week";
    }
  }
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return m;
    }
  });
}

export interface WeeklyPointsMultiElements {
  container: HTMLElement | null;
  count: HTMLElement | null;
  grid: HTMLElement | null;
}

function getWeekMetricStrings(
  stats: WeekActivityStats | WeeklyPointsTotalStats,
  isTotal = false,
): {
  volStr: string;
  volTitle: string;
  oiStr: string;
  oiTitle: string;
  netPnlStr: string;
  netPnlCls: string;
  netPnlTitle: string;
  priceStr: string;
  priceCls: string;
  priceTitle: string;
} {
  const analysis = stats.analysis;
  const pts = stats.points;

  const volStr = stats.rhVolumeUsd > 0 ? formatMoney(stats.rhVolumeUsd) : "$0.00";
  const volTitle = isTotal
    ? `Total Robinhood volume: ${formatMoney(stats.rhVolumeUsd)}`
    : `Robinhood volume for Week: ${formatMoney(stats.rhVolumeUsd)}`;

  const oiVal =
    isTotal && "avgWeeklyOiUsd" in stats && typeof stats.avgWeeklyOiUsd === "number"
      ? stats.avgWeeklyOiUsd
      : stats.rhAvgOiUsd;
  const oiStr = oiVal > 0 ? formatMoney(oiVal) : "$0.00";
  const oiTitle = isTotal
    ? `Average weekly open interest: ${formatMoney(oiVal)}${"weeksCount" in stats && stats.weeksCount ? ` (across ${stats.weeksCount} weeks)` : ""} | Cumulative: ${formatMoney(stats.rhAvgOiUsd)}`
    : `Time-weighted average open interest: ${formatMoney(stats.rhAvgOiUsd)}`;

  const pnl = stats.totalNetPnlUsd;
  let netPnlStr = "$0.00";
  let netPnlCls = "font-bold text-terminal-muted tabular-nums";
  let netPnlTitle = isTotal ? "Total net hedge PnL was $0.00" : "Net hedge PnL was $0.00";

  if (Math.abs(pnl) > 0.0001) {
    if (pnl < -0.0001) {
      netPnlStr = formatMoney(pnl);
      netPnlCls = "font-bold text-terminal-coral tabular-nums";
      netPnlTitle = isTotal
        ? `Total net PnL: ${formatMoney(pnl)}`
        : `Weekly net PnL: ${formatMoney(pnl)}`;
    } else {
      netPnlStr = `+${formatMoney(pnl)}`;
      netPnlCls = "font-bold text-terminal-emerald tabular-nums";
      netPnlTitle = isTotal
        ? `Total net PnL: +${formatMoney(pnl)}`
        : `Weekly net PnL: +${formatMoney(pnl)}`;
    }
  }

  let priceStr = "--";
  let priceCls = "font-bold text-terminal-muted tabular-nums";
  let priceTitle = isTotal
    ? "Enter points in any week above to calculate total point price"
    : "Enter points to calculate point price";

  if (analysis.costPerPoint !== null) {
    if (Math.abs(stats.totalNetPnlUsd) > 0.0001) {
      if (analysis.isProfitable) {
        priceStr = `+${formatUnitPointPrice(analysis.costPerPoint)}`;
        priceCls = "font-bold text-terminal-emerald tabular-nums";
        priceTitle = isTotal
          ? `Total net profit per point: +${formatMoney(stats.totalNetPnlUsd)} / ${pts?.toLocaleString()} pts`
          : `Net profit per point: +${formatMoney(stats.totalNetPnlUsd)} / ${pts?.toLocaleString()} pts`;
      } else {
        priceStr = formatUnitPointPrice(analysis.costPerPoint);
        priceCls = "font-bold text-white tabular-nums";
        priceTitle = isTotal
          ? `Total net cost per point: ${formatMoney(stats.totalNetPnlUsd)} / ${pts?.toLocaleString()} pts`
          : `Net cost per point: ${formatMoney(stats.totalNetPnlUsd)} / ${pts?.toLocaleString()} pts`;
      }
    } else {
      priceStr = "$0.0000";
      priceCls = "font-bold text-terminal-muted tabular-nums";
      priceTitle = isTotal ? "Total net hedge PnL was $0.00" : "Net hedge PnL was $0.00";
    }
  }

  return {
    volStr,
    volTitle,
    oiStr,
    oiTitle,
    netPnlStr,
    netPnlCls,
    netPnlTitle,
    priceStr,
    priceCls,
    priceTitle,
  };
}

function updateWeeklyPointsTotalRow(
  totalRowEl: HTMLElement,
  totalStats: WeeklyPointsTotalStats,
  activeWeekNumber: number | null,
): void {
  const isTotalActive = activeWeekNumber === null;
  if (isTotalActive) {
    totalRowEl.classList.remove("hover:bg-terminal-surfaceHover/80");
    totalRowEl.classList.add("bg-white/[0.08]", "hover:bg-white/[0.12]");
  } else {
    totalRowEl.classList.remove("bg-white/[0.08]", "hover:bg-white/[0.12]");
    totalRowEl.classList.add("hover:bg-terminal-surfaceHover/80");
  }

  const elPoints = totalRowEl.querySelector<HTMLElement>(".val-total-points");
  if (elPoints) {
    elPoints.textContent = totalStats.points ? totalStats.points.toLocaleString() : "--";
    elPoints.title = totalStats.points
      ? `Total points: ${totalStats.points.toLocaleString()} pts across all weeks`
      : "No points entered for any week";
  }

  const values = getWeekMetricStrings(totalStats, true);

  const elVol = totalRowEl.querySelector<HTMLElement>(".val-vol");
  if (elVol) {
    elVol.textContent = values.volStr;
    if (elVol.parentElement) elVol.parentElement.title = values.volTitle;
  }
  const elOi = totalRowEl.querySelector<HTMLElement>(".val-oi");
  if (elOi) {
    elOi.textContent = values.oiStr;
    if (elOi.parentElement) elOi.parentElement.title = values.oiTitle;
  }
  const elNetPnl = totalRowEl.querySelector<HTMLElement>(".val-net-pnl");
  if (elNetPnl) {
    elNetPnl.textContent = values.netPnlStr;
    elNetPnl.className = `val-net-pnl ${values.netPnlCls}`;
    if (elNetPnl.parentElement) elNetPnl.parentElement.title = values.netPnlTitle;
  }
  const elPrice = totalRowEl.querySelector<HTMLElement>(".val-price");
  if (elPrice) {
    elPrice.textContent = values.priceStr;
    elPrice.className = `val-price ${values.priceCls}`;
    if (elPrice.parentElement) elPrice.parentElement.title = values.priceTitle;
  }
}

function updateWeeklyPointsTableRow(
  rowEl: HTMLElement,
  stats: WeekActivityStats,
  activeWeekNumber: number | null,
): void {
  const isActive = activeWeekNumber === stats.weekNumber;
  if (isActive) {
    rowEl.classList.remove("hover:bg-terminal-surfaceHover/80");
    rowEl.classList.add("bg-white/10", "hover:bg-white/[0.13]");
  } else {
    rowEl.classList.remove("bg-white/10", "hover:bg-white/[0.13]");
    rowEl.classList.add("hover:bg-terminal-surfaceHover/80");
  }

  const input = rowEl.querySelector<HTMLInputElement>("input");
  const isInputActive = typeof document !== "undefined" && document.activeElement === input;
  if (input && !isInputActive) {
    input.value = stats.points ? String(stats.points) : "";
  }

  const values = getWeekMetricStrings(stats);
  const elVol = rowEl.querySelector<HTMLElement>(".val-vol");
  if (elVol) {
    elVol.textContent = values.volStr;
    if (elVol.parentElement) elVol.parentElement.title = values.volTitle;
  }
  const elOi = rowEl.querySelector<HTMLElement>(".val-oi");
  if (elOi) {
    elOi.textContent = values.oiStr;
    if (elOi.parentElement) elOi.parentElement.title = values.oiTitle;
  }
  const elNetPnl = rowEl.querySelector<HTMLElement>(".val-net-pnl");
  if (elNetPnl) {
    elNetPnl.textContent = values.netPnlStr;
    elNetPnl.className = `val-net-pnl ${values.netPnlCls}`;
    if (elNetPnl.parentElement) elNetPnl.parentElement.title = values.netPnlTitle;
  }
  const elPrice = rowEl.querySelector<HTMLElement>(".val-price");
  if (elPrice) {
    elPrice.textContent = values.priceStr;
    elPrice.className = `val-price ${values.priceCls}`;
    if (elPrice.parentElement) elPrice.parentElement.title = values.priceTitle;
  }
}

export function renderWeeklyPointsTable(
  container: HTMLElement,
  statsList: WeekActivityStats[],
  activeWeekNumber: number | null,
  onPointsChange: (weekNum: number, value: string) => void,
  onSelectWeek: (weekNum: number) => void,
  sortColumn: WeeklyPointsSortColumn = "weekNumber",
  sortDirection: "asc" | "desc" = "asc",
  onSortClick?: (column: WeeklyPointsSortColumn) => void,
): void {
  if (!statsList || statsList.length === 0) {
    container.innerHTML = `
      <div class="py-6 text-center text-terminal-muted text-xs w-full flex-1 flex items-center justify-center gap-1.5 my-auto">
        <span class="text-terminal-secondary font-medium">No weekly points data loaded</span>
        <span class="text-[11px] text-terminal-muted">— Upload RH and Core files to view weekly point metrics.</span>
      </div>
    `;
    return;
  }

  const totalStats = calculateWeeklyPointsTotalStats(statsList);

  const currentSortCol = container.getAttribute?.("data-sort-col");
  const currentSortDir = container.getAttribute?.("data-sort-dir");
  const isSortMatch = currentSortCol === sortColumn && currentSortDir === sortDirection;

  const existingRows = container.querySelectorAll<HTMLElement>("tr[data-week]");
  const existingWeeks = Array.from(existingRows).map((r) => Number(r.dataset.week));
  const targetWeeks = statsList.map((s) => s.weekNumber);
  const canReuseDom =
    isSortMatch &&
    existingRows.length === targetWeeks.length &&
    existingWeeks.every((w, i) => w === targetWeeks[i]);

  if (canReuseDom) {
    existingRows.forEach((rowEl, idx) => {
      const stats = statsList[idx];
      updateWeeklyPointsTableRow(rowEl, stats, activeWeekNumber);
    });

    if (totalStats) {
      const totalRowEl =
        typeof container.querySelector === "function"
          ? container.querySelector<HTMLElement>("tr[data-total-row]")
          : null;
      if (totalRowEl) {
        updateWeeklyPointsTotalRow(totalRowEl, totalStats, activeWeekNumber);
      }
    }
    return;
  }

  container.setAttribute?.("data-sort-col", sortColumn);
  container.setAttribute?.("data-sort-dir", sortDirection);

  const renderSortIndicator = (col: WeeklyPointsSortColumn) => {
    if (sortColumn !== col)
      return `<span class="sort-indicator text-terminal-accent ml-0.5"></span>`;
    return `<span class="sort-indicator text-terminal-accent ml-0.5">${sortDirection === "asc" ? "▲" : "▼"}</span>`;
  };

  const rowsHtml = statsList
    .map((stats, idx) => {
      const isActive = activeWeekNumber === stats.weekNumber;
      const values = getWeekMetricStrings(stats);
      const rowClass = isActive
        ? "bg-white/10 hover:bg-white/[0.13]"
        : "hover:bg-terminal-surfaceHover/80";

      return `
        <tr
          class="h-8 border-b border-terminal-borderSubtle/60 transition-colors cursor-pointer select-none text-xs font-mono group ${rowClass}"
          data-week="${stats.weekNumber}"
          title="Click to filter trades by Week ${stats.weekNumber}"
        >
          <td class="h-8 py-0 px-2 text-center text-terminal-muted tabular-nums text-[11px] w-7">
            ${idx + 1}
          </td>
          <td class="h-8 py-0 px-2 whitespace-nowrap">
            <span class="font-bold text-white transition-colors">
              Week ${stats.weekNumber}
            </span>
          </td>
          <td class="h-8 py-0 px-2 text-terminal-muted tabular-nums whitespace-nowrap text-[11px]" title="${formatShortMonthDay(new Date(stats.startTimestampMs))} – ${formatShortMonthDay(new Date(stats.endTimestampMs))}">
            ${escapeHtml(stats.dateRangeFormatted)}
          </td>
          <td class="h-8 py-0 px-2 text-center whitespace-nowrap">
            <div class="relative inline-flex items-center group/pts justify-center">
              <input
                type="text"
                inputmode="decimal"
                data-week="${stats.weekNumber}"
                value="${stats.points ? String(stats.points) : ""}"
                placeholder="—"
                class="hedge-points-table-input h-6 w-20 px-1 py-0 bg-transparent hover:bg-terminal-bg/60 border border-transparent hover:border-terminal-border focus:border-terminal-accent focus:bg-terminal-bg rounded text-white font-mono text-xs focus:outline-none transition tabular-nums text-right select-text cursor-text leading-none font-bold"
                title="Click to edit points received for Week ${stats.weekNumber}"
              />
              <svg class="w-2.5 h-2.5 text-terminal-muted opacity-0 group-hover/pts:opacity-60 pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 transition" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
              </svg>
            </div>
          </td>
          <td class="h-8 py-0 px-2 text-right font-bold text-white tabular-nums whitespace-nowrap" title="${values.volTitle}">
            <span class="val-vol">${values.volStr}</span>
          </td>
          <td class="h-8 py-0 px-2 text-right font-bold text-white tabular-nums whitespace-nowrap" title="${values.oiTitle}">
            <span class="val-oi">${values.oiStr}</span>
          </td>
          <td class="h-8 py-0 px-2 text-right font-bold tabular-nums whitespace-nowrap" title="${values.netPnlTitle}">
            <span class="val-net-pnl ${values.netPnlCls}">${values.netPnlStr}</span>
          </td>
          <td class="h-8 py-0 px-2 text-right font-bold tabular-nums whitespace-nowrap" title="${values.priceTitle}">
            <span class="val-price ${values.priceCls}">${values.priceStr}</span>
          </td>
        </tr>
      `;
    })
    .join("");

  let tfootHtml = "";
  if (totalStats) {
    const isTotalActive = activeWeekNumber === null;
    const totalRowClass = isTotalActive
      ? "bg-white/[0.08] hover:bg-white/[0.12]"
      : "hover:bg-terminal-surfaceHover/80";

    const totalValues = getWeekMetricStrings(totalStats, true);
    const totalPointsStr = totalStats.points ? totalStats.points.toLocaleString() : "--";
    const totalPointsTitle = totalStats.points
      ? `Total points: ${totalStats.points.toLocaleString()} pts across all weeks`
      : "No points entered for any week";

    tfootHtml = `
      <tfoot class="border-t border-terminal-border bg-terminal-surface font-semibold select-none sticky bottom-0 z-10">
        <tr
          class="h-8 transition-colors cursor-pointer text-xs font-mono group ${totalRowClass}"
          data-total-row="true"
          title="Click to view trades across all weeks"
        >
          <td class="h-8 py-0 px-2 text-center text-terminal-accent font-bold tabular-nums text-xs w-7">
            Σ
          </td>
          <td class="h-8 py-0 px-2 whitespace-nowrap">
            <span class="font-bold text-white transition-colors">
              Total
            </span>
          </td>
          <td class="h-8 py-0 px-2 text-terminal-muted tabular-nums whitespace-nowrap text-[11px]" title="${formatShortMonthDay(new Date(totalStats.minStartTimestampMs))} – ${formatShortMonthDay(new Date(totalStats.maxEndTimestampMs))} (${statsList.length} weeks)">
            ${escapeHtml(totalStats.dateRangeFormatted)}
          </td>
          <td class="h-8 py-0 px-2 text-center whitespace-nowrap">
            <div class="flex items-center justify-center">
              <span
                class="val-total-points inline-flex items-center justify-end h-6 w-20 px-1.5 py-0 text-white font-mono text-xs tabular-nums text-right font-bold leading-none"
                title="${totalPointsTitle}"
              >
                ${totalPointsStr}
              </span>
            </div>
          </td>
          <td class="h-8 py-0 px-2 text-right font-bold text-white tabular-nums whitespace-nowrap" title="${totalValues.volTitle}">
            <span class="val-vol">${totalValues.volStr}</span>
          </td>
          <td class="h-8 py-0 px-2 text-right font-bold text-white tabular-nums whitespace-nowrap" title="${totalValues.oiTitle}">
            <span class="val-oi">${totalValues.oiStr}</span>
          </td>
          <td class="h-8 py-0 px-2 text-right font-bold tabular-nums whitespace-nowrap" title="${totalValues.netPnlTitle}">
            <span class="val-net-pnl ${totalValues.netPnlCls}">${totalValues.netPnlStr}</span>
          </td>
          <td class="h-8 py-0 px-2 text-right font-bold tabular-nums whitespace-nowrap" title="${totalValues.priceTitle}">
            <span class="val-price ${totalValues.priceCls}">${totalValues.priceStr}</span>
          </td>
        </tr>
      </tfoot>
    `;
  }

  container.innerHTML = `
    <table class="w-full h-full border-collapse text-left text-xs font-mono">
      <thead>
        <tr class="h-8 border-b border-terminal-border bg-terminal-surface/95 text-terminal-muted text-[11px] select-none sticky top-0 z-10 backdrop-blur-xs font-sans">
          <th class="h-8 py-0 px-2 font-semibold w-7 text-center">#</th>
          <th class="h-8 py-0 px-2 font-semibold cursor-pointer hover:text-white whitespace-nowrap text-left" data-sort="weekNumber">
            Week ${renderSortIndicator("weekNumber")}
          </th>
          <th class="h-8 py-0 px-2 font-semibold cursor-pointer hover:text-white whitespace-nowrap text-left" data-sort="dateRange">
            Dates ${renderSortIndicator("dateRange")}
          </th>
          <th class="h-8 py-0 px-2 font-semibold text-center cursor-pointer hover:text-white whitespace-nowrap" data-sort="points">
            Points ${renderSortIndicator("points")}
          </th>
          <th class="h-8 py-0 px-2 font-semibold text-right cursor-pointer hover:text-white whitespace-nowrap" data-sort="volume" title="Robinhood trading volume for the week">
            Vol ${renderSortIndicator("volume")}
          </th>
          <th class="h-8 py-0 px-2 font-semibold text-right cursor-pointer hover:text-white whitespace-nowrap" data-sort="avgOi" title="Time-weighted average open interest for the week">
            Avg OI ${renderSortIndicator("avgOi")}
          </th>
          <th class="h-8 py-0 px-2 font-semibold text-right cursor-pointer hover:text-white whitespace-nowrap" data-sort="netPnl" title="Total net PnL for the week">
            Net PnL ${renderSortIndicator("netPnl")}
          </th>
          <th class="h-8 py-0 px-2 font-semibold text-right cursor-pointer hover:text-white whitespace-nowrap" data-sort="costPerPoint" title="Point price based on net PnL (-Net PnL / Points)">
            Point Price ${renderSortIndicator("costPerPoint")}
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-terminal-borderSubtle/60">
        ${rowsHtml}
        <tr class="h-full border-0 pointer-events-none spacer-row">
          <td colspan="8" class="p-0 border-0 bg-transparent"></td>
        </tr>
      </tbody>
      ${tfootHtml}
    </table>
  `;

  if (onSortClick) {
    const headers = container.querySelectorAll<HTMLElement>("th[data-sort]");
    headers.forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.getAttribute("data-sort") as WeeklyPointsSortColumn;
        if (col) {
          onSortClick(col);
        }
      });
    });
  }

  const rowEls = container.querySelectorAll<HTMLElement>("tr[data-week]");
  rowEls.forEach((rowEl) => {
    const weekNum = Number(rowEl.dataset.week);
    rowEl.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName !== "INPUT") {
        onSelectWeek(weekNum);
      }
    });

    const input = rowEl.querySelector<HTMLInputElement>("input");
    if (input) {
      input.addEventListener("input", (e) => {
        e.stopPropagation();
        onPointsChange(weekNum, input.value);
      });
      input.addEventListener("click", (e) => {
        e.stopPropagation();
      });
    }
  });

  const totalRowEl =
    typeof container.querySelector === "function"
      ? container.querySelector<HTMLElement>("tr[data-total-row]")
      : null;
  if (totalRowEl) {
    totalRowEl.addEventListener("click", () => {
      onSelectWeek(0);
    });
  }
}

export function renderWeeklyPointsMultiGrid(
  elements: WeeklyPointsMultiElements,
  statsList: WeekActivityStats[],
  activeWeekNumber: number | null,
  onPointsChange: (weekNum: number, value: string) => void,
  onSelectWeek: (weekNum: number) => void,
  sortColumn: WeeklyPointsSortColumn = "weekNumber",
  sortDirection: "asc" | "desc" = "asc",
  onSortClick?: (column: WeeklyPointsSortColumn) => void,
): void {
  if (!elements.container || !elements.grid) return;
  if (!statsList || statsList.length === 0) {
    elements.container.classList.add("hidden");
    return;
  }
  elements.container.classList.remove("hidden");
  if (elements.count) {
    elements.count.textContent = `(${statsList.length} weeks active)`;
  }
  renderWeeklyPointsTable(
    elements.grid,
    statsList,
    activeWeekNumber,
    onPointsChange,
    onSelectWeek,
    sortColumn,
    sortDirection,
    onSortClick,
  );
}
