// eslint-disable-next-line import/no-unassigned-import
import "../style.css";
import { CheckerController } from "./controller";
import { initFontSelector, initVersionChecker, initMobileNav } from "../shared";

function bootstrap(): void {
  initFontSelector();
  initVersionChecker();
  initMobileNav();
  const controller = new CheckerController();
  controller.init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
