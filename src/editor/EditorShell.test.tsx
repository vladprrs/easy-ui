import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FigmaProvenance, PrototypeDraft } from "../api/client";
import { routeObjects } from "../app/routes";
import { prototypeDocSchema } from "../prototype/schema";

const mocks = vi.hoisted(() => ({ loadCustom: vi.fn() }));
vi.mock("../customComponents/loader", () => ({ loadCustomComponents: mocks.loadCustom }));

const doc = prototypeDocSchema.parse({
  version: 1, id: "editor-demo", name: "Editor demo", description: "Draft", device: "mobile", startScreen: "home", state: {},
  screens: [{ id: "home", name: "Home", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Before" } } } } }],
});
const draft: PrototypeDraft = { doc, rev: 7, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [] };
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

function renderEditor(protoId = "editor-demo") {
  const router = createMemoryRouter(routeObjects, { initialEntries: [`/p/${protoId}/edit`] });
  render(<RouterProvider router={router} />);
}

describe("EditorShell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.loadCustom.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: vi.fn(() => []) });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/prototypes/editor-demo/draft") return json(draft);
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
  });

  it("loads the draft, selects an element, updates preview, and saves parsed data with baseRev", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/draft")) return json(draft);
      if (String(input) === "/api/prototypes/editor-demo" && init?.method === "PUT") return json({ rev: 8, warnings: [] });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderEditor();
    await screen.findByRole("heading", { name: "Editor demo" });
    fireEvent.click(screen.getByRole("button", { name: "Text · text" }));
    const input = screen.getByRole("textbox", { name: "text" });
    fireEvent.change(input, { target: { value: "After" } });
    fireEvent.blur(input);
    expect(await screen.findAllByText("After")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/prototypes/editor-demo", expect.objectContaining({ method: "PUT" })));
    const put = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/prototypes/editor-demo" && init?.method === "PUT")!;
    const body = JSON.parse(String(put[1]?.body));
    expect(body.baseRev).toBe(7);
    expect(body.doc.screens[0].spec.elements.text.props.text).toBe("After");
    // The draft has no figma provenance, so the payload must omit the field (never figma: null).
    expect("figma" in body).toBe(false);
    expect(await screen.findByText("Сохранено")).toBeTruthy();
  });

  it("passes the loaded figma provenance through on save (WF-5 roundtrip)", async () => {
    const figma: FigmaProvenance = { fileKey: "fileKEY42", nodeIds: ["10:20"], lastSyncedAt: "2026-07-13T00:00:00.000Z" };
    const figmaDraft: PrototypeDraft = { ...draft, figma, assets: [] };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/draft")) return json(figmaDraft);
      if (String(input) === "/api/prototypes/editor-demo" && init?.method === "PUT") return json({ rev: 8, warnings: [] });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderEditor();
    await screen.findByRole("heading", { name: "Editor demo" });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/prototypes/editor-demo", expect.objectContaining({ method: "PUT" })));
    const put = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/prototypes/editor-demo" && init?.method === "PUT")!;
    const body = JSON.parse(String(put[1]?.body));
    expect(body.figma).toEqual(figma);
    expect(await screen.findByText("Сохранено")).toBeTruthy();
  });

  it("shows a conflict and reloads the entire draft", async () => {
    const fetchMock = vi.mocked(fetch);
    let draftLoads = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/draft")) { draftLoads += 1; return json(draft); }
      if (init?.method === "PUT") return json({ error: { code: "revision_conflict", message: "conflict", currentRev: 12 } }, 409);
      throw new Error("Unexpected request");
    });
    renderEditor();
    await screen.findByRole("heading", { name: "Editor demo" });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    // 409 → редактор сам тянет актуальный remote-драфт для diff (2-я загрузка).
    const dialog = await screen.findByRole("dialog", { name: "Конфликт версий черновика" });
    expect(draftLoads).toBe(2);
    expect(dialog.textContent).toContain("Черновик изменён снаружи (rev 7)");
    fireEvent.click(screen.getByRole("button", { name: /Перезагрузить черновик/ }));
    await waitFor(() => expect(draftLoads).toBe(3));
  });

  it.each([
    [[{ path: ["screens", 0, "name"], message: "array path" }], "Экран «Home» › Название"],
    [[{ path: "/screens/0/name", message: "pointer path" }], "Экран «Home» › Название"],
  ])("renders 422 issues in either path format", async (issues, expectedPath) => {
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).endsWith("/draft")) return json(draft);
      if (init?.method === "PUT") return json({ error: { code: "validation_failed", message: "invalid", issues } }, 422);
      throw new Error("Unexpected request");
    });
    renderEditor();
    await screen.findByRole("heading", { name: "Editor demo" });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(expectedPath)).toBeTruthy();
  });

  it("renders a custom DS component with named-slot metadata in the canvas and strip previews", async () => {
    const customDoc = prototypeDocSchema.parse({
      ...doc, id: "custom-demo", name: "Custom demo",
      screens: [{ id: "home", name: "Home", spec: { root: "widget", elements: {
        widget: { type: "Widget", props: { label: "Custom label" }, children: ["header-text", "body-text"], on: { press: { action: "back" } } },
        "header-text": { type: "Text", props: { text: "In header" }, slot: "header" },
        "body-text": { type: "Text", props: { text: "In body" } },
      } } }],
    });
    const customDraft: PrototypeDraft = { doc: customDoc, rev: 1, builtinCatalogHash: "builtin", componentManifestHash: "custom", components: [{ id: "widget", name: "Widget", version: 1, bundleUrl: "/api/components/widget/versions/1/bundle.js", bundleHash: "hash" }] };
    mocks.loadCustom.mockResolvedValue({
      definitions: { Widget: { props: z.object({ label: z.string().optional() }), description: "w", events: ["press"], slots: ["header"], capabilities: { namedSlots: true } } },
      components: { Widget: ({ props, slots }: { props: { label?: string }; slots: Record<string, ReactNode> }) =>
        <div><span data-testid="widget-label">{props.label}</span><div data-testid="widget-header">{slots.header}</div><div data-testid="widget-body">{slots.default}</div></div> },
    });
    vi.mocked(fetch).mockImplementation((input) => String(input) === "/api/prototypes/custom-demo/draft" ? json(customDraft) : Promise.reject(new Error(`Unexpected request: ${String(input)}`)));
    renderEditor("custom-demo");
    // Canvas + screen strip both render the custom component through the runtime adapter.
    const labels = await screen.findAllByTestId("widget-label");
    expect(labels).toHaveLength(2);
    for (const label of labels) expect(label.textContent).toBe("Custom label");
    // slotIndices metadata survives the inert transform: the slotted child routes into the named slot.
    for (const header of screen.getAllByTestId("widget-header")) expect(within(header as HTMLElement).getByText("In header")).toBeTruthy();
    for (const body of screen.getAllByTestId("widget-body")) {
      expect(within(body as HTMLElement).getByText("In body")).toBeTruthy();
      expect(within(body as HTMLElement).queryByText("In header")).toBeNull();
    }
  });

  it("renders composition-demo previews inertly without losing repeat/$cond composition", async () => {
    const compositionDoc = prototypeDocSchema.parse((await import("../../prototypes/composition-demo.json")).default);
    const compositionDraft: PrototypeDraft = { doc: compositionDoc, rev: 1, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [] };
    vi.mocked(fetch).mockImplementation((input) => String(input) === "/api/prototypes/composition-demo/draft" ? json(compositionDraft) : Promise.reject(new Error(`Unexpected request: ${String(input)}`)));
    renderEditor("composition-demo");
    await screen.findByRole("heading", { name: "Composition demo" });
    // Repeat rows and the $cond first-row marker render in the previews (canvas + strip).
    expect(screen.getAllByText("Design the flow").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("★").length).toBeGreaterThanOrEqual(2);
    // Events are stripped: pressing the dismiss button must not mutate state.
    const tipsBefore = screen.getAllByText(/use the buttons to mutate state/).length;
    for (const dismiss of screen.getAllByRole("button", { name: "Got it", hidden: true })) fireEvent.click(dismiss);
    expect(screen.getAllByText(/use the buttons to mutate state/)).toHaveLength(tipsBefore);
  });

  it("keeps the inspector usable for a screen without a root", async () => {
    const emptyDoc = { ...doc, screens: [{ ...doc.screens[0], spec: { root: "missing", elements: {} } }] };
    vi.mocked(fetch).mockImplementation((input) => String(input).endsWith("/draft") ? json({ ...draft, doc: emptyDoc }) : Promise.reject(new Error("Unexpected request")));
    renderEditor();
    expect((await screen.findAllByText("Нет содержимого")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Инспектор")).toBeTruthy();
    expect(screen.getAllByLabelText("Название")).toHaveLength(2);
  });
});
