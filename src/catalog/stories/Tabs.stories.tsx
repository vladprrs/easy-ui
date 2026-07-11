import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory, titleFor } from "./story-utils";
const meta = { title: "Shadcn/Organisms/Tabs", render: (args) => <ElementStory type="Tabs" args={args} />, args: fixtures.Tabs.props } satisfies Meta<Record<string, unknown>>;
if (meta.title !== titleFor("Tabs")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
