import type { Meta, StoryObj } from "@storybook/react-vite";
import { ElementStory, wireframeTitleFor } from "../../../catalog/stories/story-utils";
import { wireframeFixtures } from "..";

const meta = { title: "Wireframe/Molecules/Select", render: (args) => <ElementStory type="Select" args={args} system="wireframe" />, args: wireframeFixtures.Select.props } satisfies Meta<Record<string, unknown>>;
if (meta.title !== wireframeTitleFor("Select")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
