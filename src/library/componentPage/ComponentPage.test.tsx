import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState as useStateForTest } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, type ComponentMeta, type ComponentVersion } from "../../api/client";
import type { CustomPlayerRuntime } from "../../catalog/runtime";
import { FullDocumentReloadRequiredError, loadCustomComponents } from "../../customComponents/loader";
import { componentPage as strings } from "../../app/strings/componentPage";
import { ComponentPage } from "./ComponentPage";

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  getDesignSystem: vi.fn(),
  loadCustom: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/client")>(),
  getComponentVersion: mocks.getVersion,
  getDesignSystemById: mocks.getDesignSystem,
}));
vi.mock("../../customComponents/loader", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../customComponents/loader")>(),
  loadCustomComponents: mocks.loadCustom,
}));

const summary = (version: number, status: ComponentMeta["versions"][number]["status"]): ComponentMeta["versions"][number] => ({
  version, status, rev: version, statusReason: null, supersededBy: null, statusRev: 1, designSystem: "shadcn", publishedAt: "",
});
const baseMeta = (versions = [summary(1, "active")], publishedVersion: number | null = 1): ComponentMeta => ({
  id: "widget", name: "Widget", designSystem: "shadcn", headRev: 2, publishedVersion, versions, updatedAt: "",
});
const baseVersion = (patch: Partial<ComponentVersion> = {}): ComponentVersion => ({
  version: 1, rev: 1, status: "active", source: "export default Widget", designSystem: "shadcn", bundleHash: "hash",
  hostAbiVersion: 3, assets: [], events: [], slots: [], publishedAt: "", ...patch,
});

let meta = baseMeta();
let runtime: CustomPlayerRuntime;

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function renderPage(path = "/library/c/widget?v=1") {
  const router = createMemoryRouter([{ path: "/library/c/:componentId", element: <><header data-testid="test-header" style={{ color: "rgb(1, 2, 3)", padding: "7px" }}>shell</header><ComponentPage /></> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("ComponentPage", () => {
  beforeEach(() => {
    meta = baseMeta();
    vi.stubGlobal("fetch", vi.fn(async () => response(meta)));
    mocks.getVersion.mockReset().mockResolvedValue(baseVersion({ example: { label: "A" } }));
    mocks.getDesignSystem.mockReset().mockResolvedValue({ id: "shadcn", tokens: {}, fonts: [], icons: [] });
    runtime = {
      definitions: { Widget: { props: z.object({ label: z.string() }), description: "Widget" } },
      components: { Widget: (({ props }: { props: { label: string } }) => <div data-testid="widget">{props.label}</div>) as CustomPlayerRuntime["components"][string] },
    };
    mocks.loadCustom.mockReset().mockImplementation(async () => runtime);
    document.documentElement.className = "shell-root";
  });

  it("requests fresh meta with no-store and rejects an invalid address before any request", async () => {
    renderPage("/library/c/widget");
    await screen.findByTestId("widget");
    expect(fetch).toHaveBeenCalledWith("/api/components/widget", expect.objectContaining({ cache: "no-store" }));
    expect(document.documentElement.className).toBe("shell-root");
    expect(getComputedStyle(screen.getByTestId("test-header")).color).toBe("rgb(1, 2, 3)");
    expect(getComputedStyle(screen.getByTestId("test-header")).padding).toBe("7px");

    vi.mocked(fetch).mockClear();
    renderPage("/library/c/widget?v=01");
    expect(await screen.findByRole("heading", { name: strings.invalidAddress })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not load a rejected bundle and keeps docs and source available", async () => {
    meta = baseMeta([summary(1, "rejected")], null);
    mocks.getVersion.mockResolvedValue(baseVersion({ status: "rejected", source: "const rejectedSource = true" }));
    renderPage("/library/c/widget");
    expect(await screen.findByText(strings.noRenderableVersions)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /v1/ }));
    expect(await screen.findByText(strings.executionForbidden)).toBeTruthy();
    expect(loadCustomComponents).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Код" }));
    expect(screen.getByText("const rejectedSource = true")).toBeTruthy();
  });

  it("mounts only after all required props become valid", async () => {
    mocks.getVersion.mockResolvedValue(baseVersion());
    const requiredRender = vi.fn(({ props }: { props: { first: string; second: string } }) => <p data-testid="required-widget">{props.first}:{props.second}</p>);
    runtime = {
      definitions: { Widget: { props: z.object({ first: z.string().min(1), second: z.string().min(1) }), description: "Required" } },
      components: { Widget: requiredRender as unknown as CustomPlayerRuntime["components"][string] },
    };
    renderPage();
    expect(await screen.findByText(strings.requiredProps)).toBeTruthy();
    expect(requiredRender).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "first" }), { target: { value: "one" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "first" }));
    expect(screen.queryByTestId("required-widget")).toBeNull();
    const second = screen.getByRole("textbox", { name: "second" });
    expect(second.getAttribute("aria-describedby")).toMatch(/^component-props-error-/);
    fireEvent.change(screen.getByRole("textbox", { name: "second" }), { target: { value: "two" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "second" }));
    expect(await screen.findByText("one:two")).toBeTruthy();
  });

  it("updates raw props without remounting component local state", async () => {
    const Stateful = ({ props }: { props: { label: string } }) => {
      const [count, setCount] = useStateForTest(0);
      return <div><span data-testid="state-label">{props.label}:{count}</span><button type="button" onClick={() => setCount((value) => value + 1)}>increment</button></div>;
    };
    runtime = {
      definitions: { Widget: { props: z.object({ label: z.string() }), description: "Stateful" } },
      components: { Widget: Stateful as CustomPlayerRuntime["components"][string] },
    };
    renderPage();
    expect(await screen.findByText("A:0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "increment" }));
    expect(screen.getByText("A:1")).toBeTruthy();
    const label = screen.getByRole("textbox", { name: "label" });
    fireEvent.change(label, { target: { value: "B" } });
    fireEvent.blur(label);
    expect(await screen.findByText("B:1")).toBeTruthy();
  });

  it("recovers an errored preview on the next valid props commit", async () => {
    const Throwing = ({ props }: { props: { label: string } }) => {
      if (props.label === "throw") throw new Error("boom");
      return <p data-testid="throwing-widget">{props.label}</p>;
    };
    runtime = {
      definitions: { Widget: { props: z.object({ label: z.string() }), description: "Throwing" } },
      components: { Widget: Throwing as CustomPlayerRuntime["components"][string] },
    };
    renderPage();
    await screen.findByTestId("throwing-widget");
    const label = screen.getByRole("textbox", { name: "label" });
    fireEvent.change(label, { target: { value: "throw" } }); fireEvent.blur(label);
    expect(await screen.findByText(strings.previewCrashed)).toBeTruthy();
    fireEvent.change(label, { target: { value: "fixed" } }); fireEvent.blur(label);
    expect(await screen.findByText("fixed")).toBeTruthy();
  });

  it("masks the previous version immediately and preserves the active tab", async () => {
    meta = baseMeta([summary(1, "active"), summary(2, "deprecated")], 1);
    let resolveSecond!: (value: ComponentVersion) => void;
    mocks.getVersion.mockImplementation((_id: string, selected: number) => selected === 1
      ? Promise.resolve(baseVersion({ source: "source version one" }))
      : new Promise<ComponentVersion>((resolve) => { resolveSecond = resolve; }));
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Код" }));
    expect(screen.getByText("source version one")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(strings.versionSelector), { target: { value: "2" } });
    expect(screen.queryByText("source version one")).toBeNull();
    expect(screen.getByText(strings.loadingVersion)).toBeTruthy();
    await act(async () => resolveSecond(baseVersion({ version: 2, status: "deprecated", source: "source version two" })));
    expect(await screen.findByText("source version two")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Код" }).getAttribute("aria-selected")).toBe("true");
  });

  it("offers a full-document reload after loader escalation while docs still work", async () => {
    mocks.loadCustom.mockRejectedValue(new FullDocumentReloadRequiredError("/api/components/widget/versions/1/bundle.js"));
    renderPage();
    expect(await screen.findByText(strings.reloadRequired)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Документация" }));
    expect(screen.getByRole("heading", { name: "Props компонента" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Код" }));
    expect(screen.getByText("export default Widget")).toBeTruthy();
  });

  it("distinguishes a missing version and never mutates the html class", async () => {
    mocks.getVersion.mockRejectedValue(new ApiError(404, { code: "not_found", message: "missing" }));
    renderPage("/library/c/widget?v=99");
    expect(await screen.findByText(strings.versionNotFound)).toBeTruthy();
    expect(document.documentElement.className).toBe("shell-root");
  });

  it("supports arrow-key tab navigation", async () => {
    renderPage();
    const componentTab = await screen.findByRole("tab", { name: "Компонент" });
    componentTab.focus();
    fireEvent.keyDown(componentTab, { key: "ArrowRight" });
    const docs = screen.getByRole("tab", { name: "Документация" });
    expect(document.activeElement).toBe(docs);
    expect(docs.getAttribute("aria-selected")).toBe("true");
  });
});
