import { describe, expect, test } from "bun:test";
import { ioSignature, normalizedSourceTokens, propsSignature, sourceShingles, structuralFingerprint } from "./fingerprint";
import { PAY_BUTTON_SOURCE, PROMO_CARD_SOURCE, RENAMED_PAY_BUTTON_SOURCE } from "./fixtures/sources";

const jaccard = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
};

describe("propsSignature", () => {
  test("имена отсортированы, required и форма сохранены, additionalProperties классифицирован", () => {
    const signature = propsSignature({
      type: "object",
      properties: { label: { type: "string" }, align: { enum: ["end", "start"] }, disabled: { type: "boolean" } },
      required: ["label"],
      additionalProperties: false,
    });
    expect(signature).toEqual({
      properties: [
        { name: "align", required: false, shape: "enum:end|start" },
        { name: "disabled", required: false, shape: "boolean" },
        { name: "label", required: true, shape: "string" },
      ],
      additionalProperties: "closed",
    });
  });

  test("default/description/title отбрасываются — переформулировка не «чинит» дубликат", () => {
    const base = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
    const decorated = { type: "object", title: "Button", properties: { label: { type: "string", description: "Подпись", default: "Оплатить" } }, required: ["label"] };
    expect(propsSignature(decorated)).toEqual(propsSignature(base));
    expect(propsSignature(base)?.additionalProperties).toBe("open");
  });

  test("не объявленная схема — undefined, а не пустая сигнатура (сигнал неприменим ≠ сигнал пуст)", () => {
    expect(propsSignature(undefined)).toBeUndefined();
    expect(propsSignature("nope")).toBeUndefined();
    expect(propsSignature({ type: "object" })).toEqual({ properties: [], additionalProperties: "open" });
  });

  test("составные формы: массивы, объединения, вложенные объекты", () => {
    const signature = propsSignature({
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: { b: {}, a: {} } } },
        either: { anyOf: [{ type: "number" }, { type: "string" }] },
      },
    });
    expect(signature?.properties.map((property) => property.shape)).toEqual(["union:number|string", "array<object{a,b}>"]);
  });
});

describe("ioSignature", () => {
  test("события и слоты сортируются и дедуплицируются", () => {
    expect(ioSignature(["press", "change", "press"], ["footer", "body"])).toEqual({ events: ["change", "press"], slots: ["body", "footer"] });
  });

  test("отсутствие входа даёт пустые массивы", () => {
    expect(ioSignature(undefined, undefined)).toEqual({ events: [], slots: [] });
  });
});

describe("sourceShingles", () => {
  test("комментарии, пробелы и значения литералов не влияют на отпечаток", () => {
    const noisy = PAY_BUTTON_SOURCE
      .replace('"yp-pay-button"', '"yp-pay-button--wide"')
      .replace("Кнопка оплаты Яндекс Пэй", "Совсем другое описание")
      .replace("export default", "// комментарий перед экспортом\n\n   export default");
    expect([...sourceShingles(noisy)].sort()).toEqual([...sourceShingles(PAY_BUTTON_SOURCE)].sort());
  });

  test("переименование локальных идентификаторов почти не двигает отпечаток", () => {
    // Именно этот кейс спека §10 называет «renamed copy/paste source»: без нормализации
    // локальных имён Jaccard проваливается, и копипаста проходит гейт.
    expect(jaccard(sourceShingles(PAY_BUTTON_SOURCE), sourceShingles(RENAMED_PAY_BUTTON_SOURCE))).toBeGreaterThan(0.8);
  });

  test("JSX-теги и имена атрибутов сохраняются", () => {
    const tokens = normalizedSourceTokens(PAY_BUTTON_SOURCE);
    expect(tokens).toContain("button");
    expect(tokens).toContain("onClick");
    expect(tokens).toContain("className");
    // Локальные биндинги нормализованы: имени компонента в потоке токенов нет.
    expect(tokens).not.toContain("YpPayButton");
    const otherTag = PAY_BUTTON_SOURCE.replace("<button", "<a").replace("</button>", "</a>");
    expect([...sourceShingles(otherTag)].sort()).not.toEqual([...sourceShingles(PAY_BUTTON_SOURCE)].sort());
  });

  test("несвязанный компонент даёт низкое пересечение", () => {
    expect(jaccard(sourceShingles(PAY_BUTTON_SOURCE), sourceShingles(PROMO_CARD_SOURCE))).toBeLessThan(0.3);
  });

  test("битый исходник не бросает, пустой даёт пустое множество", () => {
    expect(() => sourceShingles("export default function ( {{{ ")).not.toThrow();
    expect(sourceShingles("").size).toBe(0);
  });

  test("исходник короче k даёт один шингл", () => {
    expect(sourceShingles("a;").size).toBe(1);
  });
});

describe("structuralFingerprint", () => {
  const meta = { propsJsonSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] }, events: ["press"], slots: [], atomicLevel: "molecule", scope: "primitive" };

  test("равен при отличии только в описательных полях схемы", () => {
    const decorated = { ...meta, propsJsonSchema: { type: "object", title: "X", properties: { label: { type: "string", default: "Оплатить" } }, required: ["label"] } };
    expect(structuralFingerprint(decorated)).toBe(structuralFingerprint(meta));
  });

  test("различается при смене типа пропа, состава событий, уровня и scope", () => {
    const base = structuralFingerprint(meta);
    expect(structuralFingerprint({ ...meta, propsJsonSchema: { type: "object", properties: { label: { type: "number" } }, required: ["label"] } })).not.toBe(base);
    expect(structuralFingerprint({ ...meta, events: ["press", "change"] })).not.toBe(base);
    expect(structuralFingerprint({ ...meta, atomicLevel: "organism" })).not.toBe(base);
    expect(structuralFingerprint({ ...meta, scope: "section" })).not.toBe(base);
  });

  test("без объявленной схемы props отпечатка нет — иначе два безпропсовых компонента блокировали бы друг друга", () => {
    expect(structuralFingerprint({ events: [], slots: [] })).toBeUndefined();
  });

  // Калибровка на проде (docs/audit/2026-07-31-matcher-calibration.md, замер 5) нашла пару
  // `yp-no-pay-card-info ↔ yp-separator`: у обоих схема объявлена, но пуста, и отпечаток
  // блокировал их друг об друга без порога. Пустая схема равнозначна отсутствующей.
  test("пустая схема без событий и слотов не даёт отпечатка", () => {
    const empty = { type: "object", properties: {} };
    expect(structuralFingerprint({ propsJsonSchema: empty, events: [], slots: [], atomicLevel: "atom" })).toBeUndefined();
    expect(structuralFingerprint({ propsJsonSchema: { type: "object" }, events: [], slots: [] })).toBeUndefined();
  });

  test("одного события или слота уже достаточно, чтобы отпечаток различал", () => {
    const empty = { type: "object", properties: {} };
    expect(structuralFingerprint({ propsJsonSchema: empty, events: ["press"], slots: [] })).toBeDefined();
    expect(structuralFingerprint({ propsJsonSchema: empty, events: [], slots: ["footer"] })).toBeDefined();
  });
});
