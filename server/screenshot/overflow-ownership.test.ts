/**
 * BR-09 (план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §9): извлечение деклараций владения
 * переливом из документа снимаемого экрана — probe-интеграция.
 *
 * Предмет — ровно шов «документ → джоба → сбор»: сбор находит владельца по `data-eui-key`, то есть
 * по **ключу элемента**, и второго реестра адресов у волны нет. Оба пути авторинга (элементное поле
 * авторского документа и prop, в который композиция компилирует свой layout-токен) обязаны
 * приезжать одной картой: иначе declaration работала бы у одного автора и молчала у другого.
 */
import { expect, test } from "bun:test";
import { overflowOwnersOf } from "./service";

const doc = (elements: Record<string, unknown>) => ({
  screens: [
    { id: "other", spec: { root: "a", elements: { a: { type: "YpBox", props: {} } } } },
    { id: "home", spec: { root: "root", elements } },
  ],
});

test("BR-09: декларации читаются из элементного поля и из composition-prop'а одинаково", () => {
  const owners = overflowOwnersOf(doc({
    "rail-a": { type: "YpBox", props: {}, overflowOwnership: { axis: "x", mode: "scroll" } },
    "rail-b": { type: "YpBox", props: { overflowOwnership: { axis: "x", mode: "scroll", expectedContentOverflow: true } } },
    plain: { type: "YpBox", props: {} },
  }), "home");
  expect(owners).toEqual({
    "rail-a": { axis: "x", mode: "scroll" },
    "rail-b": { axis: "x", mode: "scroll", expectedContentOverflow: true },
  });
});

test("BR-09: документ без деклараций отдаёт «владельцев нет», а не пустую карту", () => {
  // Пустая карта и её отсутствие — разные джобы: первая положила бы в постановку ключ, которого
  // доволновая джоба не несла, и замер перестал бы быть байт-в-байт прежним.
  expect(overflowOwnersOf(doc({ root: { type: "YpBox", props: {} } }), "home")).toBeUndefined();
  expect(overflowOwnersOf(doc({}), "missing")).toBeUndefined();
  expect(overflowOwnersOf({}, "home")).toBeUndefined();
});
