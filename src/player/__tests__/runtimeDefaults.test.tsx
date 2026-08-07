import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ComponentType } from "react";
import type { ComponentDefinition } from "../../catalog/definitions";
import {
  RUNTIME_DEFAULTS_DISABLED_KEY, clearRuntimePropsWarningsForTests, drainRuntimePropsWarnings,
} from "../../catalog/runtimeDefaults";
import { EasyUiRuntimeProvider, wrapCustomComponent, type EasyUIComponentProps } from "../easyUiRuntime";
import { EUI_KEY_PROP } from "../../prototype/runtimeSpec";

// W9 (план 2026-08-07 §1.6, §W9): runtime schema defaults. Предмет теста — три границы контракта:
// применение дефолтов **только** у флагнутого компонента, **байт-в-байт** прежний рендер у
// нефлагнутого (дифференциально, а не «на глаз») и провал парса как **предупреждение**, а не отказ
// рендера (явно не как у событий).

afterEach(() => {
  cleanup();
  clearRuntimePropsWarningsForTests();
  delete (globalThis as Record<string, unknown>)[RUNTIME_DEFAULTS_DISABLED_KEY];
});
beforeEach(clearRuntimePropsWarningsForTests);

/** Компонент читает `size` **без** фолбэка: в этом и предмет — применил ли дефолт хост. */
const Badge = (p: EasyUIComponentProps) => <span data-testid="badge">{String((p.props as { size?: unknown }).size)}</span>;

const propsSchema = z.strictObject({
  label: z.string(),
  size: z.enum(["sm", "md", "lg"]).default("md"),
});

const definitionOf = (flagged: boolean): ComponentDefinition => ({
  description: "Badge",
  props: propsSchema,
  ...(flagged ? { capabilities: { runtimeSchemaDefaults: true as const } } : {}),
});

function renderBadge(definition: ComponentDefinition, props: Record<string, unknown>) {
  const Wrapped = wrapCustomComponent("Badge", Badge) as ComponentType<Record<string, unknown>>;
  return render(
    <EasyUiRuntimeProvider value={{ metadata: { el: { type: "Badge" } }, runtime: null, definitions: { Badge: definition } }}>
      <Wrapped element={{ type: "Badge", props: {} }} props={{ [EUI_KEY_PROP]: "el", ...props }} />
    </EasyUiRuntimeProvider>,
  );
}

describe("runtime schema defaults (W9)", () => {
  it("применяет объявленный дефолт флагнутому компоненту", () => {
    const { getByTestId } = renderBadge(definitionOf(true), { label: "x" });
    expect(getByTestId("badge").textContent).toBe("md");
  });

  it("не трогает рендер компонента без capability (дифференциально с флагнутым)", () => {
    const plain = renderBadge(definitionOf(false), { label: "x" });
    const plainHtml = plain.container.innerHTML;
    expect(plain.getByTestId("badge").textContent).toBe("undefined");
    cleanup();

    const flagged = renderBadge(definitionOf(true), { label: "x" });
    // Тот же вход, та же схема — разный рендер ровно из-за capability: это и есть доказательство,
    // что нефлагнутый путь остался доволновым, а не «выглядит похоже».
    expect(flagged.container.innerHTML).not.toBe(plainHtml);
    cleanup();

    // …и обратная сторона того же: без флага рендер повторяется байт-в-байт.
    expect(renderBadge(definitionOf(false), { label: "x" }).container.innerHTML).toBe(plainHtml);
    expect(drainRuntimePropsWarnings()).toEqual([]);
  });

  it("невалидные props: рендер сырыми props + предупреждение в стоке (не отказ рендера)", () => {
    const { getByTestId } = renderBadge(definitionOf(true), { label: 42 });
    // Рендер состоялся, и props в компонент приехали **сырыми**: дефолт не применён, потому что
    // применять его было не к чему — схема не сошлась.
    expect(getByTestId("badge").textContent).toBe("undefined");
    const warnings = drainRuntimePropsWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("runtime_props_parse_failed");
    expect(warnings[0]!.component).toBe("Badge");
    expect(warnings[0]!.detail).toContain("label");
    // Сток опустошён дренажом: второй кадр не наследует предупреждения первого.
    expect(drainRuntimePropsWarnings()).toEqual([]);
  });

  it("kill-switch возвращает доволновое поведение флагнутому компоненту", () => {
    (globalThis as Record<string, unknown>)[RUNTIME_DEFAULTS_DISABLED_KEY] = true;
    const { getByTestId } = renderBadge(definitionOf(true), { label: "x" });
    expect(getByTestId("badge").textContent).toBe("undefined");
    // Ни дефолтов, ни парса — значит и предупреждений быть не может.
    expect(drainRuntimePropsWarnings()).toEqual([]);
  });

  it("свёртка стока: повтор одной и той же проблемы — один пункт со счётчиком", () => {
    renderBadge(definitionOf(true), { label: 42 });
    cleanup();
    renderBadge(definitionOf(true), { label: 42 });
    const warnings = drainRuntimePropsWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.count).toBeGreaterThanOrEqual(2);
  });
});
