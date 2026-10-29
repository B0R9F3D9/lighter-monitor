/**
 * Auto Version Checker & Sonner Update Notification
 *
 * Checks for updates using the /api/version worker endpoint. When a new
 * version or hotfix build is detected, displays a sleek Sonner-style toast
 * with a direct link to the release notes / Changelog on GitHub and a
 * one-click Reload button.
 */

declare const APP_VERSION: string | undefined;
declare const BUILD_HASH: string | undefined;

export const DEFAULT_GITHUB_REPO = "B0R9F3D9/lighter-monitor";
export const DEFAULT_CHANGELOG_URL = `https://github.com/${DEFAULT_GITHUB_REPO}/blob/main/CHANGELOG.md`;
export const DEFAULT_RELEASES_URL = `https://github.com/${DEFAULT_GITHUB_REPO}/releases`;

export const STORAGE_KEY_DISMISSED = "lighter_dismissed_version";

export interface VersionResponse {
  version: string;
  buildHash?: string;
  changelogUrl?: string;
  releaseUrl?: string;
  spreadHash?: string;
  analyticsHash?: string;
  checkerHash?: string;
  hubHash?: string;
  timestamp?: number;
}

export interface GitHubReleaseInfo {
  version: string;
  name?: string;
  releaseUrl: string;
  changelogUrl: string;
  publishedAt?: string;
}

export interface ShowUpdateSonnerOptions {
  onReload?: () => void;
  changelogUrl?: string;
  releaseUrl?: string;
  updateKey?: string;
  message?: string;
}

export interface VersionCheckerConfig {
  endpoint?: string;
  checkIntervalMs?: number;
  initialDelayMs?: number;
  currentVersion?: string;
  currentBuildHash?: string;
  changelogUrl?: string;
  onUpdateAvailable?: (version: string, options?: ShowUpdateSonnerOptions) => void;
  onReload?: () => void;
}

/**
 * Returns current running version from compile-time definition,
 * meta tag, or runtime globals.
 */
export function getCurrentVersion(): string {
  if (typeof APP_VERSION !== "undefined" && APP_VERSION) {
    return APP_VERSION;
  }
  if (typeof document !== "undefined") {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="version"]');
    if (meta?.content) {
      return meta.content;
    }
  }
  if (typeof window !== "undefined") {
    return (window as unknown as { appVersion?: string }).appVersion || "dev";
  }
  return "dev";
}

/**
 * Returns current running build hash from compile-time definition,
 * meta tag, or runtime globals.
 */
export function getCurrentBuildHash(): string {
  if (typeof BUILD_HASH !== "undefined" && BUILD_HASH) {
    return BUILD_HASH;
  }
  if (typeof document !== "undefined") {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="build-hash"]');
    if (meta?.content) {
      return meta.content;
    }
  }
  if (typeof window !== "undefined") {
    return (window as unknown as { buildHash?: string }).buildHash || "";
  }
  return "";
}

/**
 * Compares two semantic version strings (e.g. "v1.0.1" vs "v1.0.0").
 * Returns:
 *   > 0 if v1 > v2 (v1 is newer)
 *   < 0 if v1 < v2 (v1 is older)
 *   0 if equal
 */
export function compareSemver(v1: string, v2: string): number {
  if (v1 === v2) return 0;
  if (v1 === "dev" || v2 === "dev") return 0;

  const clean1 = v1.replace(/^v/, "").trim();
  const clean2 = v2.replace(/^v/, "").trim();

  const [core1, pre1] = clean1.split("-");
  const [core2, pre2] = clean2.split("-");

  const p1 = (core1 || "").split(".").map((n) => parseInt(n, 10) || 0);
  const p2 = (core2 || "").split(".").map((n) => parseInt(n, 10) || 0);

  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const num1 = p1[i] ?? 0;
    const num2 = p2[i] ?? 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  // Handle prereleases if core versions match: "1.0.0" is newer than "1.0.0-rc1"
  if (!pre1 && pre2) return 1;
  if (pre1 && !pre2) return -1;
  if (pre1 && pre2) return pre1.localeCompare(pre2);

  return 0;
}

const HAS_DOTS_REGEX = /\d+\.\d+/;

/**
 * Checks whether remote version represents an upgrade compared to current version.
 */
export function isNewerVersion(remote: string, current: string): boolean {
  if (!remote || !current) return false;
  if (remote === current) return false;
  if (current === "dev" || remote === "dev") return false;

  if (HAS_DOTS_REGEX.test(remote) && HAS_DOTS_REGEX.test(current)) {
    return compareSemver(remote, current) > 0;
  }

  // Fallback for non-semver build tokens or test identifiers: inequality implies update
  return remote !== current;
}

/**
 * Helper to query GitHub Releases API for the latest published tag.
 * Kept for external tooling / admin scripts. Not called in automated client loop
 * to prevent rate limits and infinite reload loops on deployment desync.
 */
export async function fetchLatestGitHubRelease(
  repo: string = DEFAULT_GITHUB_REPO,
  etag?: string,
): Promise<{ release?: GitHubReleaseInfo; etag?: string; notModified?: boolean } | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
    };
    if (etag) {
      headers["If-None-Match"] = etag;
    }

    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      method: "GET",
      headers,
    });

    if (res.status === 304) {
      return { notModified: true, etag };
    }

    if (!res.ok) {
      return null;
    }

    const newEtag = res.headers.get("ETag") || undefined;
    const data = (await res.json()) as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      published_at?: string;
    };

    if (!data || !data.tag_name) return null;

    const version = data.tag_name.trim();
    return {
      etag: newEtag,
      release: {
        version,
        name: data.name || version,
        releaseUrl: data.html_url || `https://github.com/${repo}/releases/tag/${version}`,
        changelogUrl: DEFAULT_CHANGELOG_URL,
        publishedAt: data.published_at,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Formats version for display to the user. Ensures semver has a "v" prefix
 * (e.g. "v1.0.1") and never displays raw internal build hashes to the user.
 */
export function formatDisplayVersion(v: string): string {
  if (!v) return "";
  if (v === "dev") return "dev";
  const trimmed = v.trim();
  if (/^\d+\.\d+/.test(trimmed)) {
    return `v${trimmed}`;
  }
  return trimmed;
}

let activeSonnerElement: HTMLElement | null = null;

export function showUpdateSonner(
  newVersion: string,
  optionsOrReload?: (() => void) | ShowUpdateSonnerOptions,
): HTMLElement | null {
  if (typeof document === "undefined") return null;

  const options: ShowUpdateSonnerOptions =
    typeof optionsOrReload === "function" ? { onReload: optionsOrReload } : (optionsOrReload ?? {});

  const onReload = options.onReload ?? (() => window.location.reload());
  const updateKey = options.updateKey ?? newVersion;
  // Prioritize specific release URL if present, then changelog, then default repository changelog
  const targetUrl = options.releaseUrl || options.changelogUrl || DEFAULT_CHANGELOG_URL;

  // Don't duplicate if already open
  if (activeSonnerElement && document.body.contains(activeSonnerElement)) {
    return activeSonnerElement;
  }

  const sonner = document.createElement("div");
  sonner.id = "versionUpdateSonner";
  sonner.setAttribute("role", "alert");
  sonner.setAttribute("aria-live", "polite");
  sonner.className =
    "fixed bottom-4 right-4 z-50 w-76 max-w-[calc(100vw-2rem)] p-3.5 bg-terminal-surface border border-terminal-border rounded shadow-xl shadow-black/80 text-xs font-sans select-none transition-all duration-200 transform translate-y-2 opacity-0 pointer-events-auto";

  if (sonner.style) {
    sonner.style.bottom = "1rem";
    sonner.style.right = "1rem";
  }

  const displayVersion = formatDisplayVersion(newVersion);
  const versionBadge = displayVersion
    ? `<span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-terminal-bg border border-terminal-border text-terminal-accent font-medium tracking-tight" title="${displayVersion}">${displayVersion}</span>`
    : "";

  sonner.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
        <span class="text-white font-medium text-xs">Update available</span>
      </div>
      ${versionBadge}
    </div>
    <p class="text-[11px] text-terminal-muted mt-1 leading-normal">
      A new release is ready. Reload to apply.
    </p>
    <div class="flex items-center justify-between gap-2 mt-2.5 pt-2 border-t border-terminal-border/60">
      <a
        id="versionChangelogLink"
        href="${targetUrl}"
        target="_blank"
        rel="noopener noreferrer"
        class="text-[11px] text-terminal-accent hover:text-white flex items-center gap-1 transition-colors cursor-pointer group"
        title="View details on GitHub"
      >
        <span>Changelog</span>
        <svg class="w-3 h-3 text-terminal-accent/70 group-hover:text-white transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
      </a>
      <div class="flex items-center gap-1.5">
        <button
          id="versionDismissBtn"
          class="px-2 py-0.5 rounded bg-terminal-bg border border-terminal-border hover:border-terminal-muted text-terminal-secondary hover:text-white active:scale-95 transition text-[11px] font-medium cursor-pointer"
        >
          Dismiss
        </button>
        <button
          id="versionReloadBtn"
          class="px-2.5 py-0.5 rounded bg-terminal-accent/15 border border-terminal-accent/40 text-terminal-accent hover:bg-terminal-accent/25 hover:text-white active:scale-95 transition text-[11px] font-medium cursor-pointer flex items-center gap-1"
        >
          Reload
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(sonner);
  activeSonnerElement = sonner;

  // Trigger enter animation on next frame
  requestAnimationFrame(() => {
    sonner.classList.remove("translate-y-2", "opacity-0");
    sonner.classList.add("translate-y-0", "opacity-100");
  });

  const hide = () => {
    sonner.classList.remove("translate-y-0", "opacity-100");
    sonner.classList.add("translate-y-2", "opacity-0");
    setTimeout(() => {
      sonner.remove();
      if (activeSonnerElement === sonner) {
        activeSonnerElement = null;
      }
    }, 200);
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", handleKeyDown);
    }
  };

  const dismiss = () => {
    try {
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem(STORAGE_KEY_DISMISSED, updateKey);
      }
    } catch {}
    hide();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      dismiss();
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("keydown", handleKeyDown);
  }

  const reloadBtn = sonner.querySelector<HTMLButtonElement>("#versionReloadBtn");
  const dismissBtn = sonner.querySelector<HTMLButtonElement>("#versionDismissBtn");

  reloadBtn?.addEventListener("click", () => {
    try {
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem(STORAGE_KEY_DISMISSED, updateKey);
      }
    } catch {}
    if (reloadBtn) {
      reloadBtn.disabled = true;
      reloadBtn.innerHTML = `
        <svg class="w-3 h-3 animate-spin inline-block -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span>Reloading...</span>
      `;
    }
    onReload();
  });

  dismissBtn?.addEventListener("click", dismiss);

  return sonner;
}

export class VersionChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentVersion: string;
  private currentBuildHash: string;
  private endpoint: string;
  private checkIntervalMs: number;
  private isChecking = false;
  private lastCheckTime = 0;
  private changelogUrl: string;
  private onUpdateAvailable?: (version: string, options?: ShowUpdateSonnerOptions) => void;
  private onReload?: () => void;

  constructor(options: VersionCheckerConfig = {}) {
    this.currentVersion = options.currentVersion ?? getCurrentVersion();
    this.currentBuildHash = options.currentBuildHash ?? getCurrentBuildHash();
    this.endpoint = options.endpoint || "/api/version";
    this.checkIntervalMs = options.checkIntervalMs || 45_000;
    this.changelogUrl = options.changelogUrl || DEFAULT_CHANGELOG_URL;
    this.onUpdateAvailable = options.onUpdateAvailable;
    this.onReload = options.onReload;
  }

  public getCurrentVersion(): string {
    return this.currentVersion;
  }

  public getCurrentBuildHash(): string {
    return this.currentBuildHash;
  }

  private isDismissed(key: string): boolean {
    try {
      if (typeof sessionStorage !== "undefined") {
        return sessionStorage.getItem(STORAGE_KEY_DISMISSED) === key;
      }
    } catch {}
    return false;
  }

  private notifyUpdate(version: string, options?: ShowUpdateSonnerOptions): void {
    if (this.onUpdateAvailable) {
      this.onUpdateAvailable(version, options);
    } else {
      showUpdateSonner(version, {
        onReload: this.onReload,
        changelogUrl: options?.changelogUrl || this.changelogUrl,
        releaseUrl: options?.releaseUrl,
        updateKey: options?.updateKey,
      });
    }
  }

  public async check(): Promise<boolean> {
    if (this.isChecking) return false;
    this.isChecking = true;
    this.lastCheckTime = Date.now();

    try {
      const res = await fetch(this.endpoint, {
        method: "GET",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      });

      if (!res.ok) return false;
      const data: VersionResponse = await res.json();
      if (!data || !data.version) return false;

      // In local dev without version define, don't trigger false positives
      if (this.currentVersion === "dev" && data.version === "dev") {
        return false;
      }

      const hasNewerSemver = isNewerVersion(data.version, this.currentVersion);
      const hasNewerBuild =
        data.version === this.currentVersion &&
        Boolean(
          data.buildHash && this.currentBuildHash && data.buildHash !== this.currentBuildHash,
        );

      if (hasNewerSemver || hasNewerBuild) {
        const updateKey = hasNewerSemver ? data.version : `${data.version}-${data.buildHash}`;
        if (!this.isDismissed(updateKey)) {
          this.notifyUpdate(data.version, {
            changelogUrl: data.changelogUrl || this.changelogUrl,
            releaseUrl: data.releaseUrl,
            updateKey,
          });
          return true;
        }
      }
    } catch {
      // Offline or network error: silent no-op
    } finally {
      this.isChecking = false;
    }
    return false;
  }

  public start(initialDelayMs = 5000): void {
    if (this.timer) return;

    // Initial check after delay
    setTimeout(() => {
      this.check();
    }, initialDelayMs);

    // Periodic interval
    this.timer = setInterval(() => {
      this.check();
    }, this.checkIntervalMs);

    // Visibility change check (when user switches back to tab)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
  }

  private handleVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      const elapsed = Date.now() - this.lastCheckTime;
      // Minimum 15-second gap to prevent spam on rapid tab switching
      if (elapsed > 15_000) {
        this.check();
      }
    }
  };

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
  }
}

export function initVersionChecker(config?: VersionCheckerConfig): VersionChecker {
  const checker = new VersionChecker(config);
  checker.start(config?.initialDelayMs ?? 5000);
  if (typeof window !== "undefined") {
    const win = window as unknown as {
      versionChecker?: VersionChecker;
      showUpdateSonner?: typeof showUpdateSonner;
    };
    win.versionChecker = checker;
    win.showUpdateSonner = showUpdateSonner;
  }
  return checker;
}
