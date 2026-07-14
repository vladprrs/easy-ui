import { defineConfig, devices } from "@playwright/test";

// Vite's default host resolves to IPv6 localhost in the code-server container.
// Keep default ports and let Playwright detect the actual listener by URL.
const viteHost = "localhost";
const bunHost = "127.0.0.1";
const bun = `${process.env.HOME}/.bun/bin/bun`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "npm run dev",
      url: `http://${viteHost}:5173`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run storybook",
      url: `http://${viteHost}:6006`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: `rm -rf .e2e-data/dev && DATA_DIR=.e2e-data/dev PORT=8787 ${bun} server/main.ts`,
      url: `http://${bunHost}:8787/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `npm run build && rm -rf .e2e-data/preview && DATA_DIR=.e2e-data/preview SERVE_DIST=dist PORT=4173 ${bun} server/main.ts`,
      url: `http://${bunHost}:4173/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
    {
      // W3-3 auth-preview shares the completed production build, but owns an isolated DB.
      // Waiting for preview health avoids a second concurrent write into dist.
      command: `rm -rf .e2e-data/auth-preview && until ${bun} -e "const r=await fetch('http://127.0.0.1:4173/api/health').catch(()=>null);process.exit(r?.ok?0:1)"; do sleep 1; done; DATA_DIR=.e2e-data/auth-preview SERVE_DIST=dist PORT=4174 BASIC_AUTH=owner:secret PUBLIC_ORIGIN=http://127.0.0.1:4174 ${bun} server/main.ts`,
      url: `http://${bunHost}:4174/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
  projects: [
    {
      // Provisions API-backed fixtures (custom design system, W0-8) before dev specs run.
      name: "dev-setup",
      testMatch: /dev\/.*\.setup\.ts/,
      use: { baseURL: `http://${viteHost}:5173` },
    },
    {
      name: "dev",
      testMatch: /dev\/.*\.spec\.ts/,
      dependencies: ["dev-setup"],
      use: { baseURL: `http://${viteHost}:5173` },
    },
    {
      name: "preview",
      testMatch: /preview\/.*\.spec\.ts/,
      use: { baseURL: `http://${bunHost}:4173` },
    },
    {
      name: "auth-preview",
      testMatch: /share\/.*\.spec\.ts/,
      use: { baseURL: `http://${bunHost}:4174` },
    },
  ],
});
