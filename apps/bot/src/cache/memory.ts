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
export const IN_MEMORY_RR_CHECKED = new Map<string, number>(); // `${network}:${accountIndex}` -> last synced timestamp

let lastCronMetrics: any = null;

export function setLastCronMetrics(metrics: any): void {
  lastCronMetrics = metrics;
}

export function getLastCronMetrics(): any {
  return lastCronMetrics;
}

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

export function deleteMemoryAccount(network: LighterNetwork, accountIndex: number): void {
  const key = getMemoryAccountKey(network, accountIndex);
  MEMORY_ACCOUNTS.delete(key);
  IN_MEMORY_RR_CHECKED.delete(key);
}

export function getMemoryPrice(
  networkOrSymbol: LighterNetwork | string,
  symbolArg?: string,
): number | undefined {
  if (symbolArg !== undefined) {
    const network = networkOrSymbol as LighterNetwork;
    const sym = symbolArg.toUpperCase();
    return MEMORY_PRICES.get(`${network}:${sym}`) ?? MEMORY_PRICES.get(sym);
  }
  const sym = String(networkOrSymbol).toUpperCase();
  return MEMORY_PRICES.get(sym);
}

export function setMemoryPrice(
  networkOrSymbol: LighterNetwork | string,
  symbolOrPrice: string | number,
  priceArg?: number,
): void {
  let network: LighterNetwork | undefined;
  let symbol: string;
  let price: number;

  if (typeof symbolOrPrice === "number") {
    symbol = String(networkOrSymbol);
    price = symbolOrPrice;
  } else {
    network = networkOrSymbol as LighterNetwork;
    symbol = symbolOrPrice;
    price = priceArg!;
  }

  const sym = symbol.toUpperCase();
  if (network) {
    MEMORY_PRICES.set(`${network}:${sym}`, price);
  }
  MEMORY_PRICES.set(sym, price);

  const dash = sym.indexOf("-");
  const slash = sym.indexOf("/");
  const under = sym.indexOf("_");
  const sep = dash !== -1 ? dash : slash !== -1 ? slash : under;
  if (sep !== -1) {
    const base = sym.slice(0, sep);
    if (network) {
      MEMORY_PRICES.set(`${network}:${base}`, price);
    }
    MEMORY_PRICES.set(base, price);
  }
}

export function clearMemoryCache(): void {
  MEMORY_ACCOUNTS.clear();
  MEMORY_PRICES.clear();
  IN_MEMORY_RR_CHECKED.clear();
  lastCronMetrics = null;
}
