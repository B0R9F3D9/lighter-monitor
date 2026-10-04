import type {
  HedgeMatchingResult,
  HedgePair,
  HedgeSummaryMetrics,
  ParsedTradeView,
  SelectedHedgeMetrics,
  UnhedgedTrade,
} from "./types";

interface WorkingTrade {
  trade: ParsedTradeView;
  network: "RH" | "CORE";
  remainingSize: number;
  timestampMs: number;
  microTime: number;
  tradeIdNum: number;
}

/**
 * Derives an aggregation key to group multi-slice fills belonging to the same order:
 * 1. User Order ID (bid_id for BUY, ask_id for SELL) - most accurate for raw Lighter API
 * 2. Non-zero transaction hash (all fills in a market sweep share the same L2 tx_hash)
 * 3. Timestamp in ms (block time fallback for bookmarklet exports where order IDs are omitted)
 *
 * NOTE: Microsecond transaction_time is intentionally NOT used as a grouping key because
 * Lighter increments transaction_time per execution match, which previously prevented raw API fills
 * from collapsing together into (X fills).
 */
function getTradeOrderAggregationKey(trade: ParsedTradeView): string {
  const raw = trade.raw as any;

  if (raw) {
    if (trade.side === "BUY") {
      const bidId = raw.bid_id_str || (raw.bid_id != null ? String(raw.bid_id) : "");
      if (bidId && bidId !== "0") {
        return `order_${bidId}_${trade.marketId}_${trade.side}`;
      }
      const bidClientId =
        raw.bid_client_id_str || (raw.bid_client_id != null ? String(raw.bid_client_id) : "");
      if (bidClientId && bidClientId !== "0") {
        return `client_${bidClientId}_${trade.marketId}_${trade.side}`;
      }
    } else {
      const askId = raw.ask_id_str || (raw.ask_id != null ? String(raw.ask_id) : "");
      if (askId && askId !== "0") {
        return `order_${askId}_${trade.marketId}_${trade.side}`;
      }
      const askClientId =
        raw.ask_client_id_str || (raw.ask_client_id != null ? String(raw.ask_client_id) : "");
      if (askClientId && askClientId !== "0") {
        return `client_${askClientId}_${trade.marketId}_${trade.side}`;
      }
    }
  }

  // Fallback for bookmarklet exports (where order IDs are omitted) or mock objects:
  const timeKey =
    trade.raw?.transaction_time != null ? `${trade.raw.transaction_time}` : `${trade.timestampMs}`;

  return `${timeKey}_${trade.marketId}_${trade.side}`;
}

/**
 * Aggregates multi-slice execution fills belonging to the same order.
 * Fills sharing the same order ID, transaction hash, or block timestamp are combined into a single order with:
 * - Total size = sum(fills.size)
 * - VWAP price = sum(fills.usdValue) / sum(fills.size)
 * - Total fees = sum(fills.feeUsd)
 * - Total realized PnL = sum(fills.realizedPnl)
 * - fillsCount = number of aggregated execution slices
 */
export function aggregateTradesByOrder(trades: ParsedTradeView[]): ParsedTradeView[] {
  if (trades.length === 0) return [];

  const groupsMap = new Map<string, ParsedTradeView[]>();
  const groupOrder: string[] = [];

  for (const trade of trades) {
    const key = getTradeOrderAggregationKey(trade);

    let group = groupsMap.get(key);
    if (!group) {
      group = [];
      groupsMap.set(key, group);
      groupOrder.push(key);
    }
    group.push(trade);
  }

  const aggregated: ParsedTradeView[] = [];

  for (const key of groupOrder) {
    const group = groupsMap.get(key)!;
    if (group.length === 1) {
      aggregated.push({
        ...group[0],
        fillsCount: 1,
      });
      continue;
    }

    // Sort group chronologically so lead trade is earliest
    group.sort((a, b) => {
      const aMicro = a.raw?.transaction_time ?? 0;
      const bMicro = b.raw?.transaction_time ?? 0;
      if (aMicro !== bMicro) return aMicro - bMicro;

      const aId = Number(a.raw?.trade_id || a.tradeId) || 0;
      const bId = Number(b.raw?.trade_id || b.tradeId) || 0;
      return aId - bId;
    });

    const leadTrade = group[0];
    let totalSize = 0;
    let totalUsdValue = 0;
    let totalRealizedPnl = 0;
    let totalFeeUsd = 0;

    for (const fill of group) {
      totalSize += fill.size;
      totalUsdValue += fill.usdValue;
      totalRealizedPnl += fill.realizedPnl;
      totalFeeUsd += fill.feeUsd;
    }

    const vwapPrice = totalSize > 0 ? totalUsdValue / totalSize : leadTrade.price;

    const firstId = leadTrade.tradeId;
    const lastId = group[group.length - 1].tradeId;
    const combinedTradeId = firstId === lastId ? firstId : `${firstId}..${lastId}`;

    aggregated.push({
      raw: leadTrade.raw,
      tradeId: combinedTradeId,
      timeFormatted: leadTrade.timeFormatted,
      timestampMs: leadTrade.timestampMs,
      marketSymbol: leadTrade.marketSymbol,
      marketId: leadTrade.marketId,
      marketKind: leadTrade.marketKind,
      type: leadTrade.type,
      side: leadTrade.side,
      role: leadTrade.role,
      price: vwapPrice,
      size: totalSize,
      usdValue: totalUsdValue,
      realizedPnl: totalRealizedPnl,
      feeUsd: totalFeeUsd,
      txHash: leadTrade.txHash,
      txHashShort: leadTrade.txHashShort,
      fillsCount: group.length,
      tradeIdNum: leadTrade.tradeIdNum ?? (Number(leadTrade.tradeId) || 0),
      searchIndex: `${leadTrade.marketSymbol} ${leadTrade.side} ${leadTrade.role} ${combinedTradeId} ${leadTrade.txHash}`.toLowerCase(),
    });
  }

  return aggregated;
}

const toWorkingTrade = (t: ParsedTradeView, network: "RH" | "CORE"): WorkingTrade => ({
  trade: t,
  network,
  remainingSize: t.size,
  timestampMs: t.timestampMs,
  microTime: t.raw?.transaction_time ?? 0,
  tradeIdNum: t.tradeIdNum ?? (Number(t.raw?.trade_id || t.tradeId) || 0),
});

/**
 * Matches trades executed on Robinhood (RH) with hedging trades executed on Core (Mainnet).
 *
 * Matching logic:
 * 1. Aggregates multi-slice fills from the same order into parent orders with VWAP (if aggregateFills=true).
 * 2. Groups trades by marketSymbol (e.g. AAPL, BTC, ETH).
 * 3. Matches opposite sides (RH BUY <-> Core SELL; RH SELL <-> Core BUY).
 * 4. Matches closest trades in chronological order within maxTimeDeltaSeconds window.
 * 5. Supports partial fill consumption if size differs.
 * 6. Flags any leftover quantity as UNHEDGED.
 */
export function matchHedgeTrades(
  rhTrades: ParsedTradeView[],
  coreTrades: ParsedTradeView[],
  rhAccountIndex?: number | number[] | null,
  coreAccountIndex?: number | number[] | null,
  maxTimeDeltaSeconds = 600,
  aggregateFills = true,
  rhAccountIndices?: number[],
  coreAccountIndices?: number[],
): HedgeMatchingResult {
  const maxDeltaMs = maxTimeDeltaSeconds * 1000;

  const resolvedRhIndices: number[] = rhAccountIndices
    ? rhAccountIndices
    : Array.isArray(rhAccountIndex)
      ? rhAccountIndex
      : rhAccountIndex !== null && rhAccountIndex !== undefined
        ? [rhAccountIndex]
        : Array.from(
            new Set(rhTrades.map((t) => t.userAccountId).filter((id): id is number => id != null)),
          );

  const resolvedCoreIndices: number[] = coreAccountIndices
    ? coreAccountIndices
    : Array.isArray(coreAccountIndex)
      ? coreAccountIndex
      : coreAccountIndex !== null && coreAccountIndex !== undefined
        ? [coreAccountIndex]
        : Array.from(
            new Set(
              coreTrades.map((t) => t.userAccountId).filter((id): id is number => id != null),
            ),
          );

  const primaryRhAcc = Array.isArray(rhAccountIndex)
    ? (rhAccountIndex[0] ?? null)
    : (rhAccountIndex ?? resolvedRhIndices[0] ?? null);
  const primaryCoreAcc = Array.isArray(coreAccountIndex)
    ? (coreAccountIndex[0] ?? null)
    : (coreAccountIndex ?? resolvedCoreIndices[0] ?? null);

  const actualRhTrades = aggregateFills ? aggregateTradesByOrder(rhTrades) : rhTrades;
  const actualCoreTrades = aggregateFills ? aggregateTradesByOrder(coreTrades) : coreTrades;

  // Clone with working mutable remaining sizes and precomputed numeric sort keys
  const rhWorking: WorkingTrade[] = actualRhTrades.map((t) => toWorkingTrade(t, "RH"));
  const coreWorking: WorkingTrade[] = actualCoreTrades.map((t) => toWorkingTrade(t, "CORE"));

  // Group by market symbol
  const rhByMarket = new Map<string, WorkingTrade[]>();
  for (const item of rhWorking) {
    const sym = (item.trade.marketSymbol || `#${item.trade.marketId}`).toUpperCase();
    if (!rhByMarket.has(sym)) rhByMarket.set(sym, []);
    rhByMarket.get(sym)!.push(item);
  }

  const coreByMarket = new Map<string, WorkingTrade[]>();
  for (const item of coreWorking) {
    const sym = (item.trade.marketSymbol || `#${item.trade.marketId}`).toUpperCase();
    if (!coreByMarket.has(sym)) coreByMarket.set(sym, []);
    coreByMarket.get(sym)!.push(item);
  }

  // All unique markets
  const allMarkets = new Set<string>([...rhByMarket.keys(), ...coreByMarket.keys()]);

  const pairs: HedgePair[] = [];
  const unhedged: UnhedgedTrade[] = [];
  let pairCounter = 1;
  const EPSILON = 1e-6;

  const sortTradesChronological = (a: WorkingTrade, b: WorkingTrade): number => {
    if (a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }
    // Secondary tie-breaker by transaction_time (microseconds)
    if (a.microTime !== b.microTime) {
      return a.microTime - b.microTime;
    }
    // Tertiary tie-breaker by trade_id
    return a.tradeIdNum - b.tradeIdNum;
  };

  for (const market of allMarkets) {
    const marketRh = (rhByMarket.get(market) || []).toSorted(sortTradesChronological);
    const marketCore = (coreByMarket.get(market) || []).toSorted(sortTradesChronological);

    // Split Core trades by side for direct O(N + M) sliding window matching without scanning mismatched sides
    const coreBuys: WorkingTrade[] = [];
    const coreSells: WorkingTrade[] = [];
    for (const c of marketCore) {
      if (c.trade.side === "BUY") {
        coreBuys.push(c);
      } else {
        coreSells.push(c);
      }
    }

    let coreBuyIndex = 0; // Candidates for RH SELL
    let coreSellIndex = 0; // Candidates for RH BUY

    for (const rhItem of marketRh) {
      if (rhItem.remainingSize <= EPSILON) continue;

      const isRhBuy = rhItem.trade.side === "BUY";
      const candidates = isRhBuy ? coreSells : coreBuys;
      let candIdx = isRhBuy ? coreSellIndex : coreBuyIndex;

      // Find eligible Core candidates with opposite side in sequential FIFO chronological order within maxDeltaMs
      while (rhItem.remainingSize > EPSILON) {
        // Fast-forward past exhausted candidates or candidates that occurred prior to (rhItem - maxDeltaMs).
        // Since marketRh is sorted chronologically ascending, any candidate earlier than (rhItem.timestampMs - maxDeltaMs)
        // is permanently expired for all current and future RH trades.
        while (candIdx < candidates.length) {
          const cand = candidates[candIdx];
          if (cand.remainingSize <= EPSILON) {
            candIdx++;
            continue;
          }
          if (cand.timestampMs < rhItem.timestampMs - maxDeltaMs) {
            candIdx++;
            continue;
          }
          break;
        }

        if (candIdx >= candidates.length) {
          // No more candidates in this queue
          break;
        }

        const bestCandidate = candidates[candIdx];

        // If earliest available candidate is beyond maxDeltaMs in the future,
        // no subsequent candidate will be within window either (sorted chronologically).
        // Note: do NOT increment candIdx because future RH trades may match this candidate!
        if (bestCandidate.timestampMs > rhItem.timestampMs + maxDeltaMs) {
          break;
        }

        const matchedSize = Math.min(rhItem.remainingSize, bestCandidate.remainingSize);
        rhItem.remainingSize = Math.max(0, rhItem.remainingSize - matchedSize);
        if (rhItem.remainingSize < EPSILON) rhItem.remainingSize = 0;

        bestCandidate.remainingSize = Math.max(0, bestCandidate.remainingSize - matchedSize);
        if (bestCandidate.remainingSize < EPSILON) {
          bestCandidate.remainingSize = 0;
          candIdx++; // advance pointer past fully exhausted candidate
        }

        // Pricing calculations:
        // Whichever leg was BUY paid buyPrice; whichever leg was SELL received sellPrice.
        const buyPrice = isRhBuy ? rhItem.trade.price : bestCandidate.trade.price;
        const sellPrice = isRhBuy ? bestCandidate.trade.price : rhItem.trade.price;

        const priceDelta = sellPrice - buyPrice; // Positive if sold higher than bought (profit); negative if loss
        const pricePnlUsd = priceDelta * matchedSize;

        // Pro-rated fees based on matched size
        const rhFeePro =
          rhItem.trade.size > 0 ? (rhItem.trade.feeUsd / rhItem.trade.size) * matchedSize : 0;
        const coreFeePro =
          bestCandidate.trade.size > 0
            ? (bestCandidate.trade.feeUsd / bestCandidate.trade.size) * matchedSize
            : 0;
        const totalFeesUsd = rhFeePro + coreFeePro;

        // Net PnL in USD (positive = profit, negative = loss)
        const netPnlUsd = pricePnlUsd - totalFeesUsd;

        const notionalUsd = matchedSize * ((rhItem.trade.price + bestCandidate.trade.price) / 2);
        const pnlBps = notionalUsd > 0 ? (netPnlUsd / notionalUsd) * 10000 : 0;
        const timeDeltaSec = (bestCandidate.trade.timestampMs - rhItem.trade.timestampMs) / 1000;

        const isPartial =
          matchedSize < rhItem.trade.size - EPSILON ||
          matchedSize < bestCandidate.trade.size - EPSILON;

        const pairSearchIndex =
          `${market} ${rhItem.trade.side} ${bestCandidate.trade.side} ${rhItem.trade.tradeId} ${bestCandidate.trade.tradeId}`.toLowerCase();

        pairs.push({
          id: `pair-${rhItem.trade.tradeId}-${bestCandidate.trade.tradeId}-${pairCounter++}`,
          marketSymbol: market,
          matchedSize,
          rhTradeId: rhItem.trade.tradeId,
          rhUserAccountId: rhItem.trade.userAccountId,
          rhSide: rhItem.trade.side,
          rhPrice: rhItem.trade.price,
          rhSize: rhItem.trade.size,
          rhFeeUsd: rhFeePro,
          rhTimestampMs: rhItem.trade.timestampMs,
          rhTimeFormatted: rhItem.trade.timeFormatted,
          rhTxHash: rhItem.trade.txHash,
          rhRole: rhItem.trade.role,
          rhFillsCount: rhItem.trade.fillsCount ?? 1,
          coreTradeId: bestCandidate.trade.tradeId,
          coreUserAccountId: bestCandidate.trade.userAccountId,
          coreSide: bestCandidate.trade.side,
          corePrice: bestCandidate.trade.price,
          coreSize: bestCandidate.trade.size,
          coreFeeUsd: coreFeePro,
          coreTimestampMs: bestCandidate.trade.timestampMs,
          coreTimeFormatted: bestCandidate.trade.timeFormatted,
          coreTxHash: bestCandidate.trade.txHash,
          coreRole: bestCandidate.trade.role,
          coreFillsCount: bestCandidate.trade.fillsCount ?? 1,
          buyPrice,
          sellPrice,
          priceDelta,
          pricePnlUsd,
          totalFeesUsd,
          netPnlUsd,
          notionalUsd,
          pnlBps,
          timeDeltaSec,
          status: isPartial ? "PARTIAL" : "HEDGED",
          searchIndex: pairSearchIndex,
        });
      }

      if (isRhBuy) {
        coreSellIndex = candIdx;
      } else {
        coreBuyIndex = candIdx;
      }
    }

    // Leftover unhedged trades for this market
    for (const rhItem of marketRh) {
      if (rhItem.remainingSize > EPSILON) {
        unhedged.push({
          id: `unhedged-RH-${rhItem.trade.tradeId}`,
          tradeId: rhItem.trade.tradeId,
          userAccountId: rhItem.trade.userAccountId,
          network: "RH",
          marketSymbol: market,
          side: rhItem.trade.side,
          role: rhItem.trade.role,
          unhedgedSize: rhItem.remainingSize,
          originalSize: rhItem.trade.size,
          price: rhItem.trade.price,
          usdValue: rhItem.remainingSize * rhItem.trade.price,
          feeUsd:
            rhItem.trade.size > 0
              ? (rhItem.trade.feeUsd / rhItem.trade.size) * rhItem.remainingSize
              : 0,
          timestampMs: rhItem.trade.timestampMs,
          timeFormatted: rhItem.trade.timeFormatted,
          txHash: rhItem.trade.txHash,
          fillsCount: rhItem.trade.fillsCount ?? 1,
          searchIndex: `${market} ${rhItem.trade.side} RH ${rhItem.trade.tradeId}`.toLowerCase(),
        });
      }
    }

    for (const coreItem of marketCore) {
      if (coreItem.remainingSize > EPSILON) {
        unhedged.push({
          id: `unhedged-CORE-${coreItem.trade.tradeId}`,
          tradeId: coreItem.trade.tradeId,
          userAccountId: coreItem.trade.userAccountId,
          network: "CORE",
          marketSymbol: market,
          side: coreItem.trade.side,
          role: coreItem.trade.role,
          unhedgedSize: coreItem.remainingSize,
          originalSize: coreItem.trade.size,
          price: coreItem.trade.price,
          usdValue: coreItem.remainingSize * coreItem.trade.price,
          feeUsd:
            coreItem.trade.size > 0
              ? (coreItem.trade.feeUsd / coreItem.trade.size) * coreItem.remainingSize
              : 0,
          timestampMs: coreItem.trade.timestampMs,
          timeFormatted: coreItem.trade.timeFormatted,
          txHash: coreItem.trade.txHash,
          fillsCount: coreItem.trade.fillsCount ?? 1,
          searchIndex: `${market} ${coreItem.trade.side} CORE ${coreItem.trade.tradeId}`.toLowerCase(),
        });
      }
    }
  }

  // Sort pairs chronologically descending (most recent first)
  pairs.sort((a, b) => {
    if (b.rhTimestampMs !== a.rhTimestampMs) {
      return b.rhTimestampMs - a.rhTimestampMs;
    }
    return b.coreTimestampMs - a.coreTimestampMs;
  });
  unhedged.sort((a, b) => b.timestampMs - a.timestampMs);

  const metrics = calculateHedgeMetrics(
    pairs,
    unhedged,
    primaryRhAcc,
    primaryCoreAcc,
    rhTrades.length,
    coreTrades.length,
    resolvedRhIndices,
    resolvedCoreIndices,
  );

  return { pairs, unhedged, metrics };
}

function calculateHedgeMetrics(
  pairs: HedgePair[],
  unhedged: UnhedgedTrade[],
  rhAccountIndex: number | null,
  coreAccountIndex: number | null,
  rhTotalTrades: number,
  coreTotalTrades: number,
  rhAccountIndices?: number[],
  coreAccountIndices?: number[],
): HedgeSummaryMetrics {
  let totalHedgedVolumeUsd = 0;
  let totalNetPnlUsd = 0;
  let totalPricePnlUsd = 0;
  let totalFeesUsd = 0;
  let bestPairPnlUsd = pairs.length > 0 ? -Infinity : 0;
  let worstPairPnlUsd = pairs.length > 0 ? Infinity : 0;
  let firstTradeTime: number | null = null;
  let lastTradeTime: number | null = null;

  for (const p of pairs) {
    totalHedgedVolumeUsd += p.notionalUsd;
    totalNetPnlUsd += p.netPnlUsd;
    totalPricePnlUsd += p.pricePnlUsd;
    totalFeesUsd += p.totalFeesUsd;

    if (p.netPnlUsd > bestPairPnlUsd) bestPairPnlUsd = p.netPnlUsd;
    if (p.netPnlUsd < worstPairPnlUsd) worstPairPnlUsd = p.netPnlUsd;

    if (firstTradeTime === null || p.rhTimestampMs < firstTradeTime) {
      firstTradeTime = p.rhTimestampMs;
    }
    if (lastTradeTime === null || p.rhTimestampMs > lastTradeTime) {
      lastTradeTime = p.rhTimestampMs;
    }
  }

  if (pairs.length === 0) {
    bestPairPnlUsd = 0;
    worstPairPnlUsd = 0;
  }

  let unhedgedVolumeUsd = 0;
  let unhedgedRhCount = 0;
  let unhedgedCoreCount = 0;

  for (const u of unhedged) {
    unhedgedVolumeUsd += u.usdValue;
    totalFeesUsd += u.feeUsd; // Include unhedged trades' fees in total fees
    if (u.network === "RH") unhedgedRhCount++;
    else unhedgedCoreCount++;

    if (firstTradeTime === null || u.timestampMs < firstTradeTime) {
      firstTradeTime = u.timestampMs;
    }
    if (lastTradeTime === null || u.timestampMs > lastTradeTime) {
      lastTradeTime = u.timestampMs;
    }
  }

  const avgPnlBps = totalHedgedVolumeUsd > 0 ? (totalNetPnlUsd / totalHedgedVolumeUsd) * 10000 : 0;

  return {
    totalPairs: pairs.length,
    totalHedgedVolumeUsd,
    totalNetPnlUsd,
    totalPricePnlUsd,
    totalFeesUsd,
    avgPnlBps,
    bestPairPnlUsd,
    worstPairPnlUsd,
    totalUnhedgedTrades: unhedged.length,
    unhedgedVolumeUsd,
    unhedgedRhCount,
    unhedgedCoreCount,
    rhAccountIndex,
    coreAccountIndex,
    rhAccountIndices,
    coreAccountIndices,
    rhTotalTrades,
    coreTotalTrades,
    firstTradeTime,
    lastTradeTime,
  };
}

/**
 * Calculates aggregate summary metrics for a user-selected subset of hedge pairs and unhedged trades.
 */
export function calculateSelectedHedgeMetrics(
  selectedPairs: HedgePair[],
  selectedUnhedged: UnhedgedTrade[],
): SelectedHedgeMetrics {
  let totalHedgedVolumeUsd = 0;
  let unhedgedVolumeUsd = 0;
  let totalNetPnlUsd = 0;
  let totalPricePnlUsd = 0;
  let totalFeesUsd = 0;

  for (const p of selectedPairs) {
    totalHedgedVolumeUsd += p.notionalUsd;
    totalNetPnlUsd += p.netPnlUsd;
    totalPricePnlUsd += p.pricePnlUsd;
    totalFeesUsd += p.totalFeesUsd;
  }

  for (const u of selectedUnhedged) {
    unhedgedVolumeUsd += u.usdValue;
    totalFeesUsd += u.feeUsd;
    totalNetPnlUsd -= u.feeUsd;
  }

  const totalVolumeUsd = totalHedgedVolumeUsd + unhedgedVolumeUsd;
  const avgPnlBps = totalVolumeUsd > 0 ? (totalNetPnlUsd / totalVolumeUsd) * 10000 : 0;

  return {
    selectedCount: selectedPairs.length + selectedUnhedged.length,
    pairsCount: selectedPairs.length,
    unhedgedCount: selectedUnhedged.length,
    totalVolumeUsd,
    totalNetPnlUsd,
    totalPricePnlUsd,
    totalFeesUsd,
    avgPnlBps,
  };
}

/**
 * Computes the updated set of selected row IDs when performing a Shift-range selection in the hedge table.
 *
 * @param visibleIds - The ordered array of row IDs currently visible in the table.
 * @param anchorId - The starting anchor row ID of the selection.
 * @param targetId - The row ID where the user Shift-clicked.
 * @param baseSnapshot - The snapshot of selected IDs before the range operation began.
 * @param shouldSelect - True to select the range, false to deselect the range.
 * @returns An object with newSelectedIds and newAnchorId.
 */
export function computeRangeSelection(
  visibleIds: string[],
  anchorId: string | null,
  targetId: string,
  baseSnapshot: Set<string>,
  shouldSelect = true,
): { newSelectedIds: Set<string>; newAnchorId: string } {
  const targetIndex = visibleIds.indexOf(targetId);
  if (targetIndex === -1) {
    return { newSelectedIds: new Set(baseSnapshot), newAnchorId: anchorId ?? targetId };
  }

  if (!anchorId) {
    const next = new Set(baseSnapshot);
    if (shouldSelect) {
      next.add(targetId);
    } else {
      next.delete(targetId);
    }
    return { newSelectedIds: next, newAnchorId: targetId };
  }

  const anchorIndex = visibleIds.indexOf(anchorId);
  if (anchorIndex === -1) {
    const next = new Set(baseSnapshot);
    if (shouldSelect) {
      next.add(targetId);
    } else {
      next.delete(targetId);
    }
    return { newSelectedIds: next, newAnchorId: targetId };
  }

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const next = new Set(baseSnapshot);

  for (let i = start; i <= end; i++) {
    const id = visibleIds[i];
    if (shouldSelect) {
      next.add(id);
    } else {
      next.delete(id);
    }
  }

  return { newSelectedIds: next, newAnchorId: anchorId };
}

/**
 * Exports hedge analysis pairs to CSV string for download / spreadsheet audit.
 */
export function exportHedgeReportToCsv(pairs: HedgePair[], unhedged: UnhedgedTrade[]): string {
  const headers = [
    "Pair ID",
    "Time RH (UTC)",
    "Time Core (UTC)",
    "Market",
    "RH Side",
    "Core Side",
    "Matched Size",
    "RH Price",
    "Core Price",
    "RH Fills",
    "Core Fills",
    "Price Delta",
    "Notional USD",
    "Slippage PnL USD",
    "RH Fee USD",
    "Core Fee USD",
    "Total Fees USD",
    "Net PnL USD",
    "Hedge PnL (bps)",
    "Time Delta Sec",
    "Status",
    "RH Trade ID",
    "Core Trade ID",
  ];

  const rows: string[] = [headers.join(",")];

  for (const p of pairs) {
    rows.push(
      [
        p.id,
        p.rhTimeFormatted,
        p.coreTimeFormatted,
        p.marketSymbol,
        p.rhSide,
        p.coreSide,
        p.matchedSize.toFixed(4),
        p.rhPrice.toFixed(4),
        p.corePrice.toFixed(4),
        (p.rhFillsCount ?? 1).toString(),
        (p.coreFillsCount ?? 1).toString(),
        p.priceDelta.toFixed(4),
        p.notionalUsd.toFixed(2),
        p.pricePnlUsd.toFixed(4),
        p.rhFeeUsd.toFixed(4),
        p.coreFeeUsd.toFixed(4),
        p.totalFeesUsd.toFixed(4),
        p.netPnlUsd.toFixed(4),
        p.pnlBps.toFixed(2),
        p.timeDeltaSec.toFixed(2),
        p.status,
        p.rhTradeId,
        p.coreTradeId,
      ].join(","),
    );
  }

  for (const u of unhedged) {
    const isRh = u.network === "RH";
    rows.push(
      [
        `unhedged-${u.network}-${u.tradeId}`,
        isRh ? u.timeFormatted : "--",
        !isRh ? u.timeFormatted : "--",
        u.marketSymbol,
        isRh ? u.side : "--",
        !isRh ? u.side : "--",
        u.unhedgedSize.toFixed(4),
        isRh ? u.price.toFixed(4) : "--",
        !isRh ? u.price.toFixed(4) : "--",
        isRh ? (u.fillsCount ?? 1).toString() : "--",
        !isRh ? (u.fillsCount ?? 1).toString() : "--",
        "--",
        u.usdValue.toFixed(2),
        "--",
        isRh ? u.feeUsd.toFixed(4) : "0.0000",
        !isRh ? u.feeUsd.toFixed(4) : "0.0000",
        u.feeUsd.toFixed(4),
        "--",
        "--",
        "--",
        `UNHEDGED (${u.network})`,
        isRh ? u.tradeId : "--",
        !isRh ? u.tradeId : "--",
      ].join(","),
    );
  }

  return rows.join("\n");
}
