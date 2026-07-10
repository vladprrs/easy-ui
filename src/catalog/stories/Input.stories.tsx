import type { Spec } from "@json-render/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory, SpecStory } from "./story-utils";

const meta = { title: "Catalog/Input", render: (args) => <ElementStory type="Input" args={args} />, args: fixtures.Input.props } satisfies Meta<Record<string, unknown>>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
export const BoundState: StoryObj<typeof meta> = {
  parameters: { initialState: { name: "Ada" } },
  render: (args) => <SpecStory spec={{ root: "stack", elements: {
    stack: { type: "Stack", props: { direction: "vertical", gap: "md" }, children: ["input", "preview"] },
    input: { type: "Input", props: { ...args, value: { $bindState: "/name" } }, children: [] },
    preview: { type: "Text", props: { text: { $template: "Hello, ${/name}!" }, variant: "lead" }, children: [] },
  } } as Spec} />,
};
