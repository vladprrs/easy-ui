import { JSONUIProvider } from "@json-render/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPlayerRuntime } from "../catalog/runtime";
import { prototypeDocSchema } from "../prototype/schema";
import { EasyUiActionRuntime } from "./actionRuntime";
import { DuoStage } from "./DuoStage";

const duo = prototypeDocSchema.parse((await import("../../test/fixtures/duo-pos.json")).default);

function renderStage(focusedSurfaceId: string, options: { layout?: "row" | "focused"; onFocusSurface?: (id: string) => void } = {}) {
  const deps = { navigate: vi.fn(), back: vi.fn(), openUrl: vi.fn(), restart: vi.fn() };
  const runtime = createPlayerRuntime(deps);
  const actionRuntime = new EasyUiActionRuntime({ initialState: duo.state, screenIds: new Set(duo.screens.map((item) => item.id)), deps });
  const stage = (focused: string) => <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
    <DuoStage
      doc={duo}
      screenBySurface={{ kso: "kso-scan", app: "app-home" }}
      focusedSurfaceId={focused}
      onFocusSurface={options.onFocusSurface ?? (() => {})}
      registry={runtime.registry}
      runtime={actionRuntime}
      customDefinitions={{}}
      customTypes={new Set<string>()}
      onError={() => {}}
      designSystem={duo.designSystem}
      statusBarHidden={false}
      restart={() => {}}
      layout={options.layout ?? "row"}
    />
  </JSONUIProvider>;
  const view = render(stage(focusedSurfaceId));
  return { view, stage, actionRuntime };
}

describe("DuoStage (D10–D11)", () => {
  it("renders one panel per surface and marks the focused one", () => {
    renderStage("kso");
    const panels = screen.getAllByTestId("surface-panel");
    expect(panels.map((panel) => panel.dataset.surface)).toEqual(["kso", "app"]);
    expect(panels.map((panel) => panel.dataset.focused)).toEqual(["true", "false"]);
    // Заголовок панели — имя поверхности из документа.
    expect(screen.getByRole("button", { name: "КСО" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Приложение" })).toBeTruthy();
    // Обе панели живые: содержимое каждой отрисовано.
    expect(screen.getByText("Товар в чеке")).toBeTruthy();
    expect(screen.getByText("Приложение покупателя")).toBeTruthy();
  });

  it("registers a render budget spec per surface", () => {
    const { actionRuntime } = renderStage("kso");
    // Спеки обеих панелей активны одновременно: гард бюджета проверяет каждую
    // отдельно, поэтому вторая сцена не затирает первую (D7).
    const specs = (actionRuntime as unknown as { specsBySurface: Map<string, unknown> }).specsBySurface;
    expect([...specs.keys()].sort()).toEqual(["app", "kso"]);
  });

  it("keeps every surface mounted when the focus moves (D11)", () => {
    const { view, stage } = renderStage("kso", { layout: "focused" });
    const hiddenBefore = screen.getByText("Приложение покупателя");
    expect(screen.getAllByTestId("surface-panel")[1]!.className).toContain("hidden");
    view.rerender(stage("app"));
    // Тот же DOM-узел: скрытая панель получает `display: none`, а не размонтирование —
    // таймеры и эффекты второй поверхности продолжают жить.
    expect(screen.getByText("Приложение покупателя")).toBe(hiddenBefore);
    expect(screen.getByText("Товар в чеке")).toBeTruthy();
    expect(screen.getAllByTestId("surface-panel")[0]!.className).toContain("hidden");
  });

  it("asks the caller to move the focus when a panel header is pressed", () => {
    const onFocusSurface = vi.fn();
    renderStage("kso", { onFocusSurface });
    screen.getByRole("button", { name: "Приложение" }).click();
    expect(onFocusSurface).toHaveBeenCalledWith("app");
  });
});
