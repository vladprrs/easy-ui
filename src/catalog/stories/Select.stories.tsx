import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory } from "./story-utils";
const meta = { title: "Catalog/Select", render: (args) => <ElementStory type="Select" args={args} />, args: fixtures.Select.props } satisfies Meta<Record<string, unknown>>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
