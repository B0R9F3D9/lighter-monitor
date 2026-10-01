import { AnalyticsController } from "./controller";
import { initVersionChecker } from "../shared/version_checker";

function bootstrap() {
  const controller = new AnalyticsController();
  controller.init();
  initVersionChecker();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
