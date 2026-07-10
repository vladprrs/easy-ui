import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtures } from "../fixtures";
import { ElementStory } from "./story-utils";
const meta = { title: "Catalog/Hotspot", render: (args) => <div className="relative h-64 w-96 overflow-hidden rounded-lg border bg-muted"><ElementStory type="Hotspot" args={args} /></div>, args: fixtures.Hotspot.props, parameters: { layout: "centered" } } satisfies Meta<Record<string, unknown>>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
