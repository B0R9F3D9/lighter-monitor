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

export type HedgeStrategyCategory = "CRYPTO" | "RWA_COMMODITIES_ETF" | "RWA_PRE_IPO_EQUITIES";

export interface HedgeSideConfig {
  category: HedgeStrategyCategory;
  categoryLabel: string;
  isRhLong: boolean;
  rhSide: "BUY" | "SELL"; // "BUY" is Long, "SELL" is Short
  coreSide: "BUY" | "SELL";
  rhAction: "Long" | "Short";
  coreAction: "Long" | "Short";
}

export type TokenCategoryType =
  | "all"
  | "crypto"
  | "rwa_commodities_etf"
  | "rwa_pre_ipo_equities"
  | "stocks"
  | "pre_ipo"
  | "etf";

export const CRYPTO_SYMBOLS: Set<string> = new Set();
export const NON_EQUITY_SYMBOLS: Set<string> = new Set();
export const EQUITY_SYMBOLS: Set<string> = new Set();
export const PRE_IPO_SYMBOLS: Set<string> = new Set();
export const ETF_SYMBOLS: Set<string> = new Set();
export const COMMODITY_SYMBOLS: Set<string> = new Set();

export const KNOWN_PRE_IPO = new Set([
  "OPENAI",
  "ANTHROPIC",
  "SPCX",
  "SPACEX",
  "CRWV",
  "SHEIN",
  "CRCL",
  "STRIPE",
  "OURA",
]);
export const KNOWN_ETF = new Set([
  "SPY",
  "QQQ",
  "USAR",
  "SGOV",
  "SLV",
  "USO",
  "SOXL",
  "SOXX",
  "URA",
  "US100",
  "US500",
  "SOXS",
  "KORU",
  "TUR30",
]);
export const KNOWN_COMMODITIES = new Set([
  "XAU",
  "XAG",
  "GOLD",
  "SILVER",
  "OIL",
  "WTI",
  "NATGAS",
  "XCU",
  "PAXG",
  "WHEAT",
  "XPD",
  "XPT",
]);
export const KNOWN_STOCKS = new Set([
  "AAPL",
  "NVDA",
  "MSFT",
  "TSLA",
  "AMZN",
  "GOOGL",
  "GOOG",
  "META",
  "COIN",
  "INTC",
  "AMD",
  "SNDK",
  "NFLX",
  "PLTR",
  "ARM",
  "AVGO",
  "BABA",
  "MU",
  "TSM",
  "ORCL",
  "BE",
  "IREN",
  "SOFI",
  "AMC",
  "SMCI",
  "QBTS",
  "LUNR",
  "ASTS",
  "SKHY",
  "CLSK",
  "WULF",
  "RGTI",
  "SOUN",
  "NOW",
  "RKLB",
  "SAMSUNG",
  "SKHYNIX",
  "MRNA",
  "TTWO",
  "GEV",
  "ASML",
  "AXTI",
  "WDC",
  "KIOXIA",
]);
export const KNOWN_CRYPTO = new Set([
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "LIT",
  "NEAR",
  "SUI",
  "HYPE",
  "VVV",
  "ZEC",
  "DOGE",
  "AVAX",
  "LINK",
  "UNI",
  "AAVE",
  "TRX",
  "USELESS",
  "ANSEM",
  "CASHCAT",
  "PONS",
  "XMR",
  "AI",
  "0G",
  "2Z",
  "ADA",
  "ADI",
  "AERO",
  "AI16Z",
  "APEX",
  "APT",
  "ARB",
  "ARC",
  "ASTER",
  "AVNT",
  "AXS",
  "BLUR",
  "BOME",
  "BRETT",
  "CHILLGUY",
  "CRV",
  "DOT",
  "ENA",
  "EOS",
  "FARTCOIN",
  "FET",
  "FIL",
  "FLR",
  "FTM",
  "GIGA",
  "GOAT",
  "GRASS",
  "GRIFFAIN",
  "ICP",
  "INJ",
  "IO",
  "IP",
  "JASMY",
  "JTO",
  "JUP",
  "KAS",
  "KOMA",
  "LAY",
  "LDO",
  "LEO",
  "MAGIC",
  "MANA",
  "MELANIA",
  "MEW",
  "MKR",
  "MOODENG",
  "MORPHO",
  "MOVE",
  "MNT",
  "NOT",
  "OM",
  "ONDO",
  "OP",
  "PENDLE",
  "PENGU",
  "PIPPIN",
  "POL",
  "POPCAT",
  "PUMP",
  "PYTH",
  "RAY",
  "RENDER",
  "RESOLV",
  "RIVER",
  "ROBO",
  "S",
  "SEI",
  "SHIB",
  "SKR",
  "SKY",
  "STRK",
  "SYRUP",
  "TAO",
  "TIA",
  "TON",
  "TRUMP",
  "VIRTUAL",
  "WIF",
  "WLD",
  "WLFI",
  "XLM",
  "XPL",
  "YZY",
  "ZK",
  "ZORA",
  "ZRO",
]);

const dynamicTokenMetadata = new Map<string, ApiTokenInfo>();
const dynamicTokenLogos = new Map<string, string>();

export function registerTokenLogos(
  tokens: Array<{ symbol: string; logo?: string; logo_extension?: string }>,
): void {
  for (const t of tokens) {
    if (!t.symbol || !t.logo) continue;
    const ext = t.logo_extension || "png";
    const rawSym = t.symbol.toUpperCase().trim();
    const isPair = rawSym.includes("/");

    if (!isPair) {
      // Direct base token symbol (e.g. "QQQ", "AAPL", "BTC")
      const url = `https://assets.lighter.xyz/fe/token/${t.logo}.${ext}`;
      dynamicTokenLogos.set(rawSym, url);
    } else {
      // Trading / spot pair (e.g. "QQQ/USDG")
      const pairUrl = `https://assets.lighter.xyz/fe/token/${t.logo}.${ext}`;
      dynamicTokenLogos.set(rawSym, pairUrl);

      const baseSym = rawSym.split("/")[0]!;
      // Never overwrite an existing base token logo with a composite pair logo
      if (!dynamicTokenLogos.has(baseSym)) {
        const cleanLogo = t.logo.replace(/usd[gc]?$/i, "") || baseSym.toLowerCase();
        dynamicTokenLogos.set(baseSym, `https://assets.lighter.xyz/fe/token/${cleanLogo}.${ext}`);
      }
    }
  }
}

export function registerTokens(tokens: ApiTokenInfo[]): void {
  registerTokenLogos(tokens);

  for (const t of tokens) {
    if (!t.symbol) continue;
    const rawSym = t.symbol.toUpperCase().trim();
    const isPair = rawSym.includes("/");
    const sym = isPair ? rawSym.split("/")[0]! : rawSym;

    if (isPair && dynamicTokenMetadata.has(sym)) {
      continue;
    }

    dynamicTokenMetadata.set(sym, t);

    const cats = t.categories || [];
    const isPreIpo = cats.includes("PRE_IPO") || KNOWN_PRE_IPO.has(sym);
    const isEtf = cats.includes("ETF") || KNOWN_ETF.has(sym);
    const isCommodity = cats.includes("COMMODITIES") || KNOWN_COMMODITIES.has(sym);
    const isStock =
      !isPreIpo &&
      !isEtf &&
      !isCommodity &&
      (cats.includes("STOCK") || (t.asset_type === "RWA" && !isEtf && !isCommodity));

    if (isPreIpo) {
      PRE_IPO_SYMBOLS.add(sym);
    }
    if (isEtf) {
      ETF_SYMBOLS.add(sym);
    }
    if (isCommodity) {
      COMMODITY_SYMBOLS.add(sym);
    }

    if (isStock) {
      EQUITY_SYMBOLS.add(sym);
      NON_EQUITY_SYMBOLS.delete(sym);
    } else {
      NON_EQUITY_SYMBOLS.add(sym);
      EQUITY_SYMBOLS.delete(sym);
    }

    const isCrypto =
      t.asset_type === "CRYPTO" ||
      (!isStock &&
        !isPreIpo &&
        !isEtf &&
        !isCommodity &&
        cats.some((c) =>
          ["LAYER_1", "LAYER_2", "MEMES", "DEFI", "MAJOR", "AI", "COMPUTE"].includes(c),
        ));

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

export function isPreIpoSymbol(symbol: string): boolean {
  const sym = symbol.toUpperCase().trim();
  const baseSym = sym.includes("/") ? sym.split("/")[0]! : sym;
  const meta = dynamicTokenMetadata.get(baseSym);
  return (
    meta?.categories?.includes("PRE_IPO") ||
    PRE_IPO_SYMBOLS.has(baseSym) ||
    KNOWN_PRE_IPO.has(baseSym)
  );
}

export function isEtfSymbol(symbol: string): boolean {
  const sym = symbol.toUpperCase().trim();
  const baseSym = sym.includes("/") ? sym.split("/")[0]! : sym;
  const meta = dynamicTokenMetadata.get(baseSym);
  return meta?.categories?.includes("ETF") || ETF_SYMBOLS.has(baseSym) || KNOWN_ETF.has(baseSym);
}

export function isCommoditySymbol(symbol: string): boolean {
  const sym = symbol.toUpperCase().trim();
  const baseSym = sym.includes("/") ? sym.split("/")[0]! : sym;
  const meta = dynamicTokenMetadata.get(baseSym);
  return (
    meta?.categories?.includes("COMMODITIES") ||
    COMMODITY_SYMBOLS.has(baseSym) ||
    KNOWN_COMMODITIES.has(baseSym)
  );
}

/**
 * Categorizes market symbols according to Lighter Points program rules:
 * - Crypto: Core Short / RH Long (2.5x)
 * - RWA (Commodities, ETFs): Core Short / RH Long (2.5x)
 * - RWA (Pre IPOs, Equities): Core Long / RH Short (2.5x)
 */
export function getHedgeCategory(symbol: string): HedgeStrategyCategory {
  const sym = symbol.toUpperCase().trim();
  const baseSym = sym.includes("/") ? sym.split("/")[0]! : sym;

  const meta = dynamicTokenMetadata.get(baseSym);
  if (meta) {
    const cats = meta.categories || [];
    if (cats.includes("PRE_IPO")) return "RWA_PRE_IPO_EQUITIES";
    if (cats.includes("ETF") || cats.includes("COMMODITIES")) return "RWA_COMMODITIES_ETF";
    if (cats.includes("STOCK")) return "RWA_PRE_IPO_EQUITIES";
    if (meta.asset_type === "RWA") return "RWA_PRE_IPO_EQUITIES";
    if (meta.asset_type === "CRYPTO") return "CRYPTO";
  }

  if (PRE_IPO_SYMBOLS.has(baseSym) || KNOWN_PRE_IPO.has(baseSym)) return "RWA_PRE_IPO_EQUITIES";
  if (ETF_SYMBOLS.has(baseSym) || KNOWN_ETF.has(baseSym)) return "RWA_COMMODITIES_ETF";
  if (COMMODITY_SYMBOLS.has(baseSym) || KNOWN_COMMODITIES.has(baseSym))
    return "RWA_COMMODITIES_ETF";
  if (EQUITY_SYMBOLS.has(baseSym) || KNOWN_STOCKS.has(baseSym)) return "RWA_PRE_IPO_EQUITIES";
  if (CRYPTO_SYMBOLS.has(baseSym) || KNOWN_CRYPTO.has(baseSym)) return "CRYPTO";

  if (isEquitySymbol(baseSym)) return "RWA_PRE_IPO_EQUITIES";
  return "CRYPTO";
}

/**
 * Returns the exact opening execution sides (legs) and boost parameters:
 * - Crypto: Core Short / RH Long (2.5x) -> isRhLong: true
 * - RWA (Commodities, ETFs): Core Short / RH Long (2.5x) -> isRhLong: true
 * - RWA (Pre IPOs, Equities): Core Long / RH Short (2.5x) -> isRhLong: false
 */
export function getHedgeSideConfig(symbol: string): HedgeSideConfig {
  const cat = getHedgeCategory(symbol);

  if (cat === "CRYPTO") {
    return {
      category: "CRYPTO",
      categoryLabel: "Crypto",
      isRhLong: true,
      rhSide: "BUY",
      coreSide: "SELL",
      rhAction: "Long",
      coreAction: "Short",
    };
  }

  if (cat === "RWA_COMMODITIES_ETF") {
    return {
      category: "RWA_COMMODITIES_ETF",
      categoryLabel: "RWA (Commodities, ETFs)",
      isRhLong: true,
      rhSide: "BUY",
      coreSide: "SELL",
      rhAction: "Long",
      coreAction: "Short",
    };
  }

  return {
    category: "RWA_PRE_IPO_EQUITIES",
    categoryLabel: "RWA (Pre IPOs, Equities)",
    isRhLong: false,
    rhSide: "SELL",
    coreSide: "BUY",
    rhAction: "Short",
    coreAction: "Long",
  };
}

/**
 * Filter matcher for the asset class selector in /spread and /analytics:
 * - 'all': all tokens
 * - 'crypto': Crypto tokens (Core Short / RH Long, 2.5x)
 * - 'rwa_commodities_etf': RWA (Commodities, ETFs) (Core Short / RH Long, 2.5x)
 * - 'rwa_pre_ipo_equities': RWA (Pre IPOs, Equities) (Core Long / RH Short, 2.5x)
 * - legacy / backward-compatible filters: 'stocks', 'pre_ipo', 'etf'
 */
export function matchesCategoryFilter(symbol: string, filter: TokenCategoryType): boolean {
  if (filter === "all") return true;

  const sym = symbol.toUpperCase().trim();
  const baseSym = sym.includes("/") ? sym.split("/")[0]! : sym;
  const filterNorm = (filter as string).toLowerCase().trim();

  // 1. Official 3 Lighter Points Program groups:
  if (filterNorm === "crypto") {
    return getHedgeCategory(baseSym) === "CRYPTO";
  }

  if (filterNorm === "rwa_commodities_etf") {
    return getHedgeCategory(baseSym) === "RWA_COMMODITIES_ETF";
  }

  if (filterNorm === "rwa_pre_ipo_equities") {
    return getHedgeCategory(baseSym) === "RWA_PRE_IPO_EQUITIES";
  }

  // 2. Legacy / sub-category filters:
  const meta = dynamicTokenMetadata.get(baseSym);
  const cats = meta?.categories || [];

  if (filterNorm === "pre_ipo") {
    return cats.includes("PRE_IPO") || PRE_IPO_SYMBOLS.has(baseSym) || KNOWN_PRE_IPO.has(baseSym);
  }

  if (filterNorm === "etf") {
    return cats.includes("ETF") || ETF_SYMBOLS.has(baseSym) || KNOWN_ETF.has(baseSym);
  }

  if (filterNorm === "stocks") {
    const isPre =
      cats.includes("PRE_IPO") || PRE_IPO_SYMBOLS.has(baseSym) || KNOWN_PRE_IPO.has(baseSym);
    const isEtf = cats.includes("ETF") || ETF_SYMBOLS.has(baseSym) || KNOWN_ETF.has(baseSym);
    const isCom =
      cats.includes("COMMODITIES") ||
      COMMODITY_SYMBOLS.has(baseSym) ||
      KNOWN_COMMODITIES.has(baseSym);
    if (isPre || isEtf || isCom) return false;

    return (
      cats.includes("STOCK") ||
      (meta?.asset_type === "RWA" && !cats.includes("ETF") && !cats.includes("COMMODITIES")) ||
      EQUITY_SYMBOLS.has(baseSym) ||
      KNOWN_STOCKS.has(baseSym)
    );
  }

  return true;
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
  const isPair = sym.includes("/");
  const baseSym = isPair ? sym.split("/")[0]! : sym;

  // Explicit trading pair logo requested
  if (isPair && dynamicTokenLogos.has(sym)) {
    return dynamicTokenLogos.get(sym)!;
  }

  if (dynamicTokenLogos.has(baseSym)) {
    let url = dynamicTokenLogos.get(baseSym)!;
    // Safety guard: if base token was somehow assigned a composite pair icon like qqqUsdg.png, clean it
    if (!isPair && /usd[gc]?\.[a-z0-9]+$/i.test(url)) {
      url = url.replace(/usd[gc]?(\.[a-z0-9]+)$/i, "$1");
    }
    return url;
  }
  if (KNOWN_TOKEN_LOGOS[baseSym]) {
    return KNOWN_TOKEN_LOGOS[baseSym];
  }
  return `https://assets.lighter.xyz/fe/token/${baseSym.toLowerCase()}.png`;
}
