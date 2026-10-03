/**
 * Shared Font Selection & Typography Management
 * Provides centralized font options, storage, CSS variable application,
 * and DOM selector synchronization across Hub (/), Spread (/spread), and Analytics (/analytics).
 */

export const AVAILABLE_FONTS = [
  "Inter",
  "Roboto",
  "Montserrat",
  "Poppins",
  "Open Sans",
  "JetBrains Mono",
] as const;

export type AvailableFont = (typeof AVAILABLE_FONTS)[number];

export const FONT_STORAGE_KEY = "terminal_font";
export const DEFAULT_FONT: AvailableFont = "Inter";

/**
 * Returns CSS font-family stack for a given font name
 */
export function getFontStack(fontName: string): string {
  if (fontName === "JetBrains Mono") {
    return '"JetBrains Mono", monospace';
  }
  const validFont = AVAILABLE_FONTS.includes(fontName as AvailableFont) ? fontName : DEFAULT_FONT;
  return `"${validFont}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
}

/**
 * Reads the current saved font from localStorage
 */
export function getSavedFont(): AvailableFont {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return DEFAULT_FONT;
  }
  try {
    const saved = localStorage.getItem(FONT_STORAGE_KEY);
    if (saved && AVAILABLE_FONTS.includes(saved as AvailableFont)) {
      return saved as AvailableFont;
    }
  } catch {}
  return DEFAULT_FONT;
}

/**
 * Dynamically loads font stylesheet from Google Fonts if not already loaded and not bundled/primary
 */
export function loadFontStylesheet(fontName: string): void {
  if (
    typeof document === "undefined" ||
    typeof document.createElement !== "function" ||
    !document.head
  ) {
    return;
  }
  if (fontName === "Inter" || fontName === "JetBrains Mono") return;
  const linkId = `gfont-${fontName.toLowerCase().replace(/\s+/g, "-")}`;
  if (typeof document.getElementById === "function" && document.getElementById(linkId)) return;
  const link = document.createElement("link");
  link.id = linkId;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
}

/**
 * Applies the given font to CSS custom properties and document body
 */
export function applyFont(fontName: string): void {
  const font = AVAILABLE_FONTS.includes(fontName as AvailableFont)
    ? (fontName as AvailableFont)
    : DEFAULT_FONT;
  loadFontStylesheet(font);
  const stack = getFontStack(font);

  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("--font-selected", stack);
    document.documentElement.style.setProperty("--font-sans", stack);
    if (document.body) {
      document.body.style.fontFamily = stack;
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("terminal:fontchange", {
        detail: { font, stack },
      }),
    );
  }
}

/**
 * Persists selected font to localStorage and applies it
 */
export function setFont(fontName: string): void {
  const font = AVAILABLE_FONTS.includes(fontName as AvailableFont)
    ? (fontName as AvailableFont)
    : DEFAULT_FONT;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(FONT_STORAGE_KEY, font);
    }
  } catch {}
  applyFont(font);
}

export interface FontSelectorOptions {
  selectorId?: string;
  onFontChange?: (font: AvailableFont, stack: string) => void;
}

/**
 * Returns clean HTML markup for the font selector dropdown
 */
export function renderFontSelectorMarkup(selectedFont?: string): string {
  const current = selectedFont || getSavedFont();
  const optionsHtml = AVAILABLE_FONTS.map(
    (font) =>
      `<option value="${font}" class="bg-terminal-surface text-white"${font === current ? " selected" : ""}>${font}</option>`,
  ).join("\n    ");

  return `<div class="flex items-center gap-1 bg-terminal-bg border border-terminal-border px-2 py-0.5 rounded text-[11px] text-terminal-secondary">
  <label for="fontSelector" class="text-terminal-muted cursor-pointer select-none">Font:</label>
  <select
    id="fontSelector"
    class="bg-transparent text-white font-sans text-[11px] cursor-pointer outline-none focus:outline-none border-0 p-0 pr-1 hover:text-terminal-accent transition"
    title="Select Interface Font"
  >
    ${optionsHtml}
  </select>
</div>`;
}

/**
 * Initializes font selector UI and registers event listeners.
 * Synchronizes with localStorage and cross-tab storage changes.
 */
export function initFontSelector(options?: FontSelectorOptions): () => void {
  const selectorId = options?.selectorId || "fontSelector";
  const selectEl =
    typeof document !== "undefined"
      ? (document.getElementById(selectorId) as HTMLSelectElement | null)
      : null;

  const currentFont = getSavedFont();
  applyFont(currentFont);

  if (selectEl) {
    selectEl.value = currentFont;
  }

  const handleChange = (e: Event) => {
    const val = (e.target as HTMLSelectElement).value;
    setFont(val);
    options?.onFontChange?.(val as AvailableFont, getFontStack(val));
  };

  selectEl?.addEventListener("change", handleChange);

  const handleStorage = (e: StorageEvent) => {
    if (e.key === FONT_STORAGE_KEY && e.newValue) {
      applyFont(e.newValue);
      if (selectEl) {
        selectEl.value = e.newValue;
      }
      options?.onFontChange?.(e.newValue as AvailableFont, getFontStack(e.newValue));
    }
  };

  const handleFontChange = (e: Event) => {
    const detail = (e as CustomEvent<{ font: AvailableFont; stack: string }>).detail;
    if (detail && detail.font) {
      if (selectEl && selectEl.value !== detail.font) {
        selectEl.value = detail.font;
      }
      options?.onFontChange?.(detail.font, detail.stack);
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
    window.addEventListener("terminal:fontchange", handleFontChange);
  }

  // Initial callback notification if registered
  if (options?.onFontChange) {
    options.onFontChange(currentFont, getFontStack(currentFont));
  }

  return () => {
    selectEl?.removeEventListener("change", handleChange);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("terminal:fontchange", handleFontChange);
    }
  };
}
