import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { manifest: true },
  appType: "spa",
  server: {
    proxy: {
      "/storybook": {
        target: "http://localhost:6006",
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/storybook/, ""),
      },
    },
  },
  // Do not inherit the development Storybook proxy in `vite preview`:
  // production serves the built files from dist/storybook on the same origin.
  preview: { proxy: {} },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
