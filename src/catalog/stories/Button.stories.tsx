import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory, titleFor } from "./story-utils";

const meta = { title: "Shadcn/Atoms/Button", render: (args) => <ElementStory type="Button" args={args} />, args: fixtures.Button.props } satisfies Meta<Record<string, unknown>>;
if (meta.title !== titleFor("Button")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
