// eslint-disable-next-line import/no-unassigned-import
import "../style.css";
import { CheckerController } from "./controller";
import { initFontSelector } from "../shared";
import { initVersionChecker } from "../shared/version_checker";

function bootstrap(): void {
  initFontSelector();
  initVersionChecker();
  const controller = new CheckerController();
  controller.init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
