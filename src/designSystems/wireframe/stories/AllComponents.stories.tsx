import type { Spec } from "@json-render/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SpecStory } from "../../../catalog/stories/story-utils";
import { wireframeFixtures } from "..";

const meta = { title: "Wireframe/All Components", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
export const Gallery: StoryObj = {
  render: () => <div className="grid gap-6 md:grid-cols-2">{Object.entries(wireframeFixtures).map(([name, element]) => <section className="min-w-0 rounded-lg border bg-card p-4" key={name}><h2 className="mb-4 text-sm font-semibold text-muted-foreground">{name}</h2><SpecStory spec={{ root: "demo", elements: { demo: element } } as Spec} system="wireframe" /></section>)}</div>,
};
