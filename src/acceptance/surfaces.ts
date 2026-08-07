/**
 * Четыре поверхности геометрии случая — нормализация и её инварианты
 * (план `docs/plans/2026-08-07-migration-feedback-wave.md` §1.1, волна W1a).
 *
 * Ретроспектива миграции YP v2 назвала корень проблемы прямо: `expectedGeometry` — **одно** число
 * на четыре разных вопроса. «343×88» головного кейса Payment Schedule это габарит корневого бокса
 * компонента; «367×88» — габарит экспорта из Figma; «480×88» и «558×88» — union in-flow потомков
 * при двух ширинах поля. Пока контракт умеет ровно одну величину, автор обязан выбрать, о чём
 * соврать, и приёмка судит компонент по чужому числу.
 *
 * Здесь живёт **нормализация**, а не хранение. Три инварианта:
 *
 * 1. **Результат нормализации не персистится и не входит ни в один хеш** (N3). `expectedSurfaces`
 *    доезжает до `comparisonFingerprintOf`/`VerdictPolicySnapshot` **только** условным спредом при
 *    явной декларации в манифесте; доволновой случай, у которого поверхности выведены из
 *    `expectedGeometry`, обязан давать байт-в-байт прежние `verdict_policy_hash`/`comparisonFingerprint`.
 *    Иначе первая же волна прогнала бы вердиктный каскад по всему накопленному корпусу.
 * 2. **Легаси-поле остаётся собственным.** `expectedGeometry` не переписывается в `expectedSurfaces`
 *    ни в схеме, ни в строке БД, ни в снимке политики: нормализация — это чтение, и её выход живёт
 *    ровно столько, сколько длится вызов потребителя (дефолт канвы сравнения, per-surface вердикт).
 * 3. **Отказы объявляются здесь, а не в трёх местах.** Схема (`caseSetSchema.ts`) владеет формой,
 *    сервер (`server/acceptance/caseSets.ts`) — статусом и адресом случая, а *смысл* трёх
 *    несовместимостей — один, и он не должен разъехаться между PUT, dry-run и драйвером.
 *
 * Единицы всех поверхностей — **CSS px** (то же, что у `expectedGeometry`): `referenceExport`
 * нормализуется гейтом из device px ассета делением на `deviceScaleFactor` (W1b).
 */

/**
 * Порядок значим: он же порядок `divergingSurfaces[]` вердикта — от «что построил браузер» к «что
 * прислал дизайнер». Читатель отчёта должен видеть причину раньше следствия.
 */
export const GEOMETRY_SURFACES = ["root", "layoutUnion", "paint", "referenceExport"] as const;
export type GeometrySurface = (typeof GEOMETRY_SURFACES)[number];

export interface SurfaceDims { width: number; height: number }
export type ExpectedSurfaces = Partial<Record<GeometrySurface, SurfaceDims>>;

/** Единственное значение `clipExpectation` (вариант «root-clips-layout» снят — сценария нет). */
export const CLIP_EXPECTATION = "root-does-not-clip-layout";
export type ClipExpectation = typeof CLIP_EXPECTATION;

/**
 * Минимум случая, нужный нормализации. Структурный тип, а не `CaseSetCase`: те же поля приезжают и
 * из манифеста, и из `AcceptanceCase` строки рана, и подгонять одно под другое ради вызова значило
 * бы завести зависимость сервера от схемы там, где хватает четырёх полей.
 */
export interface SurfaceDeclaration {
  expectedGeometry?: SurfaceDims | null;
  expectedSurfaces?: ExpectedSurfaces | null;
  comparisonSurface?: GeometrySurface | null;
  clipExpectation?: ClipExpectation | null;
}

/**
 * Объявлены ли поверхности **явно**. Ровно этот предикат — дискриминатор легаси/нового пути
 * вердикта (§1.1): легаси-вход обязан исполнить прежний код байт-в-байт, поэтому «нормализовали из
 * `expectedGeometry`» и «объявили поверхности» никогда не смешиваются.
 */
export const declaresSurfaces = (item: SurfaceDeclaration): boolean =>
  item.expectedSurfaces !== undefined && item.expectedSurfaces !== null
  && Object.keys(item.expectedSurfaces).length > 0;

/**
 * Поверхности случая: явная декларация, иначе `expectedGeometry` в роли `layoutUnion` — ровно та
 * величина, которую сегодняшний вердикт и сравнивает с union'ом in-flow потомков. Ни поля нет —
 * пустая карта (а не выдуманные нули).
 *
 * **Не персистить результат** (инвариант 1 шапки).
 */
export function expectedSurfacesOf(item: SurfaceDeclaration): ExpectedSurfaces {
  if (declaresSurfaces(item)) return { ...item.expectedSurfaces };
  const legacy = item.expectedGeometry;
  if (legacy) return { layoutUnion: { width: legacy.width, height: legacy.height } };
  return {};
}

/**
 * Поверхность **сравнения**: в её координатах строится каноническая канва визуального гейта.
 * Дефолт — `layoutUnion`, то есть сегодняшнее поведение (канва выводится из `expectedGeometry`,
 * иначе из измеренного `layoutBounds`), поэтому доволновой случай идёт прежней веткой.
 */
export function comparisonSurfaceOf(item: SurfaceDeclaration): GeometrySurface {
  return item.comparisonSurface ?? "layoutUnion";
}

/** Проекция поверхностей на слой сравнения (§1.1, N15): эталон — единственная поверхность диффа. */
export function comparisonSurfaceProjection(surfaces: ExpectedSurfaces | null | undefined): ExpectedSurfaces | undefined {
  const referenceExport = surfaces?.referenceExport;
  return referenceExport === undefined ? undefined : { referenceExport };
}

/**
 * Проекция поверхностей на вердиктный слой (§1.1, N15): всё, что мерит браузер. Правка ожидания
 * `root`/`paint` обязана стоить дешёвый recompute, а не re-diff, — поэтому проекции две, а не одна.
 */
export function verdictSurfaceProjection(surfaces: ExpectedSurfaces | null | undefined): ExpectedSurfaces | undefined {
  if (!surfaces) return undefined;
  const projection: ExpectedSurfaces = {};
  for (const name of ["root", "layoutUnion", "paint"] as const) {
    const dims = surfaces[name];
    if (dims !== undefined) projection[name] = dims;
  }
  return Object.keys(projection).length === 0 ? undefined : projection;
}

export interface CaseSurfaceIssue {
  code: "case_surface_conflict" | "case_comparison_surface_undeclared" | "case_clip_expectation_requires_root";
  message: string;
}

/**
 * Три несовместимости декларации (§W1a). Возвращается **первая** — сообщение обязано называть одну
 * причину, а не список: автор чинит по одной.
 *
 * 1. `case_surface_conflict` — объявлены и `expectedGeometry`, и `expectedSurfaces`. Молча выбрать
 *    одно значило бы решить за автора, какое из двух чисел настоящее; ровно эта тихая подстановка
 *    и роняла головной кейс.
 * 2. `case_comparison_surface_undeclared` — сравнивать предложено с поверхностью, габаритов которой
 *    никто не объявил. Канва тогда строилась бы наугад.
 * 3. `case_clip_expectation_requires_root` — «корень не режет layout» без объявленного `root`
 *    непроверяемо: не с чем сравнивать union.
 */
export function caseSurfaceIssueOf(item: SurfaceDeclaration, caseId: string): CaseSurfaceIssue | null {
  const hasLegacy = item.expectedGeometry !== undefined && item.expectedGeometry !== null;
  if (hasLegacy && declaresSurfaces(item)) {
    return {
      code: "case_surface_conflict",
      message: `Case ${caseId} declares both expectedGeometry and expectedSurfaces;`
        + " expectedGeometry is the legacy spelling of expectedSurfaces.layoutUnion — keep one of them",
    };
  }
  const surfaces = expectedSurfacesOf(item);
  if (item.comparisonSurface !== undefined && item.comparisonSurface !== null
    && surfaces[item.comparisonSurface] === undefined) {
    return {
      code: "case_comparison_surface_undeclared",
      message: `Case ${caseId} compares against the "${item.comparisonSurface}" surface but never declares its dimensions;`
        + " declare expectedSurfaces." + item.comparisonSurface + " (CSS px)",
    };
  }
  if (item.clipExpectation !== undefined && item.clipExpectation !== null && surfaces.root === undefined) {
    return {
      code: "case_clip_expectation_requires_root",
      message: `Case ${caseId} declares clipExpectation "${item.clipExpectation}" without expectedSurfaces.root;`
        + " the expectation is a statement about the root box and is unverifiable without it",
    };
  }
  return null;
}
