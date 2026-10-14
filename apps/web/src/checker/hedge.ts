import type {
  AccountAverageOiResult,
  AccountDailyStat,
  HedgeMatchingResult,
  HedgePair,
  HedgeSummaryMetrics,
  MarketSummarySortColumn,
  MarketSummaryStat,
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
    let totalFundingUsd: number | null = null;
    let hasGroupFunding = false;

    for (const fill of group) {
      totalSize += fill.size;
      totalUsdValue += fill.usdValue;
      totalRealizedPnl += fill.realizedPnl;
      totalFeeUsd += fill.feeUsd;
      if (fill.fundingUsd !== null && fill.fundingUsd !== undefined) {
        totalFundingUsd = (totalFundingUsd || 0) + fill.fundingUsd;
        hasGroupFunding = true;
      }
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
      fundingUsd: hasGroupFunding ? totalFundingUsd : null,
      txHash: leadTrade.txHash,
      txHashShort: leadTrade.txHashShort,
      fillsCount: group.length,
      tradeIdNum: leadTrade.tradeIdNum ?? (Number(leadTrade.tradeId) || 0),
      searchIndex:
        `${leadTrade.marketSymbol} ${leadTrade.side} ${leadTrade.role} ${combinedTradeId} ${leadTrade.txHash}`.toLowerCase(),
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

        // Pro-rated funding based on matched size
        const rhHasFunding =
          rhItem.trade.fundingUsd !== null && rhItem.trade.fundingUsd !== undefined;
        const coreHasFunding =
          bestCandidate.trade.fundingUsd !== null && bestCandidate.trade.fundingUsd !== undefined;

        const rhFundingPro =
          rhHasFunding && rhItem.trade.size > 0
            ? (rhItem.trade.fundingUsd! / rhItem.trade.size) * matchedSize
            : null;
        const coreFundingPro =
          coreHasFunding && bestCandidate.trade.size > 0
            ? (bestCandidate.trade.fundingUsd! / bestCandidate.trade.size) * matchedSize
            : null;
        const totalFundingUsd =
          rhFundingPro !== null || coreFundingPro !== null
            ? (rhFundingPro || 0) + (coreFundingPro || 0)
            : null;

        // Net PnL in USD (positive = profit, negative = loss): Slippage + Funding - Fees
        const netPnlUsd = pricePnlUsd + (totalFundingUsd ?? 0) - totalFeesUsd;

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
          rhFundingUsd: rhFundingPro,
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
          coreFundingUsd: coreFundingPro,
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
          totalFundingUsd,
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
          fundingUsd:
            rhItem.trade.fundingUsd !== null &&
            rhItem.trade.fundingUsd !== undefined &&
            rhItem.trade.size > 0
              ? (rhItem.trade.fundingUsd / rhItem.trade.size) * rhItem.remainingSize
              : null,
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
          fundingUsd:
            coreItem.trade.fundingUsd !== null &&
            coreItem.trade.fundingUsd !== undefined &&
            coreItem.trade.size > 0
              ? (coreItem.trade.fundingUsd / coreItem.trade.size) * coreItem.remainingSize
              : null,
          timestampMs: coreItem.trade.timestampMs,
          timeFormatted: coreItem.trade.timeFormatted,
          txHash: coreItem.trade.txHash,
          fillsCount: coreItem.trade.fillsCount ?? 1,
          searchIndex:
            `${market} ${coreItem.trade.side} CORE ${coreItem.trade.tradeId}`.toLowerCase(),
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

export function calculateHedgeMetrics(
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
  let rhTotalFundingUsd: number | null = null;
  let coreTotalFundingUsd: number | null = null;
  let totalFundingUsd: number | null = null;
  let hasAnyFunding = false;
  let bestPairPnlUsd = pairs.length > 0 ? -Infinity : 0;
  let worstPairPnlUsd = pairs.length > 0 ? Infinity : 0;
  let firstTradeTime: number | null = null;
  let lastTradeTime: number | null = null;

  for (const p of pairs) {
    totalHedgedVolumeUsd += p.notionalUsd;
    totalNetPnlUsd += p.netPnlUsd;
    totalPricePnlUsd += p.pricePnlUsd;
    totalFeesUsd += p.totalFeesUsd;
    if (p.rhFundingUsd !== null && p.rhFundingUsd !== undefined) {
      rhTotalFundingUsd = (rhTotalFundingUsd || 0) + p.rhFundingUsd;
      hasAnyFunding = true;
    }
    if (p.coreFundingUsd !== null && p.coreFundingUsd !== undefined) {
      coreTotalFundingUsd = (coreTotalFundingUsd || 0) + p.coreFundingUsd;
      hasAnyFunding = true;
    }
    if (p.totalFundingUsd !== null && p.totalFundingUsd !== undefined) {
      totalFundingUsd = (totalFundingUsd || 0) + p.totalFundingUsd;
      hasAnyFunding = true;
    }

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
    if (u.fundingUsd !== null && u.fundingUsd !== undefined) {
      hasAnyFunding = true;
      totalFundingUsd = (totalFundingUsd || 0) + u.fundingUsd;
      if (u.network === "RH") {
        rhTotalFundingUsd = (rhTotalFundingUsd || 0) + u.fundingUsd;
      } else {
        coreTotalFundingUsd = (coreTotalFundingUsd || 0) + u.fundingUsd;
      }
    }
    if (u.network === "RH") {
      unhedgedRhCount++;
    } else {
      unhedgedCoreCount++;
    }

    if (firstTradeTime === null || u.timestampMs < firstTradeTime) {
      firstTradeTime = u.timestampMs;
    }
    if (lastTradeTime === null || u.timestampMs > lastTradeTime) {
      lastTradeTime = u.timestampMs;
    }
  }

  // Total Net PnL = Slippage (price delta PnL) + Funding - Fees
  const totalFundingComponent = hasAnyFunding && totalFundingUsd !== null ? totalFundingUsd : 0;
  totalNetPnlUsd = totalPricePnlUsd + totalFundingComponent - totalFeesUsd;

  const avgPnlBps = totalHedgedVolumeUsd > 0 ? (totalNetPnlUsd / totalHedgedVolumeUsd) * 10000 : 0;

  return {
    totalPairs: pairs.length,
    totalHedgedVolumeUsd,
    totalNetPnlUsd,
    totalPricePnlUsd,
    totalFeesUsd,
    totalFundingUsd: hasAnyFunding ? totalFundingUsd : null,
    rhTotalFundingUsd: hasAnyFunding ? rhTotalFundingUsd : null,
    coreTotalFundingUsd: hasAnyFunding ? coreTotalFundingUsd : null,
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
  let totalFundingUsd: number | null = null;
  let hasSelectedFunding = false;
  let totalMatchedSize = 0;
  let totalBuyProduct = 0;
  let totalSellProduct = 0;
  let totalWeightedDeltaProduct = 0;

  const marketsSet = new Set<string>();

  for (const p of selectedPairs) {
    totalHedgedVolumeUsd += p.notionalUsd;
    totalNetPnlUsd += p.netPnlUsd;
    totalPricePnlUsd += p.pricePnlUsd;
    totalFeesUsd += p.totalFeesUsd;
    if (p.totalFundingUsd !== null && p.totalFundingUsd !== undefined) {
      totalFundingUsd = (totalFundingUsd || 0) + p.totalFundingUsd;
      hasSelectedFunding = true;
    }
    totalMatchedSize += p.matchedSize;
    totalBuyProduct += p.buyPrice * p.matchedSize;
    totalSellProduct += p.sellPrice * p.matchedSize;
    totalWeightedDeltaProduct += p.priceDelta * p.matchedSize;
    if (p.marketSymbol) {
      marketsSet.add(p.marketSymbol.toUpperCase());
    }
  }

  for (const u of selectedUnhedged) {
    unhedgedVolumeUsd += u.usdValue;
    totalFeesUsd += u.feeUsd;
    if (u.fundingUsd !== null && u.fundingUsd !== undefined) {
      totalFundingUsd = (totalFundingUsd || 0) + u.fundingUsd;
      hasSelectedFunding = true;
    }
  }

  // Total Net PnL = Slippage + Funding - Fees
  const selectedFundingComponent =
    hasSelectedFunding && totalFundingUsd !== null ? totalFundingUsd : 0;
  totalNetPnlUsd = totalPricePnlUsd + selectedFundingComponent - totalFeesUsd;

  const totalVolumeUsd = totalHedgedVolumeUsd + unhedgedVolumeUsd;
  const avgPnlBps = totalVolumeUsd > 0 ? (totalNetPnlUsd / totalVolumeUsd) * 10000 : 0;

  const weightedPriceDelta =
    totalMatchedSize > 0 ? totalWeightedDeltaProduct / totalMatchedSize : 0;
  const weightedPriceDeltaBps =
    totalHedgedVolumeUsd > 0 ? (totalPricePnlUsd / totalHedgedVolumeUsd) * 10000 : 0;
  const weightedBuyPrice = totalMatchedSize > 0 ? totalBuyProduct / totalMatchedSize : 0;
  const weightedSellPrice = totalMatchedSize > 0 ? totalSellProduct / totalMatchedSize : 0;

  const isSingleMarket = marketsSet.size === 1;
  const marketSymbol = isSingleMarket ? Array.from(marketsSet)[0] : undefined;

  return {
    selectedCount: selectedPairs.length + selectedUnhedged.length,
    pairsCount: selectedPairs.length,
    unhedgedCount: selectedUnhedged.length,
    totalVolumeUsd,
    totalNetPnlUsd,
    totalPricePnlUsd,
    totalFeesUsd,
    totalFundingUsd,
    avgPnlBps,
    totalMatchedSize,
    weightedPriceDelta,
    weightedPriceDeltaBps,
    weightedBuyPrice,
    weightedSellPrice,
    isSingleMarket,
    marketSymbol,
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
    "RH Funding USD",
    "Core Funding USD",
    "Total Funding USD",
    "Net PnL USD",
    "Hedge PnL (bps)",
    "Time Delta Sec",
    "Status",
    "RH Trade ID",
    "Core Trade ID",
  ];

  const rows: string[] = [headers.join(",")];

  for (const p of pairs) {
    const rhFills = p.rhFillsCount ?? 1;
    const coreFills = p.coreFillsCount ?? 1;
    const rhFunding = p.rhFundingUsd != null ? p.rhFundingUsd.toFixed(4) : "--";
    const coreFunding = p.coreFundingUsd != null ? p.coreFundingUsd.toFixed(4) : "--";
    const totalFunding = p.totalFundingUsd != null ? p.totalFundingUsd.toFixed(4) : "--";
    rows.push(
      `${p.id},${p.rhTimeFormatted},${p.coreTimeFormatted},${p.marketSymbol},${p.rhSide},${p.coreSide},${p.matchedSize.toFixed(4)},${p.rhPrice.toFixed(4)},${p.corePrice.toFixed(4)},${rhFills},${coreFills},${p.priceDelta.toFixed(4)},${p.notionalUsd.toFixed(2)},${p.pricePnlUsd.toFixed(4)},${p.rhFeeUsd.toFixed(4)},${p.coreFeeUsd.toFixed(4)},${p.totalFeesUsd.toFixed(4)},${rhFunding},${coreFunding},${totalFunding},${p.netPnlUsd.toFixed(4)},${p.pnlBps.toFixed(2)},${p.timeDeltaSec.toFixed(2)},${p.status},${p.rhTradeId},${p.coreTradeId}`,
    );
  }

  for (const u of unhedged) {
    const isRh = u.network === "RH";
    const rhTime = isRh ? u.timeFormatted : "--";
    const coreTime = !isRh ? u.timeFormatted : "--";
    const rhSide = isRh ? u.side : "--";
    const coreSide = !isRh ? u.side : "--";
    const rhPrice = isRh ? u.price.toFixed(4) : "--";
    const corePrice = !isRh ? u.price.toFixed(4) : "--";
    const rhFills = isRh ? (u.fillsCount ?? 1).toString() : "--";
    const coreFills = !isRh ? (u.fillsCount ?? 1).toString() : "--";
    const rhFee = isRh ? u.feeUsd.toFixed(4) : "0.0000";
    const coreFee = !isRh ? u.feeUsd.toFixed(4) : "0.0000";
    const totalFee = u.feeUsd.toFixed(4);
    const rhFunding = isRh && u.fundingUsd != null ? u.fundingUsd.toFixed(4) : "--";
    const coreFunding = !isRh && u.fundingUsd != null ? u.fundingUsd.toFixed(4) : "--";
    const totalFunding = u.fundingUsd != null ? u.fundingUsd.toFixed(4) : "--";
    const rhTradeId = isRh ? u.tradeId : "--";
    const coreTradeId = !isRh ? u.tradeId : "--";
    rows.push(
      `unhedged-${u.network}-${u.tradeId},${rhTime},${coreTime},${u.marketSymbol},${rhSide},${coreSide},${u.unhedgedSize.toFixed(4)},${rhPrice},${corePrice},${rhFills},${coreFills},--,${u.usdValue.toFixed(2)},--,${rhFee},${coreFee},${totalFee},${rhFunding},${coreFunding},${totalFunding},--,--,--,UNHEDGED (${u.network}),${rhTradeId},${coreTradeId}`,
    );
  }

  return rows.join("\n");
}

/**
 * Calculates the Time-Weighted Average Open Interest (TWAOI) for a set of account trades.
 *
 * Accurately tracks perpetual positions across markets and subaccounts over time:
 * - Scale-in (adding to position in same direction): updates volume-weighted average entry price (VWAP)
 * - Scale-out (partial close): reduces position size while preserving existing entry price
 * - Full close: resets position and entry price to 0
 * - Flips (crossing zero from Long to Short or vice versa): closes previous position and opens remainder at trade price
 * - Models open interest notional (|pos| * entryPrice) as a piecewise-constant step function
 * - Integrates over the specified date filter range (or entire active history)
 *
 * @param allTrades - Complete chronological history of trades for the account.
 * @param dateFilter - Optional active date filter (preset or custom range).
 * @param nowMs - Current timestamp in milliseconds (defaults to Date.now()).
 */
export function calculateAccountAverageOi(
  allTrades: ParsedTradeView[],
  dateFilter: {
    startTimestampMs: number | null;
    endTimestampMs: number | null;
    presetId?: string;
  } | null,
  nowMs = Date.now(),
): AccountAverageOiResult {
  if (allTrades.length === 0) {
    return {
      avgOiUsd: 0,
      currentOpenOiUsd: 0,
      holdingDurationMs: 0,
      periodDurationMs: 0,
    };
  }

  // Filter out spot trades if any (open interest only applies to perpetual contracts)
  const perpTrades = allTrades.filter(
    (t) =>
      (!t.marketKind || t.marketKind !== "spot") &&
      t.timestampMs >= 0 &&
      !isNaN(t.timestampMs) &&
      t.size > 0 &&
      t.price > 0,
  );

  if (perpTrades.length === 0) {
    return {
      avgOiUsd: 0,
      currentOpenOiUsd: 0,
      holdingDurationMs: 0,
      periodDurationMs: 0,
    };
  }

  // Sort chronologically ascending (earliest to latest)
  const sortedTrades = perpTrades.toSorted((a, b) => {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    const aMicro = a.raw?.transaction_time ?? 0;
    const bMicro = b.raw?.transaction_time ?? 0;
    if (aMicro !== bMicro) return aMicro - bMicro;
    const aId = a.tradeIdNum ?? (Number(a.tradeId) || 0);
    const bId = b.tradeIdNum ?? (Number(b.tradeId) || 0);
    return aId - bId;
  });

  const earliestTradeMs = sortedTrades[0].timestampMs;
  const latestTradeMs = sortedTrades[sortedTrades.length - 1].timestampMs;

  // Group trades by subaccount and market to prevent cross-account position offsetting
  const marketAccountGroups = new Map<string, ParsedTradeView[]>();
  for (const t of sortedTrades) {
    const key = `${t.userAccountId ?? "default"}_${t.marketId ?? t.marketSymbol}`;
    let list = marketAccountGroups.get(key);
    if (!list) {
      list = [];
      marketAccountGroups.set(key, list);
    }
    list.push(t);
  }

  interface TimelineSegment {
    startTime: number;
    endTime: number;
    oi: number;
  }

  const allSegments: TimelineSegment[] = [];
  let totalCurrentOpenOi = 0;
  const EPSILON = 1e-8;

  // Replay trade history for each subaccount/market pair
  for (const groupTrades of marketAccountGroups.values()) {
    let pos = 0;
    let entryPrice = 0;
    let currentOi = 0;
    let lastTime = groupTrades[0].timestampMs;

    for (const t of groupTrades) {
      const tTime = t.timestampMs;
      const size = Math.abs(t.size);
      const price = Math.abs(t.price);
      const isBuy = t.side === "BUY";
      const delta = isBuy ? size : -size;

      // Close previous segment if time has advanced and we had positive open interest
      if (tTime > lastTime) {
        if (currentOi > 0) {
          allSegments.push({
            startTime: lastTime,
            endTime: tTime,
            oi: currentOi,
          });
        }
      }

      const prevPos = pos;
      const newPos = pos + delta;

      if (Math.abs(newPos) <= EPSILON) {
        // Complete position closure
        pos = 0;
        entryPrice = 0;
      } else if (Math.abs(prevPos) <= EPSILON) {
        // Position opened from flat
        pos = newPos;
        entryPrice = price;
      } else if ((prevPos > 0 && delta > 0) || (prevPos < 0 && delta < 0)) {
        // Adding to position in the same direction: update VWAP entry price
        const totalSize = Math.abs(newPos);
        entryPrice = (Math.abs(prevPos) * entryPrice + size * price) / totalSize;
        pos = newPos;
      } else {
        // Opposite direction (scale-out / reduction or flip)
        if ((prevPos > 0 && newPos > 0) || (prevPos < 0 && newPos < 0)) {
          // Partial close: entry price remains unchanged for remaining contracts
          pos = newPos;
        } else {
          // Flipped position: remainder opened in opposite direction at current trade price
          pos = newPos;
          entryPrice = price;
        }
      }

      currentOi = Math.abs(pos) * entryPrice;
      lastTime = tTime;
    }

    // If position remains open after all trades, it stays open into the future
    if (currentOi > 0) {
      totalCurrentOpenOi += currentOi;
      allSegments.push({
        startTime: lastTime,
        endTime: Infinity,
        oi: currentOi,
      });
    }
  }

  // Determine time interval boundaries [T_start, T_end]
  let tStart: number;
  let tEnd: number;

  const isSpecificFilter = Boolean(dateFilter && dateFilter.presetId !== "all");

  if (isSpecificFilter) {
    tStart = dateFilter!.startTimestampMs ?? earliestTradeMs;
    tEnd = dateFilter!.endTimestampMs ?? Math.max(latestTradeMs, nowMs);
  } else {
    tStart = earliestTradeMs;
    if (totalCurrentOpenOi > 0) {
      tEnd = Math.max(latestTradeMs, nowMs);
    } else {
      tEnd = latestTradeMs;
    }
  }

  const isFutureEnd = isSpecificFilter && tEnd > nowMs;
  const effectiveEnd = isFutureEnd ? Math.max(tStart, Math.min(tEnd, nowMs)) : tEnd;
  const periodDurationMs = Math.max(0, effectiveEnd - tStart);

  if (periodDurationMs <= 0) {
    return {
      avgOiUsd: totalCurrentOpenOi,
      currentOpenOiUsd: totalCurrentOpenOi,
      holdingDurationMs: 0,
      periodDurationMs: 0,
      projectedFullPeriodAvgOiUsd: totalCurrentOpenOi,
    };
  }

  let totalIntegral = 0;
  let holdingDurationMs = 0;

  for (const seg of allSegments) {
    if (seg.oi <= 0) continue;
    const overlapStart = Math.max(seg.startTime, tStart);
    const overlapEnd = Math.min(seg.endTime, effectiveEnd);
    if (overlapEnd > overlapStart) {
      const dur = overlapEnd - overlapStart;
      totalIntegral += seg.oi * dur;
      holdingDurationMs += dur;
    }
  }

  const avgOiUsd = totalIntegral / periodDurationMs;

  let projectedFullPeriodAvgOiUsd: number | undefined = undefined;
  if (isFutureEnd) {
    const fullDuration = tEnd - tStart;
    if (fullDuration > 0) {
      const remainingTime = Math.max(0, tEnd - effectiveEnd);
      const projectedIntegral = totalIntegral + totalCurrentOpenOi * remainingTime;
      projectedFullPeriodAvgOiUsd = projectedIntegral / fullDuration;
    }
  }

  return {
    avgOiUsd,
    currentOpenOiUsd: totalCurrentOpenOi,
    holdingDurationMs,
    periodDurationMs,
    projectedFullPeriodAvgOiUsd,
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Calculates day-by-day metrics (trades count, volume, average holding time, pnl, fees)
 * for an account across the active period.
 */
export function calculateAccountDailyStats(
  allTrades: ParsedTradeView[],
  dateFilter?: {
    startTimestampMs?: number | null;
    endTimestampMs?: number | null;
    presetId?: string;
  } | null,
  nowMs = Date.now(),
): AccountDailyStat[] {
  // Filter out spot trades if any (open interest & position duration apply to perps)
  const perpTrades = allTrades.filter(
    (t) =>
      (!t.marketKind || t.marketKind !== "spot") &&
      t.timestampMs >= 0 &&
      !isNaN(t.timestampMs) &&
      t.size > 0 &&
      t.price > 0,
  );

  let tStart: number;
  let tEnd: number;

  const isSpecificFilter = Boolean(dateFilter && dateFilter.presetId !== "all");

  if (isSpecificFilter) {
    tStart =
      dateFilter!.startTimestampMs ??
      (perpTrades.length > 0
        ? Math.min(...perpTrades.map((t) => t.timestampMs))
        : nowMs - 7 * MS_PER_DAY);
    tEnd = dateFilter!.endTimestampMs ?? Math.max(tStart + 7 * MS_PER_DAY, nowMs);
  } else {
    if (perpTrades.length > 0) {
      tStart = Math.min(...perpTrades.map((t) => t.timestampMs));
      tEnd = Math.max(...perpTrades.map((t) => t.timestampMs));
    } else {
      tStart = nowMs - 7 * MS_PER_DAY;
      tEnd = nowMs;
    }
  }

  // Normalize to UTC midnight boundaries
  const startObj = new Date(tStart);
  const startDayMs = Date.UTC(
    startObj.getUTCFullYear(),
    startObj.getUTCMonth(),
    startObj.getUTCDate(),
  );

  const endObj = new Date(tEnd);
  let endDayMs = Date.UTC(endObj.getUTCFullYear(), endObj.getUTCMonth(), endObj.getUTCDate());
  if (tEnd > endDayMs || tEnd === tStart) {
    endDayMs += MS_PER_DAY;
  }

  const daySpan = Math.max(1, Math.round((endDayMs - startDayMs) / MS_PER_DAY));

  const candidateDayStarts: number[] = [];
  if (daySpan <= 14 || isSpecificFilter) {
    for (let dayMs = startDayMs; dayMs < endDayMs; dayMs += MS_PER_DAY) {
      candidateDayStarts.push(dayMs);
    }
  } else {
    const daysSet = new Set<number>();
    for (const t of perpTrades) {
      const d = new Date(t.timestampMs);
      const dMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      daysSet.add(dMs);
    }
    const sortedDays = Array.from(daysSet).toSorted((a, b) => a - b);
    if (sortedDays.length > 0) {
      candidateDayStarts.push(...sortedDays);
    } else {
      for (let dayMs = endDayMs - 7 * MS_PER_DAY; dayMs < endDayMs; dayMs += MS_PER_DAY) {
        candidateDayStarts.push(dayMs);
      }
    }
  }

  // Sort chronologically ascending
  const sortedTrades = perpTrades.toSorted((a, b) => {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    const aMicro = a.raw?.transaction_time ?? 0;
    const bMicro = b.raw?.transaction_time ?? 0;
    if (aMicro !== bMicro) return aMicro - bMicro;
    const aId = a.tradeIdNum ?? (Number(a.tradeId) || 0);
    const bId = b.tradeIdNum ?? (Number(b.tradeId) || 0);
    return aId - bId;
  });

  // Group by subaccount and market to prevent cross-account position offsetting
  const marketAccountGroups = new Map<string, ParsedTradeView[]>();
  for (const t of sortedTrades) {
    const key = `${t.userAccountId ?? "default"}_${t.marketId ?? t.marketSymbol}`;
    let list = marketAccountGroups.get(key);
    if (!list) {
      list = [];
      marketAccountGroups.set(key, list);
    }
    list.push(t);
  }

  const EPSILON = 1e-8;

  interface HoldingInterval {
    start: number;
    end: number;
  }
  const allHoldingIntervals: HoldingInterval[] = [];

  for (const groupTrades of marketAccountGroups.values()) {
    let pos = 0;
    let posOpenTime = 0;

    for (const t of groupTrades) {
      const prevPos = pos;
      const size = Math.abs(t.size);
      const delta = t.side === "BUY" ? size : -size;
      const newPos = prevPos + delta;

      if (Math.abs(prevPos) <= EPSILON && Math.abs(newPos) > EPSILON) {
        // Opened from flat
        posOpenTime = t.timestampMs;
      } else if (Math.abs(prevPos) > EPSILON && Math.abs(newPos) <= EPSILON) {
        // Closed to flat
        if (t.timestampMs > posOpenTime) {
          allHoldingIntervals.push({ start: posOpenTime, end: t.timestampMs });
        }
        posOpenTime = 0;
      } else if ((prevPos > 0 && newPos < 0) || (prevPos < 0 && newPos > 0)) {
        // Flipped position
        if (t.timestampMs > posOpenTime) {
          allHoldingIntervals.push({ start: posOpenTime, end: t.timestampMs });
        }
        posOpenTime = t.timestampMs;
      }

      pos = newPos;
    }

    if (Math.abs(pos) > EPSILON && posOpenTime > 0) {
      allHoldingIntervals.push({ start: posOpenTime, end: Infinity });
    }
  }

  return candidateDayStarts.map((dayStartMs) => {
    const dayEndMs = dayStartMs + MS_PER_DAY;
    const dateObj = new Date(dayStartMs);

    const dayOfWeek = DAY_NAMES[dateObj.getUTCDay()];
    const shortDate = `${pad2(dateObj.getUTCDate())}/${pad2(dateObj.getUTCMonth() + 1)}`;
    const dateFormatted = `${dateObj.getUTCFullYear()}-${pad2(dateObj.getUTCMonth() + 1)}-${pad2(dateObj.getUTCDate())}`;

    const dayTrades = perpTrades.filter(
      (t) => t.timestampMs >= dayStartMs && t.timestampMs < dayEndMs,
    );

    let totalVolumeUsd = 0;
    let realizedPnlUsd = 0;
    let totalFeesUsd = 0;

    for (const t of dayTrades) {
      totalVolumeUsd += t.usdValue;
      realizedPnlUsd += t.realizedPnl;
      totalFeesUsd += t.feeUsd;
    }

    // Determine holding duration during this specific 24-hour day
    const dayIntervals: HoldingInterval[] = [];
    const effectiveLimit = Math.min(dayEndMs, nowMs);

    for (const iv of allHoldingIntervals) {
      const start = Math.max(iv.start, dayStartMs);
      const end = Math.min(iv.end, effectiveLimit);
      if (end > start) {
        dayIntervals.push({ start, end });
      }
    }

    const sortedIntervals = dayIntervals.toSorted((a, b) => a.start - b.start);
    const merged: HoldingInterval[] = [];
    for (const iv of sortedIntervals) {
      if (merged.length === 0 || merged[merged.length - 1].end < iv.start) {
        merged.push({ start: iv.start, end: iv.end });
      } else {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, iv.end);
      }
    }

    let dayHoldingMs = 0;
    for (const m of merged) {
      dayHoldingMs += m.end - m.start;
    }
    const avgHoldingDurationMs = Math.min(dayHoldingMs, MS_PER_DAY);

    return {
      dateFormatted,
      dayOfWeek,
      shortDate,
      timestampMs: dayStartMs,
      tradesCount: dayTrades.length,
      totalVolumeUsd,
      avgHoldingDurationMs,
      realizedPnlUsd,
      totalFeesUsd,
    };
  });
}

/**
 * Calculates average position holding duration (in ms) for trades in a specific market.
 * Uses FIFO inventory matching between BUY and SELL executions per subaccount:
 * - When a position is reduced or closed, the holding duration (closeTime - openTime) is accumulated.
 * - If dateFilter is active, only matches/positions active within the date range are considered.
 * - If no closed trades exist in the period but open lots exist, open holding duration so far is used.
 */
export function calculateMarketHoldingDuration(
  trades: ParsedTradeView[],
  dateFilter?: {
    startTimestampMs?: number | null;
    endTimestampMs?: number | null;
    presetId?: string;
  } | null,
  nowMs = Date.now(),
): number {
  if (!trades || trades.length === 0) return 0;

  const validTrades = trades.filter(
    (t) => t.timestampMs >= 0 && !isNaN(t.timestampMs) && t.size > 0 && t.price > 0,
  );
  if (validTrades.length === 0) return 0;

  const sortedTrades = validTrades.toSorted((a, b) => {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    const aMicro = a.raw?.transaction_time ?? 0;
    const bMicro = b.raw?.transaction_time ?? 0;
    if (aMicro !== bMicro) return aMicro - bMicro;
    const aId = a.tradeIdNum ?? (Number(a.tradeId) || 0);
    const bId = b.tradeIdNum ?? (Number(b.tradeId) || 0);
    return aId - bId;
  });

  const isSpecificFilter = Boolean(dateFilter && dateFilter.presetId !== "all");
  const earliestMs = sortedTrades[0].timestampMs;
  const latestMs = sortedTrades[sortedTrades.length - 1].timestampMs;

  const tStart = isSpecificFilter ? (dateFilter!.startTimestampMs ?? earliestMs) : earliestMs;
  const tEnd = isSpecificFilter
    ? (dateFilter!.endTimestampMs ?? Math.max(latestMs, nowMs))
    : Math.max(latestMs, nowMs);

  const effectiveEnd = Math.min(tEnd, nowMs);
  const EPSILON = 1e-8;

  // Group trades by subaccount to avoid cross-subaccount position offsetting
  const subaccountGroups = new Map<string, ParsedTradeView[]>();
  for (const t of sortedTrades) {
    const accKey = String(t.userAccountId ?? "default");
    let list = subaccountGroups.get(accKey);
    if (!list) {
      list = [];
      subaccountGroups.set(accKey, list);
    }
    list.push(t);
  }

  interface Lot {
    size: number;
    timestampMs: number;
    side: "BUY" | "SELL";
  }

  let totalMatchedDurationWeighted = 0;
  let totalMatchedSize = 0;
  let totalOpenDurationWeighted = 0;
  let totalOpenSize = 0;

  for (const groupTrades of subaccountGroups.values()) {
    const lots: Lot[] = [];

    for (const t of groupTrades) {
      let remSize = Math.abs(t.size);

      // Match against opposite side inventory (FIFO)
      while (lots.length > 0 && lots[0].side !== t.side && remSize > EPSILON) {
        const head = lots[0];
        const matchSize = Math.min(remSize, head.size);
        const openTime = head.timestampMs;
        const closeTime = t.timestampMs;
        const dur = Math.max(0, closeTime - openTime);

        const inPeriod =
          (closeTime >= tStart && closeTime <= tEnd) ||
          (openTime >= tStart && openTime <= tEnd) ||
          (openTime < tStart && closeTime > tEnd);

        if (inPeriod) {
          totalMatchedDurationWeighted += matchSize * dur;
          totalMatchedSize += matchSize;
        }

        head.size -= matchSize;
        remSize -= matchSize;

        if (head.size <= EPSILON) {
          lots.shift();
        }
      }

      if (remSize > EPSILON) {
        lots.push({
          size: remSize,
          timestampMs: t.timestampMs,
          side: t.side,
        });
      }
    }

    // Process open lots for this subaccount
    for (const lot of lots) {
      if (lot.timestampMs <= effectiveEnd) {
        const openDur = Math.max(0, effectiveEnd - lot.timestampMs);
        totalOpenDurationWeighted += lot.size * openDur;
        totalOpenSize += lot.size;
      }
    }
  }

  if (totalMatchedSize > 0) {
    return Math.round(totalMatchedDurationWeighted / totalMatchedSize);
  }

  if (totalOpenSize > 0) {
    return Math.round(totalOpenDurationWeighted / totalOpenSize);
  }

  return 0;
}

/**
 * Groups hedge pairs and unhedged trades by token (market) for the active date period,
 * computing volume, transactions count, average holding duration, and average volume size.
 */
export function calculateMarketSummaryStats(
  pairs: HedgePair[],
  unhedged: UnhedgedTrade[],
  allRhTrades: ParsedTradeView[] = [],
  allCoreTrades: ParsedTradeView[] = [],
  dateFilter?: {
    startTimestampMs?: number | null;
    endTimestampMs?: number | null;
    presetId?: string;
  } | null,
  nowMs = Date.now(),
  sortColumn: MarketSummarySortColumn = "volumeUsd",
  sortDirection: "asc" | "desc" = "desc",
): MarketSummaryStat[] {
  const marketMap = new Map<
    string,
    {
      volumeUsd: number;
      pairsCount: number;
      unhedgedCount: number;
      totalTokenSize: number;
      realizedPnlUsd: number;
    }
  >();

  for (const p of pairs) {
    const sym = (p.marketSymbol || "UNKNOWN").toUpperCase();
    let m = marketMap.get(sym);
    if (!m) {
      m = { volumeUsd: 0, pairsCount: 0, unhedgedCount: 0, totalTokenSize: 0, realizedPnlUsd: 0 };
      marketMap.set(sym, m);
    }
    // Strictly Robinhood volume: matchedSize * rhPrice
    const rhPrice = p.rhPrice > 0 ? p.rhPrice : p.sellPrice || p.buyPrice || 0;
    m.volumeUsd += p.matchedSize * rhPrice;
    m.pairsCount++;
    m.totalTokenSize += p.matchedSize;
    m.realizedPnlUsd += p.netPnlUsd;
  }

  for (const u of unhedged) {
    // Only count Robinhood trades for volume & transaction counts
    if (u.network === "RH") {
      const sym = (u.marketSymbol || "UNKNOWN").toUpperCase();
      let m = marketMap.get(sym);
      if (!m) {
        m = { volumeUsd: 0, pairsCount: 0, unhedgedCount: 0, totalTokenSize: 0, realizedPnlUsd: 0 };
        marketMap.set(sym, m);
      }
      m.volumeUsd += u.usdValue;
      m.unhedgedCount++;
      m.totalTokenSize += u.unhedgedSize;
    }
  }

  // Pre-group trade histories by market symbol for holding duration calculation
  const rhByMarket = new Map<string, ParsedTradeView[]>();
  for (const t of allRhTrades) {
    const sym = (t.marketSymbol || `#${t.marketId}`).toUpperCase();
    let list = rhByMarket.get(sym);
    if (!list) {
      list = [];
      rhByMarket.set(sym, list);
    }
    list.push(t);
  }

  const coreByMarket = new Map<string, ParsedTradeView[]>();
  for (const t of allCoreTrades) {
    const sym = (t.marketSymbol || `#${t.marketId}`).toUpperCase();
    let list = coreByMarket.get(sym);
    if (!list) {
      list = [];
      coreByMarket.set(sym, list);
    }
    list.push(t);
  }

  const result: MarketSummaryStat[] = [];

  for (const [sym, data] of marketMap.entries()) {
    const transactionsCount = data.pairsCount + data.unhedgedCount;
    const avgVolumeSizeUsd = transactionsCount > 0 ? data.volumeUsd / transactionsCount : 0;
    const avgTokenSize = transactionsCount > 0 ? data.totalTokenSize / transactionsCount : 0;

    const rhTrades = rhByMarket.get(sym) || [];
    const coreTrades = coreByMarket.get(sym) || [];

    const rhHold =
      rhTrades.length > 0 ? calculateMarketHoldingDuration(rhTrades, dateFilter, nowMs) : 0;
    const coreHold =
      coreTrades.length > 0 ? calculateMarketHoldingDuration(coreTrades, dateFilter, nowMs) : 0;

    let avgHoldingDurationMs = 0;
    if (rhHold > 0 && coreHold > 0) {
      avgHoldingDurationMs = Math.round((rhHold + coreHold) / 2);
    } else {
      avgHoldingDurationMs = rhHold > 0 ? rhHold : coreHold;
    }

    result.push({
      marketSymbol: sym,
      volumeUsd: data.volumeUsd,
      transactionsCount,
      avgVolumeSizeUsd,
      avgHoldingDurationMs,
      pairsCount: data.pairsCount,
      unhedgedCount: data.unhedgedCount,
      totalTokenSize: data.totalTokenSize,
      avgTokenSize,
      realizedPnlUsd: data.realizedPnlUsd,
    });
  }

  return sortMarketSummaryStats(result, sortColumn, sortDirection);
}

/**
 * Sorts market summary statistics by the specified column and direction.
 * Defaults to volumeUsd descending.
 */
export function sortMarketSummaryStats(
  stats: MarketSummaryStat[],
  sortColumn: MarketSummarySortColumn = "volumeUsd",
  sortDirection: "asc" | "desc" = "desc",
): MarketSummaryStat[] {
  const dir = sortDirection === "asc" ? 1 : -1;

  return stats.toSorted((a, b) => {
    if (sortColumn === "marketSymbol") {
      return a.marketSymbol.localeCompare(b.marketSymbol) * dir;
    }
    const valA = (a[sortColumn] as number) || 0;
    const valB = (b[sortColumn] as number) || 0;
    if (Math.abs(valA - valB) > 0.00001) {
      return (valA - valB) * dir;
    }
    return a.marketSymbol.localeCompare(b.marketSymbol);
  });
}
