import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../../app/routes";
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

  it("collapses to a floating toggle and expands back", () => {
    render(<InspectorPanel log={new InspectorLog()} />);
    fireEvent.click(screen.getByRole("button", { name: "Свернуть инспектор" }));
    expect(screen.queryByRole("complementary", { name: "Инспектор взаимодействий" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Инспектор \(/ }));
    expect(screen.getByRole("complementary", { name: "Инспектор взаимодействий" })).toBeTruthy();
  });
});

describe("player integration (?debug=1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getDraft.mockResolvedValue(draft);
    mocks.loadCustom.mockResolvedValue({ definitions: {}, components: {} });
  });

  function renderAt(path: string) {
    const router = createMemoryRouter([{ path: "*", element: <AppRoutes /> }], { initialEntries: [path] });
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

  it("does not render the panel without the debug flag", async () => {
    renderAt("/p/hello-world/s/welcome");
    await screen.findByLabelText("Name");
    expect(screen.queryByRole("complementary", { name: "Инспектор взаимодействий" })).toBeNull();
  });
});
