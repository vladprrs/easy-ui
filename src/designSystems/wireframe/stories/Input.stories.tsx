import type { Meta, StoryObj } from "@storybook/react-vite";
import { ElementStory, wireframeTitleFor } from "../../../catalog/stories/story-utils";
import { wireframeFixtures } from "..";

const meta = { title: "Wireframe/Atoms/Input", render: (args) => <ElementStory type="Input" args={args} system="wireframe" />, args: wireframeFixtures.Input.props } satisfies Meta<Record<string, unknown>>;
if (meta.title !== wireframeTitleFor("Input")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
