import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAssetUsage, listAllAssets, type AssetListItem } from "../api/assetsApi";
import { AssetsPage } from "./AssetsPage";

vi.mock("../api/assetsApi", () => ({ listAllAssets: vi.fn(), getAssetUsage: vi.fn() }));

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const idOf = (seed: string) => `asset_${sha(seed)}`;

function asset(seed: string, patch: Partial<AssetListItem> = {}): AssetListItem {
  return {
    id: idOf(seed), sha256: sha(seed), mime: "image/png", size: 4096, width: 48, height: 48,
    originalName: "logo.png", createdAt: "2026-07-27T10:00:00.000Z", url: `/api/assets/${idOf(seed)}`,
    usage: { prototypes: 0, components: 0, visualReferences: 0, visualRuns: 0 },
    ...patch,
  };
}

function renderAssets() {
  const router = createMemoryRouter([{ path: "/assets", element: <AssetsPage /> }], { initialEntries: ["/assets"] });
  render(<RouterProvider router={router} />);
}

describe("AssetsPage", () => {
  beforeEach(() => {
    vi.mocked(getAssetUsage).mockResolvedValue({
      asset: { ...asset("a"), usage: undefined } as never,
      prototypes: [{ id: "checkout", name: "Checkout", revCount: 3, lastRev: 7, pinnedAtHead: true }],
      components: [{ id: "yp-logo", name: "Yp Logo", versions: [1, 2] }],
      visualReferences: [], visualRuns: [],
    });
  });

  it("renders the grid with short ids, mime, size and the usage badge", async () => {
    vi.mocked(listAllAssets).mockResolvedValue({ assets: [
      asset("a", { usage: { prototypes: 1, components: 1, visualReferences: 0, visualRuns: 0 } }),
      asset("b", { originalName: "orphan.woff2", mime: "font/woff2", width: undefined, height: undefined }),
    ], truncated: false });
    renderAssets();
    const grid = await screen.findByLabelText("Сетка ассетов");
    expect(within(grid).getByText("aaaaaaaa…aaaa")).toBeTruthy();
    expect(within(grid).getByText("orphan.woff2")).toBeTruthy();
    expect(within(grid).getByText("Не изображение")).toBeTruthy();
    expect(within(grid).getByText("не используется")).toBeTruthy();
    expect(within(grid).getAllByText(/4\.0 КБ/)).toHaveLength(2);
  });

  it("filters by mime facet, by unused and by id prefix", async () => {
    vi.mocked(listAllAssets).mockResolvedValue({ assets: [
      asset("a", { usage: { prototypes: 1, components: 0, visualReferences: 0, visualRuns: 0 } }),
      asset("b", { originalName: "icon.svg", mime: "image/svg+xml" }),
    ], truncated: false });
    renderAssets();
    const grid = await screen.findByLabelText("Сетка ассетов");
    expect(within(grid).getAllByRole("button")).toHaveLength(2);

    const facets = screen.getByLabelText("Фильтр по MIME");
    fireEvent.click(within(facets).getByRole("button", { name: /image\/svg\+xml/ }));
    expect(within(await screen.findByLabelText("Сетка ассетов")).getByText("icon.svg")).toBeTruthy();
    expect(within(screen.getByLabelText("Сетка ассетов")).queryByText("logo.png")).toBeNull();

    fireEvent.click(within(facets).getByRole("button", { name: "Все типы" }));
    fireEvent.click(screen.getByRole("switch", { name: "Только неиспользуемые" }));
    expect(within(screen.getByLabelText("Сетка ассетов")).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("switch", { name: "Только неиспользуемые" }));
    fireEvent.change(screen.getByLabelText("Поиск по id или имени файла"), { target: { value: "aaaa" } });
    expect(within(screen.getByLabelText("Сетка ассетов")).getAllByRole("button")).toHaveLength(1);
  });

  it("shows the full id, metadata and the usage graph for the selected asset", async () => {
    vi.mocked(listAllAssets).mockResolvedValue({ assets: [asset("a")], truncated: false });
    renderAssets();
    const grid = await screen.findByLabelText("Сетка ассетов");
    fireEvent.click(within(grid).getAllByRole("button")[0]);
    const details = screen.getByLabelText("Карточка ассета");
    expect(within(details).getByText(idOf("a"))).toBeTruthy();
    expect(within(details).getByText("48×48")).toBeTruthy();
    // canvas недоступен в jsdom → честное «не определена», а не «непрозрачный».
    expect(within(details).getByText("не определена")).toBeTruthy();
    await waitFor(() => expect(within(details).getByText("Checkout")).toBeTruthy());
    expect(within(details).getByText("версии v1, v2")).toBeTruthy();
    expect(getAssetUsage).toHaveBeenCalledWith(idOf("a"), expect.anything());
  });

  it("labels the raster-over-svg finding as a heuristic and reports the empty state", async () => {
    vi.mocked(listAllAssets).mockResolvedValue({ assets: [
      asset("a", { originalName: "logo.png" }),
      asset("b", { originalName: "logo.svg", mime: "image/svg+xml" }),
    ], truncated: false });
    renderAssets();
    const grid = await screen.findByLabelText("Сетка ассетов");
    expect(within(grid).getByText(/есть SVG с таким же именем · эвристика/)).toBeTruthy();
    expect(screen.getAllByText("эвристика").length).toBeGreaterThan(0);
    expect(screen.getByText(/Точные дубликаты невозможны/)).toBeTruthy();
  });

  it("keeps the loading, error and empty states honest", async () => {
    vi.mocked(listAllAssets).mockRejectedValue(new Error("boom"));
    renderAssets();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Ассеты недоступны/)).toBeTruthy();

    vi.mocked(listAllAssets).mockResolvedValue({ assets: [], truncated: false });
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText(/Ассетов пока нет/)).toBeTruthy();
  });
});
