import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory, titleFor } from "./story-utils";

type Args = Record<string, unknown>;
const meta = { title: "Shadcn/Organisms/Card", render: (args) => <ElementStory type="Card" args={args} />, args: fixtures.Card.props } satisfies Meta<Args>;
if (meta.title !== titleFor("Card")) throw new Error(`Story title drift: ${meta.title}`);
export default meta;
export const Default: StoryObj<typeof meta> = {};
