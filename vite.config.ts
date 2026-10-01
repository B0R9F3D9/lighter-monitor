import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: "web",
  base: "/",
  plugins: [tailwindcss()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    minify: "esbuild",
    cssMinify: "esbuild",
  },
});
