import { InlineKeyboard } from "grammy";
import {
  PositionRiskAnalysis,
  LighterNetwork,
  PriceStepAlertParams,
  SpreadAlertParams,
  SpreadTargetRow,
} from "../types";
import { CONFIG } from "../config";
import { formatSmartPrice, formatPriceFine, computeSpreadBasis } from "../lighter/math";

export function formatPositionsReport(
  network: LighterNetwork,
  accountIndex: number,
  alias: string | null,
  collateral: number,
  positions: PositionRiskAnalysis[],
  _userThreshold: number = 1.5,
): string {
  const badge = CONFIG.NETWORKS[network]?.badge || `[${network.toUpperCase()}]`;
  const title = alias ? `<b>#${accountIndex} (${alias})</b>` : `<b>#${accountIndex}</b>`;

  let text = `💼 ${title} <code>${badge}</code> • <b>$${collateral.toFixed(2)}</b>\n\n`;

  if (positions.length === 0) {
    text += `<i>Нет открытых позиций</i>\n`;
    return text;
  }

  for (const pos of positions) {
    const sideBadge = pos.isLong ? "🟢 LONG" : "🔴 SHORT";
    text += `${sideBadge} <b>${pos.symbol}</b> • <b>${pos.size}</b>\n`;
    text += `• Вход: $${formatSmartPrice(pos.entryPrice)} ➔ Марк: $${formatSmartPrice(pos.markPrice)}\n`;
    const pnlSign = pos.unrealizedPnl >= 0 ? "📈 +" : "📉 -";
    const pnlFormatted = `${pnlSign}$${Math.abs(pos.unrealizedPnl).toFixed(2)}`;
    text += `• UnPnL: <b>${pnlFormatted}</b>\n`;

    if (pos.liqPrice > 0 && pos.distancePercent !== null) {
      text += `• Ликвидация: $${formatSmartPrice(pos.liqPrice)} (🛡${pos.distancePercent.toFixed(2)}%)\n`;
    } else {
      text += `• Ликвидация: <i>нет риска</i> 🛡\n`;
    }
    text += `\n`;
  }
  return text;
}

export function formatPriceStepAlert(params: PriceStepAlertParams): string {
  const badge = CONFIG.NETWORKS[params.network]?.badge || `[${params.network.toUpperCase()}]`;
  const accTitle = params.alias
    ? `<b>#${params.accountIndex} (${params.alias})</b>`
    : `<b>#${params.accountIndex}</b>`;
  const sideBadge = params.isLong ? "🟢 LONG" : "🔴 SHORT";

  // Стрелка и знак шага
  const stepArrow = params.priceDeltaPercent > 0 ? "↗️ +" : "↘️ ";

  // Общее отклонение от входа
  const totalMovePercent =
    params.entryPrice > 0
      ? ((params.currentPrice - params.entryPrice) / params.entryPrice) * 100
      : 0;
  const totalSign = totalMovePercent > 0 ? "+" : "";

  // Форматирование PnL
  const pnlSign = params.unrealizedPnl >= 0 ? "📈 +" : "📉 -";
  const pnlFormatted = `${pnlSign}$${Math.abs(params.unrealizedPnl).toFixed(2)}`;

  // Блок ликвидации
  let liqSection = `• Ликвидация: <i>нет риска</i> 🛡`;
  if (params.liqPrice > 0 && params.distancePercent !== null) {
    liqSection = `• Ликвидация: <b>$${formatSmartPrice(params.liqPrice)}</b> (до неё <b>${params.distancePercent.toFixed(2)}%</b>)`;
  }

  return (
    `⚡️ <b>${params.symbol} ${badge} — $${formatSmartPrice(params.currentPrice)}</b>\n` +
    `💼 ${accTitle} • ${sideBadge}\n\n` +
    `• Импульс: <b>${stepArrow}${params.priceDeltaPercent.toFixed(2)}%</b> (с $${formatSmartPrice(params.baselinePrice)})\n` +
    `• Позиция: <b>${pnlFormatted}</b> (${totalSign}${totalMovePercent.toFixed(2)}% от $${formatSmartPrice(params.entryPrice)})\n` +
    `${liqSection}`
  );
}

// ==========================================
// ФОРМАТТЕРЫ ТАРГЕТОВ СПРЕДА RH vs CORE
// ==========================================

export function formatSpreadAlert(params: SpreadAlertParams): string {
  const dirHeader =
    params.direction === "rh_cheaper"
      ? "🟢 <b>RH &lt; Core</b> (Long RH / Short Core)"
      : "🔵 <b>RH &gt; Core</b> (Short RH / Long Core)";

  const basisSign = params.basisSigned >= 0 ? "+" : "-";
  const bpsSign = params.basisBps >= 0 ? "+" : "";

  const targetStr =
    params.unit === "bps"
      ? `${params.targetDelta.toFixed(1)} bps`
      : `$${params.targetDelta.toFixed(3)}`;

  return (
    `⚖️ <b>SPREAD TARGET: ${params.symbol}</b>\n` +
    `${dirHeader}\n\n` +
    `• 🟠 RH Price: <b>$${formatPriceFine(params.rhPrice)}</b>\n` +
    `• ⚡️ Core Price: <b>$${formatPriceFine(params.corePrice)}</b>\n` +
    `• 📐 Текущий базис: <b>${basisSign}$${Math.abs(params.basisSigned).toFixed(3)}</b> (<code>${bpsSign}${params.basisBps.toFixed(2)} bps</code>)\n` +
    `• 🎯 Таргет: <b>${targetStr}</b> (выполнен на <b>$${params.actualDiff.toFixed(3)}</b>)`
  );
}

export function getSpreadAlertKeyboard(targetId: number | string, symbol: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔕 1ч", `sp_sym_mute:${symbol}:3600`)
    .text("🔕 4ч", `sp_sym_mute:${symbol}:14400`)
    .row()
    .text("🔕 24ч", `sp_sym_mute:${symbol}:86400`)
    .text("⏸ Выкл", `sp_sym_mute:${symbol}:off`);
}

export function formatSpreadHubView(
  targets: SpreadTargetRow[],
  quotes: Map<string, { rhPrice: number; corePrice: number }>,
  _isMutedAll: boolean = false,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const uniqueSymbols = Array.from(new Set(targets.map((t) => t.symbol)));

  const dateObj = new Date(nowSec * 1000);
  const timeStr = dateObj.toLocaleTimeString("ru-RU", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  if (targets.length === 0) {
    let emptyText =
      `<i>У вас пока нет настроенных таргетов спреда.</i>\n\n` +
      `Нажмите <b>✏️ Изменить</b> ниже, чтобы выбрать токен (например, SPY, QQQ, XAU, NVDA, AAPL) ` +
      `и настроить уведомления о спреде!`;

    emptyText += `\n\n🕒 <i>Обновлено: ${timeStr} UTC</i>`;
    return emptyText;
  }

  const separator = "\n─────────────\n";
  const cards: string[] = [];

  for (const sym of uniqueSymbols) {
    const symTargets = targets.filter((t) => t.symbol === sym);
    const quote = quotes.get(sym);

    let card = `<b>${sym}</b>`;
    if (quote && quote.rhPrice > 0 && quote.corePrice > 0) {
      const { basisUsd, basisBps } = computeSpreadBasis(quote.rhPrice, quote.corePrice);
      const sign = basisUsd >= 0 ? "+" : "-";
      card += ` • Базис: <b>${sign}$${Math.abs(basisUsd).toFixed(3)}</b> (<code>${basisBps >= 0 ? "+" : ""}${basisBps.toFixed(2)} bps</code>)\n`;
      card += `• 🟠 RH: $${formatPriceFine(quote.rhPrice)}\n`;
      card += `• ⚡️ Core: $${formatPriceFine(quote.corePrice)}\n\n`;
    } else {
      card += `\n\n`;
    }

    const targetLines: string[] = [];
    for (const t of symTargets) {
      const dirIcon = t.direction === "rh_cheaper" ? "🟢" : "🔵";
      const dirText = t.direction === "rh_cheaper" ? "RH &lt; Core" : "RH &gt; Core";
      let targetVal = "";
      const refPrice = quote && quote.corePrice > 0 ? quote.corePrice : quote?.rhPrice || 0;

      const sign = t.direction === "rh_cheaper" ? "-" : "+";
      if (t.unit === "bps") {
        if (refPrice > 0) {
          const cents = (refPrice * t.target_delta) / 10000;
          const centsFormatted = cents >= 1 ? cents.toFixed(2) : cents.toFixed(3);
          targetVal = `${t.target_delta.toFixed(1)} bps (${sign}$${centsFormatted})`;
        } else {
          targetVal = `${t.target_delta.toFixed(1)} bps`;
        }
      } else {
        if (refPrice > 0) {
          const bps = (t.target_delta / refPrice) * 10000;
          targetVal = `$${t.target_delta.toFixed(2)} (${sign}${bps.toFixed(1)} bps)`;
        } else {
          targetVal = `$${t.target_delta.toFixed(2)}`;
        }
      }

      let statusBadge = "";
      if (t.is_active === 0) {
        statusBadge = " [⏸ Выключен]";
      } else if (t.muted_until > nowSec) {
        const leftMin = Math.ceil((t.muted_until - nowSec) / 60);
        statusBadge = ` [🔕 еще ${leftMin}м]`;
      } else if (t.armed === 0) {
        statusBadge = " [⏳ Ждет отката]";
      }

      targetLines.push(`${dirIcon} ${dirText} на <b>≥${targetVal}</b>${statusBadge}`);
    }

    card += targetLines.join("\n");
    cards.push(card.trim());
  }

  let text = cards.join(separator);
  text += `\n\n🕒 <i>Обновлено: ${timeStr} UTC</i>`;

  return text;
}
