/**
 * Healthcheck ping utilities for heartbeat monitoring (Healthchecks.io, Cronitor, Better Stack, etc.).
 *
 * Supports:
 * - Success pings (POST/GET with execution metrics payload)
 * - Failure pings (/fail endpoint with diagnostic error details and stack trace in request body)
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
