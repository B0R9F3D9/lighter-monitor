/**
 * Shared token logos and symbol helpers for Lighter markets.
 */

export interface ApiTokenInfo {
  symbol: string;
  name?: string;
  logo?: string;
  logo_extension?: string;
  market?: string;
  asset_type?: string;
  categories?: string[];
  is_allowed_mainnet?: boolean;
  is_asset_allowed_mainnet?: boolean;
}

export const CRYPTO_SYMBOLS: Set<string> = new Set();
export const NON_EQUITY_SYMBOLS: Set<string> = new Set();
export const EQUITY_SYMBOLS: Set<string> = new Set();

const dynamicTokenMetadata = new Map<string, ApiTokenInfo>();
const dynamicTokenLogos = new Map<string, string>();

export function registerTokenLogos(
  tokens: Array<{ symbol: string; logo?: string; logo_extension?: string }>,
): void {
  for (const t of tokens) {
    if (!t.symbol || !t.logo) continue;
    const ext = t.logo_extension || "png";
    const url = `https://assets.lighter.xyz/fe/token/${t.logo}.${ext}`;
    const rawSym = t.symbol.toUpperCase().trim();
    dynamicTokenLogos.set(rawSym, url);
    if (rawSym.includes("/")) {
      dynamicTokenLogos.set(rawSym.split("/")[0]!, url);
    }
  }
}

export function registerTokens(tokens: ApiTokenInfo[]): void {
  registerTokenLogos(tokens);

  for (const t of tokens) {
    if (!t.symbol) continue;
    const rawSym = t.symbol.toUpperCase().trim();
    const sym = rawSym.includes("/") ? rawSym.split("/")[0]! : rawSym;

    dynamicTokenMetadata.set(sym, t);

    const isStock =
      t.categories?.includes("STOCK") ||
      (t.asset_type === "RWA" &&
        !t.categories?.includes("ETF") &&
        !t.categories?.includes("COMMODITIES"));

    if (isStock) {
      EQUITY_SYMBOLS.add(sym);
      NON_EQUITY_SYMBOLS.delete(sym);
    } else {
      NON_EQUITY_SYMBOLS.add(sym);
      EQUITY_SYMBOLS.delete(sym);
    }

    const isCrypto =
      t.asset_type === "CRYPTO" ||
      (!isStock && t.categories?.some((c) => ["LAYER_1", "LAYER_2", "MEMES", "DEFI"].includes(c)));

    if (isCrypto) {
      CRYPTO_SYMBOLS.add(sym);
    }
  }
}

export function isEquitySymbol(symbol: string): boolean {
  const sym = symbol.toUpperCase().trim();
  const baseSym = sym.includes("/") ? sym.split("/")[0]! : sym;
  return EQUITY_SYMBOLS.has(baseSym);
}

export function isNonEquitySymbol(symbol: string): boolean {
  const sym = symbol.toUpperCase().trim();
  const baseSym = sym.includes("/") ? sym.split("/")[0]! : sym;
  return NON_EQUITY_SYMBOLS.has(baseSym);
}

export function isCryptoSymbol(symbol: string): boolean {
  const sym = symbol.toUpperCase().trim();
  const baseSym = sym.includes("/") ? sym.split("/")[0]! : sym;
  return CRYPTO_SYMBOLS.has(baseSym);
}

export function getTokenIcon(symbol: string): string {
  const sym = symbol.toUpperCase();
  if (sym === "AAPL") return "";
  if (sym === "BTC") return "₿";
  if (sym === "ETH") return "Ξ";
  if (sym === "SOL") return "◎";
  if (sym === "XAU") return "Au";
  if (sym === "XAG") return "Ag";
  if (sym === "GOOGL" || sym === "GOOG") return "G";
  if (sym === "NVDA") return "NV";
  if (sym === "MSFT") return "MS";
  if (sym === "TSLA") return "T";
  if (sym === "AMZN") return "AM";
  if (sym === "META") return "M";
  if (sym === "COIN") return "C";
  if (sym === "SPY") return "SP";
  if (sym === "QQQ") return "Q";
  return sym.slice(0, 2);
}

export function formatMarketPrice(p: number | undefined | null): string {
  if (p === undefined || p === null || isNaN(p) || p <= 0) return "--";
  if (p >= 1000) {
    const s = p.toFixed(2);
    const trimmed = s.endsWith("0") ? s.slice(0, -1) : s;
    const dot = trimmed.indexOf(".");
    const intPart = dot === -1 ? trimmed : trimmed.slice(0, dot);
    const decPart = dot === -1 ? "" : trimmed.slice(dot);
    return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + decPart;
  }
  if (p >= 1) {
    return p.toFixed(2);
  }
  return p.toFixed(4);
}

const KNOWN_TOKEN_LOGOS: Record<string, string> = {
  SKHY: "https://assets.lighter.xyz/fe/token/skhynix.png",
  COIN: "https://assets.lighter.xyz/fe/token/coinbase.png",
  ZEC: "https://assets.lighter.xyz/fe/token/zcash.png",
};

export function getTokenImageUrl(symbol: string): string {
  const sym = symbol.toUpperCase().trim();
  const baseSym = sym.includes("/") ? sym.split("/")[0]! : sym;
  if (dynamicTokenLogos.has(baseSym)) {
    return dynamicTokenLogos.get(baseSym)!;
  }
  if (KNOWN_TOKEN_LOGOS[baseSym]) {
    return KNOWN_TOKEN_LOGOS[baseSym];
  }
  return `https://assets.lighter.xyz/fe/token/${baseSym.toLowerCase()}.png`;
}
