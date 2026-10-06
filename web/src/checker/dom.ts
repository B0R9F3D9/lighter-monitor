import { formatFee, formatMoney, formatPrice } from "../shared/formatters";
import type {
  CheckerSummaryMetrics,
  HedgePair,
  HedgeSummaryMetrics,
  IndividualAccountMetrics,
  ParsedTradeView,
  SelectedHedgeMetrics,
  UnhedgedTrade,
} from "./types";

function formatSmartSize(size: number): string {
  if (size === 0 || isNaN(size)) return "0.0";
  if (size >= 100) return size.toFixed(1);
  if (size >= 1) return size.toFixed(3);
  return size.toFixed(4);
}

function formatSimpleDateUtc(d: Date): string {
  const month = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

export function updateExecutiveMetrics(
  metrics: CheckerSummaryMetrics | null,
  elements: {
    tradesCount: HTMLElement | null;
    totalVolume: HTMLElement | null;
    realizedPnl: HTMLElement | null;
    totalFees: HTMLElement | null;
    dateRange: HTMLElement | null;
    accountBadge?: HTMLElement | null;
    networkBadge?: HTMLElement | null;
    verdictBadge?: HTMLElement | null;
  },
  accountIndex?: number | null,
  network?: string | null,
  accountIndices?: number[] | null,
): void {
  if (elements.accountBadge) {
    if (accountIndices && accountIndices.length > 1) {
      elements.accountBadge.textContent = accountIndices.map((a) => `#${a}`).join(", ");
    } else {
      elements.accountBadge.textContent =
        accountIndex !== null && accountIndex !== undefined ? `#${accountIndex}` : "--";
    }
    const isRh = network?.toLowerCase() === "rh";
    const isCore = network?.toLowerCase() === "mainnet" || network?.toLowerCase() === "core";
    if (isRh) {
      elements.accountBadge.className = "text-terminal-emerald font-bold text-sm tracking-tight";
    } else if (isCore) {
      elements.accountBadge.className = "text-terminal-accent font-bold text-sm tracking-tight";
    } else {
      elements.accountBadge.className = "text-white font-bold text-sm tracking-tight";
    }
  }
  if (elements.networkBadge) {
    elements.networkBadge.textContent = network ? network.toUpperCase() : "";
    const isRh = network?.toLowerCase() === "rh";
    const isCore = network?.toLowerCase() === "mainnet" || network?.toLowerCase() === "core";
    if (isRh) {
      elements.networkBadge.className = "text-terminal-emerald text-[11px] font-semibold";
    } else if (isCore) {
      elements.networkBadge.className = "text-terminal-accent text-[11px] font-semibold";
    } else {
      elements.networkBadge.className = "text-terminal-muted text-[11px]";
    }
  }

  if (!metrics || metrics.totalTrades === 0) {
    if (elements.tradesCount) elements.tradesCount.textContent = "0";
    if (elements.totalVolume) elements.totalVolume.textContent = "$0.00";
    if (elements.realizedPnl) {
      elements.realizedPnl.textContent = "$0.00";
      elements.realizedPnl.className = "font-bold text-terminal-muted tabular-nums";
    }
    if (elements.totalFees) elements.totalFees.textContent = "$0.00";
    if (elements.dateRange) elements.dateRange.textContent = "--";
    if (elements.verdictBadge) {
      elements.verdictBadge.textContent = "--";
      elements.verdictBadge.className = "text-[11px] font-semibold text-terminal-muted";
    }
    return;
  }

  if (elements.tradesCount) {
    elements.tradesCount.textContent = metrics.totalTrades.toLocaleString();
  }

  if (elements.totalVolume) {
    elements.totalVolume.textContent = formatMoney(metrics.totalVolumeUsd);
  }

  if (elements.realizedPnl) {
    const pnl = metrics.totalRealizedPnl;
    const sign = pnl > 0 ? "+" : "";
    elements.realizedPnl.textContent = `${sign}${formatMoney(pnl)}`;
    if (pnl > 0.001) {
      elements.realizedPnl.className = "font-bold text-terminal-emerald tabular-nums";
    } else if (pnl < -0.001) {
      elements.realizedPnl.className = "font-bold text-terminal-coral tabular-nums";
    } else {
      elements.realizedPnl.className = "font-bold text-terminal-muted tabular-nums";
    }
  }

  if (elements.totalFees) {
    elements.totalFees.textContent = formatFee(metrics.totalFeesUsd);
  }

  if (elements.dateRange) {
    if (metrics.firstTradeTime && metrics.lastTradeTime) {
      const d1 = new Date(metrics.firstTradeTime);
      const d2 = new Date(metrics.lastTradeTime);
      elements.dateRange.textContent = `${formatSimpleDateUtc(d1)} → ${formatSimpleDateUtc(d2)}`;
    } else {
      elements.dateRange.textContent = "--";
    }
  }

  if (elements.verdictBadge) {
    elements.verdictBadge.textContent = "";
  }
}

function createTradeRow(item: ParsedTradeView, index: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "hover:bg-terminal-surfaceHover transition-colors text-xs font-mono select-text";

  const isBuy = item.side === "BUY";
  const sideColorClass = isBuy ? "text-terminal-emerald" : "text-terminal-coral";

  const isMaker = item.role === "MAKER";
  const roleHtml = isMaker
    ? `<span class="text-terminal-accent font-semibold text-[11px]">MAKER</span>`
    : `<span class="text-terminal-muted text-[11px]">taker</span>`;

  let pnlHtml = `<span class="text-terminal-muted tabular-nums">$0.00</span>`;
  if (item.realizedPnl > 0.0001) {
    pnlHtml = `<span class="text-terminal-emerald font-semibold tabular-nums">+${formatMoney(item.realizedPnl)}</span>`;
  } else if (item.realizedPnl < -0.0001) {
    pnlHtml = `<span class="text-terminal-coral font-semibold tabular-nums">${formatMoney(item.realizedPnl)}</span>`;
  }

  const txLink =
    item.txHashShort && item.txHashShort !== "--"
      ? `<span class="text-terminal-muted hover:text-white transition cursor-pointer select-all" title="${item.txHash}">${item.txHashShort}</span>`
      : `<span class="text-terminal-muted">--</span>`;

  const accTag = item.userAccountId
    ? `<span class="text-terminal-muted/80 text-[10px] ml-1">#${item.userAccountId}</span>`
    : "";

  tr.innerHTML = `
    <td class="py-1.5 px-2 text-terminal-muted tabular-nums text-[11px]">${index}</td>
    <td class="py-1.5 px-2 text-white whitespace-nowrap text-[11px]">${item.timeFormatted}</td>
    <td class="py-1.5 px-2 whitespace-nowrap">
      <span class="font-bold text-white">${item.marketSymbol}</span>${accTag}
    </td>
    <td class="py-1.5 px-2 text-center whitespace-nowrap font-bold text-[11px] ${sideColorClass}">${item.side}</td>
    <td class="py-1.5 px-2 text-center whitespace-nowrap text-[11px]">${roleHtml}</td>
    <td class="py-1.5 px-2 text-right text-white tabular-nums">${formatPrice(item.price)}</td>
    <td class="py-1.5 px-2 text-right ${sideColorClass} tabular-nums">${formatSmartSize(item.size)}</td>
    <td class="py-1.5 px-2 text-right text-white tabular-nums">${formatMoney(item.usdValue)}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap">${pnlHtml}</td>
    <td class="py-1.5 px-2 text-right text-terminal-secondary text-[11px] tabular-nums">${formatFee(item.feeUsd)}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap text-[11px] font-mono">${txLink}</td>
  `;

  return tr;
}

export function renderTradesTable(
  container: HTMLTableSectionElement,
  trades: ParsedTradeView[],
  limit = 250,
): void {
  container.innerHTML = "";

  if (trades.length === 0) {
    const emptyRow = document.createElement("tr");
    emptyRow.innerHTML = `
      <td colspan="11" class="py-12 text-center text-terminal-muted">
        <div class="flex flex-col items-center justify-center gap-1.5">
          <span class="text-terminal-secondary font-medium">No trades to display</span>
          <span class="text-[11px] text-terminal-muted">Drop your exported JSON file above or use the bookmarklet to export trades from Lighter.</span>
        </div>
      </td>
    `;
    container.appendChild(emptyRow);
    return;
  }

  const renderSlice = trades.slice(0, limit);
  const frag = document.createDocumentFragment();

  renderSlice.forEach((trade, i) => {
    frag.appendChild(createTradeRow(trade, i + 1));
  });

  if (trades.length > limit) {
    const noticeRow = document.createElement("tr");
    noticeRow.innerHTML = `
      <td colspan="11" class="py-2.5 text-center text-[11px] text-terminal-secondary bg-terminal-surface/40">
        Showing first ${limit} of ${trades.length} trades. Export JSON to download full dataset.
      </td>
    `;
    frag.appendChild(noticeRow);
  }

  container.appendChild(frag);
}

function createHedgeRow(pair: HedgePair, index: number, isSelected = false): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const baseClass =
    "hover:bg-terminal-surfaceHover transition-colors text-xs font-mono select-text cursor-pointer";
  tr.className = isSelected ? `${baseClass} bg-white/10 hover:bg-white/[0.13]` : baseClass;
  tr.dataset.id = pair.id;
  tr.dataset.index = index.toString();
  tr.title = "Click to select pair (Shift+Click to select range)";

  const rhIsBuy = pair.rhSide === "BUY";
  const coreIsBuy = pair.coreSide === "BUY";

  const rhSideColor = rhIsBuy ? "text-terminal-emerald" : "text-terminal-coral";
  const coreSideColor = coreIsBuy ? "text-terminal-emerald" : "text-terminal-coral";

  let priceDeltaHtml = `<span class="text-terminal-muted tabular-nums">$0.00</span>`;
  if (pair.priceDelta > 0.0001) {
    priceDeltaHtml = `<span class="text-terminal-emerald font-semibold tabular-nums">+${formatPrice(pair.priceDelta)}</span>`;
  } else if (pair.priceDelta < -0.0001) {
    priceDeltaHtml = `<span class="text-terminal-coral font-semibold tabular-nums">${formatPrice(pair.priceDelta)}</span>`;
  }

  let slippageHtml = `<span class="text-terminal-muted tabular-nums">$0.00</span>`;
  if (pair.pricePnlUsd > 0.0001) {
    slippageHtml = `<span class="text-terminal-emerald font-semibold tabular-nums">+${formatMoney(pair.pricePnlUsd)}</span>`;
  } else if (pair.pricePnlUsd < -0.0001) {
    slippageHtml = `<span class="text-terminal-coral font-semibold tabular-nums">${formatMoney(pair.pricePnlUsd)}</span>`;
  }

  let netPnlHtml = `<span class="text-terminal-muted tabular-nums">$0.00</span>`;
  if (pair.netPnlUsd > 0.0001) {
    netPnlHtml = `<span class="text-terminal-emerald font-bold tabular-nums">+${formatMoney(pair.netPnlUsd)}</span>`;
  } else if (pair.netPnlUsd < -0.0001) {
    netPnlHtml = `<span class="text-terminal-coral font-bold tabular-nums">${formatMoney(pair.netPnlUsd)}</span>`;
  }

  let bpsHtml = `<span class="text-terminal-muted tabular-nums">0.0 bps</span>`;
  if (pair.pnlBps > 0.01) {
    bpsHtml = `<span class="text-terminal-emerald font-semibold tabular-nums">+${pair.pnlBps.toFixed(2)} bps</span>`;
  } else if (pair.pnlBps < -0.01) {
    bpsHtml = `<span class="text-terminal-coral font-semibold tabular-nums">${pair.pnlBps.toFixed(2)} bps</span>`;
  }

  const statusBadge =
    pair.status === "HEDGED"
      ? `<span class="text-terminal-emerald font-semibold text-[11px]">HEDGED</span>`
      : `<span class="text-terminal-amber font-semibold text-[11px]">PARTIAL</span>`;

  const timeDeltaStr = (pair.timeDeltaSec >= 0 ? "+" : "") + pair.timeDeltaSec.toFixed(1) + "s";

  tr.innerHTML = `
    <td class="py-1.5 px-2 text-center w-7">
      <input
        type="checkbox"
        class="hedge-row-cb hedge-cb"
        data-id="${pair.id}"
        ${isSelected ? "checked" : ""}
        title="Select pair (Shift+Click to select range)"
      />
    </td>
    <td class="py-1.5 px-2 text-terminal-muted tabular-nums text-[11px]">${index}</td>
    <td class="py-1.5 px-2 text-white whitespace-nowrap text-[11px]">${pair.rhTimeFormatted}</td>
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
    <td class="py-1.5 px-2 text-right text-white tabular-nums">${formatSmartSize(pair.matchedSize)}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap">${priceDeltaHtml}</td>
    <td class="py-1.5 px-2 text-right text-white tabular-nums">${formatMoney(pair.notionalUsd)}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap">${slippageHtml}</td>
    <td class="py-1.5 px-2 text-right text-terminal-secondary text-[11px] tabular-nums">${formatFee(pair.totalFeesUsd)}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap">${netPnlHtml}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap text-[11px]">${bpsHtml}</td>
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
    "hover:bg-terminal-surfaceHover transition-colors text-xs font-mono select-text cursor-pointer";
  tr.className = isSelected
    ? `${baseClass} bg-white/10 hover:bg-white/[0.13]`
    : `${baseClass} bg-terminal-coral/5`;
  tr.dataset.id = id;
  tr.dataset.index = index.toString();
  tr.title = "Click to select trade (Shift+Click to select range)";

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

  tr.innerHTML = `
    <td class="py-1.5 px-2 text-center w-7">
      <input
        type="checkbox"
        class="hedge-row-cb hedge-cb"
        data-id="${id}"
        ${isSelected ? "checked" : ""}
        title="Select trade (Shift+Click to select range)"
      />
    </td>
    <td class="py-1.5 px-2 text-terminal-muted tabular-nums text-[11px]">${index}</td>
    <td class="py-1.5 px-2 text-white whitespace-nowrap text-[11px]">${trade.timeFormatted}</td>
    <td class="py-1.5 px-2 whitespace-nowrap">
      <span class="font-bold text-white">${trade.marketSymbol}</span>
    </td>
    <td class="py-1.5 px-2 whitespace-nowrap text-[11px]">${rhLegHtml}</td>
    <td class="py-1.5 px-2 whitespace-nowrap text-[11px]">${coreLegHtml}</td>
    <td class="py-1.5 px-2 text-right text-terminal-coral tabular-nums font-semibold">${formatSmartSize(trade.unhedgedSize)}</td>
    <td class="py-1.5 px-2 text-right text-terminal-muted">--</td>
    <td class="py-1.5 px-2 text-right text-white tabular-nums">${formatMoney(trade.usdValue)}</td>
    <td class="py-1.5 px-2 text-right text-terminal-muted">--</td>
    <td class="py-1.5 px-2 text-right text-terminal-secondary text-[11px] tabular-nums">${formatFee(trade.feeUsd)}</td>
    <td class="py-1.5 px-2 text-right text-terminal-muted font-bold">--</td>
    <td class="py-1.5 px-2 text-right text-terminal-muted">--</td>
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
  limit = 250,
  selectedIds: Set<string> = new Set(),
): void {
  container.innerHTML = "";

  const showPairs = filterMode === "all";
  const totalItems = (showPairs ? pairs.length : 0) + unhedged.length;

  if (totalItems === 0) {
    const emptyRow = document.createElement("tr");
    emptyRow.innerHTML = `
      <td colspan="15" class="py-12 text-center text-terminal-muted">
        <div class="flex flex-col items-center justify-center gap-1.5">
          <span class="text-terminal-secondary font-medium">No hedge pairs to display</span>
          <span class="text-[11px] text-terminal-muted">Upload both your Robinhood JSON and Core JSON files to compare and audit your hedge efficiency.</span>
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
    noticeRow.innerHTML = `
      <td colspan="15" class="py-2.5 text-center text-[11px] text-terminal-secondary bg-terminal-surface/40">
        Showing first ${limit} of ${totalItems} records. Export CSV to analyze the complete dataset.
      </td>
    `;
    frag.appendChild(noticeRow);
  }

  container.appendChild(frag);
}

export interface HedgeMetricElements {
  accountsBadge?: HTMLElement | null;
  pairsCount: HTMLElement | null;
  hedgedVolume: HTMLElement | null;
  netPnl: HTMLElement | null;
  pnlBps: HTMLElement | null;
  slippage: HTMLElement | null;
  fees: HTMLElement | null;
  unhedgedCount: HTMLElement | null;
}

export function updateHedgeExecutiveMetrics(
  metrics: HedgeSummaryMetrics | null,
  elements: HedgeMetricElements,
): void {
  if (!metrics || (metrics.totalPairs === 0 && metrics.totalUnhedgedTrades === 0)) {
    if (elements.accountsBadge) {
      elements.accountsBadge.innerHTML = `<span class="text-terminal-emerald">RH</span> <span class="text-terminal-muted font-normal">vs</span> <span class="text-terminal-accent">CORE</span>`;
    }
    if (elements.pairsCount) elements.pairsCount.textContent = "0";
    if (elements.hedgedVolume) elements.hedgedVolume.textContent = "$0.00";
    if (elements.netPnl) {
      elements.netPnl.textContent = "$0.00";
      elements.netPnl.className = "font-bold text-terminal-muted tabular-nums";
    }
    if (elements.pnlBps) elements.pnlBps.textContent = "(0.0 bps)";
    if (elements.slippage) elements.slippage.textContent = "$0.00";
    if (elements.fees) elements.fees.textContent = "$0.00";
    if (elements.unhedgedCount) elements.unhedgedCount.textContent = "0";
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
    if (metrics.totalPricePnlUsd > 0.001) {
      elements.slippage.className = "font-bold text-terminal-emerald tabular-nums";
    } else if (metrics.totalPricePnlUsd < -0.001) {
      elements.slippage.className = "font-bold text-terminal-coral tabular-nums";
    } else {
      elements.slippage.className = "font-bold text-terminal-secondary tabular-nums";
    }
  }

  if (elements.fees) {
    elements.fees.textContent = formatFee(metrics.totalFeesUsd);
  }

  if (elements.unhedgedCount) {
    elements.unhedgedCount.textContent = metrics.totalUnhedgedTrades.toLocaleString();
    elements.unhedgedCount.className =
      metrics.totalUnhedgedTrades > 0
        ? "font-bold text-terminal-coral tabular-nums"
        : "font-bold text-terminal-secondary tabular-nums";
  }
}

export interface IndividualAccountMetricElements {
  accountBadge: HTMLElement | null;
  tradesCount: HTMLElement | null;
  volume: HTMLElement | null;
  realizedPnl: HTMLElement | null;
  fees: HTMLElement | null;
  unhedgedCount: HTMLElement | null;
}

export function updateIndividualAccountMetrics(
  metrics: IndividualAccountMetrics | null,
  elements: IndividualAccountMetricElements,
): void {
  const isRh = metrics?.network === "RH";
  const activeColor = isRh ? "text-terminal-emerald" : "text-terminal-accent";

  if (!metrics || metrics.tradesCount === 0) {
    if (elements.accountBadge) {
      if (metrics?.accountIndices && metrics.accountIndices.length > 1) {
        elements.accountBadge.textContent = metrics.accountIndices.map((a) => `#${a}`).join(", ");
        elements.accountBadge.className = `font-bold text-sm tracking-tight ${activeColor}`;
      } else if (metrics?.accountIndex) {
        elements.accountBadge.textContent = `#${metrics.accountIndex}`;
        elements.accountBadge.className = `font-bold text-sm tracking-tight ${activeColor}`;
      } else {
        elements.accountBadge.textContent = "--";
        elements.accountBadge.className = "font-bold text-sm tracking-tight text-terminal-muted";
      }
    }
    if (elements.tradesCount) elements.tradesCount.textContent = "0";
    if (elements.volume) elements.volume.textContent = "$0.00";
    if (elements.realizedPnl) {
      elements.realizedPnl.textContent = "$0.00";
      elements.realizedPnl.className = "font-bold text-terminal-muted tabular-nums";
    }
    if (elements.fees) elements.fees.textContent = "$0.00";
    if (elements.unhedgedCount) {
      elements.unhedgedCount.textContent = "0";
      elements.unhedgedCount.className = "font-bold text-terminal-muted tabular-nums";
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
    elements.accountBadge.className = `font-bold text-sm tracking-tight ${activeColor}`;
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
  }

  if (elements.unhedgedCount) {
    elements.unhedgedCount.textContent = metrics.unhedgedCount.toLocaleString();
    elements.unhedgedCount.className =
      metrics.unhedgedCount > 0
        ? "font-bold text-terminal-coral tabular-nums"
        : "font-bold text-terminal-muted tabular-nums";
  }
}

export interface HedgeSelectionMetricElements {
  selectionCard: HTMLElement | null;
  countBadge: HTMLElement | null;
  pairsCount: HTMLElement | null;
  volume: HTMLElement | null;
  netPnl: HTMLElement | null;
  pnlBps: HTMLElement | null;
  weightedDelta: HTMLElement | null;
  weightedDeltaBps: HTMLElement | null;
  slippage: HTMLElement | null;
  fees: HTMLElement | null;
  unhedgedCount: HTMLElement | null;
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
    const text = metrics.selectedCount === 1 ? "1 row" : `${metrics.selectedCount} rows`;
    elements.countBadge.textContent = text;
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
      if (delta > 0.0001) {
        elements.weightedDelta.className = "font-bold text-terminal-emerald tabular-nums";
      } else if (delta < -0.0001) {
        elements.weightedDelta.className = "font-bold text-terminal-coral tabular-nums";
      } else {
        elements.weightedDelta.className = "font-bold text-terminal-muted tabular-nums";
      }

      const marketLabel =
        metrics.isSingleMarket && metrics.marketSymbol ? ` (${metrics.marketSymbol})` : "";
      elements.weightedDelta.title = `Weighted Δ Price${marketLabel}: Sell avg ${formatPrice(metrics.weightedSellPrice)} - Buy avg ${formatPrice(metrics.weightedBuyPrice)} (Matched Size: ${metrics.totalMatchedSize.toLocaleString(undefined, { maximumFractionDigits: 4 })})`;
    }
  }

  if (elements.weightedDeltaBps) {
    if (metrics.pairsCount === 0) {
      elements.weightedDeltaBps.textContent = "";
      elements.weightedDeltaBps.className = "text-[10px] text-terminal-muted tabular-nums ml-1";
    } else {
      const bps = metrics.weightedPriceDeltaBps;
      const sign = bps > 0.001 ? "+" : "";
      elements.weightedDeltaBps.textContent = `(${sign}${bps.toFixed(2)} bps)`;
      if (bps > 0.01) {
        elements.weightedDeltaBps.className = "text-[10px] text-terminal-emerald tabular-nums ml-1";
      } else if (bps < -0.01) {
        elements.weightedDeltaBps.className = "text-[10px] text-terminal-coral tabular-nums ml-1";
      } else {
        elements.weightedDeltaBps.className = "text-[10px] text-terminal-muted tabular-nums ml-1";
      }
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
    if (metrics.totalPricePnlUsd > 0.001) {
      elements.slippage.className = "font-bold text-terminal-emerald tabular-nums";
    } else if (metrics.totalPricePnlUsd < -0.001) {
      elements.slippage.className = "font-bold text-terminal-coral tabular-nums";
    } else {
      elements.slippage.className = "font-bold text-terminal-secondary tabular-nums";
    }
  }

  if (elements.fees) {
    elements.fees.textContent = formatFee(metrics.totalFeesUsd);
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
