import { Env } from "../types";
import { Api } from "grammy";
import { escapeHtml } from "../bot/release_notifier";

/**
 * Healthcheck ping utilities for heartbeat monitoring (Healthchecks.io, Cronitor, Better Stack, etc.).
 *
 * Supports:
 * - Success pings (POST/GET with execution metrics payload)
 * - Failure pings (/fail endpoint with diagnostic error details and stack trace in request body)
 * - Automated Admin Outage & Recovery notifications via Telegram
 */

export function getHealthcheckFailUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname.endsWith("/fail")) {
      pathname += "/fail";
    }
    parsed.pathname = pathname;
    return parsed.toString();
  } catch {
    const cleaned = trimmed.replace(/\/+$/, "");
    return cleaned.endsWith("/fail") ? cleaned : `${cleaned}/fail`;
  }
}

export function getHealthcheckSuccessUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/fail")) {
      pathname = pathname.slice(0, -"/fail".length);
    } else if (pathname.endsWith("/start")) {
      pathname = pathname.slice(0, -"/start".length);
    }
    parsed.pathname = pathname;
    return parsed.toString();
  } catch {
    let cleaned = trimmed.replace(/\/+$/, "");
    if (cleaned.endsWith("/fail")) {
      cleaned = cleaned.slice(0, -"/fail".length);
    } else if (cleaned.endsWith("/start")) {
      cleaned = cleaned.slice(0, -"/start".length);
    }
    return cleaned;
  }
}

/**
 * Pings the healthcheck service indicating successful execution.
 */
export async function pingHealthcheckSuccess(
  url?: string,
  payload?: Record<string, any>,
): Promise<void> {
  if (!url || !url.trim()) return;
  const successUrl = getHealthcheckSuccessUrl(url);

  try {
    let body: string | undefined;
    let headers: Record<string, string> | undefined;

    if (payload && Object.keys(payload).length > 0) {
      body = JSON.stringify(payload);
      if (body.length > 100_000) {
        body = body.slice(0, 99_900) + "\n... [truncated]";
      }
      headers = { "Content-Type": "application/json" };
    }

    const res = await fetch(successUrl, {
      method: body ? "POST" : "GET",
      body,
      headers,
      signal: AbortSignal.timeout(5000),
    });

    // If server does not accept POST (405 Method Not Allowed), fallback to GET
    if (!res.ok && res.status === 405 && body) {
      await fetch(successUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch (err) {
    console.warn("[Healthcheck] Failed to send success ping to", successUrl, err);
  }
}

/**
 * Pings the healthcheck service indicating task failure (/fail endpoint)
 * with diagnostic error details and stack trace in the request body.
 */
export async function pingHealthcheckFail(
  url?: string,
  error?: unknown,
  details?: Record<string, any>,
): Promise<void> {
  if (!url || !url.trim()) return;
  const failUrl = getHealthcheckFailUrl(url);

  const errName = error instanceof Error ? error.name : "Error";
  const errMessage = error instanceof Error ? error.message : String(error || "Unknown error");
  const stack = error instanceof Error && error.stack ? error.stack : undefined;

  let body =
    `CRON MONITOR EXECUTION FAILED\n` +
    `Time: ${new Date().toISOString()}\n` +
    `Error: ${errName}: ${errMessage}\n`;

  if (stack) {
    body += `\nStack trace:\n${stack}\n`;
  }

  if (details && Object.keys(details).length > 0) {
    body += `\nContext:\n${JSON.stringify(details, null, 2)}\n`;
  }

  if (body.length > 100_000) {
    body = body.slice(0, 99_900) + "\n... [truncated]";
  }

  try {
    const res = await fetch(failUrl, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok && res.status === 405) {
      await fetch(failUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch {
    // If POST failed, try simple GET fallback
    try {
      await fetch(failUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
    } catch (getErr) {
      console.warn("[Healthcheck] Failed to send fail ping to", failUrl, getErr);
    }
  }
}

/**
 * Resolves Telegram IDs of administrators who should receive outage/recovery alerts.
 * Supports:
 * - Direct numeric IDs (or comma-separated list) from env.ADMIN_TELEGRAM_ID
 * - Username lookup (@username) in the `users` table
 * - Fallback to the first registered user in the database if no admin env is set
 */
export async function resolveAdminTelegramIds(db?: D1Database, env?: Env): Promise<number[]> {
  const ids = new Set<number>();

  if (env?.ADMIN_TELEGRAM_ID) {
    const rawAdmin = env.ADMIN_TELEGRAM_ID.trim();
    const tokens = rawAdmin
      .split(",")
      .map((s) =>
        s
          .trim()
          .replace(/^["']|["']$/g, "")
          .replace(/^ADMIN_TELEGRAM_ID\s*=\s*/i, ""),
      )
      .filter(Boolean);

    for (const token of tokens) {
      if (/^-?\d+$/.test(token)) {
        ids.add(parseInt(token, 10));
      } else if (db && (token.startsWith("@") || /^[a-zA-Z0-9_]+$/.test(token))) {
        const cleanUsername = token.replace(/^@/, "").toLowerCase();
        try {
          const userRow = await db
            .prepare("SELECT telegram_id FROM users WHERE LOWER(username) = ? LIMIT 1")
            .bind(cleanUsername)
            .first<{ telegram_id: number }>();
          if (userRow?.telegram_id) {
            ids.add(userRow.telegram_id);
          }
        } catch (err) {
          console.warn("[Healthcheck] Failed to resolve username to telegram_id:", token, err);
        }
      }
    }
  }

  // Fallback to earliest registered user if no explicit IDs were resolved
  if (ids.size === 0 && db) {
    try {
      const firstUser = await db
        .prepare("SELECT telegram_id FROM users ORDER BY created_at ASC LIMIT 1")
        .first<{ telegram_id: number }>();
      if (firstUser?.telegram_id) {
        ids.add(firstUser.telegram_id);
      }
    } catch (err) {
      console.warn("[Healthcheck] Failed to fallback to first user for admin alert:", err);
    }
  }

  return Array.from(ids);
}

export const OUTAGE_ALERT_COOLDOWN_SEC = 900; // 15 минут между повторными уведомлениями об аварии

export interface AdminOutageState {
  is_outage: boolean;
  first_detected_at: number;
  last_alerted_at: number;
  reason: string;
  rate_limits_count: number;
}

/**
 * Checks outage status and alerts administrators via Telegram if degradation is detected.
 * Enforces a 15-minute cooldown between repeated alerts to prevent spam during long outages.
 */
export async function checkAndNotifyAdminOutage(
  env: Env,
  reason: string,
  rateLimitsCount: number,
  nowSec: number,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  let currentState: AdminOutageState | null = null;
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        "SELECT value_json FROM bot_system_metrics WHERE key = 'admin_outage_state' LIMIT 1",
      ).first<{ value_json: string }>();
      if (row?.value_json) {
        currentState = JSON.parse(row.value_json) as AdminOutageState;
      }
    } catch (err) {
      console.warn("[Healthcheck] Failed to read admin_outage_state from DB:", err);
    }
  }

  const isNewOutage = !currentState || !currentState.is_outage;
  const shouldAlert =
    isNewOutage || nowSec - (currentState?.last_alerted_at || 0) >= OUTAGE_ALERT_COOLDOWN_SEC;

  if (!shouldAlert) {
    return;
  }

  const adminIds = await resolveAdminTelegramIds(env.DB, env);
  if (adminIds.length === 0) {
    console.warn("[Healthcheck] No admin Telegram ID resolved to send outage alert");
    return;
  }

  const firstDetectedAt = isNewOutage ? nowSec : (currentState?.first_detected_at ?? nowSec);
  const outageDurationMin = Math.round((nowSec - firstDetectedAt) / 60);

  let message: string;
  if (isNewOutage) {
    message =
      `🚨 <b>Внимание: Сбой API биржи Lighter</b>\n\n` +
      `Обнаружены проблемы при выполнении планового мониторинга:\n` +
      `• <b>Причина:</b> ${escapeHtml(reason)}\n` +
      `• <b>Рейт-лимиты (429):</b> <b>${rateLimitsCount}</b>\n` +
      `• <b>Healthcheck:</b> Отправлен сигнал <code>/fail</code>\n\n` +
      `<i>Бот переведён в защитный режим с кэшированными данными до восстановления связи.</i>`;
  } else {
    message =
      `⚠️ <b>Lighter Monitor: Сбой продолжается (~${outageDurationMin} мин)</b>\n\n` +
      `• <b>Причина:</b> ${escapeHtml(reason)}\n` +
      `• <b>Рейт-лимиты (429):</b> <b>${rateLimitsCount}</b>\n` +
      `• <b>Healthcheck:</b> Статус <code>/fail</code> остаётся активным\n\n` +
      `<i>Повторное уведомление (кулдаун 15 минут).</i>`;
  }

  const api = new Api(env.TELEGRAM_BOT_TOKEN, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  });
  for (const adminId of adminIds) {
    try {
      await api.sendMessage(adminId, message, { parse_mode: "HTML" });
    } catch (err) {
      console.error(`[Healthcheck] Failed to send outage alert to admin ${adminId}:`, err);
    }
  }

  if (env.DB) {
    const newState: AdminOutageState = {
      is_outage: true,
      first_detected_at: firstDetectedAt,
      last_alerted_at: nowSec,
      reason,
      rate_limits_count: rateLimitsCount,
    };

    try {
      await env.DB.prepare(`
        INSERT INTO bot_system_metrics (key, value_json, updated_at)
        VALUES ('admin_outage_state', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
        .bind(JSON.stringify(newState), nowSec)
        .run();
    } catch (err) {
      console.error("[Healthcheck] Failed to persist admin_outage_state:", err);
    }
  }
}

/**
 * Checks if the exchange recovered from an active outage and notifies administrators via Telegram.
 */
export async function checkAndNotifyAdminRecovery(env: Env, nowSec: number): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.DB) return;

  let currentState: AdminOutageState | null = null;
  try {
    const row = await env.DB.prepare(
      "SELECT value_json FROM bot_system_metrics WHERE key = 'admin_outage_state' LIMIT 1",
    ).first<{ value_json: string }>();
    if (row?.value_json) {
      currentState = JSON.parse(row.value_json) as AdminOutageState;
    }
  } catch (err) {
    console.warn("[Healthcheck] Failed to read admin_outage_state for recovery check:", err);
  }

  if (!currentState || !currentState.is_outage) {
    return; // Нет активного сбоя
  }

  const outageDurationMin = Math.max(
    1,
    Math.round((nowSec - (currentState.first_detected_at || nowSec)) / 60),
  );

  const adminIds = await resolveAdminTelegramIds(env.DB, env);
  if (adminIds.length > 0) {
    const message =
      `✅ <b>Lighter Monitor: Связь с биржей восстановлена</b>\n\n` +
      `Все эндпоинты Lighter API снова отвечают в штатном режиме.\n` +
      `• <b>Длительность сбоя:</b> ~${outageDurationMin} мин\n` +
      `• <b>Healthcheck:</b> Переведен в статус <code>OK</code>\n\n` +
      `<i>Синхронизация позиций и мониторинг спредов возобновлены.</i>`;

    const api = new Api(env.TELEGRAM_BOT_TOKEN, {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
    });
    for (const adminId of adminIds) {
      try {
        await api.sendMessage(adminId, message, { parse_mode: "HTML" });
      } catch (err) {
        console.error(`[Healthcheck] Failed to send recovery notice to admin ${adminId}:`, err);
      }
    }
  }

  const recoveredState = {
    is_outage: false,
    first_detected_at: currentState.first_detected_at,
    recovered_at: nowSec,
    duration_min: outageDurationMin,
    last_reason: currentState.reason,
  };

  try {
    await env.DB.prepare(`
      INSERT INTO bot_system_metrics (key, value_json, updated_at)
      VALUES ('admin_outage_state', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `)
      .bind(JSON.stringify(recoveredState), nowSec)
      .run();
  } catch (err) {
    console.error("[Healthcheck] Failed to update recovered admin_outage_state:", err);
  }
}
