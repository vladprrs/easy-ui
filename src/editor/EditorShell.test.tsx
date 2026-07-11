import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeDraft } from "../api/client";
import { AppRoutes } from "../app/routes";
import { prototypeDocSchema } from "../prototype/schema";

const doc = prototypeDocSchema.parse({
  version: 1, id: "editor-demo", name: "Editor demo", description: "Draft", device: "mobile", startScreen: "home", state: {},
  screens: [{ id: "home", name: "Home", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Before" } } } } }],
});
const draft: PrototypeDraft = { doc, rev: 7, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [] };
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

function renderEditor() {
  const router = createMemoryRouter([{ path: "*", element: <AppRoutes /> }], { initialEntries: ["/p/editor-demo/edit"] });
  render(<RouterProvider router={router} />);
}

describe("EditorShell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
    expect(await screen.findByText("Черновик изменён (rev 12)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Перезагрузить черновик/ }));
    await waitFor(() => expect(draftLoads).toBe(2));
  });

  it.each([
    [[{ path: ["screens", 0, "name"], message: "array path" }], "/screens/0/name"],
    [[{ path: "/screens/0/name", message: "pointer path" }], "/screens/0/name"],
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

  it("keeps the inspector usable for a screen without a root", async () => {
    const emptyDoc = { ...doc, screens: [{ ...doc.screens[0], spec: { root: "missing", elements: {} } }] };
    vi.mocked(fetch).mockImplementation((input) => String(input).endsWith("/draft") ? json({ ...draft, doc: emptyDoc }) : Promise.reject(new Error("Unexpected request")));
    renderEditor();
    expect((await screen.findAllByText("Нет содержимого")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Инспектор")).toBeTruthy();
    expect(screen.getAllByLabelText("Название")).toHaveLength(2);
  });
});
