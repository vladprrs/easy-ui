import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  addons: ["@storybook/addon-docs"],
  stories: ["../src/**/*.stories.tsx"],
  // Storybook has its own host validation (403 "Invalid host" behind the
  // workspace reverse proxy) — allow the *.coder proxy hostnames.
  core: { allowedHosts: ["pay-proto.coder", ".coder"] },
  // Storybook builds its own Vite dev server and does not inherit the app's
  // server.allowedHosts; the workspace reverse proxy serves it under *.coder.
  viteFinal: async (viteConfig) => ({
    ...viteConfig,
    server: { ...viteConfig.server, allowedHosts: [".coder"] },
  }),
};

export default config;
