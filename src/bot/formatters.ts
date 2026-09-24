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

export function formatPriceStepAlert(params: PriceStepAlertParams): string {
  const badge = CONFIG.NETWORKS[params.network]?.badge || `[${params.network.toUpperCase()}]`;
  const accTitle = params.alias ? `<b>#${params.accountIndex} (${params.alias})</b>` : `<b>#${params.accountIndex}</b>`;
  const sideBadge = params.isLong ? "🟢 LONG" : "🔴 SHORT";
  
  // 1. Локальный импульс с прошлой засечки
  const isProfitableStep = params.isLong ? (params.priceDeltaPercent > 0) : (params.priceDeltaPercent < 0);
  const stepEmoji = isProfitableStep ? "🟢" : "🔴";
  const stepLabel = isProfitableStep ? "В плюс" : "В просадку";
  const stepArrow = params.priceDeltaPercent > 0 ? "↗️ +" : "↘️ ";

  // 2. Глобальный результат от цены входа
  const totalMovePercent = params.entryPrice > 0 
    ? ((params.currentPrice - params.entryPrice) / params.entryPrice) * 100 
    : 0;
  
  let totalLabel = "Безубыток";
  let totalEmoji = "⚪️";
  if (Math.abs(totalMovePercent) >= 0.05) {
    const isProfitableTotal = params.isLong ? (totalMovePercent > 0) : (totalMovePercent < 0);
    totalEmoji = isProfitableTotal ? "🟢" : "🔴";
    totalLabel = isProfitableTotal ? "В плюс" : "В просадку";
  }
  const totalSign = totalMovePercent > 0 ? "+" : "";

  // 3. Запас прочности / Риск ликвидации
  let liqSection = `• Цена ликвидации: <i>нет риска</i> 🛡`;
  if (params.liqPrice > 0 && params.distancePercent !== null) {
    let liqWarn = "";
    if (params.distancePercent <= 1.0) {
      liqWarn = " 🚨 <b>[КРИТИЧНО]</b>";
    } else if (params.distancePercent <= 2.5) {
      liqWarn = " ⚠️ <b>[ОПАСНО]</b>";
    } else if (params.distancePercent <= 4.0) {
      liqWarn = " ⚡️";
    }
    liqSection = 
      `• Цена ликвидации: <b>$${formatSmartPrice(params.liqPrice)}</b>\n` +
      `• До ликвидации осталось: <b>${params.distancePercent.toFixed(2)}%</b>${liqWarn}`;
  }

  const pnlSign = params.unrealizedPnl >= 0 ? "📈" : "📉";
  const pnlFormatted = params.unrealizedPnl >= 0 
    ? `+$${params.unrealizedPnl.toFixed(2)}` 
    : `-$${Math.abs(params.unrealizedPnl).toFixed(2)}`;

  return (
    `⚡️ <b>Движение ${params.symbol} ${badge}</b>\n\n` +
    `💼 Аккаунт: ${accTitle}\n` +
    `📊 Позиция: <b>${sideBadge} ${params.symbol}</b> (Вход: $${formatSmartPrice(params.entryPrice)})\n\n` +
    `1️⃣ <b>Локальный импульс:</b>\n` +
    `• С прошлой засечки: <b>${stepArrow}${params.priceDeltaPercent.toFixed(2)}% ($${formatSmartPrice(params.baselinePrice)} ➔ $${formatSmartPrice(params.currentPrice)})</b> ${stepEmoji} <i>${stepLabel}</i>\n\n` +
    `2️⃣ <b>Глобальное состояние позиции:</b>\n` +
    `• Ход от точки входа: <b>${totalSign}${totalMovePercent.toFixed(2)}%</b> (${totalEmoji} <i>${totalLabel}</i>)\n` +
    `• Текущий UnPnL: ${pnlSign} <b>${pnlFormatted}</b>\n\n` +
    `3️⃣ <b>Запас прочности (безопасность):</b>\n` +
    `${liqSection}\n\n` +
    `<i>Нажмите кнопку ниже, чтобы открыть карточку сделки:</i>`
  );
}

