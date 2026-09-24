import { PositionRiskAnalysis } from "../types";
import { formatSmartPrice } from "../lighter/math";

export function formatPositionsReport(
  accountIndex: number, 
  alias: string | null, 
  l1Address: string, 
  collateral: number, 
  positions: PositionRiskAnalysis[]
): string {
  const shortAddr = l1Address ? `${l1Address.slice(0, 6)}...${l1Address.slice(-4)}` : "—";
  const title = alias ? `<b>#${accountIndex} (${alias})</b>` : `<b>#${accountIndex}</b>`;
  
  let text = `Аккаунт: ${title}\n`;
  text += `Кошелек: <code>${shortAddr}</code>\n`;
  text += `Коллатерал: $${collateral.toFixed(2)}\n\n`;

  if (positions.length === 0) {
    text += `<i>Нет открытых позиций</i>\n`;
    return text;
  }

  for (const pos of positions) {
    const side = pos.isLong ? "[LONG]" : "[SHORT]";
    text += `<b>${pos.symbol}</b> ${side} (mId: ${pos.marketId})\n`;
    text += `• Размер: ${pos.size}\n`;
    text += `• Вход: $${formatSmartPrice(pos.entryPrice)} | Марк: $${formatSmartPrice(pos.markPrice)}\n`;
    const pnlFormatted = pos.unrealizedPnl >= 0 ? `+$${pos.unrealizedPnl.toFixed(2)}` : `-$${Math.abs(pos.unrealizedPnl).toFixed(2)}`;
    text += `• UnPnL: ${pnlFormatted}\n`;

    if (pos.liqPrice > 0 && pos.distancePercent !== null) {
      let badge = "";
      if (pos.tier === 'CRITICAL_2') badge = " [КРИТИЧНО]";
      else if (pos.tier === 'DANGER_5') badge = " [ОПАСНО]";
      else if (pos.tier === 'WARN_10') badge = " [ВНИМАНИЕ]";

      text += `• Ликвидация: $${formatSmartPrice(pos.liqPrice)} (<b>${pos.distancePercent.toFixed(2)}%</b>${badge})\n`;
    } else {
      text += `• Ликвидация: <i>нет риска</i>\n`;
    }
    text += `\n`;
  }
  return text;
}

export function formatLiquidationAlert(accountIndex: number, alias: string | null, pos: PositionRiskAnalysis): string {
  const label = pos.tier === 'CRITICAL_2' ? "КРИТИЧЕСКИЙ РИСК ЛИКВИДАЦИИ" : "РИСК ЛИКВИДАЦИИ";
  const accName = alias ? `#${accountIndex} (${alias})` : `#${accountIndex}`;

  return `⚠️ <b>${label}</b>\n\n` +
    `Аккаунт: <b>${accName}</b>\n` +
    `Инструмент: <b>${pos.symbol}</b> (${pos.isLong ? "LONG" : "SHORT"})\n` +
    `• До ликвидации: <b>${pos.distancePercent?.toFixed(2)}%</b>\n` +
    `• Текущая цена: $${formatSmartPrice(pos.markPrice)}\n` +
    `• Цена ликвидации: $${formatSmartPrice(pos.liqPrice)}\n` +
    `• Размер позиции: ${pos.size} ($${pos.posValue.toFixed(2)})\n` +
    `• UnPnL: ${pos.unrealizedPnl >= 0 ? `+$${pos.unrealizedPnl.toFixed(2)}` : `-$${Math.abs(pos.unrealizedPnl).toFixed(2)}`}\n\n` +
    `Рекомендуется пополнить маржу или сократить позицию.`;
}

export function formatPositionWipedAlert(accountIndex: number, alias: string | null, symbol: string): string {
  const accName = alias ? `#${accountIndex} (${alias})` : `#${accountIndex}`;
  return `❗️ <b>ПОЗИЦИЯ ЗАКРЫТА ИЛИ ЛИКВИДИРОВАНА</b>\n\n` +
    `Аккаунт: <b>${accName}</b>\n` +
    `Инструмент: <b>${symbol}</b>\n\n` +
    `Позиция с высоким риском больше не числится открытой в Lighter. Проверьте баланс на бирже.`;
}
