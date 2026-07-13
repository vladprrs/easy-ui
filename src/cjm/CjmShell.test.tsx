import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeDraft, PrototypeVersion } from "../api/client";
import { prototypeDocSchema } from "../prototype/schema";
import { AppRoutes } from "../app/routes";
import { TileErrorBoundary } from "./CjmScreenTile";

const mocks = vi.hoisted(() => ({ getDraft: vi.fn(), getVersion: vi.fn(), loadCustom: vi.fn() }));
vi.mock("../api/client", async (original) => ({ ...(await original()), getPrototypeDraft: mocks.getDraft, getPrototypeVersion: mocks.getVersion }));
vi.mock("../customComponents/loader", () => ({ loadCustomComponents: mocks.loadCustom }));

const doc = prototypeDocSchema.parse({
  version: 1, id: "journey", name: "Checkout journey", description: "From cart to success", device: "mobile", startScreen: "cart",
  state: { copy: "Base" },
  screens: [
    { id: "cart", name: "Cart", note: "Review the order", stateOverrides: { copy: "Override copy" }, spec: { root: "text", elements: { text: { type: "Text", props: { text: { $state: "/copy" } } } } } },
    { id: "success", name: "Success", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Done" } } } } },
  ],
});
const draft: PrototypeDraft = { doc, rev: 4, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [] };

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: "*", element: <AppRoutes /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("CjmShell", () => {
  beforeEach(() => {
    mocks.getDraft.mockReset().mockResolvedValue(draft);
    mocks.getVersion.mockReset().mockResolvedValue({ ...draft, version: 2, publishedAt: "2026-07-10T00:00:00Z" } satisfies PrototypeVersion);
    mocks.loadCustom.mockReset().mockResolvedValue(undefined);
  });

  it("renders ordered tiles, notes, override state, and the optional description", async () => {
    renderAt("/p/journey/cjm");
    expect(await screen.findByText("Override copy")).toBeTruthy();
    expect(screen.getByText("Review the order")).toBeTruthy();
    expect(screen.getByText("From cart to success")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Открыть экран «Cart» прототипа «Checkout journey» в плеере" }).getAttribute("href")).toBe("/p/journey/s/cart");
    expect(screen.getByRole("link", { name: "Открыть плеер" }).getAttribute("href")).toBe("/p/journey");
    expect(document.title).toBe("Checkout journey · CJM — easy-ui");
  });

  it("keeps published tile links version-aware", async () => {
    renderAt("/p/journey/v/2/cjm");
    expect((await screen.findByRole("link", { name: "Открыть экран «Success» прототипа «Checkout journey» в плеере" })).getAttribute("href")).toBe("/p/journey/v/2/s/success");
    expect(document.title).toBe("Checkout journey v2 · CJM — easy-ui");
  });

  it("omits the description block when the document has no description", async () => {
    mocks.getDraft.mockResolvedValue({ ...draft, doc: { ...doc, description: undefined } });
    renderAt("/p/journey/cjm");
    await screen.findByRole("heading", { name: "Checkout journey" });
    expect(screen.queryByText("From cart to success")).toBeNull();
  });

  it("does not activate modal side effects for an open Dialog", async () => {
    const dialogDoc = prototypeDocSchema.parse({ ...doc, state: { open: false }, screens: [{ id: "cart", name: "Cart", stateOverrides: { open: true }, spec: { root: "dialog", elements: { dialog: { type: "Dialog", props: { title: "Modal", openPath: "/open" } } } } }] });
    mocks.getDraft.mockResolvedValue({ ...draft, doc: dialogDoc });
    renderAt("/p/journey/cjm");
    const list = await screen.findByRole("list", { name: "Экраны CJM" });
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
    expect(list.getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByRole("link", { name: /Открыть экран/ })).toBeTruthy();
  });

  it("contains a renderer failure to its tile while neighbors stay alive", async () => {
    const brokenDoc = prototypeDocSchema.parse({ ...doc, startScreen: "broken", screens: [
      { id: "broken", name: "Broken", spec: { root: "broken", elements: { broken: { type: "Broken", props: { text: "Crash" } } } } },
      { id: "success", name: "Success", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Still alive" } } } } },
    ] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Broken = () => { throw new Error("renderer exploded"); };
    render(<><TileErrorBoundary prototypeId={brokenDoc.id} screenId="broken"><Broken /></TileErrorBoundary><p>Still alive</p></>);
    expect(screen.getByTestId("tile-error")).toBeTruthy();
    expect(screen.getByText("Still alive")).toBeTruthy();
  });

  it("isolates state stores between tiles", async () => {
    const isolatedDoc = prototypeDocSchema.parse({ ...doc, startScreen: "screen-1", state: { copy: "Base" }, screens: ["One", "Two"].map((name, index) => ({
      id: `screen-${index + 1}`, name, stateOverrides: { copy: name }, spec: { root: "input", elements: { input: { type: "Input", props: { label: name, value: { $bindState: "/copy" } } } } },
    })) });
    mocks.getDraft.mockResolvedValue({ ...draft, doc: isolatedDoc });
    renderAt("/p/journey/cjm");
    const [first, second] = await screen.findAllByRole("textbox") as HTMLInputElement[];
    expect(first.value).toBe("One");
    expect(second.value).toBe("Two");
    fireEvent.change(first, { target: { value: "Changed" } });
    expect(first.value).toBe("Changed");
    expect(second.value).toBe("Two");
  });
});
