import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError, getComponentMeta, getPrototypeMeta, getPrototypeRevision, getPrototypeVersion, listComponents,
  listPrototypeRevisions, listPrototypes,
} from "../api/client";
import {
  deleteVisualReference, enqueueComponentScreenshot, enqueuePrototypeScreenshot, getScreenshotJob, getVisualReference,
  listVisualReferences, putVisualReference,
} from "./api";
import { VisualPage } from "./VisualPage";

vi.mock("../api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/client")>();
  return {
    ...original,
    getComponentMeta: vi.fn(), getPrototypeMeta: vi.fn(), getPrototypeRevision: vi.fn(), getPrototypeVersion: vi.fn(),
    listComponents: vi.fn(), listPrototypeRevisions: vi.fn(), listPrototypes: vi.fn(),
  };
});

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    checkVisualReference: vi.fn(), deleteVisualReference: vi.fn(), enqueueComponentScreenshot: vi.fn(),
    enqueuePrototypeScreenshot: vi.fn(), getScreenshotJob: vi.fn(), getVisualReference: vi.fn(),
    getVisualRun: vi.fn(), listVisualReferences: vi.fn(), putVisualReference: vi.fn(),
  };
});

const doc = {
  version: 1 as const,
  id: "checkout",
  name: "Checkout",
  designSystem: "shadcn",
  device: "mobile" as const,
  startScreen: "welcome",
  state: {},
  screens: [
    { id: "welcome", name: "Приветствие", spec: { root: "root", elements: { root: { type: "Text", props: { text: "Hello" } } } } },
    { id: "done", name: "Готово", canvas: { width: 640, height: 480 }, spec: { root: "root", elements: { root: { type: "Text", props: { text: "Done" } } } } },
  ],
};

const snapshot = { doc, rev: 2, builtinCatalogHash: "builtin", componentManifestHash: "components", components: [], message: null, createdAt: "now" };

describe("VisualPage reference capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listVisualReferences).mockResolvedValue({ references: [] });
    vi.mocked(listPrototypes).mockResolvedValue([{ id: "checkout", name: "Checkout", device: "mobile", screenCount: 2, headRev: 2, latestVersion: 1, updatedAt: "now" }]);
    vi.mocked(getPrototypeMeta).mockResolvedValue({ id: "checkout", name: "Checkout", designSystem: "shadcn", headRev: 2, latestVersion: 1, versions: [{ version: 1, rev: 1, publishedAt: "then" }], updatedAt: "now" });
    vi.mocked(listPrototypeRevisions).mockResolvedValue([{ rev: 2, message: null, createdAt: "now" }, { rev: 1, message: null, createdAt: "then" }]);
    vi.mocked(getPrototypeRevision).mockResolvedValue(snapshot);
    vi.mocked(getPrototypeVersion).mockResolvedValue({ ...snapshot, rev: 1, version: 1, publishedAt: "then" });
    vi.mocked(listComponents).mockResolvedValue([{ id: "rating", name: "Rating", designSystem: "custom", headRev: 3, latestVersion: 3, updatedAt: "now" }]);
    vi.mocked(getComponentMeta).mockResolvedValue({ id: "rating", name: "Rating", designSystem: "custom", headRev: 3, updatedAt: "now", versions: [{ version: 3, rev: 3, status: "active", statusReason: null, supersededBy: null, statusRev: 1, designSystem: "custom", publishedAt: "now" }] });
    vi.mocked(getVisualReference).mockResolvedValue({ id: "vref_new", fingerprint: {}, note: null, createdAt: "now", asset: null, lastRun: null, runs: [] });
    vi.mocked(putVisualReference).mockResolvedValue({ id: "vref_new", fingerprint: {}, note: null, createdAt: "now", asset: null, lastRun: null });
  });

  it("offers both cascades and derives dimensions without width/height text fields", async () => {
    render(<VisualPage />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Снять эталон" }));

    expect((await screen.findByLabelText("Прототип") as HTMLSelectElement).value).toBe("checkout");
    expect((screen.getByLabelText("Ревизия или версия") as HTMLSelectElement).value).toBe("rev:2");
    const screenSelect = await screen.findByLabelText("Экран") as HTMLSelectElement;
    await waitFor(() => expect(screenSelect.value).toBe("welcome"));
    expect(screen.getByText("Размер: 390×844 — определён автоматически")).toBeTruthy();
    expect(screen.queryByPlaceholderText("width")).toBeNull();
    expect(screen.queryByPlaceholderText("height")).toBeNull();
    fireEvent.change(screenSelect, { target: { value: "done" } });
    expect(screen.getByText("Размер: 640×480 — определён автоматически")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Ревизия или версия"), { target: { value: "version:1" } });
    await waitFor(() => expect(getPrototypeVersion).toHaveBeenCalledWith("checkout", 1, expect.any(AbortSignal)));

    fireEvent.change(screen.getByLabelText("Режим"), { target: { value: "component" } });
    const componentSelect = await screen.findByLabelText("Компонент") as HTMLSelectElement;
    await waitFor(() => expect(componentSelect.value).toBe("rating"));
    await waitFor(() => expect((screen.getByLabelText("Версия") as HTMLSelectElement).value).toBe("3"));
    expect(screen.getByText("Размер: 390×844 — определён автоматически")).toBeTruthy();
  });

  it("captures a prototype baseline through enqueue/poll and PUTs the returned asset", async () => {
    vi.mocked(enqueuePrototypeScreenshot).mockResolvedValue({ jobId: "shot_1" });
    vi.mocked(getScreenshotJob).mockResolvedValue({ status: "done", result: { imageUrl: "/asset", assetId: "asset_png", width: 390, height: 844, consoleErrors: [], pageErrors: [] } });
    render(<VisualPage />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Снять эталон" }));
    await screen.findByLabelText("Экран");
    const capture = screen.getByRole("button", { name: "Снять эталон" }) as HTMLButtonElement;
    await waitFor(() => expect(capture.disabled).toBe(false));
    fireEvent.click(capture);

    await waitFor(() => expect(enqueuePrototypeScreenshot).toHaveBeenCalled());
    await waitFor(() => expect(putVisualReference).toHaveBeenCalledWith(expect.objectContaining({
      scope: "prototype-screen", prototypeId: "checkout", screenId: "welcome", refRevision: 2,
      viewport: { width: 390, height: 844 },
    }), "asset_png", undefined));
    expect(enqueuePrototypeScreenshot).toHaveBeenCalledWith("checkout", "welcome", { rev: 2 }, expect.objectContaining({ viewport: { width: 390, height: 844 } }));
  });

  it("explains a baseline-managed conflict when PUT cannot create a generic reference", async () => {
    vi.mocked(enqueuePrototypeScreenshot).mockResolvedValue({ jobId: "shot_managed" });
    vi.mocked(getScreenshotJob).mockResolvedValue({ status: "done", result: { imageUrl: "/asset", assetId: "asset_png", width: 390, height: 844, consoleErrors: [], pageErrors: [] } });
    vi.mocked(putVisualReference).mockRejectedValue(new ApiError(409, { code: "baseline_managed", message: "raw server error" }));
    render(<VisualPage />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Снять эталон" }));
    await screen.findByLabelText("Экран");
    const capture = screen.getByRole("button", { name: "Снять эталон" }) as HTMLButtonElement;
    await waitFor(() => expect(capture.disabled).toBe(false));
    fireEvent.click(capture);

    expect(await screen.findByText("Этот reference управляется baseline-набором и не может быть изменён отдельно.")).toBeTruthy();
    expect(screen.queryByText("raw server error")).toBeNull();
  });

  it("explains a baseline-managed conflict when DELETE cannot remove a generic reference", async () => {
    const reference = { id: "vref_managed", fingerprint: { scope: "prototype-screen", prototypeId: "checkout", screenId: "welcome", refRevision: 2 }, note: null, createdAt: "now", asset: null, lastRun: null };
    vi.mocked(listVisualReferences).mockResolvedValue({ references: [reference] });
    vi.mocked(getVisualReference).mockResolvedValue({ ...reference, runs: [] });
    vi.mocked(deleteVisualReference).mockRejectedValue(new ApiError(409, { code: "baseline_managed", message: "raw delete error" }));
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    render(<VisualPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Удалить эталон" }));

    expect(await screen.findByText("Этот reference управляется baseline-набором и не может быть изменён отдельно.")).toBeTruthy();
    expect(screen.queryByText("raw delete error")).toBeNull();
  });

  it("stops polling without cancelling the component screenshot job", async () => {
    vi.mocked(enqueueComponentScreenshot).mockResolvedValue({ jobId: "shot_component" });
    vi.mocked(getScreenshotJob).mockReturnValue(new Promise(() => {}));
    render(<VisualPage />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Снять эталон" }));
    fireEvent.change(screen.getByLabelText("Режим"), { target: { value: "component" } });
    await screen.findByLabelText("Версия");
    fireEvent.click(screen.getByRole("button", { name: "Снять эталон" }));
    fireEvent.click(await screen.findByRole("button", { name: "Перестать ждать" }));

    expect(screen.getByText("Ожидание остановлено. Задание продолжает выполняться на сервере.")).toBeTruthy();
    expect(enqueueComponentScreenshot).toHaveBeenCalledWith("rating", 3, expect.objectContaining({ viewport: { width: 390, height: 844 } }));
    expect(putVisualReference).not.toHaveBeenCalled();
  });

  it("labels legacy run evidence as unknown", async () => {
    const legacyRun = { runId: "legacy", referenceId: "vref_legacy", status: "reference_unknown" as const, referenceStatus: "unknown" as const, createdAt: "now", diffPercent: 0 };
    const legacyReference = { id: "vref_legacy", fingerprint: { scope: "component", componentId: "rating", refVersion: 3, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" }, note: null, createdAt: "now", asset: null, lastRun: legacyRun };
    vi.mocked(listVisualReferences).mockResolvedValue({ references: [legacyReference] });
    vi.mocked(getVisualReference).mockResolvedValue({ ...legacyReference, runs: [legacyRun] });
    render(<VisualPage />);

    expect((await screen.findAllByText("Эталон прогона неизвестен")).length).toBeGreaterThan(0);
  });
});
