// eslint-disable-next-line import/no-unassigned-import
import "./style.css";
import { TerminalController } from "./controller";

function bootstrap() {
  const controller = new TerminalController();
  controller.init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
