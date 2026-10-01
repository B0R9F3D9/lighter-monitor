/**
 * Auto Version Checker & Sonner Update Notification
 * Periodically verifies /api/version and displays a sleek bottom-right
 * Sonner-style notification when a new version of the website is available.
 */

declare const APP_VERSION: string | undefined;

export interface VersionResponse {
  version: string;
  spreadHash?: string;
  analyticsHash?: string;
  hubHash?: string;
  timestamp?: number;
}

export interface VersionCheckerConfig {
  endpoint?: string;
  checkIntervalMs?: number;
  initialDelayMs?: number;
  currentVersion?: string;
  onUpdateAvailable?: (version: string) => void;
  onReload?: () => void;
}

export const STORAGE_KEY_DISMISSED = "lighter_dismissed_version";

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

let activeSonnerElement: HTMLElement | null = null;

export function showUpdateSonner(
  newVersion: string,
  onReload: () => void = () => window.location.reload(),
): HTMLElement | null {
  if (typeof document === "undefined") return null;

  // Don't duplicate if already open
  if (activeSonnerElement && document.body.contains(activeSonnerElement)) {
    return activeSonnerElement;
  }

  const sonner = document.createElement("div");
  sonner.id = "versionUpdateSonner";
  sonner.setAttribute("role", "alert");
  sonner.setAttribute("aria-live", "polite");
  sonner.className =
    "fixed bottom-4 right-4 z-50 w-72 p-3 bg-terminal-surface border border-terminal-border rounded shadow-xl shadow-black/70 text-xs font-sans select-none transition-all duration-200 transform translate-y-2 opacity-0 pointer-events-auto";

  const shortVersion = newVersion
    ? newVersion.length > 14
      ? newVersion.slice(0, 11)
      : newVersion
    : "";
  const versionBadge = shortVersion
    ? `<span class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-terminal-bg border border-terminal-border text-terminal-muted" title="${newVersion}">${shortVersion}</span>`
    : "";

  sonner.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <span class="text-white font-medium text-xs">Update ready</span>
      ${versionBadge}
    </div>
    <p class="text-[11px] text-terminal-muted mt-1 leading-normal">
      Reload to apply the new version.
    </p>
    <div class="flex items-center justify-end gap-2 mt-2.5">
      <button
        id="versionDismissBtn"
        class="px-2.5 py-1 rounded bg-terminal-bg border border-terminal-border hover:border-terminal-muted text-terminal-secondary hover:text-white active:scale-95 transition text-[11px] font-medium cursor-pointer"
      >
        Dismiss
      </button>
      <button
        id="versionReloadBtn"
        class="px-3 py-1 rounded bg-terminal-accent/15 border border-terminal-accent/40 text-terminal-accent hover:bg-terminal-accent/25 hover:text-white active:scale-95 transition text-[11px] font-medium cursor-pointer flex items-center gap-1"
      >
        Reload
      </button>
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
        sessionStorage.setItem(STORAGE_KEY_DISMISSED, newVersion);
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
  private endpoint: string;
  private checkIntervalMs: number;
  private isChecking = false;
  private lastCheckTime = 0;
  private onUpdateAvailable?: (version: string) => void;
  private onReload?: () => void;

  constructor(options: VersionCheckerConfig = {}) {
    this.currentVersion = options.currentVersion ?? getCurrentVersion();
    this.endpoint = options.endpoint || "/api/version";
    this.checkIntervalMs = options.checkIntervalMs || 45_000;
    this.onUpdateAvailable = options.onUpdateAvailable;
    this.onReload = options.onReload;
  }

  public getCurrentVersion(): string {
    return this.currentVersion;
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

      if (data.version !== this.currentVersion) {
        // Check if dismissed in this session
        try {
          if (typeof sessionStorage !== "undefined") {
            const dismissed = sessionStorage.getItem(STORAGE_KEY_DISMISSED);
            if (dismissed === data.version) {
              return false;
            }
          }
        } catch {}

        if (this.onUpdateAvailable) {
          this.onUpdateAvailable(data.version);
        } else {
          showUpdateSonner(data.version, this.onReload);
        }
        return true;
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
