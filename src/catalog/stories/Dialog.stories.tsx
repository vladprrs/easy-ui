import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory } from "./story-utils";
const meta = { title: "Catalog/Dialog", render: (args) => <ElementStory type="Dialog" args={args} />, args: fixtures.Dialog.props, parameters: { initialState: { dialogOpen: true } } } satisfies Meta<Record<string, unknown>>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
