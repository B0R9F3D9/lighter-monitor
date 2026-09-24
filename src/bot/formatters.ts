import { PositionRiskAnalysis, LighterNetwork } from "../types";
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

export function formatLiquidationAlert(
  network: LighterNetwork,
  accountIndex: number, 
  alias: string | null, 
  pos: PositionRiskAnalysis
): string {
  const badge = CONFIG.NETWORKS[network]?.badge || `[${network.toUpperCase()}]`;
  const isCrit = pos.distancePercent !== null && pos.distancePercent <= 1.0;
  const header = isCrit ? "💥 <b>КРИТИЧЕСКИЙ РИСК ЛИКВИДАЦИИ!</b>" : "🚨 <b>ВНИМАНИЕ: РИСК ЛИКВИДАЦИИ!</b>";
  const accName = alias ? `#${accountIndex} (${alias})` : `#${accountIndex}`;
  const sideBadge = pos.isLong ? "🟢 LONG" : "🔴 SHORT";
  const pnlSign = pos.unrealizedPnl >= 0 ? "📈" : "📉";
  const pnlFormatted = pos.unrealizedPnl >= 0 ? `+$${pos.unrealizedPnl.toFixed(2)}` : `-$${Math.abs(pos.unrealizedPnl).toFixed(2)}`;

  return `${header}\n\n` +
    `💼 Аккаунт: <b>${accName} ${badge}</b>\n` +
    `📊 Инструмент: <b>${pos.symbol}</b> (${sideBadge})\n` +
    `⚠️ До ликвидации: <b>${pos.distancePercent?.toFixed(2)}%</b> 🚨\n` +
    `• Текущая цена: $${formatSmartPrice(pos.markPrice)}\n` +
    `• Цена ликвидации: $${formatSmartPrice(pos.liqPrice)}\n` +
    `• Размер позиции: ${pos.size} ($${pos.posValue.toFixed(2)})\n` +
    `• UnPnL: ${pnlSign} ${pnlFormatted}\n\n` +
    `⚠️ <i>Рекомендуется пополнить маржу или сократить позицию!</i>`;
}

export function formatPositionWipedAlert(
  network: LighterNetwork,
  accountIndex: number, 
  alias: string | null, 
  symbol: string
): string {
  const badge = CONFIG.NETWORKS[network]?.badge || `[${network.toUpperCase()}]`;
  const accName = alias ? `#${accountIndex} (${alias})` : `#${accountIndex}`;
  return `💀 <b>ВНИМАНИЕ! ПОЗИЦИЯ ЗАКРЫТА ИЛИ ЛИКВИДИРОВАНА</b>\n\n` +
    `💼 Аккаунт: <b>${accName} ${badge}</b>\n` +
    `📊 Инструмент: <b>${symbol}</b>\n\n` +
    `Позиция с высоким риском больше не числится открытой в Lighter. Проверьте баланс на бирже.`;
}
