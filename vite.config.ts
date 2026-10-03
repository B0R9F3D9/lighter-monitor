import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "web/app"),
  publicDir: path.resolve(import.meta.dirname, "web/public"),
  base: "/",
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "web/src"),
      "/src": path.resolve(import.meta.dirname, "web/src"),
    },
  },
  server: {
    fs: {
      allow: [path.resolve(import.meta.dirname, "web")],
    },
  },
  plugins: [tailwindcss()],
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
        index: path.resolve(import.meta.dirname, "web/app/index.html"),
        spread: path.resolve(import.meta.dirname, "web/app/spread.html"),
        analytics: path.resolve(import.meta.dirname, "web/app/analytics.html"),
        checkerSolo: path.resolve(import.meta.dirname, "web/app/checker/solo.html"),
        checkerHedge: path.resolve(import.meta.dirname, "web/app/checker/hedge.html"),
      },
    },
  },
});
