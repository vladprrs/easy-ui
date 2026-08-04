import { describe, expect, it } from "vitest";
import { acceptanceBadge, componentStatusBadge, prototypeStatusBadge } from "./statusBadge";

describe("componentStatusBadge", () => {
  it("renders no badge for active and lifecycle-internal statuses", () => {
    expect(componentStatusBadge("active")).toBeNull();
    expect(componentStatusBadge("staging")).toBeNull();
    expect(componentStatusBadge("failed")).toBeNull();
  });

  it("renders a coloured badge for the terminal statuses", () => {
    expect(componentStatusBadge("deprecated")).toMatchObject({ label: "Устаревший", title: "Устаревший" });
    expect(componentStatusBadge("superseded")).toMatchObject({ label: "Заменён" });
    expect(componentStatusBadge("rejected")).toMatchObject({ label: "Отклонён" });
    expect(componentStatusBadge("archived")).toMatchObject({ label: "В архиве" });
  });

  it("carries the reason into the title when provided", () => {
    expect(componentStatusBadge("rejected", "  unsafe code  ")).toMatchObject({ title: "Отклонён: unsafe code" });
    expect(componentStatusBadge("deprecated", "   ")?.title).toBe("Устаревший");
  });
});

// Признак приёмки (RFC candidate-acceptance §7, волна R3c): отдельный от жизненного цикла версии
// и от визуального `verified`. Пока приёмка не наполнена, бейдж не рисуется вовсе — «не принят»
// на каждой карточке был бы шумом, а не информацией.
describe("acceptanceBadge", () => {
  it("renders only for an accepted entry", () => {
    expect(acceptanceBadge({ accepted: false })).toBeNull();
    expect(acceptanceBadge({ accepted: true })).toMatchObject({
      label: "Принят",
      title: "Активная версия опубликована через приёмку: за ней стоит пройденный acceptance-run",
    });
  });
});

describe("prototypeStatusBadge", () => {
  it("maps every visibility status to a Russian badge", () => {
    expect(prototypeStatusBadge("private")).toMatchObject({ label: "Личный", title: "Личный" });
    expect(prototypeStatusBadge("published")).toMatchObject({ label: "Общий", title: "Общий" });
    expect(prototypeStatusBadge("archived")).toMatchObject({ label: "В архиве", title: "В архиве" });
  });
});
