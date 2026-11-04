import { getHedgeSideConfig } from "../shared";
import type { CalculatorResults, CalculatorState } from "./types";

export function calculateCalculatorResults(state: CalculatorState): CalculatorResults {
  const price = Math.max(0, state.price || 0);
  const sizeVal = Math.max(0, state.sizeValue || 0);

  // 1. Calculate Size in USD and Tokens
  let sizeUsd = 0;
  let sizeTokens = 0;
  if (state.sizeMode === "usd") {
    sizeUsd = sizeVal;
    sizeTokens = price > 0 ? sizeUsd / price : 0;
  } else {
    sizeTokens = sizeVal;
    sizeUsd = sizeTokens * price;
  }

  // 2. Entry Spread
  let entrySpreadUsd = 0;
  let entrySpreadCents = 0;
  let entrySpreadBps = 0;
  if (state.entrySpreadMode === "cents") {
    entrySpreadCents = state.entrySpreadValue || 0;
    entrySpreadUsd = entrySpreadCents / 100;
    entrySpreadBps = price > 0 ? (entrySpreadUsd / price) * 10000 : 0;
  } else {
    entrySpreadBps = state.entrySpreadValue || 0;
    entrySpreadUsd = price > 0 ? (entrySpreadBps / 10000) * price : 0;
    entrySpreadCents = entrySpreadUsd * 100;
  }

  // 3. Exit Spread
  let exitSpreadUsd = 0;
  let exitSpreadCents = 0;
  let exitSpreadBps = 0;
  if (state.exitSpreadMode === "cents") {
    exitSpreadCents = state.exitSpreadValue || 0;
    exitSpreadUsd = exitSpreadCents / 100;
    exitSpreadBps = price > 0 ? (exitSpreadUsd / price) * 10000 : 0;
  } else {
    exitSpreadBps = state.exitSpreadValue || 0;
    exitSpreadUsd = price > 0 ? (exitSpreadBps / 10000) * price : 0;
    exitSpreadCents = exitSpreadUsd * 100;
  }

  // 4. Direction & Spread Delta
  // Using getHedgeSideConfig logic from /spread and /analytics
  const hedgeCfg = getHedgeSideConfig(state.symbol);
  const isRhLong = hedgeCfg.isRhLong;
  const openRhSide = hedgeCfg.rhAction as "Long" | "Short";
  const openCoreSide = hedgeCfg.coreAction as "Long" | "Short";
  const closeRhSide = (isRhLong ? "Short" : "Long") as "Long" | "Short";
  const closeCoreSide = (isRhLong ? "Long" : "Short") as "Long" | "Short";

  // For Crypto/Commodities (isRhLong: true):
  //   Buy RH, Sell Core at entry; Sell RH, Buy Core at exit.
  //   Capture = Exit Spread - Entry Spread.
  // For Equities (isRhLong: false):
  //   Sell RH, Buy Core at entry; Buy RH, Sell Core at exit.
  //   Capture = Entry Spread - Exit Spread.
  const spreadDeltaUsd = isRhLong ? exitSpreadUsd - entrySpreadUsd : entrySpreadUsd - exitSpreadUsd;
  const spreadDeltaCents = isRhLong
    ? exitSpreadCents - entrySpreadCents
    : entrySpreadCents - exitSpreadCents;
  const spreadDeltaBps = isRhLong ? exitSpreadBps - entrySpreadBps : entrySpreadBps - exitSpreadBps;

  // 5. Volume & Fees
  // Position is opened and closed on Robinhood account -> fee is charged for both open and close
  const feeRateBps = Math.max(0, state.feeRateBps || 0);
  const totalFeesUsd = (sizeUsd * 2 * feeRateBps) / 10000;

  // 6. Spread PnL & Net PnL
  const spreadPnlUsd = spreadDeltaUsd * sizeTokens;
  const netPnlUsd = spreadPnlUsd - totalFeesUsd;
  const netReturnBps = sizeUsd > 0 ? (netPnlUsd / sizeUsd) * 10000 : 0;
  const netReturnPercent = sizeUsd > 0 ? (netPnlUsd / sizeUsd) * 100 : 0;

  // 7. Break-even Exit Spread
  const feesPerToken = sizeTokens > 0 ? totalFeesUsd / sizeTokens : 0;
  const breakEvenExitSpreadUsd = isRhLong
    ? entrySpreadUsd + feesPerToken
    : entrySpreadUsd - feesPerToken;
  const breakEvenExitSpreadCents = breakEvenExitSpreadUsd * 100;
  const breakEvenExitSpreadBps = price > 0 ? (breakEvenExitSpreadUsd / price) * 10000 : 0;

  return {
    sizeUsd,
    sizeTokens,
    entrySpreadUsd,
    entrySpreadCents,
    entrySpreadBps,
    exitSpreadUsd,
    exitSpreadCents,
    exitSpreadBps,
    spreadDeltaUsd,
    spreadDeltaCents,
    spreadDeltaBps,
    spreadPnlUsd,
    totalFeesUsd,
    netPnlUsd,
    netReturnBps,
    netReturnPercent,
    breakEvenExitSpreadUsd,
    breakEvenExitSpreadCents,
    breakEvenExitSpreadBps,
    isRhLong,
    openRhSide,
    openCoreSide,
    closeRhSide,
    closeCoreSide,
  };
}

export function formatSignedMoney(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return "$0.00";
  if (Math.abs(num) < 0.0001) return "$0.00";
  const sign = num > 0 ? "+" : num < 0 ? "-" : "";
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatSignedCents(cents: number | undefined | null): string {
  if (cents === undefined || cents === null || isNaN(cents)) return "0.00¢";
  if (Math.abs(cents) < 0.0001) return "0.00¢";
  const sign = cents > 0 ? "+" : cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  if (abs >= 100) {
    return `${sign}${abs.toFixed(1)}¢`;
  }
  return `${sign}${abs.toFixed(2)}¢`;
}

export function formatSignedBps(bps: number | undefined | null): string {
  if (bps === undefined || bps === null || isNaN(bps)) return "0.00 bps";
  if (Math.abs(bps) < 0.0001) return "0.00 bps";
  const sign = bps > 0 ? "+" : bps < 0 ? "-" : "";
  return `${sign}${Math.abs(bps).toFixed(2)} bps`;
}
