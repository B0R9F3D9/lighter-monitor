// eslint-disable-next-line import/no-unassigned-import
import "../style.css";

function initHub(): void {
  // Listen for keyboard navigation hotkeys [1] -> /spread, [2] -> /analytics
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    // If typing in an input, don't hijack
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement
    ) {
      return;
    }

    if (e.key === "1") {
      e.preventDefault();
      window.location.href = "/spread";
    } else if (e.key === "2") {
      e.preventDefault();
      window.location.href = "/analytics";
    }
  });

  // Apply saved font preference if set
  try {
    const f = localStorage.getItem("terminal_font");
    if (f) {
      const stack =
        f === "JetBrains Mono"
          ? '"JetBrains Mono", monospace'
          : `"${f}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      document.documentElement.style.setProperty("--font-selected", stack);
      document.documentElement.style.setProperty("--font-sans", stack);
    }
  } catch {}
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initHub);
} else {
  initHub();
}
