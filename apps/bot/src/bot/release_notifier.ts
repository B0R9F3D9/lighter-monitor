import { Api, InlineKeyboard } from "grammy";
import { Env } from "../types";
import { CONFIG } from "../config";
import {
  APP_VERSION,
  RELEASE_TITLE,
  RELEASE_HIGHLIGHTS,
  CHANGELOG_URL,
  GITHUB_REPO,
} from "../version";
import {
  removeBlockedUser,
  getUsersForReleaseNotification,
  batchUpdateUsersLastSeenVersion,
} from "../db/queries";

// In-memory cache at isolate level to skip queries/subrequests in 0ms when version is already handled
let completedVersionCache: string | null = null;

export function invalidateCompletedVersionCache(): void {
  completedVersionCache = null;
}

export function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatMarkdownSnippet(str: string): string {
  let res = escapeHtml(str);
  // Non-greedy matching to safely handle nested asterisks/formulas (e.g. **Formula (`Price * Size`):**)
  res = res.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  res = res.replace(/`(.+?)`/g, "<code>$1</code>");
  res = res.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  return res;
}

export function formatReleaseNotification(
  version: string,
  title?: string,
  highlights?: string[],
  maxHighlights: number = 3,
): string {
  const cleanVer = version.startsWith("v") ? version : `v${version}`;
  let text = `🚀 <b>Lighter Monitor обновлен до ${cleanVer}!</b>\n\n`;

  if (title && title.trim()) {
    text += `<i>${escapeHtml(title.trim())}</i>\n\n`;
  }

  if (highlights && highlights.length > 0) {
    text += `<b>Главные изменения:</b>\n`;
    const selected = highlights.slice(0, maxHighlights);
    for (const h of selected) {
      text += `• ${formatMarkdownSnippet(h)}\n`;
    }
    text += `\n`;
  }

  text += `Подробный список изменений — в описании релиза на GitHub.`;
  return text;
}

export function getReleaseNotificationKeyboard(
  version: string,
  webAppUrl?: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const cleanVer = version.startsWith("v") ? version : `v${version}`;
  const releaseUrl = `https://github.com/${GITHUB_REPO}/releases/tag/${cleanVer}`;

  kb.url("📖 Что нового (Release Notes)", releaseUrl);

  const cleanWebApp = (webAppUrl || "").trim().replace(/\/$/, "");
  if (cleanWebApp && cleanWebApp.startsWith("https://")) {
    kb.row().url("🌐 Открыть Web Terminal", cleanWebApp);
  }
  return kb;
}

export function getChangelogKeyboard(version: string, webAppUrl?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const cleanVer = version.startsWith("v") ? version : `v${version}`;
  const releaseUrl = `https://github.com/${GITHUB_REPO}/releases/tag/${cleanVer}`;

  kb.url("📖 Релиз на GitHub", releaseUrl).url("📜 Changelog", CHANGELOG_URL);

  const cleanWebApp = (webAppUrl || "").trim().replace(/\/$/, "");
  if (cleanWebApp && cleanWebApp.startsWith("https://")) {
    kb.row().url("🌐 Открыть Web Terminal", cleanWebApp);
  }
  return kb;
}

export interface BroadcastOptions {
  version?: string;
  batchSize?: number;
  title?: string;
  highlights?: string[];
  api?: Api;
}

export async function checkAndBroadcastRelease(
  env: Env,
  _ctx?: ExecutionContext,
  options?: BroadcastOptions,
): Promise<{ processed: number; sent: number; isCompleted: boolean }> {
  const targetVersion = options?.version || APP_VERSION;
  if (!targetVersion || targetVersion === "dev") {
    return { processed: 0, sent: 0, isCompleted: true };
  }

  // Fast-path: 0 ms, 0 DB queries, 0 subrequests if all users have already been notified for this version
  if (completedVersionCache === targetVersion) {
    return { processed: 0, sent: 0, isCompleted: true };
  }

  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) {
    return { processed: 0, sent: 0, isCompleted: false };
  }

  const batchLimit = Math.min(
    Math.max(options?.batchSize ?? CONFIG.RELEASE_NOTIFICATION_BATCH_SIZE, 1),
    30,
  );

  const pendingUsers = await getUsersForReleaseNotification(env.DB, targetVersion, batchLimit);
  if (pendingUsers.length === 0) {
    completedVersionCache = targetVersion;
    return { processed: 0, sent: 0, isCompleted: true };
  }

  const api = options?.api || new Api(env.TELEGRAM_BOT_TOKEN);
  const notificationTitle = options?.title ?? RELEASE_TITLE;
  const notificationHighlights = options?.highlights ?? RELEASE_HIGHLIGHTS;
  const messageText = formatReleaseNotification(
    targetVersion,
    notificationTitle,
    notificationHighlights,
  );
  const keyboard = getReleaseNotificationKeyboard(targetVersion, env.WEBAPP_URL);

  const successUserIds: number[] = [];
  const sendPromises = pendingUsers.map(async (user) => {
    try {
      await api.sendMessage(user.telegram_id, messageText, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
      successUserIds.push(user.telegram_id);
      return { success: true, telegram_id: user.telegram_id };
    } catch (err: any) {
      const code = err?.error_code;
      const desc = String(err?.description || err?.message || "").toLowerCase();

      // Permanent delivery failures: delete dead / deactivated / blocked accounts
      if (
        code === 403 ||
        (code === 400 &&
          (desc.includes("chat not found") ||
            desc.includes("deactivated") ||
            desc.includes("peer_id_invalid") ||
            desc.includes("user not found") ||
            desc.includes("bot was kicked") ||
            desc.includes("bot can't initiate conversation")))
      ) {
        await removeBlockedUser(env.DB, user.telegram_id);
      } else if (code === 400 && desc.includes("can't parse entities")) {
        // Fallback: send as plain text without HTML entities
        try {
          await api.sendMessage(user.telegram_id, messageText.replace(/<[^>]+>/g, ""), {
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true },
          });
          successUserIds.push(user.telegram_id);
          return { success: true, telegram_id: user.telegram_id };
        } catch {
          // Advance version to prevent deadlocking queue
          successUserIds.push(user.telegram_id);
        }
      } else if (code === 429) {
        console.warn(`[release_notifier] Rate limited (429) for user ${user.telegram_id}`);
      } else {
        console.error(`[release_notifier] Failed to notify ${user.telegram_id}:`, err);
        // Advance user version on permanent 4xx errors to prevent queue deadlocks
        if (typeof code === "number" && code >= 400 && code < 500 && code !== 429) {
          successUserIds.push(user.telegram_id);
        }
      }
      return { success: false, telegram_id: user.telegram_id, error: err };
    }
  });

  await Promise.allSettled(sendPromises);

  if (successUserIds.length > 0) {
    await batchUpdateUsersLastSeenVersion(env.DB, successUserIds, targetVersion);
  }

  const isCompleted = pendingUsers.length < batchLimit;
  if (isCompleted) {
    completedVersionCache = targetVersion;
  }

  console.log(
    JSON.stringify({
      event: "release_broadcast_batch",
      version: targetVersion,
      batch_processed: pendingUsers.length,
      batch_sent: successUserIds.length,
      is_completed: isCompleted,
    }),
  );

  return { processed: pendingUsers.length, sent: successUserIds.length, isCompleted };
}
