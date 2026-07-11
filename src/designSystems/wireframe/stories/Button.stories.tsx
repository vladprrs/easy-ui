import type { Meta, StoryObj } from "@storybook/react-vite";
import { ElementStory, wireframeTitleFor } from "../../../catalog/stories/story-utils";
import { wireframeFixtures } from "..";

const meta = { title: "Wireframe/Atoms/Button", render: (args) => <ElementStory type="Button" args={args} system="wireframe" />, args: wireframeFixtures.Button.props } satisfies Meta<Record<string, unknown>>;
if (meta.title !== wireframeTitleFor("Button")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
