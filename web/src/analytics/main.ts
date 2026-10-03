import { AnalyticsController } from "./controller";
import { initVersionChecker, initMobileNav } from "../shared";

function bootstrap() {
  const controller = new AnalyticsController();
  controller.init();
  initVersionChecker();
  initMobileNav();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
