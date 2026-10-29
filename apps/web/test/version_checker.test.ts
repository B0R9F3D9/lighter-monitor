import { beforeEach, describe, expect, it } from "bun:test";
import {
  compareSemver,
  DEFAULT_CHANGELOG_URL,
  fetchLatestGitHubRelease,
  formatDisplayVersion,
  getCurrentBuildHash,
  getCurrentVersion,
  isNewerVersion,
  showUpdateSonner,
  STORAGE_KEY_DISMISSED,
  VersionChecker,
} from "../src/shared/version_checker";

describe("Version Checker & Auto-Updater", () => {
  beforeEach(() => {
    if (typeof (globalThis as any).sessionStorage !== "undefined") {
      (globalThis as any).sessionStorage.clear();
    }
  });

  describe("Semantic Versioning & Comparison", () => {
    it("compares semver versions correctly", () => {
      expect(compareSemver("v1.0.1", "v1.0.0")).toBe(1);
      expect(compareSemver("1.1.0", "1.0.9")).toBe(1);
      expect(compareSemver("v2.0.0", "v1.99.99")).toBe(1);
      expect(compareSemver("v1.0.0", "v1.0.1")).toBe(-1);
      expect(compareSemver("v1.0.0", "v1.0.0")).toBe(0);
      expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
      expect(compareSemver("v1.0.0", "v1.0.0-rc.1")).toBe(1);
      expect(compareSemver("v1.0.0-rc.1", "v1.0.0")).toBe(-1);
    });

    it("evaluates isNewerVersion accurately", () => {
      expect(isNewerVersion("v1.0.1", "v1.0.0")).toBe(true);
      expect(isNewerVersion("v1.1.0", "v1.0.0")).toBe(true);
      expect(isNewerVersion("v2.0.0", "v1.0.0")).toBe(true);
      expect(isNewerVersion("v1.0.0", "v1.0.0")).toBe(false);
      expect(isNewerVersion("v0.9.0", "v1.0.0")).toBe(false);
      expect(isNewerVersion("dev", "dev")).toBe(false);
      expect(isNewerVersion("dev", "v1.0.0")).toBe(false);
      expect(isNewerVersion("v1.0.0", "dev")).toBe(false);
      expect(isNewerVersion("v1.0.1-new", "v1.0.0")).toBe(true);
    });

    it("formats version for user display cleanly without raw hashes", () => {
      expect(formatDisplayVersion("v1.0.0")).toBe("v1.0.0");
      expect(formatDisplayVersion("1.0.1")).toBe("v1.0.1");
      expect(formatDisplayVersion("dev")).toBe("dev");
      expect(formatDisplayVersion("")).toBe("");
    });
  });

  describe("GitHub Releases API Helper", () => {
    it("handles 404 private repo gracefully without throwing", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }) as any;

      try {
        const res = await fetchLatestGitHubRelease("B0R9F3D9/lighter-monitor");
        expect(res).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles 304 Not Modified conditional response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(null, { status: 304 });
      }) as any;

      try {
        const res = await fetchLatestGitHubRelease("B0R9F3D9/lighter-monitor", "W/etag-123");
        expect(res?.notModified).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("parses 200 OK latest release successfully", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(
          JSON.stringify({
            tag_name: "v1.1.0",
            name: "v1.1.0 — New Features",
            html_url: "https://github.com/B0R9F3D9/lighter-monitor/releases/tag/v1.1.0",
            published_at: "2026-10-29T12:00:00Z",
          }),
          { status: 200, headers: { ETag: '"release-etag-abc"' } },
        );
      }) as any;

      try {
        const res = await fetchLatestGitHubRelease("B0R9F3D9/lighter-monitor");
        expect(res?.release?.version).toBe("v1.1.0");
        expect(res?.release?.releaseUrl).toContain("releases/tag/v1.1.0");
        expect(res?.release?.changelogUrl).toBe(DEFAULT_CHANGELOG_URL);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Version Checker Polling & Update Detection", () => {
    it("retrieves current app version and build hash correctly", () => {
      const v = getCurrentVersion();
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);

      const h = getCurrentBuildHash();
      expect(typeof h).toBe("string");
    });

    it("detects no update when remote version and buildHash match current", async () => {
      let updateCalled = false;
      const currentVer = "v1.0.0";
      const currentHash = "hash-123";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ version: currentVer, buildHash: currentHash }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as any;

      try {
        const checker = new VersionChecker({
          currentVersion: currentVer,
          currentBuildHash: currentHash,
          endpoint: "/api/version",
          onUpdateAvailable: () => {
            updateCalled = true;
          },
        });

        const hasUpdate = await checker.check();
        expect(hasUpdate).toBe(false);
        expect(updateCalled).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("detects new update when semver increases", async () => {
      let newVersionDetected = "";
      const currentVer = "v1.0.0";
      const remoteVer = "v1.0.1";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ version: remoteVer }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as any;

      try {
        const checker = new VersionChecker({
          currentVersion: currentVer,
          endpoint: "/api/version",
          onUpdateAvailable: (v) => {
            newVersionDetected = v;
          },
        });

        const hasUpdate = await checker.check();
        expect(hasUpdate).toBe(true);
        expect(newVersionDetected).toBe(remoteVer);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("detects hotfix update when semver is identical but buildHash differs", async () => {
      let updateCalled = false;
      let detectedVersion = "";
      let detectedOptions: any = null;

      const currentVer = "v1.0.0";
      const localHash = "hash-aaa";
      const deployedHotfixHash = "hash-bbb";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(
          JSON.stringify({
            version: currentVer,
            buildHash: deployedHotfixHash,
            releaseUrl: "https://github.com/B0R9F3D9/lighter-monitor/releases/tag/v1.0.0",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any;

      try {
        const checker = new VersionChecker({
          currentVersion: currentVer,
          currentBuildHash: localHash,
          endpoint: "/api/version",
          onUpdateAvailable: (v, opts) => {
            updateCalled = true;
            detectedVersion = v;
            detectedOptions = opts;
          },
        });

        const hasUpdate = await checker.check();
        expect(hasUpdate).toBe(true);
        expect(updateCalled).toBe(true);
        expect(detectedVersion).toBe("v1.0.0");
        expect(detectedOptions?.updateKey).toBe("v1.0.0-hash-bbb");
        expect(detectedOptions?.releaseUrl).toContain("releases/tag/v1.0.0");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("respects session dismissal for hotfix updates using compound updateKey", async () => {
      let updateCalled = false;
      const currentVer = "v1.0.0";
      const hotfixHash = "hash-hotfix-1";
      const updateKey = `${currentVer}-${hotfixHash}`;

      const storage = new Map<string, string>();
      storage.set(STORAGE_KEY_DISMISSED, updateKey);

      const originalSessionStorage = (globalThis as any).sessionStorage;
      (globalThis as any).sessionStorage = {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        clear: () => storage.clear(),
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ version: currentVer, buildHash: hotfixHash }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as any;

      try {
        const checker = new VersionChecker({
          currentVersion: currentVer,
          currentBuildHash: "hash-initial",
          endpoint: "/api/version",
          onUpdateAvailable: () => {
            updateCalled = true;
          },
        });

        const hasUpdate = await checker.check();
        expect(hasUpdate).toBe(false);
        expect(updateCalled).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
        (globalThis as any).sessionStorage = originalSessionStorage;
      }
    });

    it("silently handles network errors without crashing", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error("Network offline");
      }) as any;

      try {
        const checker = new VersionChecker({
          currentVersion: "v1.0.0",
          endpoint: "/api/version",
        });

        const hasUpdate = await checker.check();
        expect(hasUpdate).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Sonner Toast UI & Actions", () => {
    it("renders Sonner toast with releaseUrl priority and sets dismissal on Reload click", () => {
      const eventListeners: Record<string, EventListenerOrEventListenerObject[]> = {};
      const mockWindow = {
        addEventListener: (type: string, listener: any) => {
          eventListeners[type] = eventListeners[type] || [];
          eventListeners[type].push(listener);
        },
        removeEventListener: (type: string, listener: any) => {
          if (!eventListeners[type]) return;
          eventListeners[type] = eventListeners[type].filter((l) => l !== listener);
        },
        location: { reload: () => {} },
      };

      const storage = new Map<string, string>();
      const mockSessionStorage = {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        clear: () => storage.clear(),
      };

      const elements = new Set<any>();
      const mockDocument: any = {
        createElement: (tag: string) => {
          const el: any = {
            tagName: tag.toUpperCase(),
            id: "",
            className: "",
            classList: {
              add: (...classes: string[]) => {
                el.className = `${el.className} ${classes.join(" ")}`.trim();
              },
              remove: (...classes: string[]) => {
                for (const c of classes) {
                  el.className = el.className.replace(new RegExp(`\\b${c}\\b`, "g"), "").trim();
                }
              },
            },
            attributes: new Map<string, string>(),
            setAttribute: (k: string, v: string) => el.attributes.set(k, v),
            innerHTML: "",
            children: [] as any[],
            querySelector: (sel: string) => {
              if (sel === "#versionReloadBtn") return reloadBtn;
              if (sel === "#versionDismissBtn") return dismissBtn;
              if (sel === "#versionChangelogLink") return changelogLink;
              return null;
            },
            remove: () => elements.delete(el),
          };
          return el;
        },
        body: {
          appendChild: (el: any) => elements.add(el),
          contains: (el: any) => elements.has(el),
        },
      };

      const reloadBtn = {
        listeners: new Map<string, Function>(),
        addEventListener: (evt: string, fn: Function) => reloadBtn.listeners.set(evt, fn),
        disabled: false,
        innerHTML: "",
      };
      const dismissBtn = {
        listeners: new Map<string, Function>(),
        addEventListener: (evt: string, fn: Function) => dismissBtn.listeners.set(evt, fn),
      };
      const changelogLink = {
        href: "",
        target: "_blank",
      };

      const originalDoc = (globalThis as any).document;
      const originalWin = (globalThis as any).window;
      const originalSessionStorage = (globalThis as any).sessionStorage;
      const originalRaf = (globalThis as any).requestAnimationFrame;

      (globalThis as any).document = mockDocument;
      (globalThis as any).window = mockWindow;
      (globalThis as any).sessionStorage = mockSessionStorage;
      (globalThis as any).requestAnimationFrame = (fn: Function) => fn();

      let reloaded = false;

      try {
        const specificReleaseUrl =
          "https://github.com/B0R9F3D9/lighter-monitor/releases/tag/v2.0.0";
        const fallbackChangelog =
          "https://github.com/B0R9F3D9/lighter-monitor/blob/main/CHANGELOG.md";

        const sonner = showUpdateSonner("v2.0.0", {
          onReload: () => {
            reloaded = true;
          },
          releaseUrl: specificReleaseUrl,
          changelogUrl: fallbackChangelog,
          updateKey: "v2.0.0-custom-key",
        });

        expect(sonner).not.toBeNull();
        expect(sonner?.id).toBe("versionUpdateSonner");
        expect(sonner?.innerHTML).toContain("Update available");
        expect(sonner?.innerHTML).toContain("Reload");
        expect(sonner?.innerHTML).toContain("Dismiss");
        expect(sonner?.innerHTML).toContain("Release notes");
        expect(sonner?.innerHTML).toContain("versionBadgeLink");
        // Verify releaseUrl takes priority over generic changelogUrl
        expect(sonner?.innerHTML).toContain(specificReleaseUrl);
        expect(sonner?.innerHTML).toContain("v2.0.0");
        expect(elements.has(sonner)).toBe(true);

        // Does NOT embed huge changelog text
        expect(sonner?.innerHTML).not.toContain("## [v1.0.0]");

        // Trigger reload -> must write updateKey to sessionStorage to protect against loop
        reloadBtn.listeners.get("click")?.();
        expect(reloaded).toBe(true);
        expect(storage.get(STORAGE_KEY_DISMISSED)).toBe("v2.0.0-custom-key");
      } finally {
        (globalThis as any).document = originalDoc;
        (globalThis as any).window = originalWin;
        (globalThis as any).sessionStorage = originalSessionStorage;
        (globalThis as any).requestAnimationFrame = originalRaf;
      }
    });
  });
});
