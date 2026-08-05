import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Component, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

  it("renders a pinned custom component when the loaded runtime is supplied", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "gallery-custom", name: "Gallery custom", designSystem: "e2e-custom-ds", device: "mobile", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Home", spec: { root: "stars", elements: {
        stars: { type: "RatingStars", props: { value: 3 } },
      } } }],
    });
    const custom = {
      definitions: { RatingStars: { props: z.strictObject({ value: z.number() }), description: "Stars" } },
      components: { RatingStars: (({ props }: { props: { value: number } }) => <button type="button">{"★".repeat(props.value)}</button>) as unknown as ComponentType },
    };
    render(<GalleryPreviewFrame draft={{ doc, rev: 1, builtinCatalogHash: "host", componentManifestHash: "stars", components: [] }} custom={custom} manageTheme={false} />);
    expect(screen.getByRole("button", { name: "★★★" })).toBeTruthy();
  });

  it("renders host Image and canvas-split Hotspot for a custom-only prototype", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "gallery-host", name: "Gallery host", designSystem: "custom-only", device: "mobile", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Home", canvas: { width: 390, height: 844 }, spec: { root: "image", elements: {
        image: { type: "Image", props: { src: "/images/gallery.png", alt: "Gallery host image", objectFit: "cover" } },
        hotspot: { type: "Hotspot", props: { x: 4, y: 5, width: 30, height: 40, ariaLabel: "Gallery host hotspot" } },
      } } }],
    });
    render(<GalleryPreviewFrame draft={{ doc, rev: 1, builtinCatalogHash: "host", componentManifestHash: "empty", components: [] }} manageTheme={false} />);
    expect(screen.getByRole("img", { name: "Gallery host image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gallery host hotspot" })).toBeTruthy();
  });
});

describe("GalleryPreviewFrame на дуо-доке (multi-surface)", () => {
  beforeEach(() => {
    mocks.getThemeVersion.mockReset().mockResolvedValue({ systemId: "shadcn", version: 1, createdAt: "2026-08-01T00:00:00Z", tokens: {}, fonts: [], icons: [] });
    mocks.getLatestTheme.mockReset().mockResolvedValue({ id: "shadcn", latestMetaVersion: 1, tokens: {}, fonts: [], icons: [] });
  });
  afterEach(cleanup);

  it("подписывает превью бейджем поверхностей и меряет его по primary (D3)", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "duo-gallery", name: "Дуо", designSystem: "shadcn", device: "desktop", startScreen: "kso", state: {},
      surfaces: [
        { id: "kso", name: "КСО", device: "desktop", startScreen: "kso" },
        { id: "app", name: "Приложение", device: "mobile", startScreen: "app" },
      ],
      screens: [
        { id: "kso", name: "Касса", surface: "kso", canvas: { width: 1080, height: 1920 }, spec: { root: "t", elements: { t: { type: "Text", props: { text: "Касса" } } } } },
        { id: "app", name: "Дом", surface: "app", spec: { root: "t", elements: { t: { type: "Text", props: { text: "Дом" } } } } },
      ],
    });
    render(<GalleryPreviewFrame draft={{ doc, rev: 1, builtinCatalogHash: "b", componentManifestHash: "m", components: [], designSystemMetaVersion: 1 }} />);
    const badge = screen.getByTestId("gallery-preview-surfaces");
    expect(badge.textContent).toBe("2 поверхности");
    expect(badge.getAttribute("title")).toBe("Поверхности: КСО, Приложение");
    // Кадр — стартовый экран primary-поверхности, то есть КСО с его холстом.
    expect(document.querySelector<HTMLElement>("[data-eui-stage-viewport='gallery']")!.style.width).toBe("1080px");
  });

  it("не рисует бейдж на обычном документе", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "plain-gallery", name: "Plain", designSystem: "shadcn", device: "mobile", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Дом", spec: { root: "t", elements: { t: { type: "Text", props: { text: "Дом" } } } } }],
    });
    render(<GalleryPreviewFrame draft={{ doc, rev: 1, builtinCatalogHash: "b", componentManifestHash: "m", components: [], designSystemMetaVersion: 1 }} />);
    expect(screen.queryByTestId("gallery-preview-surfaces")).toBeNull();
  });
});
