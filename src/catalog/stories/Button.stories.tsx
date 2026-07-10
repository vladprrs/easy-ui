import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory } from "./story-utils";

const meta = { title: "Catalog/Button", render: (args) => <ElementStory type="Button" args={args} />, args: fixtures.Button.props } satisfies Meta<Record<string, unknown>>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
