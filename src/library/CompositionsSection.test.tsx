import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getComposition, getCompositionUsages, listCompositions } from "../api/client";
import { CompositionsSection } from "./CompositionsSection";

vi.mock("../api/client", () => ({ getComposition: vi.fn(), getCompositionUsages: vi.fn(), listCompositions: vi.fn() }));

function renderSection() {
  const router = createMemoryRouter([{ path: "/library", element: <CompositionsSection /> }], { initialEntries: ["/library"] });
  render(<RouterProvider router={router} />);
}

const summary = {
  id: "promo-card", name: "Промо-карточка", designSystem: "yandex-pay", headRev: 4,
  latestVersion: 2, updatedAt: "2026-07-27T10:00:00.000Z", description: "Карточка промо-акции",
  params: ["title", "amount"], slots: ["default", "footer"],
};

describe("CompositionsSection", () => {
  beforeEach(() => {
    vi.mocked(listCompositions).mockResolvedValue([summary]);
    vi.mocked(getComposition).mockResolvedValue({
      id: "promo-card", name: "Промо-карточка", designSystem: "yandex-pay", headRev: 4,
      updatedAt: "2026-07-27T10:00:00.000Z", publishedVersion: 2,
      versions: [{ version: 2, rev: 4, status: "active", statusReason: null, supersededBy: null, statusRev: 4, sourceHash: "h2", publishedAt: "2026-07-27T10:00:00.000Z" },
        { version: 1, rev: 2, status: "superseded", statusReason: null, supersededBy: 2, statusRev: 4, sourceHash: "h1", publishedAt: "2026-07-26T10:00:00.000Z" }],
      doc: {
        version: 1, name: "Промо-карточка", description: "Карточка промо-акции",
        params: { title: { type: "string", required: true }, amount: { type: "number", default: 100 } },
        slots: ["default", "footer"],
        spec: { root: "box", elements: {} },
      },
    });
    vi.mocked(getCompositionUsages).mockResolvedValue({
      currentHeadUsages: [{ prototypeId: "checkout", name: "Checkout", kind: "product-flow", rev: 7, version: 2 }],
      immutableUsages: [{ prototypeId: "checkout", version: 3, compositionVersion: 1 }],
      safeToRemove: false,
    });
  });

  it("shows the composition list with params, slots and versions", async () => {
    renderSection();
    expect(await screen.findByRole("heading", { name: "Промо-карточка" })).toBeTruthy();
    expect(within(screen.getByLabelText("Композиции")).getAllByRole("button")).toHaveLength(1);

    const params = await screen.findByLabelText("Параметры композиции");
    expect(within(params).getByText("title")).toBeTruthy();
    expect(within(params).getAllByText("string").length).toBeGreaterThan(0);
    expect(within(params).getAllByText("Обязательный").length).toBe(1);
    expect(within(params).getByText(/По умолчанию: 100/)).toBeTruthy();

    const slots = screen.getByLabelText("Слоты композиции");
    expect(within(slots).getByText("footer")).toBeTruthy();

    const versions = screen.getByLabelText("Версии композиции");
    expect(within(versions).getByText("v2 · rev 4")).toBeTruthy();
    expect(within(versions).getByText("Заменён")).toBeTruthy();
  });

  it("shows head usages with links and the immutable publications", async () => {
    renderSection();
    const usages = await screen.findByLabelText("Использование композиции в head");
    expect(within(usages).getByText("Checkout")).toBeTruthy();
    expect(within(usages).getByRole("link", { name: "Редактор" }).getAttribute("href")).toBe("/p/checkout/edit");
    expect(within(usages).getByRole("link", { name: "Плеер" }).getAttribute("href")).toBe("/p/checkout");
    expect(screen.getByText("1 прототип")).toBeTruthy();
    expect(screen.getByText(/публикация v3 → композиция v1/)).toBeTruthy();
  });

  it("selects a composition from the list", async () => {
    vi.mocked(listCompositions).mockResolvedValue([summary, { ...summary, id: "banner", name: "Баннер", latestVersion: null, params: [], slots: [] }]);
    vi.mocked(getComposition).mockRejectedValue(new Error("offline"));
    renderSection();
    const list = await screen.findByLabelText("Композиции");
    fireEvent.click(within(list).getByRole("button", { name: /Баннер/ }));
    expect(await screen.findByRole("heading", { name: "Баннер" })).toBeTruthy();
    // Пока деталь недоступна, витрина продолжает показывать сводку из списка.
    expect(await screen.findByText(/Не удалось загрузить композицию/)).toBeTruthy();
    expect(screen.getAllByText("Не опубликована").length).toBeGreaterThan(0);
  });

  it("renders the empty state when there are no compositions", async () => {
    vi.mocked(listCompositions).mockResolvedValue([]);
    renderSection();
    expect(await screen.findByRole("heading", { name: "Композиций пока нет" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Открыть описание API" }).getAttribute("href")).toBe("/api/openapi.json");
  });
});
