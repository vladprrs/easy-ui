import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory, titleFor } from "./story-utils";
const meta = { title: "Shadcn/Molecules/Select", render: (args) => <ElementStory type="Select" args={args} />, args: fixtures.Select.props } satisfies Meta<Record<string, unknown>>;
if (meta.title !== titleFor("Select")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
