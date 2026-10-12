import { LighterNetwork } from "../types";

export interface FastPosition {
  marketId: number;
  symbol: string;
  isLong: boolean;
  entryPrice: number;
  size: number;
  liqPrice: number;
  markPrice?: number;
  unrealizedPnl?: number;
}

export interface FastAccountState {
  network: LighterNetwork;
  accountIndex: number;
  alias: string | null;
  l1Address?: string | null;
  collateral: number;
  lastUpdated: number;
  fingerprint: number; // 32-bit checksum for zero-alloc dirty checking
  positions: FastPosition[];
}

// Global In-Memory state preserved across requests in warm isolates
export const MEMORY_ACCOUNTS = new Map<string, FastAccountState>();
export const MEMORY_PRICES = new Map<string, number>(); // symbol -> price

export function getMemoryAccountKey(network: LighterNetwork, accountIndex: number): string {
  return `${network}:${accountIndex}`;
}

export function getMemoryAccount(
  network: LighterNetwork,
  accountIndex: number,
): FastAccountState | undefined {
  return MEMORY_ACCOUNTS.get(getMemoryAccountKey(network, accountIndex));
}

export function setMemoryAccount(state: FastAccountState): void {
  MEMORY_ACCOUNTS.set(getMemoryAccountKey(state.network, state.accountIndex), state);
}

export function getMemoryPrice(symbol: string): number | undefined {
  const sym = symbol.toUpperCase();
  return MEMORY_PRICES.get(sym);
}

export function setMemoryPrice(symbol: string, price: number): void {
  const sym = symbol.toUpperCase();
  MEMORY_PRICES.set(sym, price);
  const dash = sym.indexOf("-");
  const slash = sym.indexOf("/");
  const under = sym.indexOf("_");
  const sep = dash !== -1 ? dash : slash !== -1 ? slash : under;
  if (sep !== -1) {
    MEMORY_PRICES.set(sym.slice(0, sep), price);
  }
}

export function clearMemoryCache(): void {
  MEMORY_ACCOUNTS.clear();
  MEMORY_PRICES.clear();
}
