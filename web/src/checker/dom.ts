import { formatMoney, formatPrice } from "../shared/formatters";
import type { CheckerSummaryMetrics, ParsedTradeView } from "./types";

export function formatSmartSize(size: number): string {
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
): void {
  if (elements.accountBadge) {
    elements.accountBadge.textContent =
      accountIndex !== null && accountIndex !== undefined ? `#${accountIndex}` : "--";
  }
  if (elements.networkBadge) {
    elements.networkBadge.textContent = network ? network.toUpperCase() : "--";
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
    elements.totalFees.textContent = formatMoney(metrics.totalFeesUsd);
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

export function updateProgressBar(
  progressEl: HTMLElement | null,
  textEl: HTMLElement | null,
  percentage: number,
  text: string,
): void {
  if (progressEl) {
    const clamped = Math.max(0, Math.min(100, percentage));
    progressEl.style.width = `${clamped}%`;
  }
  if (textEl) {
    textEl.textContent = text;
  }
}

export function createTradeRow(item: ParsedTradeView, index: number): HTMLTableRowElement {
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

  tr.innerHTML = `
    <td class="py-1.5 px-2 text-terminal-muted tabular-nums text-[11px]">${index}</td>
    <td class="py-1.5 px-2 text-white whitespace-nowrap text-[11px]">${item.timeFormatted}</td>
    <td class="py-1.5 px-2 whitespace-nowrap">
      <span class="font-bold text-white">${item.marketSymbol}</span>
    </td>
    <td class="py-1.5 px-2 text-center whitespace-nowrap font-bold text-[11px] ${sideColorClass}">${item.side}</td>
    <td class="py-1.5 px-2 text-center whitespace-nowrap text-[11px]">${roleHtml}</td>
    <td class="py-1.5 px-2 text-right text-white tabular-nums">${formatPrice(item.price)}</td>
    <td class="py-1.5 px-2 text-right ${sideColorClass} tabular-nums">${formatSmartSize(item.size)}</td>
    <td class="py-1.5 px-2 text-right text-white tabular-nums">${formatMoney(item.usdValue)}</td>
    <td class="py-1.5 px-2 text-right whitespace-nowrap">${pnlHtml}</td>
    <td class="py-1.5 px-2 text-right text-terminal-secondary text-[11px] tabular-nums">${item.feeUsd > 0 ? formatMoney(item.feeUsd) : "$0.00"}</td>
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
