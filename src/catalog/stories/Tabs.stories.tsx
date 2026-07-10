import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory } from "./story-utils";
const meta = { title: "Catalog/Tabs", render: (args) => <ElementStory type="Tabs" args={args} />, args: fixtures.Tabs.props } satisfies Meta<Record<string, unknown>>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
