import type {
  HedgeMatchingResult,
  HedgePair,
  HedgeSummaryMetrics,
  ParsedTradeView,
  UnhedgedTrade,
} from "./types";

interface WorkingTrade {
  trade: ParsedTradeView;
  network: "RH" | "CORE";
  remainingSize: number;
}

/**
 * Matches trades executed on Robinhood (RH) with hedging trades executed on Core (Mainnet).
 *
 * Matching logic:
 * 1. Groups trades by marketSymbol (e.g. AAPL, BTC, ETH).
 * 2. Matches opposite sides (RH BUY <-> Core SELL; RH SELL <-> Core BUY).
 * 3. Matches closest trades in time within maxTimeDeltaSeconds window.
 * 4. Supports partial fill consumption if size differs.
 * 5. Flags any leftover quantity as UNHEDGED.
 */
export function matchHedgeTrades(
  rhTrades: ParsedTradeView[],
  coreTrades: ParsedTradeView[],
  rhAccountIndex: number | null,
  coreAccountIndex: number | null,
  maxTimeDeltaSeconds = 600,
): HedgeMatchingResult {
  const maxDeltaMs = maxTimeDeltaSeconds * 1000;

  // Clone with working mutable remaining sizes
  const rhWorking: WorkingTrade[] = rhTrades.map((t) => ({
    trade: t,
    network: "RH",
    remainingSize: t.size,
  }));

  const coreWorking: WorkingTrade[] = coreTrades.map((t) => ({
    trade: t,
    network: "CORE",
    remainingSize: t.size,
  }));

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

  for (const market of allMarkets) {
    const marketRh = (rhByMarket.get(market) || []).toSorted(
      (a, b) => a.trade.timestampMs - b.trade.timestampMs,
    );
    const marketCore = (coreByMarket.get(market) || []).toSorted(
      (a, b) => a.trade.timestampMs - b.trade.timestampMs,
    );

    for (const rhItem of marketRh) {
      if (rhItem.remainingSize <= 0.0000001) continue;

      // Find eligible Core candidates with opposite side and available size within maxDeltaMs
      while (rhItem.remainingSize > 0.0000001) {
        let bestCandidate: WorkingTrade | null = null;
        let minTimeDiff = Infinity;

        for (const candidate of marketCore) {
          if (candidate.remainingSize <= 0.0000001) continue;
          if (candidate.trade.side === rhItem.trade.side) continue; // Must be opposite side

          const timeDiff = Math.abs(candidate.trade.timestampMs - rhItem.trade.timestampMs);
          if (timeDiff <= maxDeltaMs && timeDiff < minTimeDiff) {
            minTimeDiff = timeDiff;
            bestCandidate = candidate;
          }
        }

        // If no matching core candidate found within window, stop and leave remainder as unhedged
        if (!bestCandidate) {
          break;
        }

        const matchedSize = Math.min(rhItem.remainingSize, bestCandidate.remainingSize);
        rhItem.remainingSize -= matchedSize;
        bestCandidate.remainingSize -= matchedSize;

        // Pricing calculations:
        // Whichever leg was BUY paid buyPrice; whichever leg was SELL received sellPrice.
        const rhIsBuy = rhItem.trade.side === "BUY";
        const buyPrice = rhIsBuy ? rhItem.trade.price : bestCandidate.trade.price;
        const sellPrice = rhIsBuy ? bestCandidate.trade.price : rhItem.trade.price;

        const priceDelta = sellPrice - buyPrice; // Positive if sold higher than bought; negative if loss
        const priceLossUsd = priceDelta * matchedSize;

        // Pro-rated fees based on matched size
        const rhFeePro =
          rhItem.trade.size > 0 ? (rhItem.trade.feeUsd / rhItem.trade.size) * matchedSize : 0;
        const coreFeePro =
          bestCandidate.trade.size > 0
            ? (bestCandidate.trade.feeUsd / bestCandidate.trade.size) * matchedSize
            : 0;
        const totalFeesUsd = rhFeePro + coreFeePro;

        // Net loss / PnL in USD (negative = irreversible loss)
        const netLossUsd = priceLossUsd - totalFeesUsd;

        const notionalUsd = matchedSize * ((rhItem.trade.price + bestCandidate.trade.price) / 2);
        const costBps = notionalUsd > 0 ? (netLossUsd / notionalUsd) * 10000 : 0;
        const timeDeltaSec = (bestCandidate.trade.timestampMs - rhItem.trade.timestampMs) / 1000;

        const isPartial =
          matchedSize < rhItem.trade.size - 0.000001 ||
          matchedSize < bestCandidate.trade.size - 0.000001;

        pairs.push({
          id: `pair-${rhItem.trade.tradeId}-${bestCandidate.trade.tradeId}-${pairCounter++}`,
          marketSymbol: market,
          matchedSize,
          rhTradeId: rhItem.trade.tradeId,
          rhSide: rhItem.trade.side,
          rhPrice: rhItem.trade.price,
          rhSize: rhItem.trade.size,
          rhFeeUsd: rhFeePro,
          rhTimestampMs: rhItem.trade.timestampMs,
          rhTimeFormatted: rhItem.trade.timeFormatted,
          rhTxHash: rhItem.trade.txHash,
          rhRole: rhItem.trade.role,
          coreTradeId: bestCandidate.trade.tradeId,
          coreSide: bestCandidate.trade.side,
          corePrice: bestCandidate.trade.price,
          coreSize: bestCandidate.trade.size,
          coreFeeUsd: coreFeePro,
          coreTimestampMs: bestCandidate.trade.timestampMs,
          coreTimeFormatted: bestCandidate.trade.timeFormatted,
          coreTxHash: bestCandidate.trade.txHash,
          coreRole: bestCandidate.trade.role,
          buyPrice,
          sellPrice,
          priceDelta,
          priceLossUsd,
          totalFeesUsd,
          netLossUsd,
          notionalUsd,
          costBps,
          timeDeltaSec,
          status: isPartial ? "PARTIAL" : "HEDGED",
        });
      }
    }

    // Leftover unhedged trades for this market
    for (const rhItem of marketRh) {
      if (rhItem.remainingSize > 0.0000001) {
        unhedged.push({
          tradeId: rhItem.trade.tradeId,
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
        });
      }
    }

    for (const coreItem of marketCore) {
      if (coreItem.remainingSize > 0.0000001) {
        unhedged.push({
          tradeId: coreItem.trade.tradeId,
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
    rhAccountIndex,
    coreAccountIndex,
    rhTrades.length,
    coreTrades.length,
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
): HedgeSummaryMetrics {
  let totalHedgedVolumeUsd = 0;
  let totalNetLossUsd = 0;
  let totalPriceLossUsd = 0;
  let totalFeesUsd = 0;
  let bestPairLossUsd = pairs.length > 0 ? -Infinity : 0;
  let worstPairLossUsd = pairs.length > 0 ? Infinity : 0;
  let firstTradeTime: number | null = null;
  let lastTradeTime: number | null = null;

  for (const p of pairs) {
    totalHedgedVolumeUsd += p.notionalUsd;
    totalNetLossUsd += p.netLossUsd;
    totalPriceLossUsd += p.priceLossUsd;
    totalFeesUsd += p.totalFeesUsd;

    if (p.netLossUsd > bestPairLossUsd) bestPairLossUsd = p.netLossUsd;
    if (p.netLossUsd < worstPairLossUsd) worstPairLossUsd = p.netLossUsd;

    if (firstTradeTime === null || p.rhTimestampMs < firstTradeTime) {
      firstTradeTime = p.rhTimestampMs;
    }
    if (lastTradeTime === null || p.rhTimestampMs > lastTradeTime) {
      lastTradeTime = p.rhTimestampMs;
    }
  }

  if (pairs.length === 0) {
    bestPairLossUsd = 0;
    worstPairLossUsd = 0;
  }

  const avgCostBps =
    totalHedgedVolumeUsd > 0 ? (totalNetLossUsd / totalHedgedVolumeUsd) * 10000 : 0;

  let unhedgedVolumeUsd = 0;
  let unhedgedRhCount = 0;
  let unhedgedCoreCount = 0;

  for (const u of unhedged) {
    unhedgedVolumeUsd += u.usdValue;
    if (u.network === "RH") unhedgedRhCount++;
    else unhedgedCoreCount++;

    if (firstTradeTime === null || u.timestampMs < firstTradeTime) {
      firstTradeTime = u.timestampMs;
    }
    if (lastTradeTime === null || u.timestampMs > lastTradeTime) {
      lastTradeTime = u.timestampMs;
    }
  }

  return {
    totalPairs: pairs.length,
    totalHedgedVolumeUsd,
    totalNetLossUsd,
    totalPriceLossUsd,
    totalFeesUsd,
    avgCostBps,
    bestPairLossUsd,
    worstPairLossUsd,
    totalUnhedgedTrades: unhedged.length,
    unhedgedVolumeUsd,
    unhedgedRhCount,
    unhedgedCoreCount,
    rhAccountIndex,
    coreAccountIndex,
    rhTotalTrades,
    coreTotalTrades,
    firstTradeTime,
    lastTradeTime,
  };
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
    "Price Delta",
    "Notional USD",
    "Slippage Loss USD",
    "RH Fee USD",
    "Core Fee USD",
    "Total Fees USD",
    "Net Loss USD",
    "Hedge Cost Bps",
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
        p.priceDelta.toFixed(4),
        p.notionalUsd.toFixed(2),
        p.priceLossUsd.toFixed(4),
        p.rhFeeUsd.toFixed(4),
        p.coreFeeUsd.toFixed(4),
        p.totalFeesUsd.toFixed(4),
        p.netLossUsd.toFixed(4),
        p.costBps.toFixed(2),
        p.timeDeltaSec.toFixed(2),
        p.status,
        p.rhTradeId,
        p.coreTradeId,
      ].join(","),
    );
  }

  for (const u of unhedged) {
    rows.push(
      [
        `unhedged-${u.network}-${u.tradeId}`,
        u.network === "RH" ? u.timeFormatted : "--",
        u.network === "CORE" ? u.timeFormatted : "--",
        u.marketSymbol,
        u.network === "RH" ? u.side : "--",
        u.network === "CORE" ? u.side : "--",
        u.unhedgedSize.toFixed(4),
        u.price.toFixed(4),
        "--",
        "--",
        u.usdValue.toFixed(2),
        "--",
        u.network === "RH" ? u.feeUsd.toFixed(4) : "0",
        u.network === "CORE" ? u.feeUsd.toFixed(4) : "0",
        u.feeUsd.toFixed(4),
        "--",
        "--",
        "--",
        `UNHEDGED (${u.network})`,
        u.network === "RH" ? u.tradeId : "--",
        u.network === "CORE" ? u.tradeId : "--",
      ].join(","),
    );
  }

  return rows.join("\n");
}
