import { expect, test } from "bun:test";
import type { AcceptanceCase } from "./cases";
import {
  CASE_FINGERPRINT_ALGO_VERSION, COMPARISON_PAINT_MARGIN_PX, FIELD_LAYERS,
  caseFingerprintsOf, comparisonFingerprintOf, frameFingerprint, readinessPolicyHashOf,
  verdictPolicyHashOf, verdictPolicySnapshotOf,
  type CaseSurface, type LayeredField,
} from "./ids";
import { ACCEPTANCE_POLICIES, withRequiredVisual, type AcceptancePolicy } from "./policies";
import { rendererFingerprint } from "../capture/renderer";

/**
 * Трёхслойный отпечаток случая (план `docs/plans/2026-08-04-acceptance-pipeline-feedback.md`,
 * решение D-B, волна W1).
 *
 * Предмет файла — **алгебра идентичности**, а не поведение раннера: какой вход в какой слой
 * входит и что именно инвалидирует. Дыра, ради которой слои и заводились (порог политики внутри
 * плоского `case_fingerprint` ⇒ смена одного числа роняет весь накопленный reuse), проверяется
 * здесь на уровне хэшей, а её продуктовые следствия — в `orchestrator.test.ts`.
 */

const SURFACE: CaseSurface = { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" };
const CANDIDATE = `cand_${"0".repeat(64)}`;
const ASSET_A = `asset_${"a".repeat(64)}`;
const ASSET_B = `asset_${"b".repeat(64)}`;
const DEFAULT = ACCEPTANCE_POLICIES["default-v1"];

const fingerprints = (
  item: Parameters<typeof caseFingerprintsOf>[0]["case"],
  policy: AcceptancePolicy = DEFAULT,
) => caseFingerprintsOf({ candidateId: CANDIDATE, surface: SURFACE, policy, case: item });

const PLAIN = { caseKey: "alpha", propsHash: "props-1" };

// ------------------------------------------------------- версия алгоритма

test("версия алгоритма отпечатка случая === 7 (кадр может содержать запинованных детей слотов)", () => {
  // Литерал, а не ссылка на константу: тест обязан падать при **любом** изменении значения, в том
  // числе случайном. Bump 5→6 санкционирован планом 2026-08-04 (D-B), 6→7 — планом 2026-08-05 (§A4):
  // модель случая расширилась слотами, и накопленные вердикты сняты без знания о детях.
  expect(CASE_FINGERPRINT_ALGO_VERSION).toBe(7);
});

// ------------------------------------------------------------ слои и дельты

test("порог политики меняет вердиктный слой и итоговый отпечаток, но не кадр и не сравнение", () => {
  // Ровно тот случай из фидбэка (P0-3): «поменяли порог — пересняли 25 кадров». Порог обязан
  // менять вердиктный слой и только его; кадр и эталон к порогу отношения не имеют.
  const stricter: AcceptancePolicy = { ...DEFAULT, visual: { ...DEFAULT.visual, maxRawDiffPct: 0.1 } };
  const before = fingerprints(PLAIN);
  const after = fingerprints(PLAIN, stricter);

  expect(after.frame).toBe(before.frame);
  expect(after.comparison).toBe(before.comparison);
  expect(after.verdictPolicy).not.toBe(before.verdictPolicy);
  expect(after.case).not.toBe(before.case);
});

test("per-case допуск случая ведёт себя как порог профиля: только вердиктный слой", () => {
  const before = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A });
  const after = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, casePolicy: { maxRawDiffPct: 0.25 } });
  expect(after.frame).toBe(before.frame);
  expect(after.comparison).toBe(before.comparison);
  expect(after.verdictPolicy).not.toBe(before.verdictPolicy);
});

test("смена эталона меняет слой сравнения, но не кадр (анти-репро C0)", () => {
  // Инвариант, ради которого re-diff отделён от recompute: новый эталон обязан быть **измерен**
  // заново, а не пересчитан арифметически по метрикам старого сравнения.
  const before = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A });
  const after = fingerprints({ ...PLAIN, referenceAssetId: ASSET_B });
  expect(after.frame).toBe(before.frame);
  expect(after.comparison).not.toBe(before.comparison);
  expect(after.verdictPolicy).toBe(before.verdictPolicy);
});

test("cropLineage — вход сравнения: его смена не трогает кадр", () => {
  const before = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, cropLineage: { rect: [0, 0, 24, 20] } });
  const after = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, cropLineage: { rect: [0, 0, 24, 12] } });
  expect(after.frame).toBe(before.frame);
  expect(after.comparison).not.toBe(before.comparison);
});

test("expectedGeometry — двухслойное поле (D1): и сравнение, и вердикт", () => {
  // Оно определяет и допуск геометрии, и (с W5) `padTo` нормализации content-hug эталона. Поэтому
  // его смена обязана уводить визуал в re-diff, а не в пересчёт по старым метрикам.
  const before = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, expectedGeometry: { width: 140, height: 96 } });
  const after = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, expectedGeometry: { width: 141, height: 96 } });
  expect(after.frame).toBe(before.frame);
  expect(after.comparison).not.toBe(before.comparison);
  expect(after.verdictPolicy).not.toBe(before.verdictPolicy);
  expect(FIELD_LAYERS.expectedGeometry).toEqual(["comparison", "verdict"]);
});

test("props, поверхность и readiness-политика — кадровый слой", () => {
  const before = fingerprints(PLAIN);
  expect(fingerprints({ ...PLAIN, propsHash: "props-2" }).frame).not.toBe(before.frame);
  expect(caseFingerprintsOf({
    candidateId: CANDIDATE, surface: { ...SURFACE, dsf: 1 }, policy: DEFAULT, case: PLAIN,
  }).frame).not.toBe(before.frame);
  // `pixel-strict-v1` несёт строгую readiness — она входит в кадр, и её смена честно требует
  // пересъёмки (в отличие от порогов того же профиля).
  expect(fingerprints(PLAIN, ACCEPTANCE_POLICIES["pixel-strict-v1"]).frame).not.toBe(before.frame);
});

test("`--policy` инвалидирует reuse и на examples-, и на case-set-пути (C8)", () => {
  // До этой волны examples-путь хэшировал заглушку `CASE_POLICY_HASH_V0`, а case-set-путь — профиль
  // **из манифеста**, а не рана: strict-ран переиспользовал вердикты мягкого профиля на обоих.
  const examples = { caseKey: "alpha", propsHash: "props-1" };
  const caseSetCase = {
    caseKey: "alpha", propsHash: "props-1", referenceAssetId: ASSET_A,
    casePolicy: { maxRawDiffPct: 1 }, declaredPolicyProfile: "default-v1",
  };
  for (const item of [examples, caseSetCase]) {
    const soft = fingerprints(item);
    const strict = fingerprints(item, ACCEPTANCE_POLICIES["pixel-strict-v1"]);
    expect(strict.verdictPolicy).not.toBe(soft.verdictPolicy);
    expect(strict.case).not.toBe(soft.case);
  }
});

test("requireVisual набора меняет вердиктный слой, а не кадр (W5a-инвариант остаётся)", () => {
  const soft = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A });
  const hard = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A }, withRequiredVisual(DEFAULT));
  expect(hard.frame).toBe(soft.frame);
  expect(hard.comparison).toBe(soft.comparison);
  expect(hard.verdictPolicy).not.toBe(soft.verdictPolicy);
});

test("maxDimensionDeltaPx — вход сравнения, а не вердикта: он решает, состоится ли сравнение", () => {
  const before = comparisonFingerprintOf({
    referenceAssetId: ASSET_A, expectedGeometry: null, maxDimensionDeltaPx: 8,
    paintMarginPx: COMPARISON_PAINT_MARGIN_PX, deviceScaleFactor: 2,
  });
  const after = comparisonFingerprintOf({
    referenceAssetId: ASSET_A, expectedGeometry: null, maxDimensionDeltaPx: 4,
    paintMarginPx: COMPARISON_PAINT_MARGIN_PX, deviceScaleFactor: 2,
  });
  expect(after).not.toBe(before);
});

test("W5-слоты канонизуются отсутствием: незаполненные поля не двигают отпечаток legacy-манифестов", () => {
  // D18/C6: W5 добавит `referenceSurface`/`referencePlacement`/`cropLineage.sourceSurface`. Пока
  // их никто не заполняет, отпечаток обязан совпадать с «полем нет вовсе» — иначе выкатка W5
  // молча инвалидировала бы весь прод-кэш.
  const bare = comparisonFingerprintOf({
    referenceAssetId: ASSET_A, maxDimensionDeltaPx: 8, paintMarginPx: 64, deviceScaleFactor: 2,
  });
  const explicitUndefined = comparisonFingerprintOf({
    referenceAssetId: ASSET_A, referenceSurface: null, referencePlacement: null, cropLineage: null,
    expectedGeometry: null, maxDimensionDeltaPx: 8, paintMarginPx: 64, deviceScaleFactor: 2,
  });
  expect(explicitUndefined).toBe(bare);
  const filled = comparisonFingerprintOf({
    referenceAssetId: ASSET_A, referenceSurface: "content-hug",
    maxDimensionDeltaPx: 8, paintMarginPx: 64, deviceScaleFactor: 2,
  });
  expect(filled).not.toBe(bare);
});

test("W5: нормализация content-hug эталона форсирует re-diff, а не recompute (C12)", () => {
  // C0/C12/D1: `referenceSurface`, `referencePlacement` и `cropLineage.sourceSurface` участвуют в
  // построении нормализованного эталона, значит их смена меняет **метрики**, а не только вердикт.
  // Промах обязан приходиться на слой сравнения: кадр цел (re-diff), но старый rawDiffPct мёртв.
  const paint = { ...PLAIN, referenceAssetId: ASSET_A, expectedGeometry: { width: 136, height: 32 } };
  const base = fingerprints(paint);

  const hug = fingerprints({ ...paint, referenceSurface: "content-hug" });
  expect(hug.frame).toBe(base.frame);
  expect(hug.verdictPolicy).toBe(base.verdictPolicy);
  expect(hug.comparison).not.toBe(base.comparison);
  expect(hug.case).not.toBe(base.case);

  const placed = fingerprints({ ...paint, referenceSurface: "content-hug", referencePlacement: { x: 128, y: 128 } });
  expect(placed.frame).toBe(base.frame);
  expect(placed.verdictPolicy).toBe(base.verdictPolicy);
  expect(placed.comparison).not.toBe(hug.comparison);

  // `sourceSurface` решает, режется эталон или нет, — то есть с чем именно сравнивают.
  const lineage = { rect: [20, 10, 136, 32] as const };
  const cropped = fingerprints({ ...paint, cropLineage: { ...lineage } });
  const provenanceOnly = fingerprints({ ...paint, cropLineage: { ...lineage, sourceSurface: "content-hug" } });
  expect(provenanceOnly.frame).toBe(cropped.frame);
  expect(provenanceOnly.comparison).not.toBe(cropped.comparison);
});

test("W5: поля content-hug классифицированы как comparison, а не как кадр", () => {
  const layerOf = (field: LayeredField): readonly string[] => (FIELD_LAYERS as Record<string, readonly string[]>)[field]!;
  expect(layerOf("referenceSurface")).toEqual(["comparison"]);
  expect(layerOf("referencePlacement")).toEqual(["comparison"]);
});

test("§W4: matte и textAaBudget доезжают до comparisonFingerprint (а не только до FIELD_LAYERS)", () => {
  // Дифференциальная проверка стоит на `caseFingerprintsOf` намеренно (V5): тотальность
  // `FIELD_LAYERS` доказывает лишь объявленный слой, но не то, что поле доехало до пре-образа
  // хэша, — а «классифицировано как comparison, но кадр/сравнение не двигает» и есть тихий stale.
  const paint = { ...PLAIN, referenceAssetId: ASSET_A };
  const base = fingerprints(paint);

  const matte = fingerprints({ ...paint, comparison: { matte: "#ffffff" } });
  expect(matte.frame).toBe(base.frame);
  expect(matte.verdictPolicy).toBe(base.verdictPolicy);
  expect(matte.comparison).not.toBe(base.comparison);
  expect(matte.case).not.toBe(base.case);
  // Другой цвет — другое сравнение: matte это вход диффа, а не булев тумблер.
  expect(fingerprints({ ...paint, comparison: { matte: "#000000" } }).comparison).not.toBe(matte.comparison);
  // `"none"` — объявленное «не матировать»: манифест другой, значит и отпечаток честно другой.
  expect(fingerprints({ ...paint, comparison: { matte: "none" } }).comparison).not.toBe(base.comparison);

  // Пресет — двухслойный: он и вход сравнения (требует edgeResidual), и вход вердикта.
  const preset = fingerprints({ ...paint, textAaBudget: "live-text-v1" });
  expect(preset.frame).toBe(base.frame);
  expect(preset.comparison).not.toBe(base.comparison);
  expect(preset.verdictPolicy).not.toBe(base.verdictPolicy);
  expect(preset.verdictPolicySnapshot.textAaBudget).toBe("live-text-v1");

  // Инвариант неизменности: случай без новых полей — байт-в-байт прежние слои и прежний ключ.
  expect(fingerprints(paint)).toEqual(base);
  expect(base.verdictPolicySnapshot.textAaBudget).toBeUndefined();
  const layerOf = (field: LayeredField): readonly string[] => (FIELD_LAYERS as Record<string, readonly string[]>)[field]!;
  expect(layerOf("comparison")).toEqual(["comparison"]);
  expect(layerOf("textAaBudget")).toEqual(["comparison", "verdict"]);
});

// ------------------------------------------------------------- слоты (§A4)

/**
 * Дети слотов (план `docs/plans/2026-08-05-slot-acceptance.md` §A4).
 *
 * Все дифференциальные проверки стоят на уровне `caseFingerprintsOf`, а не `frameFingerprint`:
 * тотальность `FIELD_LAYERS` доказывает лишь то, что слой у поля объявлен, — забыть протащить
 * поле через `CaseFingerprintCase`/`caseFingerprintsOf` она не мешает, и именно этот молчаливый
 * пропуск ловят тесты ниже.
 */
const CHILD = {
  slot: "content", index: 0, componentId: "cmp_child", version: 3,
  bundleHash: "bundle-a", propsHash: "child-props-1",
};
const SECOND_CHILD = { ...CHILD, index: 1, componentId: "cmp_second", bundleHash: "bundle-b", propsHash: "child-props-2" };

/**
 * Golden кадрового отпечатка, снятый на **до-слотовом** HEAD (e3a93fc) и зафиксированный планом
 * (§«Design invariants»). Литерал, а не пересчёт: значение, вычисленное после изменения,
 * доказывало бы только само себя.
 *
 * **Сдвиг golden'а 2026-08-06 (план `2026-08-06-feedback-3-platform-capabilities.md` §1.3, W2) —
 * единственный санкционированный.** Волна W2 поменяла семантику измерения `layoutBounds` (живой
 * текст входит в контур, клипнутое поддерево режется окном клипа), и кадры прежней семантики
 * переиспользовать нельзя: вердикт геометрии сравнивал бы измерения из разных миров.
 * `CASE_FINGERPRINT_ALGO_VERSION` для этого не годится — он в `frameFingerprint` не входит
 * (находка F1), поэтому инвалидация сделана кадровым полем `geometryContractVersion`.
 *
 * `GOLDEN_FRAME_V1` — тот самый до-W2 литерал: он никуда не делся, а стал значением при
 * `geometryContractVersion = 1`. Пара литералов доказывает, что сдвиг вызван ровно версией
 * контракта, а не случайной правкой состава пре-образа.
 */
const GOLDEN_FRAME_INPUT = {
  candidateId: "cand_golden-fixture",
  caseKey: "alpha",
  propsHash: "props-1",
  surface: { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" },
  readinessPolicyHash: "readiness-fixture",
  rendererFingerprint: "renderer-fixture",
} as const;
const GOLDEN_FRAME_V1 = "f29b0c498389404e5e426486bbb6050add243c6c0d97eff579ef127ec9fabeb1";
const GOLDEN_FRAME = "668e2b2bcaf8dadbe17b49edd772e6b6238998481326cc0cbe318cc3cd25966f";

test("§W2: geometryContractVersion — кадровый вход, и он двигает кадр", () => {
  // 1. Версия 1 воспроизводит до-W2 golden байт-в-байт: состав пре-образа не тронут, поле кладётся
  //    условным спредом, поэтому «версии нет» и «версия 1» — один и тот же хэш.
  expect(frameFingerprint(GOLDEN_FRAME_INPUT, 1)).toBe(GOLDEN_FRAME_V1);
  // 2. Рабочее значение (2) даёт другой кадр — то есть пересъёмку, а не тихий перенос вердикта на
  //    новую семантику layoutBounds.
  expect(frameFingerprint(GOLDEN_FRAME_INPUT)).not.toBe(GOLDEN_FRAME_V1);
  // 3. Дифференциальный инвариант на будущее: любая смена версии обязана двигать кадр.
  expect(frameFingerprint(GOLDEN_FRAME_INPUT, 3)).not.toBe(frameFingerprint(GOLDEN_FRAME_INPUT, 2));
  // 4. ALGO не участвует: инвалидация кадра стоит на своём поле (F1), а не на версии case-схемы.
  expect(CASE_FINGERPRINT_ALGO_VERSION).toBe(7);
});

test("слоты байт-нейтральны для случая без слотов: кадр === golden до-слотового HEAD", () => {
  // Фикстура golden'а несёт синтетические `readinessPolicyHash`/`rendererFingerprint`, которые
  // `caseFingerprintsOf` выводит из политики и подменить не даёт, поэтому сам литерал проверяется
  // на `frameFingerprint`. Связка с рабочим путём — второй половиной теста: `caseFingerprintsOf`
  // для slot-free случая собирает **ровно тот же объект входа** (без ключа `slotBindings`), значит
  // байт-нейтральность golden'а распространяется и на него.
  expect(frameFingerprint(GOLDEN_FRAME_INPUT)).toBe(GOLDEN_FRAME);

  const readinessHash = readinessPolicyHashOf(DEFAULT.readiness);
  expect(fingerprints(PLAIN).frame).toBe(frameFingerprint({
    candidateId: CANDIDATE, caseKey: PLAIN.caseKey, propsHash: PLAIN.propsHash, surface: SURFACE,
    readinessPolicyHash: readinessHash, rendererFingerprint: rendererFingerprint(readinessHash),
  }));

  // Негатив: случай **со** слотами обязан уехать с golden'а — иначе поле не доехало до хэша.
  expect(frameFingerprint({ ...GOLDEN_FRAME_INPUT, slotBindings: [CHILD] })).not.toBe(GOLDEN_FRAME);
});

test("slotBindings доезжают до кадра через caseFingerprintsOf (а не только до FIELD_LAYERS)", () => {
  const bare = fingerprints(PLAIN);
  const withSlots = fingerprints({ ...PLAIN, slotBindings: [CHILD] });
  expect(withSlots.frame).not.toBe(bare.frame);
  // Слой — кадровый: сравнение и вердикт дети не трогают, значит смена состава слотов уводит в
  // пересъёмку, а не в re-diff.
  expect(withSlots.comparison).toBe(bare.comparison);
  expect(withSlots.verdictPolicy).toBe(bare.verdictPolicy);
  expect(withSlots.case).not.toBe(bare.case);
  expect(FIELD_LAYERS.slotBindings).toEqual(["frame"]);
});

test("кадр двигает одна лишь смена bundleHash ребёнка", () => {
  // Пин ребёнка — про пиксели: пересобранный бандл той же версии рисует иначе, и переиспользовать
  // кадр нельзя, хотя имя, версия и props ребёнка не изменились.
  const before = fingerprints({ ...PLAIN, slotBindings: [CHILD] });
  const after = fingerprints({ ...PLAIN, slotBindings: [{ ...CHILD, bundleHash: "bundle-rebuilt" }] });
  expect(after.frame).not.toBe(before.frame);
});

test("кадр двигает один лишь порядок детей", () => {
  // Тот же набор детей в другом порядке — другая картинка. Хэш массива обязан быть
  // позиционно-чувствительным, а не множественным.
  const forward = fingerprints({ ...PLAIN, slotBindings: [CHILD, SECOND_CHILD] });
  const reversed = fingerprints({
    ...PLAIN,
    slotBindings: [{ ...SECOND_CHILD, index: 0 }, { ...CHILD, index: 1 }],
  });
  expect(reversed.frame).not.toBe(forward.frame);
});

test("`slotBindings: []` нормализуется в отсутствие поля", () => {
  // Контракт `AcceptanceCase` — «отсутствует, а не пусто», но `canonicalStringify` выбрасывает
  // только `undefined`: пустой массив прошёл бы в пре-образ и молча инвалидировал бы весь reuse
  // slot-free наборов. Нормализация живёт в `frameFingerprint` — единственной точке, через которую
  // поле попадает в хэш, поэтому нарушителю контракта вверх по стеку она тоже помогает.
  expect(fingerprints({ ...PLAIN, slotBindings: [] }).frame).toBe(fingerprints(PLAIN).frame);
  expect(frameFingerprint({ ...GOLDEN_FRAME_INPUT, slotBindings: [] })).toBe(GOLDEN_FRAME);
});

test("§W6: вложенные дети байт-нейтральны для depth-1 и двигают кадр сами по себе", () => {
  // Голден depth-1, снятый на коде ДО волны вложенности: `children` обязан попадать в пре-образ
  // только условным спредом, иначе волна тихо инвалидировала бы каждый прод-кадр со слотами.
  // Пара литералов, как и у slot-free golden'а: версия 1 — снимок до-W2 кода, версия по умолчанию —
  // тот же вход после сдвига `geometryContractVersion` (§1.3). Ключа `children` в пре-образе нет
  // ни там, ни там — это и доказывает байт-нейтральность самой волны вложенности.
  const DEPTH1 = {
    ...GOLDEN_FRAME_INPUT,
    slotBindings: [
      { slot: "header", index: 0, componentId: "c1", version: 1, bundleHash: "bh1", propsHash: "ph1" },
      { slot: "default", index: 0, componentId: "c2", version: 2, bundleHash: "bh2", propsHash: "ph2" },
    ],
  };
  expect(frameFingerprint(DEPTH1, 1)).toBe("e08725f5606cf36f9fe03a1dddb082c7f2f5aeb268968faf7e8cde3668d8aaf6");
  expect(frameFingerprint(DEPTH1)).toBe("b45c3e3993d2acbf7e7b7fa30837876615aeed6fd31968fc64fa2b36dd072683");

  // Пустое поддерево — «отсутствует, а не пусто».
  expect(fingerprints({ ...PLAIN, slotBindings: [{ ...CHILD, children: [] }] }).frame)
    .toBe(fingerprints({ ...PLAIN, slotBindings: [CHILD] }).frame);

  // Одно лишь появление внука двигает кадр, а его bundleHash — тоже.
  const grandchild = { ...SECOND_CHILD, slot: "action", index: 0 };
  const flat = fingerprints({ ...PLAIN, slotBindings: [CHILD] });
  const nested = fingerprints({ ...PLAIN, slotBindings: [{ ...CHILD, children: [grandchild] }] });
  expect(nested.frame).not.toBe(flat.frame);
  expect(nested.comparison).toBe(flat.comparison);
  const rebuilt = fingerprints({ ...PLAIN, slotBindings: [{ ...CHILD, children: [{ ...grandchild, bundleHash: "bundle-rebuilt" }] }] });
  expect(rebuilt.frame).not.toBe(nested.frame);
  // Внук в слоте ребёнка ≠ второй ребёнок того же слота: это разные картинки.
  expect(fingerprints({ ...PLAIN, slotBindings: [CHILD, grandchild] }).frame).not.toBe(nested.frame);
});

test("расчёт отпечатков детерминирован и собирается из своих же слоёв", () => {
  const item = { ...PLAIN, referenceAssetId: ASSET_A };
  const first = fingerprints(item);
  const second = fingerprints(item);
  expect(second).toEqual(first);
  const readinessHash = readinessPolicyHashOf(DEFAULT.readiness);
  expect(first.frame).toBe(frameFingerprint({
    candidateId: CANDIDATE, caseKey: item.caseKey, propsHash: item.propsHash, surface: SURFACE,
    readinessPolicyHash: readinessHash,
    rendererFingerprint: rendererFingerprint(readinessHash),
  }));
  expect(first.verdictPolicy).toBe(verdictPolicyHashOf(verdictPolicySnapshotOf(DEFAULT, item)));
  expect(first.verdictPolicySnapshot.maxRawDiffPct).toBe(DEFAULT.visual.maxRawDiffPct);
});

// --------------------------------------------- тотальность разбиения (D3)

/**
 * Полный набор полей случая. `Required<AcceptanceCase>` — не украшение: новое поле в
 * `AcceptanceCase` **не соберётся**, пока не появится здесь, а появившись — попадёт в проверку
 * ниже и потребует классификации в `FIELD_LAYERS`.
 */
const CASE_SAMPLE: Required<AcceptanceCase> = {
  caseId: "alpha",
  caseKey: "alpha",
  props: {},
  propsHash: "props-1",
  aliasOfCaseId: null,
  referenceAssetId: null,
  expectedGeometry: null,
  casePolicyHash: "case-policy-v0",
  declaredPolicyProfile: null,
  casePolicy: {},
  cropLineage: { rect: [0, 0, 1, 1] },
  // W5: content-hug reference. Оба поля — входы построения нормализованного эталона, значит
  // comparison по инварианту D1 (проверка слоя — тестом ниже).
  referenceSurface: "paint",
  referencePlacement: { x: 0, y: 0 },
  // W4: контракт сравнения (matte) и именованный пресет растрового текста.
  comparison: {},
  textAaBudget: "live-text-v1",
  dims: {},
  geometryDetailKeys: [],
  // §A4: дети слотов — кадровый слой, их хэш — производная (report-only). В боевом случае оба поля
  // либо отсутствуют, либо непусты; здесь это лишь образец полноты типа.
  slotBindings: [],
  slotsHash: "slots-hash",
  // W1a (план 2026-08-07): поверхности геометрии. Двухслойное поле с расщеплением по под-полям,
  // `comparisonSurface` — чистое сравнение, `clipExpectation` — чистый вердикт (проверки ниже).
  expectedSurfaces: {},
  comparisonSurface: "layoutUnion",
  clipExpectation: "root-does-not-clip-layout",
};

test("каждое поле политики, случая и поверхности классифицировано по слоям (D3)", () => {
  const policyFields = Object.keys(DEFAULT).flatMap((key) => (
    key === "visual" || key === "geometry"
      ? Object.keys(DEFAULT[key as "visual" | "geometry"]).map((leaf) => `${key}.${leaf}`)
      : [key]
  ));
  const fields = [
    ...policyFields,
    ...Object.keys(CASE_SAMPLE),
    ...Object.keys(SURFACE).map((key) => `surface.${key}`),
  ];
  const layers = FIELD_LAYERS as Record<string, readonly string[]>;
  const unclassified = fields.filter((field) => layers[field] === undefined);
  // Неклассифицированное поле — это тихий stale-reuse: оно меняет случай, но не меняет ни один
  // отпечаток. Поэтому тест падает на **самом факте** пропуска, а не на его последствии.
  expect(unclassified).toEqual([]);

  for (const value of Object.values(layers)) {
    expect(value.length).toBeGreaterThan(0);
    // `report-only` — обоснованное «нигде», и оно не смешивается со слоями: поле либо влияет,
    // либо нет, третьего не бывает.
    if (value.includes("report-only")) expect(value).toEqual(["report-only"]);
  }
});

test("классификация не даёт полю сравнения уехать в кадр и наоборот", () => {
  const layerOf = (field: LayeredField): readonly string[] => (FIELD_LAYERS as Record<string, readonly string[]>)[field]!;
  expect(layerOf("referenceAssetId")).toEqual(["comparison"]);
  expect(layerOf("cropLineage")).toEqual(["comparison"]);
  expect(layerOf("visual.maxDimensionDeltaPx")).toEqual(["comparison"]);
  expect(layerOf("visual.maxRawDiffPct")).toEqual(["verdict"]);
  expect(layerOf("readiness")).toEqual(["frame"]);
  expect(layerOf("propsHash")).toEqual(["frame"]);
});


// ------------------------------------------- поверхности геометрии (W1a, план 2026-08-07)

const SURFACES = {
  root: { width: 343, height: 88 },
  layoutUnion: { width: 480, height: 88 },
  paint: { width: 486, height: 92 },
  referenceExport: { width: 367, height: 88 },
} as const;

test("W1a: доволновой случай байт-в-байт — ни один слой не сдвинут", () => {
  // Инвариант N3: нормализация `expectedGeometry → {layoutUnion}` живёт в потребителе и до хэшей не
  // доезжает. Промах здесь означал бы вердиктный каскад по **всему** накопленному корпусу.
  const legacy = { ...PLAIN, referenceAssetId: ASSET_A, expectedGeometry: { width: 480, height: 88 } };
  const before = fingerprints(legacy);
  expect(fingerprints({ ...legacy, expectedSurfaces: undefined, comparisonSurface: undefined, clipExpectation: undefined }))
    .toEqual(before);
  expect(before.verdictPolicySnapshot.expectedSurfaces).toBeUndefined();
  expect(before.verdictPolicySnapshot.clipExpectation).toBeUndefined();
  // Golden кадра тоже не двигается: поверхности вообще не кадровый слой.
  expect(frameFingerprint(GOLDEN_FRAME_INPUT)).toBe(GOLDEN_FRAME);
});

test("W1a: expectedSurfaces доезжают до обеих проекций через caseFingerprintsOf", () => {
  const base = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A });

  // 1. Вердиктная проекция: `root` не трогает сравнение — правка ожидания корня стоит recompute.
  const root = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, expectedSurfaces: { root: SURFACES.root } });
  expect(root.frame).toBe(base.frame);
  expect(root.comparison).toBe(base.comparison);
  expect(root.verdictPolicy).not.toBe(base.verdictPolicy);
  expect(root.verdictPolicySnapshot.expectedSurfaces).toEqual({ root: SURFACES.root });

  // 2. Проекция сравнения: `referenceExport` не трогает вердикт — это описание самого эталона.
  const exported = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, expectedSurfaces: { referenceExport: SURFACES.referenceExport } });
  expect(exported.frame).toBe(base.frame);
  expect(exported.comparison).not.toBe(base.comparison);
  expect(exported.verdictPolicy).toBe(base.verdictPolicy);
  expect(exported.verdictPolicySnapshot.expectedSurfaces).toBeUndefined();

  // 3. Обе сразу — обе проекции сдвинуты, и ни одна не «съела» другую.
  const both = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, expectedSurfaces: { ...SURFACES } });
  expect(both.comparison).not.toBe(base.comparison);
  expect(both.verdictPolicy).not.toBe(base.verdictPolicy);
  expect(both.frame).toBe(base.frame);
  expect(both.verdictPolicySnapshot.expectedSurfaces).toEqual({ root: SURFACES.root, layoutUnion: SURFACES.layoutUnion, paint: SURFACES.paint });

  const layerOf = (field: LayeredField): readonly string[] => (FIELD_LAYERS as Record<string, readonly string[]>)[field]!;
  expect(layerOf("expectedSurfaces")).toEqual(["comparison", "verdict"]);
});

test("W1a: comparisonSurface — только сравнение, clipExpectation — только вердикт", () => {
  const base = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, expectedSurfaces: { ...SURFACES } });

  const compared = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, expectedSurfaces: { ...SURFACES }, comparisonSurface: "referenceExport" });
  expect(compared.comparison).not.toBe(base.comparison);
  expect(compared.verdictPolicy).toBe(base.verdictPolicy);
  expect(compared.frame).toBe(base.frame);
  // Триаж C-m1: поверхность сравнения в вердиктный снимок не входит вовсе.
  expect("comparisonSurface" in compared.verdictPolicySnapshot).toBe(false);

  const clipped = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, expectedSurfaces: { ...SURFACES }, clipExpectation: "root-does-not-clip-layout" });
  expect(clipped.comparison).toBe(base.comparison);
  expect(clipped.verdictPolicy).not.toBe(base.verdictPolicy);
  expect(clipped.verdictPolicySnapshot.clipExpectation).toBe("root-does-not-clip-layout");

  const layerOf = (field: LayeredField): readonly string[] => (FIELD_LAYERS as Record<string, readonly string[]>)[field]!;
  expect(layerOf("comparisonSurface")).toEqual(["comparison"]);
  expect(layerOf("clipExpectation")).toEqual(["verdict"]);
});

test("W1a: версия алгоритма отпечатка не двигается — легаси-семантика не менялась", () => {
  expect(CASE_FINGERPRINT_ALGO_VERSION).toBe(7);
});
