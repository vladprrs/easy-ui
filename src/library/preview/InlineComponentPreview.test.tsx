import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, type ComponentPreviewData, type LibraryCatalogEntry } from "../../api/client";
import { library } from "../../app/strings/library";
import type { CustomPlayerRuntime } from "../../catalog/runtime";
import { FullDocumentReloadRequiredError } from "../../customComponents/loader";
import { resetFontRegistryForTests } from "../../designSystems/fontRegistry";
import { resetThemeCacheForTests } from "../../designSystems/themeCache";
import { InlineComponentPreview } from "./InlineComponentPreview";
import { resetMountedPreviewsForTests } from "./mountedRegistry";
import { resetPreviewSchedulerForTests } from "./previewScheduler";

const mocks = vi.hoisted(() => ({ getPreview: vi.fn(), getDesignSystem: vi.fn(), loadCustom: vi.fn() }));

vi.mock("../../api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/client")>(),
  getComponentPreview: mocks.getPreview,
  getDesignSystemById: mocks.getDesignSystem,
}));
vi.mock("../../customComponents/loader", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../customComponents/loader")>(),
  loadCustomComponents: mocks.loadCustom,
}));

const entry = (patch: Partial<LibraryCatalogEntry> = {}): LibraryCatalogEntry => ({
  kind: "component", id: "widget", name: "Widget", designSystem: "shadcn", version: 1,
  bundleUrl: "/api/components/widget/versions/1/bundle.js", bundleHash: "hash", hostAbiVersion: 4,
  description: "Widget", layoutNeutral: false, canonicalFor: [], deprecated: false, headUsageCount: 0,
  status: { published: true, verified: false, visualPending: false, blocked: false, rejected: false },
  figma: null, preview: { selector: "legacy" }, ...patch,
});

const previewData = (patch: Partial<ComponentPreviewData> = {}): ComponentPreviewData => ({
  componentId: "widget", name: "Widget", version: 1, designSystem: "shadcn",
  bundleUrl: "/api/components/widget/versions/1/bundle.js", bundleHash: "hash", hostAbiVersion: 4,
  props: { label: "Hello" }, slots: [], ...patch,
});

let runtime: CustomPlayerRuntime;

/** Управляемый IntersectionObserver: тесты дёргают ближнюю (240px) и дальнюю (800px) полосы. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  constructor(private callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
  emit(isIntersecting: boolean) {
    act(() => this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  static byMargin(margin: string) {
    return FakeIntersectionObserver.instances.filter((instance) => instance.options.rootMargin === margin);
  }
}

const root = () => document.querySelector<HTMLElement>("[data-component-preview]")!;

describe("InlineComponentPreview", () => {
  beforeEach(() => {
    resetPreviewSchedulerForTests();
    resetMountedPreviewsForTests();
    resetThemeCacheForTests();
    resetFontRegistryForTests();
    FakeIntersectionObserver.instances = [];
    mocks.getPreview.mockReset().mockResolvedValue(previewData());
    mocks.getDesignSystem.mockReset().mockResolvedValue({ id: "shadcn", tokens: { "color.brand": "#f00" }, fonts: [], icons: [], latestMetaVersion: 3 });
    runtime = {
      definitions: { Widget: { props: z.object({ label: z.string() }), description: "Widget" } },
      components: { Widget: (({ props }: { props: { label: string } }) => <div data-testid="widget">{props.label}</div>) as CustomPlayerRuntime["components"][string] },
    };
    mocks.loadCustom.mockReset().mockImplementation(async () => runtime);
  });

  it("renders the component with its scoped theme and reports ready", async () => {
    render(<InlineComponentPreview entry={entry()} priority={1} />);
    expect(await screen.findByTestId("widget")).toHaveProperty("textContent", "Hello");
    expect(root().dataset.componentPreview).toBe("shadcn widget");
    expect(root().dataset.componentPreviewMounted).toBe("true");
    expect(root().dataset.componentPreviewState).toBe("ready");
    expect(root().dataset.componentPreviewError).toBeUndefined();
    expect(mocks.getPreview).toHaveBeenCalledWith("widget", 1, { selector: "legacy" }, expect.any(AbortSignal));
    expect(document.querySelector<HTMLElement>("[data-eui-scoped-surface]")!.style.getPropertyValue("--eui-color-brand")).toBe("#f00");
  });

  it("never loads a component without example props", async () => {
    render(<InlineComponentPreview entry={entry({ preview: null })} priority={1} />);
    expect(await screen.findByText(library.previewMissing)).toBeTruthy();
    expect(root().dataset.componentPreviewState).toBe("missing");
    expect(root().dataset.componentPreviewMounted).toBe("false");
    expect(mocks.getPreview).not.toHaveBeenCalled();
    expect(mocks.loadCustom).not.toHaveBeenCalled();
  });

  it("shows one compact plate for a metadata failure and recovers on retry", async () => {
    mocks.getPreview.mockRejectedValueOnce(new ApiError(404, { code: "not_found", message: "missing" }));
    render(<InlineComponentPreview entry={entry()} priority={1} />);
    expect(await screen.findByText(library.previewFailed)).toBeTruthy();
    expect(root().dataset.componentPreviewState).toBe("error");
    expect(root().dataset.componentPreviewError).toBe("metadata");
    expect(mocks.loadCustom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: library.retry }));
    expect(await screen.findByTestId("widget")).toBeTruthy();
    expect(root().dataset.componentPreviewState).toBe("ready");
  });

  it("tags a bundle failure separately from a metadata one", async () => {
    mocks.loadCustom.mockRejectedValueOnce(new Error("bundle is broken"));
    render(<InlineComponentPreview entry={entry()} priority={1} />);
    expect(await screen.findByText(library.previewFailed)).toBeTruthy();
    expect(root().dataset.componentPreviewError).toBe("bundle");
  });

  it("offers a full-document reload after loader escalation", async () => {
    mocks.loadCustom.mockRejectedValue(new FullDocumentReloadRequiredError("/api/components/widget/versions/1/bundle.js"));
    render(<InlineComponentPreview entry={entry()} priority={1} />);
    expect(await screen.findByText(library.previewReloadRequired)).toBeTruthy();
    expect(screen.getByRole("button", { name: library.previewReload })).toBeTruthy();
    expect(screen.queryByRole("button", { name: library.retry })).toBeNull();
  });

  it("keeps a crashing component inside its own card and offers a retry", async () => {
    runtime = {
      definitions: { Widget: { props: z.object({ label: z.string() }), description: "Throwing" } },
      components: { Widget: (() => { throw new Error("boom"); }) as CustomPlayerRuntime["components"][string] },
    };
    render(<InlineComponentPreview entry={entry()} priority={1} />);
    expect(await screen.findByText(library.previewFailed)).toBeTruthy();
    await waitFor(() => expect(root().dataset.componentPreviewError).toBe("render"));
    expect(root().dataset.componentPreviewState).toBe("error");
  });

  // Возврат в зону снова зовёт loadCustomComponents — сеть при этом не трогается: модуль лежит в
  // кэше загрузчика (`moduleCache`), здесь он замокан, поэтому проверяем сам факт перемонтирования.
  it("mounts near the viewport, unmounts past the far band and remounts on return", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    try {
      render(<InlineComponentPreview entry={entry()} priority={1} />);
      expect(root().dataset.componentPreviewState).toBe("idle");
      expect(mocks.getPreview).not.toHaveBeenCalled();

      FakeIntersectionObserver.byMargin("240px 0px")[0]!.emit(true);
      expect(await screen.findByTestId("widget")).toBeTruthy();

      FakeIntersectionObserver.byMargin("800px 0px")[0]!.emit(false);
      expect(screen.queryByTestId("widget")).toBeNull();
      expect(root().dataset.componentPreviewMounted).toBe("false");
      expect(root().dataset.componentPreviewState).toBe("idle");

      FakeIntersectionObserver.byMargin("240px 0px")[0]!.emit(true);
      expect(await screen.findByTestId("widget")).toBeTruthy();
      expect(mocks.loadCustom).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
