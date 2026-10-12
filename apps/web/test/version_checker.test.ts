import { beforeEach, describe, expect, it } from "bun:test";
import {
  getCurrentVersion,
  STORAGE_KEY_DISMISSED,
  showUpdateSonner,
  VersionChecker,
} from "../src/shared/version_checker";

describe("Version Checker & Auto-Updater", () => {
  beforeEach(() => {
    // Reset global sessionStorage mock if any
    if (typeof (globalThis as any).sessionStorage !== "undefined") {
      (globalThis as any).sessionStorage.clear();
    }
  });

  it("retrieves current app version correctly", () => {
    const v = getCurrentVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });

  it("detects no update when remote version matches current version", async () => {
    let updateCalled = false;
    const currentVer = "v1.0.0";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ version: currentVer }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const checker = new VersionChecker({
        currentVersion: currentVer,
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

  it("detects new update when remote version differs from current version", async () => {
    let newVersionDetected = "";
    const currentVer = "v1.0.0";
    const remoteVer = "v1.0.1-new";

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

  it("respects session dismissal and suppresses toast if user dismissed this version", async () => {
    let updateCalled = false;
    const currentVer = "v1.0.0";
    const remoteVer = "v1.0.1-new";

    // Mock sessionStorage
    const storage = new Map<string, string>();
    storage.set(STORAGE_KEY_DISMISSED, remoteVer);

    const originalSessionStorage = (globalThis as any).sessionStorage;
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      clear: () => storage.clear(),
    };

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

  it("renders Sonner toast and handles reload and dismiss actions", () => {
    // Setup lightweight mock DOM
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
            if (sel === "#versionLaterBtn") return laterBtn;
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
    const laterBtn = {
      listeners: new Map<string, Function>(),
      addEventListener: (evt: string, fn: Function) => laterBtn.listeners.set(evt, fn),
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
      const sonner = showUpdateSonner("v2.0.0", () => {
        reloaded = true;
      });

      expect(sonner).not.toBeNull();
      expect(sonner?.id).toBe("versionUpdateSonner");
      expect(sonner?.innerHTML).toContain("Update ready");
      expect(sonner?.innerHTML).toContain("Reload");
      expect(sonner?.innerHTML).toContain("Dismiss");
      expect(sonner?.innerHTML).toContain("v2.0.0");
      expect(elements.has(sonner)).toBe(true);

      // Trigger reload
      reloadBtn.listeners.get("click")?.();
      expect(reloaded).toBe(true);

      // Trigger dismiss
      dismissBtn.listeners.get("click")?.();
      expect(storage.get(STORAGE_KEY_DISMISSED)).toBe("v2.0.0");
    } finally {
      (globalThis as any).document = originalDoc;
      (globalThis as any).window = originalWin;
      (globalThis as any).sessionStorage = originalSessionStorage;
      (globalThis as any).requestAnimationFrame = originalRaf;
    }
  });
});
