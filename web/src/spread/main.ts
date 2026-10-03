// eslint-disable-next-line import/no-unassigned-import
import "../style.css";
import { TerminalController } from "./controller";
import { initVersionChecker, initMobileNav } from "../shared";

function bootstrap() {
  const controller = new TerminalController();
  controller.init();
  initVersionChecker();
  initMobileNav();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
