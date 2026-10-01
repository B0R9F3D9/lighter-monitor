// eslint-disable-next-line import/no-unassigned-import
import "../style.css";
import { TerminalController } from "./controller";
import { initVersionChecker } from "../shared/version_checker";

function bootstrap() {
  const controller = new TerminalController();
  controller.init();
  initVersionChecker();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
