import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory, titleFor } from "./story-utils";
const meta = { title: "Shadcn/Organisms/Dialog", render: (args) => <ElementStory type="Dialog" args={args} />, args: fixtures.Dialog.props, parameters: { initialState: { dialogOpen: true } } } satisfies Meta<Record<string, unknown>>;
if (meta.title !== titleFor("Dialog")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
