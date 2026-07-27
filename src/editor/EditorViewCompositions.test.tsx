import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import compositionRaw from "../../test/fixtures/architecture/ctyp-payment-success.composition.json";
import screenRaw from "../../test/fixtures/architecture/composition-screen.json";
import type { PrototypeDraft } from "../api/client";
import { compositionDocSchema, expandCompositions } from "../prototype/composition";
import { prototypeDocSchema } from "../prototype/schema";

vi.mock("@json-render/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@json-render/react")>();
  return {
    ...actual,
    JSONUIProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="provider">{children}</div>,
    Renderer: ({ spec }: { spec: unknown }) => <pre data-testid="runtime-spec">{JSON.stringify(spec)}</pre>,
  };
});

const { EditorView } = await import("./EditorView");

const composition = compositionDocSchema.parse(compositionRaw);
const authoredDoc = prototypeDocSchema.parse(screenRaw);
const compositions = { "ctyp-payment-success": composition };
const expanded = expandCompositions(authoredDoc, { compositions });

const draft: PrototypeDraft = {
  // Сервер отдаёт раскрытый `doc` и авторский `authoredDoc` — редактор обязан взять авторский.
  doc: expanded.doc,
  authoredDoc,
  compositionRefs: expanded.expandedFrom,
  compositions: [{ id: "ctyp-payment-success", name: composition.name, version: 2, sourceHash: "hash", doc: composition }],
  rev: 4,
  builtinCatalogHash: "builtin",
  componentManifestHash: "empty",
  components: [],
};

function renderView() {
  const router = createMemoryRouter([
    { path: "/p/:protoId/edit", element: <EditorView loaded={draft} runtimeKey="test" onReload={() => {}} /> },
  ], { initialEntries: ["/p/ctyp-payment-success-composed/edit"] });
  render(<RouterProvider router={router} />);
}

const dumpedSpecs = () => screen.getAllByTestId("runtime-spec").map((node) => JSON.parse(node.textContent ?? "null") as { elements: Record<string, { type: string; props: Record<string, unknown> }> });

describe("EditorView + композиции (волна 5)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: vi.fn(() => []) });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected request"); }));
  });

  it("renders the expanded document: composition keys are present and the reference itself is gone", async () => {
    renderView();
    await screen.findByRole("heading", { name: "CTYP payment success (composed)" });

    const elements = Object.assign({}, ...dumpedSpecs().map((spec) => spec.elements)) as Record<string, { type: string; props: Record<string, unknown> }>;
    expect(elements["screen$shell"]).toBeTruthy();
    // Параметр композиции подставлен в props раскрытого элемента.
    expect(elements["screen$badge"]!.props.amount).toBe("12 ₽");
    // Дети экрана маршрутизированы в слоты и остались авторскими ключами.
    expect(elements.nav).toBeTruthy();
    expect(Object.values(elements).some((element) => element.type === "@eui/Composition")).toBe(false);
    // Авторское дерево в инспекторе, наоборот, показывает саму ссылку.
    expect(screen.getByRole("button", { name: "@eui/Composition · screen" })).toBeTruthy();
  });

  it("selects the host reference when an expanded inner element is clicked on the canvas", async () => {
    renderView();
    await screen.findByRole("heading", { name: "CTYP payment success (composed)" });

    const previewRoot = document.querySelector<HTMLElement>('[data-eui-stage-viewport="editor"]')!;
    const marker = document.createElement("span");
    marker.dataset.jrKey = "screen$badge";
    previewRoot.append(marker);
    fireEvent.click(marker);

    await waitFor(() => expect(screen.getByRole("button", { name: "@eui/Composition · screen" }).getAttribute("aria-current")).toBe("true"));
    const panel = screen.getByRole("region", { name: "Композиция" });
    expect(panel.textContent).toContain("ctyp-payment-success");
    expect(panel.textContent).toContain("v2");
  });
});
