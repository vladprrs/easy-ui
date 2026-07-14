import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeDraft } from "../api/client";
import { prototypeDocSchema } from "../prototype/schema";
import { EditorView } from "./EditorView";

const doc = prototypeDocSchema.parse({
  version: 1, id: "editor-demo", name: "Editor demo", device: "mobile", startScreen: "home", state: {},
  screens: [{ id: "home", name: "Home", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Before" } } } } }],
});
const draft: PrototypeDraft = { doc, rev: 7, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [] };
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

function renderView() {
  const router = createMemoryRouter([
    { path: "/p/:protoId/edit", element: <EditorView loaded={draft} runtimeKey="test" onReload={() => {}} /> },
    { path: "/", element: <p>Галерея-стаб</p> },
  ], { initialEntries: ["/p/editor-demo/edit"] });
  render(<RouterProvider router={router} />);
  return router;
}

function editText(value: string) {
  fireEvent.click(screen.getByRole("button", { name: "Text · text" }));
  const input = screen.getByRole("textbox", { name: "text" });
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  return input as HTMLInputElement;
}

describe("EditorView (W2-2: защита правок + undo/redo)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: vi.fn(() => []) });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected request"); }));
  });

  it("blocks SPA navigation while dirty: «Остаться» keeps the route, «Уйти» proceeds", async () => {
    const router = renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    editText("After");
    expect(await screen.findByText("Не сохранено")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Галерея" }));
    const dialog = await screen.findByRole("dialog", { name: "Несохранённые правки" });
    expect(dialog.textContent).toContain("Уйти без сохранения?");
    fireEvent.click(screen.getByRole("button", { name: "Остаться" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Несохранённые правки" })).toBeNull());
    expect(router.state.location.pathname).toBe("/p/editor-demo/edit");
    expect(screen.getByText("Не сохранено")).toBeTruthy(); // правки не потеряны

    fireEvent.click(screen.getByRole("link", { name: "Галерея" }));
    fireEvent.click(await screen.findByRole("button", { name: "Уйти" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("does not block navigation when the draft is clean", async () => {
    const router = renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    fireEvent.click(screen.getByRole("link", { name: "Галерея" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("undoes and redoes via Ctrl+Z / Ctrl+Shift+Z, ignoring the hotkey inside text fields", async () => {
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    const input = editText("After");
    expect(input.value).toBe("After");

    // Внутри текстового поля хоткей не перехватывается — нативный text-undo жив.
    fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    expect(input.value).toBe("After");

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect((screen.getByRole("textbox", { name: "text" }) as HTMLInputElement).value).toBe("Before");
    expect(await screen.findByText("Сохранено")).toBeTruthy(); // откат до checkpoint — dirty снят

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect((screen.getByRole("textbox", { name: "text" }) as HTMLInputElement).value).toBe("After");
    expect(await screen.findByText("Не сохранено")).toBeTruthy();
  });

  it("exposes undo/redo buttons with honest disabled states", async () => {
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    const undo = () => screen.getByRole("button", { name: /Отменить правку/ }) as HTMLButtonElement;
    const redo = () => screen.getByRole("button", { name: /Вернуть правку/ }) as HTMLButtonElement;
    expect(undo().disabled).toBe(true);
    expect(redo().disabled).toBe(true);

    editText("After");
    expect(undo().disabled).toBe(false);
    expect(redo().disabled).toBe(true);

    fireEvent.click(undo());
    expect(undo().disabled).toBe(true);
    expect(redo().disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "text" }) as HTMLInputElement).value).toBe("Before");
  });

  it("shows the 409 conflict dialog with a three-way diff and overwrites with the fresh rev (W2-4)", async () => {
    const remoteDoc = structuredClone(doc);
    remoteDoc.screens[0]!.spec.elements["text"]!.props.text = "Remote";
    remoteDoc.name = "Remote name";
    const puts: { baseRev: number; doc: typeof doc }[] = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/prototypes/editor-demo" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { baseRev: number; doc: typeof doc };
        puts.push(body);
        if (body.baseRev !== 9) return json({ error: { code: "revision_conflict", message: "conflict", currentRev: 9 } }, 409);
        return json({ rev: 10, warnings: [] });
      }
      if (url === "/api/prototypes/editor-demo/draft") return json({ ...draft, doc: remoteDoc, rev: 9 });
      throw new Error(`Unexpected request: ${url}`);
    });

    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    editText("Local");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    const dialog = await screen.findByRole("dialog", { name: "Конфликт версий черновика" });
    expect(dialog.textContent).toContain("Черновик изменён снаружи (rev 9)");
    // Что поменяли снаружи и что поменял ты — человекочитаемые адреса.
    expect(dialog.textContent).toContain("Название — изменено («Editor demo» → «Remote name»)");
    expect(dialog.textContent).toContain("Экран «Home» › text › text — изменено («Before» → «Remote»)");
    expect(dialog.textContent).toContain("Экран «Home» › text › text — изменено («Before» → «Local»)");

    // «Отменить» оставляет локальные правки в редакторе.
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Конфликт версий черновика" })).toBeNull());
    expect((screen.getByRole("textbox", { name: "text" }) as HTMLInputElement).value).toBe("Local");
    expect(screen.getByText("Не сохранено")).toBeTruthy();

    // Повторный save → снова диалог → «Перезаписать» кладёт локальную версию с baseRev свежего rev.
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByRole("dialog", { name: "Конфликт версий черновика" });
    fireEvent.click(screen.getByRole("button", { name: "Перезаписать" }));
    expect(await screen.findByText("Сохранено")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Конфликт версий черновика" })).toBeNull();
    const last = puts[puts.length - 1]!;
    expect(last.baseRev).toBe(9);
    expect(last.doc.screens[0]!.spec.elements["text"]!.props["text"]).toBe("Local");
  });

  it("humanizes 422 validation addresses in document terms (W2-4)", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/prototypes/editor-demo" && init?.method === "PUT") {
        return json({ error: { code: "validation_failed", message: "Prototype document is invalid", issues: [{ path: "/screens/0/spec/elements/text/props/text", message: "must be a string" }] } }, 422);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    editText("Broken");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Экран «Home» › text › text: must be a string");
  });

  it("marks the draft dirty again when undoing past a save checkpoint", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/prototypes/editor-demo" && init?.method === "PUT") return json({ rev: 8, warnings: [] });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    editText("After");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Сохранено")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Отменить правку/ }));
    expect(await screen.findByText("Не сохранено")).toBeTruthy(); // undo после save честно возвращает dirty
    expect((screen.getByRole("textbox", { name: "text" }) as HTMLInputElement).value).toBe("Before");

    fireEvent.click(screen.getByRole("button", { name: /Вернуть правку/ }));
    expect(await screen.findByText("Сохранено")).toBeTruthy();
  });
});
