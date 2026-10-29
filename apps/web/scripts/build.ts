import { build } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { minify } from "html-minifier-terser";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const webDir = path.resolve(import.meta.dirname, "..");
const outDir = path.resolve(webDir, "dist");

function writeIfChanged(filePath: string, newContent: string): boolean {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf-8");
    if (existing === newContent) return false;
  }
  fs.writeFileSync(filePath, newContent, "utf-8");
  return true;
}

function parseChangelogSection(
  changelogPath: string,
  targetVersion: string,
): { title: string; highlights: string[] } {
  if (!fs.existsSync(changelogPath)) {
    return { title: "", highlights: [] };
  }
  const content = fs.readFileSync(changelogPath, "utf-8");
  const cleanVer = targetVersion.replace(/^v/, "");
  const escapedVer = cleanVer.replace(/\./g, "\\.");
  const sectionRegex = new RegExp(`##\\s*\\[v?${escapedVer}\\][^\\n]*`, "i");
  const match = sectionRegex.exec(content);
  if (!match) {
    return { title: "", highlights: [] };
  }
  const header = match[0];
  const parts = header.split(/\s+[\u2014\u2013]\s+/);
  const title = parts.length > 1 ? parts[parts.length - 1].trim() : "";

  const startIndex = match.index + header.length;
  const nextSectionMatch = content.slice(startIndex).search(/\n##\s*\[/);
  const sectionBody =
    nextSectionMatch !== -1
      ? content.slice(startIndex, startIndex + nextSectionMatch)
      : content.slice(startIndex);

  const botHighlights: string[] = [];
  const webHighlights: string[] = [];
  const otherHighlights: string[] = [];

  let currentCategory = "";
  for (const line of sectionBody.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("### ")) {
      currentCategory = trimmed.toLowerCase();
      continue;
    }
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const rawItem = trimmed.slice(2).trim();
      if (!rawItem) continue;

      // Filter out internal technical/dev-only bullets (Core, Security, Performance, ETag, etc.)
      if (
        currentCategory.includes("core") ||
        currentCategory.includes("security") ||
        currentCategory.includes("performance")
      ) {
        continue;
      }

      if (currentCategory.includes("telegram") || currentCategory.includes("bot")) {
        botHighlights.push(rawItem);
      } else if (currentCategory.includes("web") || currentCategory.includes("terminal")) {
        webHighlights.push(rawItem);
      } else {
        otherHighlights.push(rawItem);
      }
    }
  }

  const highlights = [...botHighlights, ...webHighlights, ...otherHighlights];
  return { title, highlights };
}

function computeWebHash(): string {
  const hash = crypto.createHash("sha256");
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== ".vite") {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        // Exclude generated files from input hash to guarantee idempotency
        if (entry.name === "version.ts") continue;
        hash.update(path.relative(webDir, fullPath));
        hash.update(fs.readFileSync(fullPath));
      }
    }
  }
  walk(path.resolve(webDir, "src"));
  walk(path.resolve(webDir, "app"));
  walk(path.resolve(webDir, "public"));
  if (fs.existsSync(path.resolve(webDir, "vite.config.ts"))) {
    hash.update(fs.readFileSync(path.resolve(webDir, "vite.config.ts")));
  }
  return "v" + hash.digest("hex").slice(0, 10);
}

const rootPkgPath = path.resolve(webDir, "../../package.json");
let pkgVersion = "v1.0.0";
if (fs.existsSync(rootPkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
    if (pkg.version) {
      pkgVersion = pkg.version.startsWith("v") ? pkg.version : `v${pkg.version}`;
    }
  } catch {}
}

const buildVersion = pkgVersion;
const buildHash = computeWebHash();

console.log(
  `🚀 Building frontend with Vite 8 + Tailwind v4 (Version: ${buildVersion}, Hash: ${buildHash})...`,
);
await build({
  root: path.resolve(webDir, "app"),
  publicDir: path.resolve(webDir, "public"),
  base: "/",
  resolve: {
    alias: {
      "@": path.resolve(webDir, "src"),
      "/src": path.resolve(webDir, "src"),
    },
  },
  plugins: [tailwindcss()],
  define: {
    APP_VERSION: JSON.stringify(buildVersion),
    BUILD_HASH: JSON.stringify(buildHash),
  },
  build: {
    outDir,
    emptyOutDir: true,
    minify: "esbuild",
    cssMinify: "esbuild",
    rollupOptions: {
      input: {
        index: path.resolve(webDir, "app/index.html"),
        spread: path.resolve(webDir, "app/spread.html"),
        analytics: path.resolve(webDir, "app/analytics.html"),
        checker: path.resolve(webDir, "app/checker.html"),
      },
    },
  },
});

const minifyConfig = {
  collapseWhitespace: true,
  removeComments: true,
  removeRedundantAttributes: true,
  useShortDoctype: true,
  minifyCSS: false,
  minifyJS: false,
};

console.log("🗜️  Minifying HTML markup with html-minifier-terser...");

function injectVersionMeta(html: string, version: string, hash: string): string {
  let res = html;
  if (!res.includes('<meta name="version"')) {
    res = res.replace("<head>", `<head><meta name="version" content="${version}">`);
  }
  if (!res.includes('<meta name="build-hash"')) {
    res = res.replace("<head>", `<head><meta name="build-hash" content="${hash}">`);
  }
  return res;
}

async function readHtmlFile(filePath: string, maxRetries = 10): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    if (fs.existsSync(filePath)) {
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    } else {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`File not found or unreadable: ${filePath}`);
}

const rawHubHtml = await readHtmlFile(path.resolve(outDir, "index.html"));
const rawSpreadHtml = await readHtmlFile(path.resolve(outDir, "spread.html"));
const rawAnalyticsHtml = await readHtmlFile(path.resolve(outDir, "analytics.html"));
const rawCheckerHtml = await readHtmlFile(path.resolve(outDir, "checker.html"));

const minifiedHubHtml = await minify(
  injectVersionMeta(rawHubHtml, buildVersion, buildHash),
  minifyConfig,
);
const minifiedSpreadHtml = await minify(
  injectVersionMeta(rawSpreadHtml, buildVersion, buildHash),
  minifyConfig,
);
const minifiedAnalyticsHtml = await minify(
  injectVersionMeta(rawAnalyticsHtml, buildVersion, buildHash),
  minifyConfig,
);
const minifiedCheckerHtml = await minify(
  injectVersionMeta(rawCheckerHtml, buildVersion, buildHash),
  minifyConfig,
);

fs.writeFileSync(path.resolve(outDir, "index.html"), minifiedHubHtml, "utf-8");
fs.writeFileSync(path.resolve(outDir, "spread.html"), minifiedSpreadHtml, "utf-8");
fs.writeFileSync(path.resolve(outDir, "analytics.html"), minifiedAnalyticsHtml, "utf-8");
fs.writeFileSync(path.resolve(outDir, "checker.html"), minifiedCheckerHtml, "utf-8");

const hubHtmlHash = crypto.createHash("sha256").update(minifiedHubHtml).digest("hex").slice(0, 10);
const spreadHtmlHash = crypto
  .createHash("sha256")
  .update(minifiedSpreadHtml)
  .digest("hex")
  .slice(0, 10);
const analyticsHtmlHash = crypto
  .createHash("sha256")
  .update(minifiedAnalyticsHtml)
  .digest("hex")
  .slice(0, 10);
const checkerHtmlHash = crypto
  .createHash("sha256")
  .update(minifiedCheckerHtml)
  .digest("hex")
  .slice(0, 10);

const changelogPath = path.resolve(webDir, "../../CHANGELOG.md");
const { title: releaseTitle, highlights: releaseHighlights } = parseChangelogSection(
  changelogPath,
  buildVersion,
);

const versionModuleContent = `// Auto-generated by scripts/build.ts. Do not edit directly.
export const APP_VERSION = ${JSON.stringify(buildVersion)};
export const BUILD_HASH = ${JSON.stringify(buildHash)};
export const HUB_HTML_HASH = ${JSON.stringify(hubHtmlHash)};
export const SPREAD_HTML_HASH = ${JSON.stringify(spreadHtmlHash)};
export const ANALYTICS_HTML_HASH = ${JSON.stringify(analyticsHtmlHash)};
export const CHECKER_HTML_HASH = ${JSON.stringify(checkerHtmlHash)};
export const CHECKER_SOLO_HTML_HASH = ${JSON.stringify(checkerHtmlHash)};
export const CHECKER_HEDGE_HTML_HASH = ${JSON.stringify(checkerHtmlHash)};
export const HEDGE_HTML_HASH = ${JSON.stringify(checkerHtmlHash)};
export const RELEASE_TITLE = ${JSON.stringify(releaseTitle)};
export const RELEASE_HIGHLIGHTS: string[] = ${JSON.stringify(releaseHighlights)};
`;

const botVersionModuleContent = `// Auto-generated by scripts/build.ts. Do not edit directly.
export const APP_VERSION = ${JSON.stringify(buildVersion)};
export const BUILD_HASH = ${JSON.stringify(buildHash)};
export const GITHUB_REPO = "B0R9F3D9/lighter-monitor";
export const CHANGELOG_URL = "https://github.com/B0R9F3D9/lighter-monitor/blob/main/CHANGELOG.md";
export const RELEASE_URL = ${JSON.stringify(`https://github.com/B0R9F3D9/lighter-monitor/releases/tag/${buildVersion}`)};
export const RELEASE_TITLE = ${JSON.stringify(releaseTitle)};
export const RELEASE_HIGHLIGHTS: string[] = ${JSON.stringify(releaseHighlights)};
`;

const versionJsonContent = JSON.stringify(
  {
    version: buildVersion,
    buildHash: buildHash,
    releaseTitle: releaseTitle,
    releaseHighlights: releaseHighlights,
    changelogUrl: "https://github.com/B0R9F3D9/lighter-monitor/blob/main/CHANGELOG.md",
    releaseUrl: `https://github.com/B0R9F3D9/lighter-monitor/releases/tag/${buildVersion}`,
    hubHash: hubHtmlHash,
    spreadHash: spreadHtmlHash,
    analyticsHash: analyticsHtmlHash,
    checkerHash: checkerHtmlHash,
    timestamp: Date.now(),
  },
  null,
  2,
);

const versionChanged = writeIfChanged(path.resolve(webDir, "src/version.ts"), versionModuleContent);
const botVersionPath = path.resolve(webDir, "../bot/src/version.ts");
const botVersionChanged = writeIfChanged(botVersionPath, botVersionModuleContent);

fs.writeFileSync(path.resolve(outDir, "version.json"), versionJsonContent, "utf-8");

console.log("✓ Hub Router HTML minified:", minifiedHubHtml.length, "bytes");
console.log("✓ Spread HTML minified:", minifiedSpreadHtml.length, "bytes");
console.log("✓ Analytics HTML minified:", minifiedAnalyticsHtml.length, "bytes");
console.log("✓ Checker HTML minified:", minifiedCheckerHtml.length, "bytes");
console.log(
  versionChanged
    ? "✓ Generated apps/web/src/version.ts"
    : "✓ apps/web/src/version.ts is up to date",
);
console.log(
  botVersionChanged
    ? "✓ Generated apps/bot/src/version.ts"
    : "✓ apps/bot/src/version.ts is up to date",
);
console.log("✓ Generated apps/web/dist/version.json");
