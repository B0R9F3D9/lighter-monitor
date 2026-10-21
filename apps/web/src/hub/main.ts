// eslint-disable-next-line import/no-unassigned-import
import "../style.css";
import { initVersionChecker, initFontSelector, initMobileNav } from "../shared";

function initHub(): void {
  initVersionChecker();
  initFontSelector();
  initMobileNav();

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
    } else if (e.key === "3") {
      e.preventDefault();
      window.location.href = "/checker";
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initHub);
} else {
  initHub();
}
