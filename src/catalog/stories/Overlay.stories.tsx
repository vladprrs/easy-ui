import type { Spec } from "@json-render/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { OverlayProps } from "../hostPrimitives";
import { SpecStory } from "./story-utils";

const overlaySpec = (placement: OverlayProps["placement"], scrim = false, canvas = false): Spec => ({
  root: "root",
  elements: {
    root: { type: "Stack", props: { gap: "md" }, children: ["canvas", "overlay"] },
    canvas: {
      type: "Box",
      props: { label: canvas ? "Canvas content layer (390 × 844)" : "Scrollable screen content" },
      children: canvas ? ["canvas-heading", "canvas-copy"] : ["content-heading", "content-copy"],
    },
    "canvas-heading": { type: "Heading", props: { text: "Map canvas", level: 2 } },
    "canvas-copy": { type: "Text", props: { text: "Overlay is the ordered layer above canvas content and hotspots." } },
    "content-heading": { type: "Heading", props: { text: "Account overview", level: 2 } },
    "content-copy": { type: "Text", props: { text: "The overlay stays anchored to the stage viewport." } },
    overlay: { type: "Overlay", props: { placement, inset: "md", scrim }, children: ["notice"] },
    notice: { type: "Button", props: { label: scrim ? "Confirm" : placement } },
  },
});

const meta = {
  title: "Host primitives/Overlay",
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const placementStory = (placement: OverlayProps["placement"]): Story => ({
  render: () => <SpecStory spec={overlaySpec(placement)} system="wireframe" />,
});

export const Top = placementStory("top");
export const Bottom = placementStory("bottom");
export const Center = placementStory("center");
export const TopLeft = placementStory("top-left");
export const TopRight = placementStory("top-right");
export const BottomLeft = placementStory("bottom-left");
export const BottomRight = placementStory("bottom-right");

export const Scrim: Story = {
  render: () => <SpecStory spec={overlaySpec("center", true)} system="wireframe" />,
};

export const CanvasLayer: Story = {
  render: () => <SpecStory spec={overlaySpec("bottom-right", false, true)} system="wireframe" />,
};
