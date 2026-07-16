import type { Spec } from "@json-render/core";
import { JSONUIProvider } from "@json-render/react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpecStory } from "./story-utils";
import { createPlayerRuntime } from "../runtime";

const runtime = createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} });
const renderStory = (spec: Spec) => render(<JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} initialState={{}}><SpecStory spec={spec} /></JSONUIProvider>);

afterEach(cleanup);

describe("SpecStory StageViewport adapter", () => {
  it("keeps ordinary stories on the naked Renderer path", () => {
    renderStory({ root: "copy", elements: { copy: { type: "Text", props: { text: "Plain story" } } } } as Spec);
    expect(document.querySelector("[data-eui-stage-viewport='story']")).toBeNull();
  });

  it("creates a fixed host-box only for a spec containing Overlay", async () => {
    const spec = { root: "root", elements: {
      root: { type: "Stack", props: {}, children: ["body", "overlay"] },
      body: { type: "Text", props: { text: "Story body" } },
      overlay: { type: "Overlay", props: { placement: "top", inset: "md", scrim: false }, children: ["action"] },
      action: { type: "Text", props: { text: "Story action" } },
    } } as Spec;
    renderStory(spec);
    const stage = document.querySelector<HTMLElement>("[data-eui-stage-viewport='story']")!;
    await waitFor(() => expect(stage.querySelector("[data-eui-host-primitive='Overlay']")).not.toBeNull());
    expect(stage.style.width).toBe("390px");
    expect(stage.style.height).toBe("844px");
    expect(stage.style.position).toBe("relative");
    expect(stage.style.getPropertyValue("--eui-space-md")).toBe("12px");
  });
});
