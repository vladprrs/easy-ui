import type { Meta, StoryObj } from "@storybook/react-vite";
import { ElementStory, wireframeTitleFor } from "../../../catalog/stories/story-utils";
import { wireframeFixtures } from "..";

const meta = { title: "Wireframe/Organisms/Card", render: (args) => <ElementStory type="Card" args={args} system="wireframe" />, args: wireframeFixtures.Card.props } satisfies Meta<Record<string, unknown>>;
if (meta.title !== wireframeTitleFor("Card")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
