import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("saves via Ctrl/Cmd+S, prevents the browser shortcut, and works inside inspector fields", async () => {
    let saves = 0;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/prototypes/editor-demo" && init?.method === "PUT") {
        saves += 1;
        return json({ rev: 7 + saves, warnings: [] });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });

    const ctrlSave = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ctrlSave);
    expect(ctrlSave.defaultPrevented).toBe(true);
    await waitFor(() => expect(saves).toBe(1));

    const input = editText("After");
    const metaSave = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(metaSave);
    expect(metaSave.defaultPrevented).toBe(true);
    await waitFor(() => expect(saves).toBe(2));
  });

  it("does not start another Ctrl+S save while saving", async () => {
    let finishSave!: (response: Response) => void;
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve; });
    const fetchMock = vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/prototypes/editor-demo" && init?.method === "PUT") return pendingSave;
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(await screen.findByText("Сохранение…")).toBeTruthy();
    const repeatedSave = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(repeatedSave);
    expect(repeatedSave.defaultPrevented).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);

    finishSave(new Response(JSON.stringify({ rev: 8, warnings: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await screen.findByText("Сохранено")).toBeTruthy();
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

  it("shows revision messages and requires confirmation before a dirty restore, then fully rebases for the next save", async () => {
    const restoredDoc = structuredClone(doc);
    restoredDoc.name = "Restored editor";
    restoredDoc.screens[0]!.spec.elements["text"]!.props.text = "From revision two";
    const requests: { url: string; body?: { baseRev?: number; rev?: number } }[] = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as { baseRev?: number; rev?: number } : undefined;
      requests.push({ url, body });
      if (url === "/api/prototypes/editor-demo/revisions?limit=100") return json([
        { rev: 7, message: "Latest checkpoint", createdAt: "2026-07-14T12:00:00.000Z" },
        { rev: 2, message: "Before redesign", createdAt: "2026-07-13T10:00:00.000Z" },
      ]);
      if (url === "/api/prototypes/editor-demo/versions") return json([{ version: 1, rev: 2, publishedAt: "2026-07-13T11:00:00.000Z" }]);
      if (url === "/api/prototypes/editor-demo/revisions/2") return json({ ...draft, rev: 2, doc: restoredDoc, message: "Before redesign", createdAt: "2026-07-13T10:00:00.000Z", figma: null });
      if (url === "/api/prototypes/editor-demo/restore" && init?.method === "POST") return json({ rev: 8 });
      if (url === "/api/prototypes/editor-demo" && init?.method === "PUT") return json({ rev: 9, warnings: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    editText("Unsaved local text");

    fireEvent.click(screen.getByRole("button", { name: "История" }));
    const history = await screen.findByRole("region", { name: "История прототипа" });
    expect(history.textContent).toContain("Before redesign");
    expect(history.textContent).toContain("v1");
    fireEvent.click(within(screen.getByText("Before redesign").closest("li")!).getByRole("button", { name: "Восстановить" }));

    const confirm = await screen.findByRole("dialog", { name: "Подтверждение восстановления" });
    expect(confirm.textContent).toContain("Текущие несохранённые правки будут отброшены");
    expect(requests.some((request) => request.url.endsWith("/restore"))).toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: "Восстановить" }));

    expect(await screen.findByRole("heading", { name: "Restored editor" })).toBeTruthy();
    expect(screen.getByText("Сохранено")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Отменить правку/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Вернуть правку/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^Сохранить$/ }));
    await waitFor(() => expect(requests.some((request) => request.url === "/api/prototypes/editor-demo" && request.body?.baseRev === 8)).toBe(true));
    expect(requests.find((request) => request.url.endsWith("/restore"))?.body).toEqual({ rev: 2, baseRev: 7 });
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

  it("publishes the head revision with an optional message", async () => {
    let publishBody: { baseRev: number; message?: string } | undefined;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/prototypes/editor-demo/versions") return json([]);
      if (url === "/api/prototypes/editor-demo/publish" && init?.method === "POST") {
        publishBody = JSON.parse(String(init.body));
        return json({ version: 2, rev: 7, screens: [] }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });

    fireEvent.click(screen.getByRole("button", { name: "Опубликовать" }));
    const dialog = screen.getByRole("dialog", { name: "Публикация прототипа" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Сообщение к версии (необязательно)" }), { target: { value: "Готово для показа" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Опубликовать" }));

    expect(await screen.findByText("v 2 опубликована")).toBeTruthy();
    expect(publishBody).toEqual({ baseRev: 7, message: "Готово для показа" });
  });

  it("saves a dirty draft before publishing the newly created head revision", async () => {
    const requests: string[] = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/prototypes/editor-demo/versions") return json([]);
      if (url === "/api/prototypes/editor-demo" && init?.method === "PUT") {
        requests.push(`save:${(JSON.parse(String(init.body)) as { baseRev: number }).baseRev}`);
        return json({ rev: 8, warnings: [] });
      }
      if (url === "/api/prototypes/editor-demo/publish" && init?.method === "POST") {
        requests.push(`publish:${(JSON.parse(String(init.body)) as { baseRev: number }).baseRev}`);
        return json({ version: 1, rev: 8, screens: [] }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    editText("Published change");

    fireEvent.click(screen.getByRole("button", { name: "Опубликовать" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить и опубликовать" }));

    expect(await screen.findByText("v 1 опубликована")).toBeTruthy();
    expect(requests).toEqual(["save:7", "publish:8"]);
  });

  it("continues save-and-publish after resolving a save conflict", async () => {
    const requests: string[] = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/prototypes/editor-demo/versions") return json([]);
      if (url === "/api/prototypes/editor-demo" && init?.method === "PUT") {
        const { baseRev } = JSON.parse(String(init.body)) as { baseRev: number };
        requests.push(`save:${baseRev}`);
        return baseRev === 7
          ? json({ error: { code: "revision_conflict", message: "conflict", currentRev: 9 } }, 409)
          : json({ rev: 10, warnings: [] });
      }
      if (url === "/api/prototypes/editor-demo/draft") return json({ ...draft, rev: 9 });
      if (url === "/api/prototypes/editor-demo/publish" && init?.method === "POST") {
        requests.push(`publish:${(JSON.parse(String(init.body)) as { baseRev: number }).baseRev}`);
        return json({ version: 2, rev: 10, screens: [] }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    editText("Local publish after conflict");

    fireEvent.click(screen.getByRole("button", { name: "Опубликовать" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить и опубликовать" }));
    const conflictDialog = await screen.findByRole("dialog", { name: "Конфликт версий черновика" });
    fireEvent.click(within(conflictDialog).getByRole("button", { name: "Перезаписать" }));

    expect(await screen.findByText("v 2 опубликована")).toBeTruthy();
    expect(requests).toEqual(["save:7", "save:9", "publish:10"]);
  });

  it("treats already_published as an informative published state with its version", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/prototypes/editor-demo/versions") return json([]);
      if (url === "/api/prototypes/editor-demo/publish" && init?.method === "POST") {
        return json({ error: { code: "already_published", message: "already published", currentRev: 7, currentVersion: 4 } }, 409);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView();
    await screen.findByRole("heading", { name: "Editor demo" });
    fireEvent.click(screen.getByRole("button", { name: "Опубликовать" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Публикация прототипа" })).getByRole("button", { name: "Опубликовать" }));

    expect(await screen.findByText("v 4 опубликована")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Текущая ревизия уже опубликована как версия v 4.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the published-version badge when the loaded head is already a version", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/prototypes/editor-demo/versions") return json([{ version: 3, rev: 7, publishedAt: "2026-07-14T00:00:00.000Z" }]);
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderView();
    expect(await screen.findByText("v 3 опубликована")).toBeTruthy();
  });
});
