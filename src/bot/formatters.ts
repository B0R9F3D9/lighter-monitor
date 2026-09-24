import { PositionRiskAnalysis, LighterNetwork, PriceStepAlertParams } from "../types";
import { CONFIG } from "../config";
import { formatSmartPrice } from "../lighter/math";

export function formatPositionsReport(
  network: LighterNetwork,
  accountIndex: number, 
  alias: string | null, 
  l1Address: string, 
  collateral: number, 
  positions: PositionRiskAnalysis[],
  userThreshold: number = 1.5
): string {
  const badge = CONFIG.NETWORKS[network]?.badge || `[${network.toUpperCase()}]`;
  const shortAddr = l1Address ? `${l1Address.slice(0, 6)}...${l1Address.slice(-4)}` : "—";
  const title = alias ? `<b>#${accountIndex} (${alias})</b>` : `<b>#${accountIndex}</b>`;
  
  let text = `💼 <b>Аккаунт:</b> ${title} <code>${badge}</code>\n`;
  text += `💳 <b>Кошелек:</b> <code>${shortAddr}</code>\n`;
  text += `💰 <b>Коллатерал:</b> $${collateral.toFixed(2)}\n\n`;

  if (positions.length === 0) {
    text += `<i>Нет открытых позиций</i>\n`;
    return text;
  }

  for (const pos of positions) {
    const sideBadge = pos.isLong ? "🟢 LONG" : "🔴 SHORT";
    text += `${sideBadge} <b>${pos.symbol}</b>\n`;
    text += `• Размер: ${pos.size}\n`;
    text += `• Вход: $${formatSmartPrice(pos.entryPrice)} | Марк: $${formatSmartPrice(pos.markPrice)}\n`;
    const pnlSign = pos.unrealizedPnl >= 0 ? "📈" : "📉";
    const pnlFormatted = pos.unrealizedPnl >= 0 ? `+$${pos.unrealizedPnl.toFixed(2)}` : `-$${Math.abs(pos.unrealizedPnl).toFixed(2)}`;
    text += `• UnPnL: ${pnlSign} ${pnlFormatted}\n`;

    if (pos.liqPrice > 0 && pos.distancePercent !== null) {
      let alertBadge = "";
      let icon = "🛡";
      if (pos.distancePercent <= 1.0) {
        alertBadge = " 🚨 [КРИТИЧНО]";
        icon = "💥";
      } else if (pos.distancePercent <= userThreshold) {
        alertBadge = " ⚠️ [ОПАСНО]";
        icon = "⚠️";
      } else if (pos.distancePercent <= userThreshold * 1.5) {
        alertBadge = " [ВНИМАНИЕ]";
        icon = "⚡️";
      }

      text += `• Ликвидация: $${formatSmartPrice(pos.liqPrice)} (${icon} <b>${pos.distancePercent.toFixed(2)}%</b>${alertBadge})\n`;
    } else {
      text += `• Ликвидация: <i>нет риска</i> 🛡\n`;
    }
    text += `\n`;
  }
  return text;
}


export function formatPriceStepAlert(params: PriceStepAlertParams): string {
  const badge = CONFIG.NETWORKS[params.network]?.badge || `[${params.network.toUpperCase()}]`;
  const accTitle = params.alias ? `<b>#${params.accountIndex} (${params.alias})</b>` : `<b>#${params.accountIndex}</b>`;
  const sideBadge = params.isLong ? "🟢 LONG" : "🔴 SHORT";
  
  // Стрелка и знак шага
  const stepArrow = params.priceDeltaPercent > 0 ? "↗️ +" : "↘️ ";
  
  // Общее отклонение от входа
  const totalMovePercent = params.entryPrice > 0 
    ? ((params.currentPrice - params.entryPrice) / params.entryPrice) * 100 
    : 0;
  const totalSign = totalMovePercent > 0 ? "+" : "";

  // Форматирование PnL
  const pnlSign = params.unrealizedPnl >= 0 ? "📈 +" : "📉 -";
  const pnlFormatted = `${pnlSign}$${Math.abs(params.unrealizedPnl).toFixed(2)}`;

  // Блок ликвидации
  let liqSection = `• Ликвидация: <i>нет риска</i> 🛡`;
  if (params.liqPrice > 0 && params.distancePercent !== null) {
    let liqWarn = "";
    if (params.distancePercent <= 1.0) {
      liqWarn = " 🚨 <b>[КРИТИЧНО]</b>";
    } else if (params.distancePercent <= 2.5) {
      liqWarn = " ⚠️ <b>[ОПАСНО]</b>";
    }
    liqSection = `• Ликвидация: <b>$${formatSmartPrice(params.liqPrice)}</b> (до неё <b>${params.distancePercent.toFixed(2)}%</b>${liqWarn})`;
  }

  return (
    `⚡️ <b>${params.symbol} ${badge} — $${formatSmartPrice(params.currentPrice)}</b>\n` +
    `💼 ${accTitle} • ${sideBadge}\n\n` +
    `• Импульс: <b>${stepArrow}${params.priceDeltaPercent.toFixed(2)}%</b> (с $${formatSmartPrice(params.baselinePrice)})\n` +
    `• Позиция: <b>${pnlFormatted}</b> (${totalSign}${totalMovePercent.toFixed(2)}% от $${formatSmartPrice(params.entryPrice)})\n` +
    `${liqSection}`
  );
}

