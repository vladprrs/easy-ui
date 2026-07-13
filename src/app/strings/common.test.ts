import { describe, expect, it } from "vitest";
import { formatApiError, pluralRu, screensCount } from "./common";

describe("pluralRu / screensCount", () => {
  it("picks the right Russian plural form", () => {
    expect(screensCount(1)).toBe("1 экран");
    expect(screensCount(2)).toBe("2 экрана");
    expect(screensCount(5)).toBe("5 экранов");
    expect(screensCount(11)).toBe("11 экранов");
    expect(screensCount(21)).toBe("21 экран");
    expect(screensCount(104)).toBe("104 экрана");
    expect(pluralRu(3, ["узел", "узла", "узлов"])).toBe("узла");
  });
});

describe("formatApiError", () => {
  it("maps known server codes to Russian messages", () => {
    expect(formatApiError("prototype_not_found")).toBe("Прототип не найден");
    expect(formatApiError("version_not_found")).toBe("Версия не найдена");
    expect(formatApiError("revision_not_found")).toBe("Ревизия не найдена");
    expect(formatApiError("already_published")).toBe("Эта ревизия уже опубликована");
    expect(formatApiError("validation_failed")).toBe("Документ не прошёл валидацию");
    expect(formatApiError("conflict")).toBe("Конфликт изменений");
    expect(formatApiError("queue_full")).toContain("Очередь скриншотов");
  });

  it("interpolates the current revision into conflict messages", () => {
    expect(formatApiError("revision_conflict", { currentRev: 7 })).toBe("Конфликт изменений — текущая ревизия: 7");
    expect(formatApiError("version_conflict", { currentVersion: 3 })).toBe("Конфликт изменений — текущая версия: 3");
    expect(formatApiError("revision_conflict")).toBe("Конфликт изменений — данные уже обновлены кем-то другим");
  });

  it("falls back for unknown codes, keeping the code and server message", () => {
    expect(formatApiError("weird_code")).toBe("Ошибка API (weird_code)");
    expect(formatApiError("weird_code", { status: 500, message: "boom" })).toBe("Ошибка API (weird_code, HTTP 500): boom");
  });
});
