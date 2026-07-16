import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const compatCssFile = "assets/shadcn-v1-compat.css";
const compatCss = readFileSync(new URL("./src/styles/shadcn-v1-compat.css", import.meta.url), "utf8");

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "immutable-css-compat",
      configureServer(server) {
        server.middlewares.use(`/${compatCssFile}`, (_request, response) => {
          response.setHeader("content-type", "text/css; charset=utf-8");
          response.end(compatCss);
        });
      },
      generateBundle() {
        this.emitFile({ type: "asset", fileName: compatCssFile, source: compatCss });
      },
    },
  ],
  build: { manifest: true },
  appType: "spa",
  server: {
    // Workspace reverse proxy exposes the dev server under *.coder hostnames.
    allowedHosts: [".coder"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  preview: { proxy: {}, allowedHosts: [".coder"] },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
