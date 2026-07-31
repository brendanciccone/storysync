import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  // Provides the /mcp endpoint storysync reads components from.
  addons: ["@storybook/addon-mcp"],
  framework: { name: "@storybook/react-vite", options: {} },
};
export default config;
