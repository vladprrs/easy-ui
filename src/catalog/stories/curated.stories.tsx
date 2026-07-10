import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory } from "./story-utils";

type Args = Record<string, unknown>;
const meta = { title: "Catalog/Card", render: (args) => <ElementStory type="Card" args={args} />, args: fixtures.Card.props } satisfies Meta<Args>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
