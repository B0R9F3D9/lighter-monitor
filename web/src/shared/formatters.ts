export function formatMoney(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return "$0.00";
  const sign = num < 0 ? "-" : "";
  const abs = Math.abs(num);
  if (abs >= 1e9) return sign + "$" + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(2);
}

export function formatPrice(p: number | undefined | null): string {
  if (p === undefined || p === null || isNaN(p)) return "$0.00";
  if (Math.abs(p) < 0.00005) return "$0.00";
  const sign = p < 0 ? "-" : "";
  const abs = Math.abs(p);
  if (abs < 1) return sign + "$" + abs.toFixed(4);
  if (abs < 10) return sign + "$" + abs.toFixed(3);
  return sign + "$" + abs.toFixed(2);
}

export function formatBps(b: number | undefined | null, withSign = false): string {
  if (b === undefined || b === null || isNaN(b)) return "0.00 bps";
  const sign = b > 0 && withSign ? "+" : "";
  return sign + b.toFixed(2) + " bps";
}

export function formatBaseQty(qty: number | undefined | null): string {
  if (qty === undefined || qty === null || isNaN(qty) || qty <= 0) return "0.0";
  if (qty >= 50) return qty.toFixed(1);
  if (qty >= 1) return qty.toFixed(2);
  return qty.toFixed(4);
}

export function formatDeltaMid(
  deltaUsd: number | undefined | null,
  _deltaBps?: number | undefined | null,
): string {
  if (deltaUsd === undefined || deltaUsd === null || isNaN(deltaUsd)) return "Δ: $0.00";
  const sign = deltaUsd >= 0 ? "+" : "-";
  const abs = Math.abs(deltaUsd);
  const formattedUsd = abs < 1 ? abs.toFixed(3) : abs.toFixed(2);
  return `Δ: ${sign}$${formattedUsd}`;
}
