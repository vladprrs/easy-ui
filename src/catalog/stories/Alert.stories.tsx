import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory } from "./story-utils";
const meta = { title: "Catalog/Alert", render: (args) => <ElementStory type="Alert" args={args} />, args: fixtures.Alert.props } satisfies Meta<Record<string, unknown>>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
