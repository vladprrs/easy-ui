import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadinessGate, ReadinessReport } from "../api/client";
import { getPrototypeReadiness } from "../api/client";
import { gateLocations, ReadinessPanel } from "./ReadinessPanel";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  getPrototypeReadiness: vi.fn(),
}));

const gate = (id: string, status: ReadinessGate["status"], summary: string, detail: Record<string, unknown> = {}): ReadinessGate =>
  ({ id, status, summary, ...detail } as ReadinessGate);

const report = (overrides: Partial<ReadinessReport> = {}): ReadinessReport => ({
  prototypeId: "demo",
  rev: 4,
  generatedAt: "2026-07-27T00:00:00.000Z",
  gates: [
    gate("architecture", "warn", "architecture_warnings", {
      issues: [{ code: "arch/monolith-root", path: "/screens/0/spec/elements/root", message: "монолит", screenId: "home", elementKey: "root" }],
      exempted: [{ code: "arch/root-not-allowed", screenId: "home", elementKey: "root", path: "/x", message: "m", reason: "потому что" }],
    }),
    gate("schema", "pass", "clean", { errors: [], warnings: [] }),
    gate("capture", "unknown", "no_capture_evidence", { screens: [] }),
  ],
  blocking: [],
  publishable: true,
  enabledGates: {},
  ...overrides,
});

describe("ReadinessPanel", () => {
  beforeEach(() => { vi.mocked(getPrototypeReadiness).mockReset(); });

  it("renders one row per gate with a translated status and summary", async () => {
    vi.mocked(getPrototypeReadiness).mockResolvedValue(report());
    render(<ReadinessPanel prototypeId="demo" />);

    expect(await screen.findByText("Архитектура")).toBeTruthy();
    expect(screen.getByText("Есть архитектурные замечания")).toBeTruthy();
    expect(screen.getByText("предупреждение")).toBeTruthy();
    expect(screen.getByText("нет данных")).toBeTruthy();
    expect(screen.getByText("Снято исключениями: 1")).toBeTruthy();
    // Пустой конфиг гейтов честно проговаривается: отчёт информационный.
    expect(screen.getByText("Гейты публикации выключены — отчёт информационный.")).toBeTruthy();
    expect(screen.getByText("Публикация не заблокирована.")).toBeTruthy();
  });

  it("turns a located issue into a clickable link and reports the location upward", async () => {
    vi.mocked(getPrototypeReadiness).mockResolvedValue(report());
    const onSelectLocation = vi.fn();
    render(<ReadinessPanel prototypeId="demo" onSelectLocation={onSelectLocation} />);

    const link = await screen.findByRole("button", { name: "home → root" });
    fireEvent.click(link);
    expect(onSelectLocation).toHaveBeenCalledWith(expect.objectContaining({ screenId: "home", elementKey: "root" }));
  });

  it("names the blocking gates when the report is not publishable", async () => {
    vi.mocked(getPrototypeReadiness).mockResolvedValue(report({ blocking: ["schema"], publishable: false, enabledGates: { schema: "fail" } }));
    render(<ReadinessPanel prototypeId="demo" />);
    expect(await screen.findByText("Публикация заблокирована: Схема документа.")).toBeTruthy();
  });

  it("shows an error state and retries on demand", async () => {
    vi.mocked(getPrototypeReadiness).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(report());
    render(<ReadinessPanel prototypeId="demo" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(screen.getByText("Архитектура")).toBeTruthy());
  });
});

describe("gateLocations", () => {
  it("collects located details from every known detail array and ignores the rest", () => {
    expect(gateLocations(gate("assets", "fail", "assets_missing", {
      missing: ["asset_a"],
      errors: [{ path: "/screens/0", message: "боль", screenId: "home" }],
      pins: [{ id: "x", name: "X", version: 1, status: "active" }],
    }))).toEqual([
      { path: "/screens/0", message: "боль", screenId: "home" },
      { path: "asset_a", message: "asset_a" },
    ]);
  });
});
