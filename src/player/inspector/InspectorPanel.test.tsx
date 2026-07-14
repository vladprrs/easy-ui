import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeObjects } from "../../app/routes";
import type { PrototypeDraft } from "../../api/client";
import { prototypeDocSchema } from "../../prototype/schema";
import { InspectorLog } from "./log";
import { InspectorPanel } from "./InspectorPanel";

const mocks = vi.hoisted(() => ({ getDraft: vi.fn(), loadCustom: vi.fn() }));
vi.mock("../../api/client", async (original) => ({ ...(await original()), getPrototypeDraft: mocks.getDraft }));
vi.mock("../../customComponents/loader", () => ({ loadCustomComponents: mocks.loadCustom }));

const hello = prototypeDocSchema.parse((await import("../../../prototypes/hello-world.json")).default);
const draft: PrototypeDraft = { doc: hello, rev: 1, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [] };

afterEach(cleanup);

describe("InspectorPanel", () => {
  it("renders entries newest first, filters by kind, and clears", () => {
    const log = new InspectorLog();
    log.logEvent({ correlationId: "e1", elementId: "el", component: "YpPaymentMethodCard", event: "press", payload: { id: "pay-card" }, payloadValid: true });
    log.logAction({ correlationId: "e1", action: "setState", params: { statePath: "/selectedMethod" }, result: { type: "state", statePath: "/selectedMethod", previous: "sbp", next: "pay-card" } });
    log.logRuntimeError("navigate target does not exist: ghost");
    render(<InspectorPanel log={log} />);

    const panel = screen.getByRole("complementary", { name: "Инспектор взаимодействий" });
    const items = within(panel).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("navigate target does not exist: ghost");
    expect(items[1]!.textContent).toContain("setState");
    expect(items[1]!.textContent).toContain("/selectedMethod");
    expect(items[1]!.textContent).toContain('"sbp"');
    expect(items[1]!.textContent).toContain('"pay-card"');
    expect(items[2]!.textContent).toContain("YpPaymentMethodCard");
    expect(items[2]!.textContent).toContain("press");

    fireEvent.change(within(panel).getByLabelText("Фильтр записей"), { target: { value: "event" } });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(1);

    fireEvent.click(within(panel).getByRole("button", { name: "Очистить" }));
    expect(within(panel).getByText("Записей пока нет — повзаимодействуйте с прототипом.")).toBeTruthy();
  });

  it("shows font status separately without adding FONT events to the ledger", () => {
    const listeners = new Map<string, EventListener>();
    const fontSet = {
      *[Symbol.iterator]() { yield { family: "Inter", status: "loaded" }; },
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const previous = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: fontSet });
    const log = new InspectorLog();
    render(<InspectorPanel log={log} />);
    expect(screen.getByRole("region", { name: "Статусы шрифтов" }).textContent).toContain("Inter");
    listeners.get("loadingdone")?.(new Event("loadingdone"));
    expect(log.getSnapshot()).toHaveLength(0);
    expect(screen.getByLabelText("Фильтр записей").textContent).not.toContain("font-status");
    if (previous) Object.defineProperty(document, "fonts", previous);
    else delete (document as { fonts?: unknown }).fonts;
  });
});

describe("player integration (?debug=1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getDraft.mockResolvedValue(draft);
    mocks.loadCustom.mockResolvedValue({ definitions: {}, components: {} });
  });

  function renderAt(path: string) {
    const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    return router;
  }

  it("shows the panel with ?debug=1 and records builtin state mutations", async () => {
    renderAt("/p/hello-world/s/welcome?debug=1");
    const input = await screen.findByLabelText("Name");
    const panel = screen.getByRole("complementary", { name: "Инспектор взаимодействий" });
    fireEvent.change(input, { target: { value: "Lin" } });
    await waitFor(() => {
      const items = within(panel).getAllByRole("listitem");
      expect(items[0]!.textContent).toContain("setState");
      expect(items[0]!.textContent).toContain('"Lin"');
    });
  });

  it("toggles only panel visibility/logger sink and preserves flow state and accumulated log", async () => {
    renderAt("/p/hello-world/s/welcome?debug=1");
    const input = await screen.findByLabelText("Name") as HTMLInputElement;
    const actions = screen.getByTestId("chrome-actions");
    const toggle = within(actions).getByRole("button", { name: "Инспектор" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(input, { target: { value: "Lin" } });
    const panel = screen.getByRole("complementary", { name: "Инспектор взаимодействий" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")[0]!.textContent).toContain('"Lin"'));

    fireEvent.click(toggle);
    expect(screen.queryByRole("complementary", { name: "Инспектор взаимодействий" })).toBeNull();
    expect(input.value).toBe("Lin");
    fireEvent.change(input, { target: { value: "Mia" } });
    expect(input.value).toBe("Mia");

    fireEvent.click(toggle);
    const reopened = screen.getByRole("complementary", { name: "Инспектор взаимодействий" });
    expect(within(reopened).getAllByRole("listitem")).toHaveLength(1);
    expect(reopened.textContent).toContain('"Lin"');
    expect(reopened.textContent).not.toContain('"Mia"');
  });

  it("records non-bubbling image errors through the capture-phase listener", async () => {
    renderAt("/p/hello-world/s/welcome?debug=1");
    const panel = await screen.findByRole("complementary", { name: "Инспектор взаимодействий" });
    const image = document.createElement("img");
    image.src = "/broken.png";
    image.alt = "Broken preview";
    document.body.append(image);
    image.dispatchEvent(new Event("error", { bubbles: false }));
    await waitFor(() => expect(panel.textContent).toContain("img-error"));
    expect(panel.textContent).toContain("broken.png");
    image.remove();
  });

  it("does not render the panel without the debug flag", async () => {
    renderAt("/p/hello-world/s/welcome");
    await screen.findByLabelText("Name");
    expect(screen.queryByRole("complementary", { name: "Инспектор взаимодействий" })).toBeNull();
    expect(within(screen.getByTestId("chrome-actions")).queryByRole("button", { name: "Инспектор" })).toBeNull();
  });
});
