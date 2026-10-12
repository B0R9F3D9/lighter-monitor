/**
 * TEMPORARY CLEANUP CRUTCH:
 * Drops legacy IndexedDB database ("LighterSpreadAnalyticsDB") created by earlier
 * versions of /analytics to free up client disk space.
 *
 * TODO: Delete this file and its import in main.ts in a future commit once clients have updated.
 */
export function cleanupLegacyStorage(): void {
  try {
    const CLEANUP_KEY = "lighter_legacy_idb_cleaned_v1";
    if (typeof window === "undefined" || typeof indexedDB === "undefined") return;
    if (localStorage.getItem(CLEANUP_KEY)) return;

    const req = indexedDB.deleteDatabase("LighterSpreadAnalyticsDB");
    const markDone = () => {
      try {
        localStorage.setItem(CLEANUP_KEY, "1");
      } catch {
        // Ignore storage access errors in private/sandboxed modes
      }
    };

    req.addEventListener("success", markDone);
    req.addEventListener("error", markDone);
  } catch {
    // Gracefully ignore in restricted / private environments
  }
}
