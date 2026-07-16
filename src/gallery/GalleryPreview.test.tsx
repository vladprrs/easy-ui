import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeDraft } from "../api/client";
import { prototypeDocSchema } from "../prototype/schema";

const mocks = vi.hoisted(() => ({ getThemeVersion: vi.fn(), getLatestTheme: vi.fn() }));
vi.mock("../api/client", async (original) => ({ ...(await original()), getDesignSystemVersion: mocks.getThemeVersion, getDesignSystemById: mocks.getLatestTheme }));

import { GalleryPreviewErrorBoundary, GalleryPreviewFrame } from "./GalleryPreview";

class ThrowPreview extends Component<{ children?: ReactNode }> {
  render(): ReactNode { throw new Error("broken preview"); }
}

describe("GalleryPreviewErrorBoundary", () => {
  beforeEach(() => {
    mocks.getThemeVersion.mockReset().mockResolvedValue({ systemId: "shadcn", version: 1, createdAt: "2026-07-01T00:00:00Z", tokens: { "space.md": "18px", "space.lg": "24px", "space.xl": "32px", "space.2xl": "40px" }, fonts: [], icons: [] });
    mocks.getLatestTheme.mockReset().mockResolvedValue({ id: "shadcn", latestMetaVersion: 2, tokens: { "space.md": "36px", "space.lg": "44px", "space.xl": "52px", "space.2xl": "60px", "space.3xl": "68px", "space.4xl": "76px" }, fonts: [], icons: [] });
  });
  afterEach(cleanup);

  it("drops only a failed preview and preserves the metadata card", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<article data-testid="card">
      <h2>Метаданные прототипа</h2>
      <GalleryPreviewErrorBoundary prototypeId="broken"><ThrowPreview /></GalleryPreviewErrorBoundary>
      <p>3 экрана</p>
    </article>);
    expect(screen.getByTestId("card")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Метаданные прототипа" })).toBeTruthy();
    expect(screen.getByText("3 экрана")).toBeTruthy();
    consoleError.mockRestore();
  });

  it("keeps Gallery Overlay in the inner native StageViewport through both scales", async () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "gallery-overlay", name: "Gallery Overlay", designSystem: "shadcn", device: "tablet", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Home", canvas: { width: 1000, height: 1200 }, spec: { root: "root", elements: {
        root: { type: "Stack", props: {}, children: ["body", "overlay"] },
        body: { type: "Text", props: { text: "Body" } },
        overlay: { type: "Overlay", props: { placement: "bottom", inset: "md", scrim: false }, children: ["action"] },
        action: { type: "Text", props: { text: "Gallery action" } },
      } } }],
    });
    const draft: PrototypeDraft = { doc, rev: 7, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [], designSystemMetaVersion: 1 };
    render(<GalleryPreviewFrame draft={draft} />);
    const stage = document.querySelector<HTMLElement>("[data-eui-stage-viewport='gallery']")!;
    await waitFor(() => expect(stage.querySelector("[data-eui-host-primitive='Overlay']")).not.toBeNull());
    expect(stage.style.transform).toBe("scale(0.42)");
    expect(stage.parentElement!.style.transform).toContain("scale(0.666666");
    expect(stage.style.getPropertyValue("--eui-space-md")).toBe("18px");
    expect(stage.hasAttribute("inert")).toBe(true);
    expect(Number.parseFloat(screen.getByTestId("gallery-preview-gallery-overlay").style.height)).toBeLessThanOrEqual(200);
    expect(mocks.getThemeVersion).toHaveBeenCalledWith("shadcn", 1, expect.any(AbortSignal));
    expect(mocks.getLatestTheme).not.toHaveBeenCalled();
  });
});
