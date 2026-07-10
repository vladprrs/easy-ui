import { defineConfig, devices } from "@playwright/test";

// Vite's default host resolves to IPv6 localhost in the code-server container.
// Keep default ports and let Playwright detect the actual listener by URL.
const host = "localhost";

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
      url: `http://${host}:5173`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run storybook",
      url: `http://${host}:6006`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: "npm run preview",
      url: `http://${host}:4173`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "dev",
      testMatch: /dev\/.*\.spec\.ts/,
      use: { baseURL: `http://${host}:5173` },
    },
    {
      name: "preview",
      testMatch: /preview\/.*\.spec\.ts/,
      use: { baseURL: `http://${host}:4173` },
    },
  ],
});
