// eslint-disable-next-line import/no-unassigned-import
import "../style.css";
import { HedgeController } from "./controller";
import { initFontSelector } from "../shared";
import { initVersionChecker } from "../shared/version_checker";

function initApp(): void {
  initVersionChecker();
  initFontSelector();

  const controller = new HedgeController();
  controller.init();

  // Expose controller globally for browser console debugging / testing
  (window as unknown as { hedgeController: HedgeController }).hedgeController = controller;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
