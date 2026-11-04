export type SizeMode = "usd" | "tokens";
export type SpreadMode = "cents" | "bps";
export type CheaperSide = "rh" | "core";

export interface CalculatorState {
  symbol: string;
  price: number;
  sizeMode: SizeMode;
  sizeValue: number;
  entrySpreadMode: SpreadMode;
  entrySpreadValue: number;
  entryCheaperSide: CheaperSide;
  exitSpreadMode: SpreadMode;
  exitSpreadValue: number;
  exitCheaperSide: CheaperSide;
  feeRateBps: number;
}

export interface CalculatorResults {
  // Size
  sizeUsd: number;
  sizeTokens: number;

  // Entry Spread
  entrySpreadUsd: number;
  entrySpreadCents: number;
  entrySpreadBps: number;

  // Exit Spread
  exitSpreadUsd: number;
  exitSpreadCents: number;
  exitSpreadBps: number;

  // Delta
  spreadDeltaUsd: number;
  spreadDeltaCents: number;
  spreadDeltaBps: number;

  // Financials
  spreadPnlUsd: number;
  totalFeesUsd: number;
  netPnlUsd: number;
  netReturnBps: number;
  netReturnPercent: number;

  // Break-even
  breakEvenExitSpreadUsd: number;
  breakEvenExitSpreadCents: number;
  breakEvenExitSpreadBps: number;

  // Execution Sides from getHedgeSideConfig
  isRhLong: boolean;
  openRhSide: "Long" | "Short";
  openCoreSide: "Long" | "Short";
  closeRhSide: "Long" | "Short";
  closeCoreSide: "Long" | "Short";
}
