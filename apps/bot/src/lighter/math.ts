import { CONFIG } from "../config";
import { AlertTier, LighterNetwork, LighterPosition, PositionRiskAnalysis } from "../types";

export function analyzePositionRisk(pos: LighterPosition): PositionRiskAnalysis | null {
  const size = Math.abs(parseFloat(pos.position || "0"));
  const posValue = Math.abs(parseFloat(pos.position_value || "0"));
  const liqPrice = parseFloat(pos.liquidation_price || "0");
  const entryPrice = parseFloat(pos.avg_entry_price || "0");
  const unrealizedPnl = parseFloat(pos.unrealized_pnl || "0");

  // Если позиция нулевая или закрыта — активной сделки нет
  if (size === 0) return null;

  const markPrice = posValue > 0 && size > 0 ? posValue / size : 0;
  let distancePercent: number | null = null;
  let tier: AlertTier = "SAFE";

  if (liqPrice > 0 && markPrice > 0) {
    distancePercent = (Math.abs(markPrice - liqPrice) / markPrice) * 100;

    if (distancePercent <= CONFIG.TIERS.CRITICAL_2.maxDistance) {
      tier = "CRITICAL_2";
    } else if (distancePercent <= CONFIG.TIERS.DANGER_5.maxDistance) {
      tier = "DANGER_5";
    } else if (distancePercent <= CONFIG.TIERS.WARN_10.maxDistance) {
      tier = "WARN_10";
    }
  }

  return {
    marketId: pos.market_id,
    symbol: pos.symbol,
    isLong: pos.sign === 1,
    size,
    posValue,
    entryPrice,
    markPrice,
    liqPrice,
    unrealizedPnl,
    distancePercent,
    tier,
  };
}

/**
 * Fast Zero-Alloc 32-bit checksum (SMI in V8, 0 bytes heap allocation)
 * Any change in position size, direction, market, or count changes the fingerprint.
 */
export function computePositionsFingerprint(positions: any[]): number {
  if (!positions || positions.length === 0) return 0;
  let hash = 0 | 0;
  const len = positions.length;
  for (let i = 0; i < len; i++) {
    const p = positions[i];
    if (!p) continue;

    let mId = 0;
    let sizeInt = 0;
    let sign = 1;

    if (Array.isArray(p)) {
      mId = p[0] || 0;
      sizeInt = Math.round(Math.abs(p[4] || 0) * 100_000) | 0;
      if (sizeInt === 0) continue; // Synchronize with packPositions: ignore closed positions
      sign = p[2] ? 1 : 2;
    } else {
      const rawSize = p.position ?? p.size ?? "0";
      const sizeNum = typeof rawSize === "number" ? rawSize : parseFloat(rawSize || "0");
      sizeInt = Math.round(Math.abs(sizeNum) * 100_000) | 0;
      if (sizeInt === 0) continue; // Synchronize with packPositions: ignore closed positions
      mId = p.market_id ?? p.marketId ?? 0;
      sign =
        (p.sign ?? (p.isLong !== undefined ? (p.isLong ? 1 : -1) : sizeNum > 0 ? 1 : -1)) > 0
          ? 1
          : 2;
    }

    // Commutative XOR hash (order-independent)
    hash = (hash ^ Math.imul(mId * 31 + sign, sizeInt)) | 0;
  }
  return hash;
}

/**
 * Flat Tuple representation:
 * [market_id, symbol, is_long (1|0), entry_price, size, liq_price, mark_price, unrealized_pnl]
 * Preserves last known markPrice & unrealizedPnl to guarantee accurate PnL display
 * even across cold isolate restarts where in-memory price cache is temporarily empty.
 */
export type PackedPosition = [number, string, number, number, number, number, number, number];

export function packPositions(positions: any[]): PackedPosition[] {
  if (!positions || positions.length === 0) return [];
  const result: PackedPosition[] = [];
  const len = positions.length;
  for (let i = 0; i < len; i++) {
    const p = positions[i];
    if (!p) continue;
    if (Array.isArray(p)) {
      if (p.length >= 8) {
        result.push(p as PackedPosition);
      } else {
        // Upgrade legacy 6-tuple: [marketId, symbol, isLong, entryPrice, size, liqPrice]
        result.push([p[0], p[1], p[2], p[3], p[4], p[5], p[3] || 0, 0]);
      }
      continue;
    }

    const rawSize = p.position ?? p.size ?? "0";
    const size = Math.abs(typeof rawSize === "number" ? rawSize : parseFloat(rawSize || "0"));
    if (size === 0) continue;

    const marketId = p.market_id ?? p.marketId ?? 0;
    const symbol = String(p.symbol || "").toUpperCase();
    const isLong =
      (p.sign ??
        (p.isLong !== undefined ? (p.isLong ? 1 : -1) : parseFloat(String(rawSize)) > 0 ? 1 : -1)) >
      0
        ? 1
        : 0;
    const rawEntry = p.avg_entry_price ?? p.entryPrice ?? "0";
    const entryPrice = typeof rawEntry === "number" ? rawEntry : parseFloat(rawEntry || "0");
    const rawLiq = p.liquidation_price ?? p.liqPrice ?? "0";
    const liqPrice = typeof rawLiq === "number" ? rawLiq : parseFloat(rawLiq || "0");

    const rawPosValue = p.position_value ?? p.posValue ?? 0;
    const posValue = Math.abs(
      typeof rawPosValue === "number" ? rawPosValue : parseFloat(rawPosValue || "0"),
    );
    const rawMark = p.markPrice ?? p.mark_price;
    const markPrice =
      typeof rawMark === "number"
        ? rawMark
        : rawMark
          ? parseFloat(rawMark)
          : posValue > 0 && size > 0
            ? posValue / size
            : entryPrice;

    const rawPnl = p.unrealized_pnl ?? p.unrealizedPnl;
    const unrealizedPnl =
      typeof rawPnl === "number"
        ? rawPnl
        : rawPnl
          ? parseFloat(rawPnl)
          : (markPrice - entryPrice) * size * (isLong ? 1 : -1);

    result.push([marketId, symbol, isLong, entryPrice, size, liqPrice, markPrice, unrealizedPnl]);
  }
  return result;
}

export function unpackPosition(
  p: PackedPosition | any,
  networkOrPrices?: LighterNetwork | Map<string, number>,
  marketPrices?: Map<string, number>,
): PositionRiskAnalysis | null {
  if (!p) return null;
  if (!Array.isArray(p)) {
    if (p.marketId !== undefined && p.tier !== undefined) {
      return p as PositionRiskAnalysis;
    }
    return analyzePositionRisk(p);
  }

  const [marketId, symbol, isLongNum, entryPrice, size, liqPrice, storedMarkPrice, storedPnl] = p;
  if (size <= 0) return null;

  const isLong = isLongNum === 1;
  const cleanSym = String(symbol || "").toUpperCase();
  const baseSym = cleanSym.replace(/-PERP$/, "");

  let network: LighterNetwork | undefined;
  let prices: Map<string, number> | undefined;

  if (typeof networkOrPrices === "string") {
    network = networkOrPrices;
    prices = marketPrices;
  } else if (networkOrPrices instanceof Map) {
    prices = networkOrPrices;
  }

  // Network-scoped live price resolution
  let livePrice: number | undefined;
  if (prices) {
    if (network) {
      livePrice = prices.get(`${network}:${cleanSym}`) ?? prices.get(`${network}:${baseSym}`);
    }
    if (livePrice === undefined) {
      livePrice = prices.get(cleanSym) ?? prices.get(baseSym);
    }
  }

  // If live price is in memory, recalculate markPrice & PnL; otherwise fallback to stored cached values
  const markPrice =
    livePrice ??
    (storedMarkPrice !== undefined && storedMarkPrice > 0 ? storedMarkPrice : entryPrice);
  const posValue = size * markPrice;
  const unrealizedPnl =
    livePrice !== undefined
      ? (livePrice - entryPrice) * size * (isLong ? 1 : -1)
      : storedPnl !== undefined
        ? storedPnl
        : (markPrice - entryPrice) * size * (isLong ? 1 : -1);

  let distancePercent: number | null = null;
  let tier: AlertTier = "SAFE";

  if (liqPrice > 0 && markPrice > 0) {
    distancePercent = (Math.abs(markPrice - liqPrice) / markPrice) * 100;
    if (distancePercent <= CONFIG.TIERS.CRITICAL_2.maxDistance) {
      tier = "CRITICAL_2";
    } else if (distancePercent <= CONFIG.TIERS.DANGER_5.maxDistance) {
      tier = "DANGER_5";
    } else if (distancePercent <= CONFIG.TIERS.WARN_10.maxDistance) {
      tier = "WARN_10";
    }
  }

  return {
    marketId,
    symbol: cleanSym,
    isLong,
    size,
    posValue,
    entryPrice,
    markPrice,
    liqPrice,
    unrealizedPnl,
    distancePercent,
    tier,
  };
}

/**
 * Branchless / Zero-Alloc formatters for smart price display
 */
export function formatSmartPriceFast(price: number): string {
  if (price >= 1000) {
    const fixed = price.toFixed(2);
    const dot = fixed.indexOf(".");
    const intPart = dot === -1 ? fixed : fixed.substring(0, dot);
    const decPart = dot === -1 ? "" : fixed.substring(dot);

    let res = "";
    const len = intPart.length;
    for (let i = 0; i < len; i++) {
      if (i > 0 && (len - i) % 3 === 0) res += ",";
      res += intPart[i];
    }
    return res + decPart;
  }
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toFixed(8);
}

export function formatSmartPrice(price: number): string {
  return formatSmartPriceFast(price);
}

/**
 * Высокоточное форматирование цен (до 4 знаков), предотвращающее
 * округление центов на инструментах уровня SPY (~$600)
 */
export function formatPriceFine(price: number): string {
  if (price >= 1000) {
    const fixed = price.toFixed(4);
    const dot = fixed.indexOf(".");
    const intPart = fixed.substring(0, dot);
    let decPart = fixed.substring(dot);
    // Оставляем минимум 2 знака, убирая лишние хвостовые нули
    decPart = decPart.replace(/0+$/, "");
    if (decPart.length < 3) decPart = decPart.padEnd(3, "0");

    let res = "";
    const len = intPart.length;
    for (let i = 0; i < len; i++) {
      if (i > 0 && (len - i) % 3 === 0) res += ",";
      res += intPart[i];
    }
    return res + decPart;
  }
  if (price >= 1) {
    const fixed = price.toFixed(4);
    let decPart = fixed.substring(fixed.indexOf(".")).replace(/0+$/, "");
    if (decPart.length < 3) decPart = decPart.padEnd(3, "0");
    return fixed.substring(0, fixed.indexOf(".")) + decPart;
  }
  if (price >= 0.0001) return price.toFixed(6);
  return price.toFixed(8);
}

/**
 * Расчет базиса в $ и в bps относительно Core
 */
export function computeSpreadBasis(
  rhPrice: number,
  corePrice: number,
): { basisUsd: number; basisBps: number } {
  const basisUsd = rhPrice - corePrice;
  const basisBps = corePrice > 0 ? (basisUsd / corePrice) * 10000 : 0;
  return { basisUsd, basisBps };
}

/**
 * Парсинг пользовательского ввода порога спреда:
 * Принимает '0.15', '$0.15', '0,15', '5bps', '5 bps', '0.05%'
 */
export function parseSpreadThresholdInput(
  raw: string,
  referencePrice: number = 0,
): { value: number; unit: "usd" | "bps" } | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(",", ".");

  // BPS ввод (например: 5bps, 7.5 bps)
  if (cleaned.includes("bps")) {
    const numStr = cleaned.replace("bps", "").trim();
    const val = Math.abs(parseFloat(numStr));
    if (!isNaN(val) && val > 0 && val <= 500) {
      return { value: val, unit: "bps" };
    }
    return null;
  }

  // Процентный ввод (например: 0.05%) -> переводим в bps (1% = 100 bps)
  if (cleaned.includes("%")) {
    const numStr = cleaned.replace("%", "").trim();
    const val = Math.abs(parseFloat(numStr));
    if (!isNaN(val) && val > 0 && val <= 5) {
      return { value: Math.round(val * 100 * 10) / 10, unit: "bps" };
    }
    return null;
  }

  // Долларовый ввод (например: $0.15 или 0.15)
  const numStr = cleaned.replace("$", "").trim();
  const val = Math.abs(parseFloat(numStr));
  if (!isNaN(val) && val > 0) {
    if (referencePrice > 0 && val > referencePrice * 0.5) return null; // Защита от опечаток
    return { value: val, unit: "usd" };
  }

  return null;
}

export function isMuted(
  mutedUntil: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  return mutedUntil > nowSec;
}

export function formatMuteStatus(
  mutedUntil: number,
  nowSec: number = Math.floor(Date.now() / 1000),
  foreverTimestamp: number = 2147483647,
): string {
  if (mutedUntil <= nowSec) return "Активны 🔔";
  if (mutedUntil >= foreverTimestamp) return "Выключены (до включения) ⏸";
  const remainingMin = Math.ceil((mutedUntil - nowSec) / 60);
  if (remainingMin >= 60) {
    const hours = Math.floor(remainingMin / 60);
    const mins = remainingMin % 60;
    return mins > 0 ? `Заглушены еще ${hours}ч ${mins}м 🔕` : `Заглушены еще ${hours}ч 🔕`;
  }
  return `Заглушены еще ${remainingMin}м 🔕`;
}
