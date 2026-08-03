import { JSONUIProvider } from "@json-render/react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScopedThemeSurface } from "../designSystems/ScopedThemeSurface";
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

// Тема второй ДС приходит из API дизайн-систем: подменяем её, чтобы у панели были
// собственные токены (сеть в jsdom недоступна, и без мока тема была бы пустой).
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  getDesignSystemById: vi.fn(async () => ({ tokens: { "color.brand": "#00ff00" }, fonts: [], icons: [] })),
  getDesignSystemVersion: vi.fn(async () => ({ tokens: { "color.brand": "#00ff00" }, fonts: [], icons: [] })),
}));

/** Тот же дуо-док, но у второй поверхности собственная дизайн-система (D8/D9). */
const twoSystems = {
  ...duo,
  surfaces: duo.surfaces!.map((surface, index) => index === 0 ? surface : { ...surface, designSystem: "pay-two" }),
};

function renderTwoSystemStage(extra?: React.ReactNode) {
  const deps = { navigate: vi.fn(), back: vi.fn(), openUrl: vi.fn(), restart: vi.fn() };
  const runtime = createPlayerRuntime(deps);
  const actionRuntime = new EasyUiActionRuntime({ initialState: twoSystems.state, screenIds: new Set(twoSystems.screens.map((item) => item.id)), deps });
  return render(<JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
    <DuoStage
      doc={twoSystems}
      screenBySurface={{ kso: "kso-scan", app: "app-home" }}
      focusedSurfaceId="kso"
      onFocusSurface={() => {}}
      registry={runtime.registry}
      themePins={{ "pay-two": 3 }}
      runtime={actionRuntime}
      customDefinitions={{}}
      customTypes={new Set<string>()}
      onError={() => {}}
      designSystem={twoSystems.designSystem}
      statusBarHidden={false}
      restart={() => {}}
    />
    {extra}
  </JSONUIProvider>);
}

describe("DuoStage per-surface theming (D9)", () => {
  it("scopes the second design system to its own panel and leaves the primary one global", async () => {
    renderTwoSystemStage();
    const panels = screen.getAllByTestId("surface-panel");
    // Панель primary-ДС остаётся под глобальным ThemeStyle — своего скоупа у неё нет.
    expect(panels[0]!.querySelector("[data-eui-scoped-system]")).toBeNull();
    const scoped = panels[1]!.querySelector<HTMLElement>('[data-eui-scoped-system="pay-two"]');
    expect(scoped).not.toBeNull();
    await waitFor(() => expect(scoped!.style.getPropertyValue("--eui-color-brand")).toBe("#00ff00"));
  });

  it("keeps the panel animations alive next to a scoped CJM tile (R4-M5)", () => {
    // Тайл CJM/Library на той же странице замораживает только себя: reset-стиль
    // ключуется на собственном opt-in атрибуте, а не на любом scoped-инстансе.
    renderTwoSystemStage(<ScopedThemeSurface systemId="tile-system" theme={null}><span data-testid="cjm-like-tile" /></ScopedThemeSurface>);
    const panelScope = screen.getAllByTestId("surface-panel")[1]!.querySelector<HTMLElement>('[data-eui-scoped-system="pay-two"]')!;
    expect(panelScope.hasAttribute("data-eui-scoped-reset")).toBe(false);
    expect(document.head.querySelector("style[data-eui-scoped-reset]")).not.toBeNull();
    expect(screen.getByTestId("cjm-like-tile").closest("[data-eui-scoped-reset]")).not.toBeNull();
  });
});
