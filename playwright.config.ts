import { defineConfig, devices } from "@playwright/test";

// Vite's default host resolves to IPv6 localhost in the code-server container.
// Keep default ports and let Playwright detect the actual listener by URL.
const viteHost = "localhost";
const bunHost = "127.0.0.1";
const bun = `${process.env.HOME}/.bun/bin/bun`;
const adminEnv = `ADMIN_NAME='E2E Admin' ADMIN_PASSWORD=e2e-admin-password`;

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
      command: `${adminEnv} npm run dev`,
      url: `http://${viteHost}:5173`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: `${adminEnv} npm run storybook`,
      url: `http://${viteHost}:6006`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: `rm -rf .e2e-data/dev && ${adminEnv} DATA_DIR=.e2e-data/dev PORT=8787 PUBLIC_ORIGIN=http://${viteHost}:5173 ${bun} server/main.ts`,
      url: `http://${bunHost}:8787/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `${adminEnv} npm run build && rm -rf .e2e-data/preview && ${adminEnv} DATA_DIR=.e2e-data/preview SERVE_DIST=dist PORT=4173 ${bun} server/main.ts`,
      url: `http://${bunHost}:4173/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
    {
      // W3-3 auth-preview shares the completed production build, but owns an isolated DB.
      // Waiting for preview health avoids a second concurrent write into dist.
      command: `rm -rf .e2e-data/auth-preview && until ${bun} -e "const r=await fetch('http://127.0.0.1:4173/api/health').catch(()=>null);process.exit(r?.ok?0:1)"; do sleep 1; done; ${adminEnv} DATA_DIR=.e2e-data/auth-preview SERVE_DIST=dist PORT=4174 LEGACY_BASIC_AUTH=edge:secret PUBLIC_ORIGIN=http://127.0.0.1:4174 ${bun} server/main.ts`,
      url: `http://${bunHost}:4174/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
  projects: [
    {
      name: "dev-setup",
      testMatch: /setup\/dev\.setup\.ts/,
      use: { baseURL: `http://${viteHost}:5173` },
    },
    {
      name: "dev",
      testMatch: /dev\/.*\.spec\.ts/,
      dependencies: ["dev-setup"],
      use: { baseURL: `http://${viteHost}:5173`, storageState: ".e2e-data/storage/dev.json", extraHTTPHeaders: { origin: `http://${viteHost}:5173` } },
    },
    {
      name: "preview-setup",
      testMatch: /setup\/preview\.setup\.ts/,
      use: { baseURL: `http://${bunHost}:4173` },
    },
    {
      name: "preview",
      testMatch: /preview\/.*\.spec\.ts/,
      dependencies: ["preview-setup"],
      use: { baseURL: `http://${bunHost}:4173`, storageState: ".e2e-data/storage/preview.json", extraHTTPHeaders: { origin: `http://${bunHost}:4173` } },
    },
    {
      name: "auth-preview-setup",
      testMatch: /setup\/auth-preview\.setup\.ts/,
      use: { baseURL: `http://${bunHost}:4174` },
    },
    {
      name: "auth-preview",
      testMatch: /share\/.*\.spec\.ts/,
      dependencies: ["auth-preview-setup"],
      use: { baseURL: `http://${bunHost}:4174` },
    },
  ],
});
