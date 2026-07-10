import type { Preview } from "@storybook/react-vite";
import { JSONUIProvider } from "@json-render/react";
import { action } from "storybook/actions";
import { createPlayerRuntime } from "../src/catalog/runtime";
import "../src/styles/index.css";

const runtime = createPlayerRuntime({
  navigate: (screenId) => action("navigate")({ screenId }),
  back: () => action("back")({}),
  openUrl: (url) => action("openUrl")({ url }),
  restart: () => action("restart")({}),
});

const preview: Preview = {
  decorators: [
    (Story, context) => (
      <JSONUIProvider
        registry={runtime.registry}
        handlers={runtime.handlers}
        initialState={(context.parameters.initialState as Record<string, unknown> | undefined) ?? {}}
      >
        <Story />
      </JSONUIProvider>
    ),
  ],
  parameters: {
    layout: "centered",
    controls: { expanded: true },
  },
};

export default preview;
