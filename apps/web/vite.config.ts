import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "app"),
  publicDir: path.resolve(import.meta.dirname, "public"),
  base: "/",
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "/src": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    fs: {
      allow: [import.meta.dirname],
    },
  },
  plugins: [
    tailwindcss(),
    {
      name: "html-route-fallback",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url) {
            const [pathname, search] = req.url.split("?");
            if (
              pathname === "/analytics" ||
              (pathname.startsWith("/analytics/") && !pathname.slice(11).includes("."))
            ) {
              req.url = "/analytics.html" + (search ? `?${search}` : "");
            } else if (pathname === "/spread") {
              req.url = "/spread.html" + (search ? `?${search}` : "");
            } else if (pathname === "/checker") {
              req.url = "/checker.html" + (search ? `?${search}` : "");
            }
          }
          next();
        });
      },
    },
  ],
  define: {
    APP_VERSION: JSON.stringify("dev"),
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    minify: "esbuild",
    cssMinify: "esbuild",
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, "app/index.html"),
        spread: path.resolve(import.meta.dirname, "app/spread.html"),
        analytics: path.resolve(import.meta.dirname, "app/analytics.html"),
        checker: path.resolve(import.meta.dirname, "app/checker.html"),
      },
    },
  },
});
