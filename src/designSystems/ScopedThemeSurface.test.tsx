// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThemeContent } from "../api/client";
import { ScopedThemeSurface, scopedThemeStyle } from "./ScopedThemeSurface";
import { serializeThemeCss } from "./theme";

const theme = (tokens: ThemeContent["tokens"]): ThemeContent => ({ tokens, fonts: [], icons: [] });

const surface = (container: HTMLElement, system: string) =>
  container.querySelector<HTMLElement>(`[data-eui-scoped-system="${system}"]`)!;

describe("ScopedThemeSurface", () => {
  it("keeps two design systems on one page from bleeding into each other", () => {
    const { container } = render(<>
      <ScopedThemeSurface systemId="alpha" theme={theme({ "color.primary": "#111111" })}><span data-card="a" /></ScopedThemeSurface>
      <ScopedThemeSurface systemId="beta" theme={theme({ "color.primary": "#222222" })}><span data-card="b" /></ScopedThemeSurface>
    </>);
    expect(surface(container, "alpha").style.getPropertyValue("--eui-color-primary")).toBe("#111111");
    expect(surface(container, "beta").style.getPropertyValue("--eui-color-primary")).toBe("#222222");
    expect(container.querySelector('[data-card="a"]')!.closest("[data-eui-scoped-surface]")).toBe(surface(container, "alpha"));
  });

  it("overrides :root with the scoped value", () => {
    const style = document.createElement("style");
    style.textContent = ":root{--eui-color-primary: #root;}";
    document.head.append(style);
    const { container } = render(<ScopedThemeSurface systemId="alpha" theme={theme({ "color.primary": "#scoped" })}><span /></ScopedThemeSurface>);
    // Инлайн-объявление на элементе выигрывает у :root по каскаду; jsdom не считает var(), поэтому
    // проверяем сам факт объявления с высшей специфичностью.
    expect(getComputedStyle(surface(container, "alpha")).getPropertyValue("--eui-color-primary")).toBe("#scoped");
    style.remove();
  });

  it("renders a scoped value identically to the :root one (raw, never cssEscapeString)", () => {
    // Значение с кавычкой: в тексте CSS оно обязано быть экранировано (`a\22 b`), а через
    // setProperty — сырым. Обе записи означают ровно одно и то же вычисленное значение.
    const tokens = { "color.font": 'a"b' };
    const { container } = render(<ScopedThemeSurface systemId="alpha" theme={theme(tokens)}><span /></ScopedThemeSurface>);
    const scoped = surface(container, "alpha").style.getPropertyValue("--eui-color-font");
    expect(serializeThemeCss(theme(tokens))).toContain("--eui-color-font: a\\22 b;");
    expect(scoped).toBe('a"b');
    expect(scoped).not.toContain("\\22");

    const numeric = render(<ScopedThemeSurface systemId="beta" theme={theme({ "size.lg": 24 })}><span /></ScopedThemeSurface>);
    expect(surface(numeric.container, "beta").style.getPropertyValue("--eui-size-lg")).toBe("24");
  });

  it("shares the spacing element and leaves space.* to SurfaceSpacingScope", () => {
    const { container } = render(<ScopedThemeSurface systemId="alpha" theme={theme({ "space.md": "14px", "color.primary": "#111" })}><span /></ScopedThemeSurface>);
    const element = surface(container, "alpha");
    expect(element.style.getPropertyValue("--eui-color-primary")).toBe("#111");
    expect(element.style.getPropertyValue("--eui-space-md")).toBe("14px");
    expect(scopedThemeStyle({ "space.md": "14px" })).toEqual({});
  });

  it("scopes the animation reset and touches neither <html> classes nor :root variables", () => {
    const htmlClass = document.documentElement.className;
    const rootBefore = getComputedStyle(document.documentElement).getPropertyValue("--eui-color-primary");
    const view = render(<ScopedThemeSurface systemId="alpha" theme={theme({ "color.primary": "#111" })}><span /></ScopedThemeSurface>);
    const reset = document.head.querySelector<HTMLStyleElement>("style[data-eui-scoped-reset]");
    expect(reset?.textContent).toContain("[data-eui-scoped-reset] *");
    expect(reset?.textContent).not.toContain("[data-eui-scoped-surface]");
    expect(surface(view.container, "alpha").hasAttribute("data-eui-scoped-reset")).toBe(true);
    expect(reset?.textContent).not.toContain("html");
    expect(document.documentElement.className).toBe(htmlClass);
    expect(getComputedStyle(document.documentElement).getPropertyValue("--eui-color-primary")).toBe(rootBefore);
    view.unmount();
    expect(document.head.querySelector("style[data-eui-scoped-reset]")).toBeNull();
  });

  it("keeps a single refcounted reset style for many surfaces", () => {
    const view = render(<>
      <ScopedThemeSurface systemId="alpha" theme={theme({})}><span /></ScopedThemeSurface>
      <ScopedThemeSurface systemId="beta" theme={theme({})}><span /></ScopedThemeSurface>
    </>);
    expect(document.head.querySelectorAll("style[data-eui-scoped-reset]")).toHaveLength(1);
    view.unmount();
    expect(document.head.querySelectorAll("style[data-eui-scoped-reset]")).toHaveLength(0);
  });

  // R4-M5: раньше reset-стиль ключевался на `data-eui-scoped-surface`, поэтому соседний
  // CJM-тайл/Library-превью замораживал живую панель дуо-плеера через глобальный стиль.
  it("does not freeze a resetAnimations={false} surface when another scoped surface is on the page", () => {
    const view = render(<>
      <ScopedThemeSurface systemId="tile" theme={theme({})}><span /></ScopedThemeSurface>
      <ScopedThemeSurface systemId="panel" resetAnimations={false} theme={theme({})}><span /></ScopedThemeSurface>
    </>);
    expect(document.head.querySelectorAll("style[data-eui-scoped-reset]")).toHaveLength(1);
    expect(surface(view.container, "tile").hasAttribute("data-eui-scoped-reset")).toBe(true);
    expect(surface(view.container, "panel").hasAttribute("data-eui-scoped-reset")).toBe(false);
  });

  it("renders without a theme", () => {
    const { container } = render(<ScopedThemeSurface systemId="alpha" theme={null}><span data-card="a" /></ScopedThemeSurface>);
    expect(surface(container, "alpha").querySelector('[data-card="a"]')).not.toBeNull();
  });
});
