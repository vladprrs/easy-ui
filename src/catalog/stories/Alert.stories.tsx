import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory, titleFor } from "./story-utils";
const meta = { title: "Shadcn/Molecules/Alert", render: (args) => <ElementStory type="Alert" args={args} />, args: fixtures.Alert.props } satisfies Meta<Record<string, unknown>>;
if (meta.title !== titleFor("Alert")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
