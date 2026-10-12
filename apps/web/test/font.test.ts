import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  AVAILABLE_FONTS,
  DEFAULT_FONT,
  FONT_STORAGE_KEY,
  applyFont,
  getFontStack,
  getSavedFont,
  initFontSelector,
  renderFontSelectorMarkup,
  setFont,
} from "../src/shared/font";

describe("Shared Font Management", () => {
  const store: Record<string, string> = {};
  const origDoc = (globalThis as any).document;
  const origWin = (globalThis as any).window;
  const origStorage = (globalThis as any).localStorage;

  afterAll(() => {
    (globalThis as any).document = origDoc;
    (globalThis as any).window = origWin;
    (globalThis as any).localStorage = origStorage;
  });

  beforeEach(() => {
    for (const k of Object.keys(store)) {
      delete store[k];
    }

    // Mock localStorage
    (globalThis as any).localStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    };

    // Mock document
    const styleProps: Record<string, string> = {};
    const mockSelect = {
      id: "fontSelector",
      value: "",
      listeners: {} as Record<string, Function[]>,
      addEventListener(evt: string, cb: Function) {
        if (!this.listeners[evt]) this.listeners[evt] = [];
        this.listeners[evt].push(cb);
      },
      removeEventListener(evt: string, cb: Function) {
        if (this.listeners[evt]) {
          this.listeners[evt] = this.listeners[evt].filter((fn: Function) => fn !== cb);
        }
      },
      dispatchEvent(e: any) {
        if (this.listeners[e.type]) {
          for (const fn of this.listeners[e.type]) fn(e);
        }
      },
    };

    (globalThis as any).document = {
      documentElement: {
        style: {
          setProperty: (prop: string, val: string) => {
            styleProps[prop] = val;
          },
          getPropertyValue: (prop: string) => styleProps[prop] || "",
        },
      },
      body: {
        style: {
          fontFamily: "",
        },
      },
      querySelector: () => null,
      getElementById: (id: string) => {
        if (id === "fontSelector") {
          return mockSelect;
        }
        return null;
      },
    };

    (globalThis as any).window = {
      listeners: {} as Record<string, Function[]>,
      addEventListener(evt: string, cb: Function) {
        if (!this.listeners[evt]) this.listeners[evt] = [];
        this.listeners[evt].push(cb);
      },
      removeEventListener(evt: string, cb: Function) {
        if (this.listeners[evt]) {
          this.listeners[evt] = this.listeners[evt].filter((fn: Function) => fn !== cb);
        }
      },
      dispatchEvent(e: any) {
        if (this.listeners[e.type]) {
          for (const fn of this.listeners[e.type]) fn(e);
        }
      },
    };
  });

  it("contains all required typography options", () => {
    expect(AVAILABLE_FONTS).toContain("Inter");
    expect(AVAILABLE_FONTS).toContain("Roboto");
    expect(AVAILABLE_FONTS).toContain("Montserrat");
    expect(AVAILABLE_FONTS).toContain("Poppins");
    expect(AVAILABLE_FONTS).toContain("Open Sans");
    expect(AVAILABLE_FONTS).toContain("JetBrains Mono");
  });

  it("computes font stack correctly", () => {
    expect(getFontStack("JetBrains Mono")).toBe('"JetBrains Mono", monospace');
    expect(getFontStack("Inter")).toContain('"Inter"');
    expect(getFontStack("Roboto")).toContain('"Roboto"');
    // Fallback to default font for unknown fonts
    expect(getFontStack("Comic Sans")).toContain(`"${DEFAULT_FONT}"`);
  });

  it("retrieves saved font from localStorage with default fallback", () => {
    expect(getSavedFont()).toBe(DEFAULT_FONT);

    localStorage.setItem(FONT_STORAGE_KEY, "Roboto");
    expect(getSavedFont()).toBe("Roboto");

    // Invalid font in storage returns default
    localStorage.setItem(FONT_STORAGE_KEY, "InvalidFont");
    expect(getSavedFont()).toBe(DEFAULT_FONT);
  });

  it("applies font to CSS custom properties and body", () => {
    applyFont("Montserrat");
    expect((document.documentElement.style as any).getPropertyValue("--font-selected")).toContain(
      "Montserrat",
    );
    expect(document.body.style.fontFamily).toContain("Montserrat");
  });

  it("persists and applies font via setFont", () => {
    setFont("Poppins");
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("Poppins");
    expect((document.documentElement.style as any).getPropertyValue("--font-selected")).toContain(
      "Poppins",
    );
  });

  it("renders valid HTML markup for font selector", () => {
    const markup = renderFontSelectorMarkup("Roboto");
    expect(markup).toContain('id="fontSelector"');
    expect(markup).toContain('value="Roboto" class="bg-terminal-surface text-white" selected');
    for (const font of AVAILABLE_FONTS) {
      expect(markup).toContain(`value="${font}"`);
    }
  });

  it("initializes font selector, syncs value, and fires onFontChange callback", () => {
    localStorage.setItem(FONT_STORAGE_KEY, "Open Sans");

    let changedFont = "";
    let changedStack = "";

    const cleanup = initFontSelector({
      onFontChange: (f, s) => {
        changedFont = f;
        changedStack = s;
      },
    });

    expect(changedFont).toBe("Open Sans");
    expect(changedStack).toContain("Open Sans");

    const select = document.getElementById("fontSelector") as any;
    expect(select.value).toBe("Open Sans");

    // Simulate change event on select
    select.value = "JetBrains Mono";
    select.dispatchEvent({ type: "change", target: select });

    expect(changedFont).toBe("JetBrains Mono");
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("JetBrains Mono");

    cleanup();
  });
});
