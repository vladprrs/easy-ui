import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeObjects } from "../app/routes";
import type { PrototypeDraft, PrototypeVersion } from "../api/client";
import { prototypeDocSchema } from "../prototype/schema";

const mocks = vi.hoisted(() => ({ getDraft: vi.fn(), getVersion: vi.fn(), loadCustom: vi.fn() }));
vi.mock("../api/client", async (original) => ({ ...(await original()), getPrototypeDraft: mocks.getDraft, getPrototypeVersion: mocks.getVersion }));
vi.mock("../customComponents/loader", () => ({ loadCustomComponents: mocks.loadCustom }));

const hello = prototypeDocSchema.parse((await import("../../prototypes/hello-world.json")).default);
const draft = (): PrototypeDraft => ({ doc: hello, rev: 1, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [] });

function renderAt(path: string) {
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("PresentShell (W1-2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getDraft.mockResolvedValue(draft());
    mocks.getVersion.mockResolvedValue({ ...draft(), version: 2, publishedAt: "2026-07-10T00:00:00Z" } satisfies PrototypeVersion);
    mocks.loadCustom.mockResolvedValue({ definitions: {}, components: {} });
  });

  it("redirects the index route to the start screen without any app chrome", async () => {
    const router = renderAt("/p/hello-world/present");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/welcome"));
    await screen.findByLabelText("Name");
    expect(document.title).toBe("Hello World · Презентация — easy-ui");
    // Ни глобального Layout, ни PrototypeChrome: только прототип и оснастка.
    expect(screen.queryByRole("link", { name: "Галерея" })).toBeNull();
    expect(screen.queryByTestId("chrome-actions")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Экраны" })).toBeNull();
    // Пейджер и счётчик.
    const pager = screen.getByRole("navigation", { name: "Экраны презентации" });
    expect(pager.childElementCount).toBe(2);
    expect(screen.getByText("1 / 2")).toBeTruthy();
    // Прямой вход: вместо Esc-поведения — «Открыть в easy-ui».
    expect(screen.getByRole("link", { name: "Открыть в easy-ui" }).getAttribute("href")).toBe("/p/hello-world/s/welcome");
    expect(screen.queryByText("Esc — вернуться в плеер")).toBeNull();
  });

  it("runs the interactive flow and restart resets state", async () => {
    const router = renderAt("/p/hello-world/present");
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Lin" } });
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/details"));
    await screen.findByText("This is the second screen.");
    expect(screen.getByText("2 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Начать сначала" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/welcome"));
    expect((await screen.findByLabelText("Name") as HTMLInputElement).value).toBe("Ada");
  });

  it("keeps a deep-linked screen (no forced redirect to start)", async () => {
    const router = renderAt("/p/hello-world/present/s/details");
    await screen.findByText("This is the second screen.");
    expect(router.state.location.pathname).toBe("/p/hello-world/present/s/details");
    expect(screen.getByRole("link", { name: "Открыть в easy-ui" }).getAttribute("href")).toBe("/p/hello-world/s/details");
  });

  it("enters from the player chrome action and Esc returns to the player at the same screen", async () => {
    const router = renderAt("/p/hello-world/s/welcome");
    await screen.findByLabelText("Name");
    const presentLink = within(screen.getByTestId("chrome-actions")).getByRole("link", { name: "Презентация" });
    expect(presentLink.getAttribute("href")).toBe("/p/hello-world/present/s/welcome");
    fireEvent.click(presentLink);
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/welcome"));
    await screen.findByLabelText("Name");
    // Внутренний вход: Esc-подсказка вместо кнопки «Открыть в easy-ui».
    expect(screen.getByText("Esc — вернуться в плеер")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Открыть в easy-ui" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/details"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/s/details"));
    // Снова плеер: единый хром /p/* на месте.
    expect(await screen.findByRole("link", { name: "Галерея" })).toBeTruthy();
  });

  it("serves the versioned present route under its version-aware base", async () => {
    const router = renderAt("/p/hello-world/v/2/present");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/v/2/present/s/welcome"));
    expect(mocks.getVersion).toHaveBeenCalledWith("hello-world", 2, expect.any(AbortSignal));
    await screen.findByLabelText("Name");
    expect(document.title).toBe("Hello World v2 · Презентация — easy-ui");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/v/2/present/s/details"));
  });
});
