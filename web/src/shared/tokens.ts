/**
 * Shared token logos and symbol helpers for Lighter markets.
 */

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
    return p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  }
  if (p >= 1) {
    return p.toFixed(2);
  }
  return p.toFixed(4);
}

export const OFFICIAL_TOKEN_LOGOS: Record<string, string> = {
  AAPL: "https://assets.lighter.xyz/fe/token/aapl.png",
  AI: "https://assets.lighter.xyz/fe/token/ai.png",
  AMD: "https://assets.lighter.xyz/fe/token/amd.png",
  AMZN: "https://assets.lighter.xyz/fe/token/amzn.png",
  ANSEM: "https://assets.lighter.xyz/fe/token/ansem.png",
  ANTHROPIC: "https://assets.lighter.xyz/fe/token/anthropic.png",
  BABA: "https://assets.lighter.xyz/fe/token/baba.png",
  BE: "https://assets.lighter.xyz/fe/token/be.png",
  BTC: "https://assets.lighter.xyz/fe/token/btc.png",
  CASHCAT: "https://assets.lighter.xyz/fe/token/cashcat.png",
  COIN: "https://assets.lighter.xyz/fe/token/coinbase.png",
  CRCL: "https://assets.lighter.xyz/fe/token/crcl.png",
  CRWV: "https://assets.lighter.xyz/fe/token/crwv.png",
  ETH: "https://assets.lighter.xyz/fe/token/eth.png",
  GOOGL: "https://assets.lighter.xyz/fe/token/googl.png",
  HYPE: "https://assets.lighter.xyz/fe/token/hype.png",
  INTC: "https://assets.lighter.xyz/fe/token/intc.png",
  LIT: "https://assets.lighter.xyz/fe/token/lit.png",
  META: "https://assets.lighter.xyz/fe/token/meta.png",
  MSFT: "https://assets.lighter.xyz/fe/token/msft.png",
  MU: "https://assets.lighter.xyz/fe/token/mu.png",
  NEAR: "https://assets.lighter.xyz/fe/token/near.png",
  NVDA: "https://assets.lighter.xyz/fe/token/nvda.png",
  OPENAI: "https://assets.lighter.xyz/fe/token/openai.png",
  ORCL: "https://assets.lighter.xyz/fe/token/orcl.png",
  PLTR: "https://assets.lighter.xyz/fe/token/pltr.png",
  PONS: "https://assets.lighter.xyz/fe/token/pons.png",
  QQQ: "https://assets.lighter.xyz/fe/token/qqq.png",
  SHEIN: "https://assets.lighter.xyz/fe/token/shein.png",
  SKHY: "https://assets.lighter.xyz/fe/token/skhynix.png",
  SNDK: "https://assets.lighter.xyz/fe/token/sndk.png",
  SOL: "https://assets.lighter.xyz/fe/token/sol.png",
  SOXL: "https://assets.lighter.xyz/fe/token/soxl.png",
  SPCX: "https://assets.lighter.xyz/fe/token/spcx.png",
  SPY: "https://assets.lighter.xyz/fe/token/spy.png",
  SUI: "https://assets.lighter.xyz/fe/token/sui.png",
  TSLA: "https://assets.lighter.xyz/fe/token/tsla.png",
  TSM: "https://assets.lighter.xyz/fe/token/tsm.png",
  VVV: "https://assets.lighter.xyz/fe/token/vvv.png",
  XAG: "https://assets.lighter.xyz/fe/token/xag.png",
  XAU: "https://assets.lighter.xyz/fe/token/xau.png",
  XRP: "https://assets.lighter.xyz/fe/token/xrp.png",
  ZEC: "https://assets.lighter.xyz/fe/token/zcash.png",
};

const dynamicTokenLogos = new Map<string, string>();

export function registerTokenLogos(
  tokens: Array<{ symbol: string; logo?: string; logo_extension?: string }>,
): void {
  for (const t of tokens) {
    if (!t.symbol || !t.logo) continue;
    const ext = t.logo_extension || "png";
    const url = `https://assets.lighter.xyz/fe/token/${t.logo}.${ext}`;
    dynamicTokenLogos.set(t.symbol.toUpperCase(), url);
  }
}

export function getTokenImageUrl(symbol: string): string {
  const sym = symbol.toUpperCase();
  if (dynamicTokenLogos.has(sym)) {
    return dynamicTokenLogos.get(sym)!;
  }
  if (OFFICIAL_TOKEN_LOGOS[sym]) {
    return OFFICIAL_TOKEN_LOGOS[sym];
  }
  return `https://assets.lighter.xyz/fe/token/${sym.toLowerCase()}.png`;
}
