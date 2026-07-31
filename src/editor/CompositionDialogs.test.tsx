import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { compositionDocSchema } from "../prototype/composition";
import { prototypeDocSchema } from "../prototype/schema";
import { createEditorState } from "./editorReducer";
import { InspectorPanel } from "./InspectorPanel";

const api = vi.hoisted(() => ({
  listCompositions: vi.fn(),
  getComposition: vi.fn(),
  createComposition: vi.fn(),
  publishComposition: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/client")>(),
  ...api,
}));

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

const doc = prototypeDocSchema.parse({
  version: 1, id: "extract-demo", name: "Extract demo", designSystem: "shadcn", device: "mobile",
  startScreen: "home", state: {},
  screens: [{
    id: "home", name: "Home",
    spec: {
      root: "root",
      elements: {
        root: { type: "Box", props: {}, children: ["card"] },
        card: { type: "Card", props: { tone: "success" }, children: ["title"] },
        title: { type: "Text", props: { text: "Готово" } },
      },
    },
  }],
});

const reusable = compositionDocSchema.parse({
  version: 1, name: "Reusable", params: { title: { type: "string", required: true } }, slots: [],
  spec: { root: "box", elements: { box: { type: "Box", props: { text: { $param: "title" } } } } },
});

function renderPanel(elementKey: string | null) {
  const dispatch = vi.fn();
  const onCompositionRegistered = vi.fn();
  const state = { ...createEditorState({ doc, rev: 1 }), selection: { screenId: "home", elementKey } };
  render(<InspectorPanel state={state} definitions={{}} dispatch={dispatch} compositions={{}} onCompositionRegistered={onCompositionRegistered} />);
  return { dispatch, onCompositionRegistered };
}

describe("Диалоги композиций", () => {
  beforeEach(() => {
    api.listCompositions.mockReset().mockResolvedValue([
      { id: "reusable", name: "Reusable", designSystem: "shadcn", headRev: 2, latestVersion: 1, updatedAt: "now", params: ["title"], slots: [] },
      { id: "foreign", name: "Foreign", designSystem: "yandex-pay", headRev: 1, latestVersion: 1, updatedAt: "now", params: [], slots: [] },
    ]);
    api.getComposition.mockReset().mockResolvedValue({ id: "reusable", name: "Reusable", designSystem: "shadcn", headRev: 2, updatedAt: "now", publishedVersion: 1, versions: [], doc: reusable });
    api.createComposition.mockReset().mockResolvedValue({ id: "home-card", rev: 1 });
    api.publishComposition.mockReset().mockResolvedValue({ version: 1, rev: 1 });
  });

  it("inserts a composition of the document design system into the selected parent", async () => {
    const { dispatch, onCompositionRegistered } = renderPanel("card");
    fireEvent.click(screen.getByRole("button", { name: "Вставить композицию…" }));

    const item = await screen.findByRole("button", { name: /Reusable/ });
    expect(screen.queryByRole("button", { name: /Foreign/ })).toBeNull();
    fireEvent.click(item);

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({
      type: "insert-composition", screenId: "home", parentKey: "card", compositionId: "reusable", composition: reusable,
    }));
    expect(onCompositionRegistered).toHaveBeenCalledWith("reusable", reusable);
  });

  it("extracts a subtree: creates and publishes the composition, then replaces it with a reference", async () => {
    const { dispatch, onCompositionRegistered } = renderPanel("card");
    fireEvent.click(screen.getByRole("button", { name: "Извлечь композицию из экрана" }));
    await screen.findByRole("dialog", { name: /Извлечь композицию из/ });

    fireEvent.click(screen.getByRole("button", { name: "Извлечь и опубликовать" }));

    await waitFor(() => expect(api.publishComposition).toHaveBeenCalledWith("home-card", 1));
    const [id, sent, designSystem] = api.createComposition.mock.calls[0]!;
    expect(id).toBe("home-card");
    expect(designSystem).toBe("shadcn");
    expect(compositionDocSchema.safeParse(sent).success).toBe(true);
    expect(Object.keys((sent as { spec: { elements: Record<string, unknown> } }).spec.elements).sort()).toEqual(["card", "title"]);
    expect(dispatch).toHaveBeenCalledWith({
      type: "extract-composition", screenId: "home", rootKey: "card", compositionId: "home-card", composition: sent, keptChildren: [],
    });
    expect(onCompositionRegistered).toHaveBeenCalledWith("home-card", sent);
  });

  it("refuses to extract a region-marked subtree without calling the API", async () => {
    const regionDoc = prototypeDocSchema.parse({
      version: 1, id: "region-demo", name: "Region demo", designSystem: "shadcn", device: "mobile",
      startScreen: "home", state: {},
      screens: [{
        id: "home", name: "Home",
        spec: {
          root: "root",
          elements: {
            root: { type: "@eui/FlowRoot", props: {}, children: ["header"] },
            header: { type: "Box", props: {}, region: "header" },
          },
        },
      }],
    });
    const dispatch = vi.fn();
    const state = { ...createEditorState({ doc: regionDoc, rev: 1 }), selection: { screenId: "home", elementKey: "header" } };
    render(<InspectorPanel state={state} definitions={{}} dispatch={dispatch} compositions={{}} />);

    fireEvent.click(screen.getByRole("button", { name: "Извлечь композицию из экрана" }));
    await screen.findByRole("dialog", { name: /Извлечь композицию из/ });
    fireEvent.click(screen.getByRole("button", { name: "Извлечь и опубликовать" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("помечен регионом");
    expect(api.createComposition).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
