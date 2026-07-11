import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory, titleFor } from "./story-utils";
const meta = { title: "Shadcn/Organisms/Table", render: (args) => <ElementStory type="Table" args={args} />, args: fixtures.Table.props } satisfies Meta<Record<string, unknown>>;
if (meta.title !== titleFor("Table")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
