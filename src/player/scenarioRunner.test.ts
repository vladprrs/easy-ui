import { describe, expect, it } from "vitest";
import { prototypeDocSchema, type PrototypeDoc } from "../prototype/schema";
import type { ScenarioStep } from "../prototype/scenario";
import { runScenario, ScenarioSession } from "./scenarioRunner";

// Раннер сценариев (волна 6): чистый прогон без DOM. Проверяем семантику статусов —
// в первую очередь то, что дрейф ключей даёт `stale`, а не `fail`.

const doc = (): PrototypeDoc => prototypeDocSchema.parse({
  version: 1,
  id: "runner",
  name: "Runner",
  designSystem: "yandex-pay",
  device: "mobile",
  startScreen: "home",
  state: { count: 0, agreed: false, items: [{ title: "Первый бонус" }, { title: "Второй бонус" }] },
  screens: [
    {
      id: "home",
      name: "Home",
      spec: {
        root: "root",
        elements: {
          root: { type: "YpBox", props: {}, children: ["cta", "hint", "list", "blocked"] },
          cta: {
            type: "YpButton",
            props: { text: "Продолжить" },
            on: { press: [{ action: "setState", params: { statePath: "/count", value: 1 } }, { action: "navigate", params: { screenId: "done" } }] },
          },
          hint: { type: "YpText", props: { text: { $template: "Всего: ${/count}" } } },
          list: { type: "YpBox", props: {}, repeat: { statePath: "/items" }, children: ["item"] },
          item: { type: "YpText", props: { text: { $item: "title" } } },
          blocked: { type: "YpButton", props: { text: "Шестая", disabled: true } },
        },
      },
    },
    {
      id: "done",
      name: "Done",
      spec: { root: "root", elements: { root: { type: "YpText", props: { text: "Бонусы начислены" } } } },
    },
  ],
});

const run = (steps: ScenarioStep[], document = doc()) => runScenario(steps, document);

describe("runScenario", () => {
  it("walks a happy path across screens, state and text", async () => {
    const result = await run([
      { type: "expectScreen", screenId: "home" },
      { type: "expectText", text: "Продолжить" },
      { type: "click", elementKey: "cta", label: "Продолжить" },
      { type: "expectScreen", screenId: "done" },
      { type: "expectState", pointer: "/count", value: 1 },
      { type: "expectText", text: "Бонусы начислены" },
    ]);
    expect(result.steps.map((step) => step.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);
    expect(result.status).toBe("pass");
    expect(result.screenId).toBe("done");
  });

  it("marks a missing element key stale, not failed", async () => {
    const result = await run([
      { type: "expectScreen", screenId: "home" },
      { type: "click", elementKey: "cta-renamed" },
    ]);
    expect(result.steps[1]).toMatchObject({ status: "stale", message: "element_missing:cta-renamed" });
    expect(result.status).toBe("pass");
    expect(result.stale).toBe(1);
  });

  it("marks a click on an element whose press binding disappeared stale", async () => {
    const document = doc();
    delete document.screens[0]!.spec.elements.cta!.on;
    const result = await run([{ type: "click", elementKey: "cta" }], document);
    expect(result.steps[0]).toMatchObject({ status: "stale", message: "no_press_binding:cta" });
  });

  it("fails a violated expectation without stopping the run", async () => {
    const result = await run([
      { type: "expectText", text: "Продолжить" },
      { type: "expectScreen", screenId: "done" },
      { type: "expectText", text: "нет такого текста" },
      { type: "expectState", pointer: "/count", value: 0 },
    ]);
    expect(result.steps.map((step) => step.status)).toEqual(["pass", "fail", "fail", "pass"]);
    expect(result.status).toBe("fail");
    expect(result.failed).toBe(2);
  });

  it("resolves text through templates and repeat items", async () => {
    const result = await run([
      { type: "setState", pointer: "/count", value: 42 },
      { type: "expectText", text: "Всего: 42" },
      { type: "expectText", text: "Второй бонус" },
    ]);
    expect(result.steps.map((step) => step.status)).toEqual(["pass", "pass", "pass"]);
  });

  it("checks disabled props and reports non-disabled elements as failures", async () => {
    const result = await run([
      { type: "expectDisabled", elementKey: "blocked" },
      { type: "expectDisabled", elementKey: "cta" },
      { type: "expectDisabled", elementKey: "gone" },
    ]);
    expect(result.steps.map((step) => step.status)).toEqual(["pass", "fail", "stale"]);
  });

  it("skips invisible elements: a click on a hidden element fails, its text is not found", async () => {
    const document = doc();
    document.screens[0]!.spec.elements.cta!.visible = { $state: "/agreed" };
    const result = await run([
      { type: "expectText", text: "Продолжить" },
      { type: "click", elementKey: "cta" },
      { type: "setState", pointer: "/agreed", value: true },
      { type: "expectText", text: "Продолжить" },
      { type: "click", elementKey: "cta" },
    ], document);
    expect(result.steps.map((step) => step.status)).toEqual(["fail", "fail", "pass", "pass", "pass"]);
  });

  it("rejects an unsafe state pointer through the hardened store", async () => {
    const document = doc();
    const session = new ScenarioSession(document);
    const result = await runScenario([{ type: "setState", pointer: "/items/0/title", value: "x" }], document, { session });
    expect(result.steps[0]!.status).toBe("pass");
    expect(session.errors).toEqual([]);
  });

  it("resolves keys of an expanded composition as ordinary keys", async () => {
    const document = doc();
    // Раскрытие композиции даёт ключи вида `<hostKey>$<innerKey>` — для раннера это
    // обычный ключ раскрытого документа, никакой особой обработки не требуется.
    const elements = document.screens[0]!.spec.elements;
    elements["card$cta"] = { ...elements.cta!, props: { text: "Из композиции" } };
    elements.root!.children = [...elements.root!.children!, "card$cta"];
    const result = await run([
      { type: "click", elementKey: "card$cta" },
      { type: "expectScreen", screenId: "done" },
    ], document);
    expect(result.steps.map((step) => step.status)).toEqual(["pass", "pass"]);
  });

  it("starts at the screen named by a leading expectScreen step", async () => {
    const result = await run([
      { type: "expectScreen", screenId: "done" },
      { type: "expectText", text: "Бонусы начислены" },
    ]);
    expect(result.steps.map((step) => step.status)).toEqual(["pass", "pass"]);
  });
});

/**
 * Дуо-документ (план multi-surface, D12): прогон держит карту «поверхность → экран»,
 * `restart` сбрасывает **обе** поверхности, `expectScreen` сверяется с картой.
 * Контракт шага при этом не меняется — те же `expectScreen`/`click`/`expectText`.
 */
const duoFixture = (await import("../../test/fixtures/duo-pos.json")).default;
const duoDoc = (): PrototypeDoc => prototypeDocSchema.parse(structuredClone(duoFixture));

describe("runScenario on a duo document", () => {
  it("navigates the target surface, keeps the companion and matches expectScreen by surface", async () => {
    const result = await run([
      { type: "expectScreen", screenId: "kso-idle" },
      // Экран второй поверхности — тоже часть картинки: сверка идёт с её панелью.
      { type: "expectScreen", screenId: "app-home" },
      { type: "click", elementKey: "kso-idle-scan" },
      { type: "expectScreen", screenId: "kso-scan" },
      // Оплата на кассе открывает чек в приложении: цель принадлежит второй поверхности.
      { type: "click", elementKey: "kso-scan-pay" },
      { type: "expectScreen", screenId: "app-receipt" },
      // Касса осталась своей панелью на месте — и уже показывает новый статус.
      { type: "expectScreen", screenId: "kso-scan" },
      { type: "expectText", text: "Оплата принята" },
      // Статус пишет касса, читают обе панели.
      { type: "expectText", text: "Статус заказа: Оплачен" },
      { type: "expectState", pointer: "/order/status", value: "paid" },
    ], duoDoc());
    expect(result.steps.map((step) => step.status)).toEqual(Array.from({ length: 10 }, () => "pass"));
    expect(result.status).toBe("pass");
  });

  it("restart resets every surface", async () => {
    const session = new ScenarioSession(duoDoc());
    await session.runtime.dispatch({ action: "navigate", params: { screenId: "app-receipt" } }, { event: "press", payload: undefined, elementId: "x" });
    await session.runtime.dispatch({ action: "navigate", params: { screenId: "kso-done" } }, { event: "press", payload: undefined, elementId: "x" });
    expect(session.screenOfSurface("app")).toBe("app-receipt");
    await session.runtime.dispatch({ action: "restart" }, { event: "press", payload: undefined, elementId: "x" });
    expect(session.screenId).toBe("kso-idle");
    expect(session.screenOfSurface("app")).toBe("app-home");
    expect(session.screenOfSurface("kso")).toBe("kso-idle");
  });

  it("clicks an element of the non-focused panel", async () => {
    const result = await run([
      { type: "expectScreen", screenId: "kso-idle" },
      // Кнопка живёт на панели приложения, фокус — на КСО: панель смонтирована (D11).
      { type: "click", elementKey: "app-home-show" },
      { type: "expectScreen", screenId: "kso-scan" },
    ], duoDoc());
    expect(result.steps.map((step) => step.status)).toEqual(["pass", "pass", "pass"]);
  });
});
