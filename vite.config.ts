import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: "web",
  base: "/",
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
        index: path.resolve(import.meta.dirname, "web/index.html"),
        spread: path.resolve(import.meta.dirname, "web/spread.html"),
        analytics: path.resolve(import.meta.dirname, "web/analytics.html"),
        checker: path.resolve(import.meta.dirname, "web/checker.html"),
      },
    },
  },
});
