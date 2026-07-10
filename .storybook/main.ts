import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  addons: ["@storybook/addon-docs"],
  stories: ["../src/**/*.stories.tsx"],
};

export default config;
