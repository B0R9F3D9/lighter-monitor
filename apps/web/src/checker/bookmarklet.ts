/**
 * Lighter & Robinhood Chain Trade History Exporter Bookmarklet
 *
 * This script runs directly in the user's browser while on https://robinhoodchain.lighter.xyz
 * or https://app.lighter.xyz (or rh.lighter.xyz / lighter.xyz).
 *
 * It extracts the active session/auth token and account index,
 * fetches all trade history with pagination from /api/v1/trades,
 * displays a floating HUD overlay on Lighter with live progress,
 * and automatically triggers a download of the parsed JSON file.
 */

import { BOOKMARKLET_RAW_CODE } from "./bookmarklet_code";

export { BOOKMARKLET_RAW_CODE };

/**
 * Returns clean minified bookmarklet href: "javascript:(function(){...})()"
 */
export function getBookmarkletHref(): string {
  // Collapse whitespace, remove comments and newlines for safe bookmarklet URI
  const minified = BOOKMARKLET_RAW_CODE.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "") // remove comments
    .replace(/\s+/g, " ") // collapse multiple spaces
    .trim();

  return `javascript:${encodeURIComponent(minified)}`;
}
