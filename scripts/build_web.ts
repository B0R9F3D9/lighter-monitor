import { spawnSync } from "node:child_process";
import path from "node:path";

const rootDir = process.cwd();
const webDir = path.resolve(rootDir, "apps/web");

console.log("⚡ Delegating build to @lighter-monitor/web (apps/web)...");
const res = spawnSync("bun", ["run", "build"], {
  cwd: webDir,
  stdio: "inherit",
});

if (res.error) {
  console.error("Build failed:", res.error);
  process.exit(1);
}
process.exit(res.status ?? 0);
