/**
 * Case-set-манифесты: валидация, хранение (`component_case_sets`, миграция v26), покрытие
 * измерений и построение набора случаев рана.
 *
 * Источники: план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md` §5 W2 (+§2 A2/A5/A6),
 * RFC `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md` §3.3/§3.4, фидбэк §10
 * «Verification matrix». Схема манифеста — общая с клиентом/драйвером: `src/acceptance/caseSetSchema.ts`.
 *
 * Инварианты, за которые отвечает этот модуль:
 *
 * - **Контентная адресация.** `case_set_id = "cset_" + sha256(canonicalStringify(manifest))`.
 *   Повторный PUT того же манифеста возвращает ту же строку (`cached: true`) и **ничего не
 *   переписывает**: раны, сославшиеся на этот id, обязаны оставаться воспроизводимыми. Изменённый
 *   манифест — это другой набор с другим id, а не новая версия старого.
 * - **Отказ вместо тихой деградации.** Ссылка на несуществующий ассет, дубликат props без
 *   `aliasOf`, алиас на алиас, повтор `case.id` — доменные 422. Матрица на 49 случаев, где два
 *   случая молча схлопнулись, хуже отсутствующей матрицы: она *выглядит* пройденной.
 * - **Warning ≠ блокер.** Расхождение props со схемой опубликованного компонента — предупреждение:
 *   схема головы кандидата может законно отличаться от последней публикации, а манифест часто
 *   готовится до правки компонента (§5 W2 «props против propsJsonSchema — warning»).
 * - **`case_policy_hash` per-case** (RFC §3.4): sha256 профиля политики набора и допусков ровно
 *   этого случая. Он входит в `case_fingerprint`, поэтому правка допуска одного случая
 *   инвалидирует reuse только его — и никого больше.
 */
import type { Database } from "bun:sqlite";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { caseSetManifestSchema, type CaseSetManifest } from "../../src/acceptance/caseSetSchema";
import { ApiError } from "../http";
import { propsHashOf, type AcceptanceCase } from "./cases";
import type { CaseSurface } from "./ids";
import { acceptanceMaxCasesPerRun } from "./policies";

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export interface CaseSetRow {
  case_set_id: string;
  component_id: string;
  design_system: string;
  manifest_json: string;
  case_count: number;
  source_file_key: string | null;
  source_node_id: string | null;
  created_by: string;
  created_at: string;
}

/** Контентный адрес манифеста. Канонизация — общая `canonicalStringify` (порядок ключей не влияет). */
export function caseSetIdOf(manifest: CaseSetManifest): string {
  return `cset_${sha256(canonicalStringify(manifest))}`;
}

/**
 * `case_policy_hash` одного случая (RFC §3.4). В хэш входят **только** политика набора и допуски
 * этого случая: props/эталон/поверхность уже присутствуют в `case_fingerprint` отдельными полями,
 * дублировать их здесь значило бы менять хэш политики при смене props.
 */
export function casePolicyHashOf(manifest: CaseSetManifest, caseId: string): string {
  return sha256(canonicalStringify({
    profile: manifest.policy?.profile ?? null,
    perCase: manifest.policy?.perCase?.[caseId] ?? null,
    // W5a: `requireVisual` меняет **обязательность** визуального гейта, то есть смысл вердикта
    // случая. Без него набор, переключённый на обязательный визуал, переиспользовал бы вердикты,
    // посчитанные когда гейт был advisory, — и матрица выглядела бы пройденной.
    requireVisual: manifest.requireVisual ?? false,
  }));
}

/** Поверхность съёмки набора (`capture` манифеста) → `CaseSurface` рана. */
export function surfaceOfManifest(manifest: CaseSetManifest): CaseSurface {
  return {
    viewport: { width: manifest.capture.viewport.width, height: manifest.capture.viewport.height },
    dsf: manifest.capture.deviceScaleFactor ?? 2,
    theme: manifest.capture.theme ?? "light",
  };
}

const issue = (path: (string | number)[], message: string) => ({ path, message });

/**
 * Схема опубликованного компонента для warning-проверки props. Берётся из последней активной
 * публикации: это единственный **дешёвый** источник `propsJsonSchema` (у головной ревизии его нет
 * без полного extract'а, а extract стоит typecheck). Нет публикации — проверка пропускается.
 */
function publishedPropsSchema(db: Database, componentId: string): { properties?: Record<string, unknown>; required?: string[] } | null {
  const row = db.query(`SELECT definition_meta FROM component_publishes
    WHERE component_id=? AND status='active' ORDER BY version DESC LIMIT 1`).get(componentId) as { definition_meta: string } | null;
  if (!row) return null;
  try {
    const meta = JSON.parse(row.definition_meta) as { propsJsonSchema?: unknown };
    const schema = meta.propsJsonSchema;
    return schema !== null && typeof schema === "object" ? schema as { properties?: Record<string, unknown>; required?: string[] } : null;
  } catch { return null; }
}

/** Shallow-сверка props случая со схемой публикации: неизвестные и отсутствующие обязательные ключи. */
function propsWarnings(manifest: CaseSetManifest, schema: ReturnType<typeof publishedPropsSchema>): string[] {
  if (!schema || typeof schema.properties !== "object" || schema.properties === null) return [];
  const known = new Set(Object.keys(schema.properties));
  const required = Array.isArray(schema.required) ? schema.required : [];
  const warnings: string[] = [];
  for (const item of manifest.cases) {
    const unknownKeys = Object.keys(item.props).filter((key) => !known.has(key));
    if (unknownKeys.length > 0) {
      warnings.push(`case ${item.id}: props not in the published schema of ${manifest.componentId}: ${unknownKeys.sort().join(", ")}`);
    }
    const missing = required.filter((key) => !(key in item.props));
    if (missing.length > 0) {
      warnings.push(`case ${item.id}: props miss required keys of the published schema: ${missing.sort().join(", ")}`);
    }
  }
  return warnings;
}

export interface ValidatedManifest {
  manifest: CaseSetManifest;
  caseSetId: string;
  warnings: string[];
}

/**
 * Полная валидация манифеста против БД. Порядок отказов — от формы к смыслу, чтобы сообщение об
 * ошибке всегда указывало на первую настоящую причину:
 * схема → componentId → потолок → уникальность id → эталоны → алиасы → дубли props → dims.
 */
export function validateManifest(db: Database, componentId: string, raw: unknown): ValidatedManifest {
  const parsed = caseSetManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, "validation_failed", "Case-set manifest is invalid", { issues: parsed.error.issues });
  }
  const manifest = parsed.data;
  if (manifest.componentId !== componentId) {
    throw new ApiError(422, "case_set_component_mismatch",
      `Manifest describes component ${manifest.componentId}, not ${componentId}`);
  }
  if (manifest.cases.length > acceptanceMaxCasesPerRun) {
    throw new ApiError(422, "case_set_too_large",
      `Case set exceeds the per-run limit of ${acceptanceMaxCasesPerRun} cases (${manifest.cases.length} declared)`);
  }

  const byId = new Map<string, typeof manifest.cases[number]>();
  for (const item of manifest.cases) {
    if (byId.has(item.id)) throw new ApiError(422, "duplicate_case_id", `Duplicate case id: ${item.id}`);
    byId.set(item.id, item);
  }

  // Эталоны: существование в реестре ассетов (канон `parseFigmaInput`, `server/figma.ts`).
  for (const item of manifest.cases) {
    if (item.referenceAssetId === undefined) continue;
    if (!db.query("SELECT 1 ok FROM assets WHERE id=?").get(item.referenceAssetId)) {
      throw new ApiError(422, "asset_not_found", "A referenced case asset does not exist",
        { issues: [issue(["cases", item.id, "referenceAssetId"], `unknown asset: ${item.referenceAssetId}`)] });
    }
  }

  // Алиасы: цель обязана существовать, не быть собой и сама не быть алиасом (цепочки запрещены —
  // вердикт наследуется ровно на один шаг, D10).
  for (const item of manifest.cases) {
    if (item.aliasOf === undefined) continue;
    const target = byId.get(item.aliasOf);
    if (!target || item.aliasOf === item.id) {
      throw new ApiError(422, "invalid_alias_target",
        `Case ${item.id} aliases ${item.aliasOf}, which is not another case of this set`);
    }
    if (target.aliasOf !== undefined) {
      throw new ApiError(422, "invalid_alias_target",
        `Case ${item.id} aliases ${item.aliasOf}, which is itself an alias; alias chains are not allowed`);
    }
    if (propsHashOf(target.props) !== propsHashOf(item.props)) {
      throw new ApiError(422, "invalid_alias_target",
        `Case ${item.id} aliases ${item.aliasOf} but declares different props; an alias must repeat its target's props`);
    }
  }

  // Per-case политика на алиасе (D16, план 2026-08-04): вердикт алиаса **всегда** идентичен
  // вердикту цели (D10), своей съёмки и своего сравнения у него нет. Допуск, адресованный алиасу,
  // не может быть исполнен ничем — это не «мягкое игнорирование», а объявленное намерение, которое
  // никогда не сбудется, поэтому отказ, а не warning.
  for (const caseId of Object.keys(manifest.policy?.perCase ?? {})) {
    const target = byId.get(caseId);
    if (target?.aliasOf !== undefined) {
      throw new ApiError(422, "per_case_policy_on_alias",
        `Case ${caseId} is an alias of ${target.aliasOf}; per-case policy must be declared on the alias target, not on the alias`);
    }
  }

  // Дубли props без `aliasOf`: явный отказ. Матрица обязана платить за каждый кадр осознанно.
  const firstByPropsHash = new Map<string, string>();
  for (const item of manifest.cases) {
    const hash = propsHashOf(item.props);
    const first = firstByPropsHash.get(hash);
    if (first === undefined) { firstByPropsHash.set(hash, item.id); continue; }
    if (item.aliasOf === undefined) {
      throw new ApiError(422, "duplicate_case_props",
        `Cases ${first} and ${item.id} declare identical props; mark the duplicate with aliasOf: "${first}"`);
    }
  }

  const warnings: string[] = [];
  // `dims` вне объявленных измерений — предупреждение, а не отказ: coverage покажет это честно
  // (недостающие tuples), а форвард-совместимость важнее строгости на необязательном поле.
  const dimensions = manifest.dimensions;
  if (dimensions) {
    for (const item of manifest.cases) {
      for (const [name, value] of Object.entries(item.dims ?? {})) {
        const values = dimensions[name];
        if (!values) warnings.push(`case ${item.id}: dims references an undeclared dimension "${name}"`);
        else if (!values.includes(value)) warnings.push(`case ${item.id}: dims."${name}" = "${value}" is not one of the declared values`);
      }
      const declared = Object.keys(dimensions);
      const missing = declared.filter((name) => (item.dims ?? {})[name] === undefined);
      if (missing.length > 0 && item.aliasOf === undefined) {
        warnings.push(`case ${item.id}: dims miss the declared dimensions ${missing.sort().join(", ")}`);
      }
    }
  }
  warnings.push(...propsWarnings(manifest, publishedPropsSchema(db, componentId)));

  return { manifest, caseSetId: caseSetIdOf(manifest), warnings };
}

export interface PutCaseSetInput {
  componentId: string;
  designSystem: string;
  manifest: CaseSetManifest;
  createdBy: string;
}

/** Репозиторий `component_case_sets`. Строки иммутабельны: тот же манифест → та же строка. */
export class CaseSetRepo {
  constructor(private readonly db: Database) {}

  put(input: PutCaseSetInput): { row: CaseSetRow; cached: boolean } {
    const id = caseSetIdOf(input.manifest);
    return this.db.transaction(() => {
      const existing = this.get(id);
      if (existing) return { row: existing, cached: true };
      this.db.query(`INSERT INTO component_case_sets
        (case_set_id,component_id,design_system,manifest_json,case_count,source_file_key,source_node_id,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, input.componentId, input.designSystem, JSON.stringify(input.manifest), input.manifest.cases.length,
          input.manifest.source?.fileKey ?? null, input.manifest.source?.componentSetNodeId ?? null,
          input.createdBy, new Date().toISOString());
      return { row: this.require(id), cached: false };
    })();
  }

  get(caseSetId: string): CaseSetRow | undefined {
    return (this.db.query("SELECT * FROM component_case_sets WHERE case_set_id=?").get(caseSetId) as CaseSetRow | null) ?? undefined;
  }

  require(caseSetId: string): CaseSetRow {
    const row = this.get(caseSetId);
    if (!row) throw new ApiError(404, "not_found", "Case set not found");
    return row;
  }
}

/**
 * Манифест из строки. Хранится он всегда уже провалидированным, поэтому повторный `parse` —
 * защита от ручной правки БД, а не рабочий путь; провал = 500-уровневая ошибка данных.
 */
export function manifestOfRow(row: CaseSetRow): CaseSetManifest {
  const parsed = caseSetManifestSchema.safeParse(JSON.parse(row.manifest_json));
  if (!parsed.success) throw new Error(`Stored case-set manifest is invalid: ${row.case_set_id}`);
  return parsed.data;
}

export interface CoverageReport {
  dimensions: Record<string, string[]>;
  expectedTuples: number;
  presentTuples: number;
  missingTuples: Record<string, string>[];
  duplicates: { tuple: Record<string, string>; caseIds: string[] }[];
}

/**
 * Покрытие измерений: `expected` — декартово произведение объявленных `dimensions`, `present` —
 * различные tuples из `cases[].dims`. Без `dimensions` покрытие тривиально (`presentTuples` = число
 * случаев): строить фиктивное произведение по неполной Figma-матрице нельзя — это прямое требование
 * фидбэка §10.1 («не строить фиктивный Cartesian product»).
 *
 * Алиасы участвуют в покрытии наравне с целями: их координата в семье реальна, даже если кадр общий.
 */
export function coverageOf(manifest: CaseSetManifest): CoverageReport {
  const dimensions = manifest.dimensions ?? {};
  const names = Object.keys(dimensions).sort();
  if (names.length === 0) {
    return { dimensions: {}, expectedTuples: 0, presentTuples: manifest.cases.length, missingTuples: [], duplicates: [] };
  }
  const keyOf = (tuple: Record<string, string>): string => names.map((name) => `${name}=${tuple[name] ?? ""}`).join("|");

  const present = new Map<string, { tuple: Record<string, string>; caseIds: string[] }>();
  for (const item of manifest.cases) {
    const dims = item.dims;
    if (!dims) continue;
    // Неполная координата в покрытии не участвует: она не адресует ни одну ячейку матрицы.
    if (names.some((name) => dims[name] === undefined)) continue;
    const tuple: Record<string, string> = {};
    for (const name of names) tuple[name] = dims[name]!;
    const key = keyOf(tuple);
    const bucket = present.get(key);
    if (bucket) bucket.caseIds.push(item.id);
    else present.set(key, { tuple, caseIds: [item.id] });
  }

  let expected: Record<string, string>[] = [{}];
  for (const name of names) {
    expected = expected.flatMap((prefix) => dimensions[name]!.map((value) => ({ ...prefix, [name]: value })));
  }

  const missingTuples = expected.filter((tuple) => !present.has(keyOf(tuple)));
  const duplicates = [...present.values()].filter((entry) => entry.caseIds.length > 1)
    .map((entry) => ({ tuple: entry.tuple, caseIds: entry.caseIds }));
  return {
    dimensions: Object.fromEntries(names.map((name) => [name, dimensions[name]!])),
    expectedTuples: expected.length,
    presentTuples: present.size,
    missingTuples,
    duplicates,
  };
}

/**
 * Набор случаев рана из манифеста (аналог `buildCases` для examples-пути).
 *
 * Алиасы: явный `aliasOf` манифеста, плюс дедуп по `propsHash` поверх — на случай, когда манифест
 * объявил алиас, а props совпали ещё с чьими-то (валидация выше это уже запретила, но набор
 * строится оборонительно: одна и та же props-пара **никогда** не снимается дважды, A7).
 */
export function buildCasesFromManifest(manifest: CaseSetManifest): AcceptanceCase[] {
  if (manifest.cases.length > acceptanceMaxCasesPerRun) {
    throw new ApiError(422, "case_set_too_large",
      `Case set exceeds the per-run limit of ${acceptanceMaxCasesPerRun} cases (${manifest.cases.length} declared)`);
  }
  const cases: AcceptanceCase[] = [];
  const byPropsHash = new Map<string, string>();
  for (const item of manifest.cases) {
    const propsHash = propsHashOf(item.props);
    const firstWithProps = byPropsHash.get(propsHash);
    if (firstWithProps === undefined && item.aliasOf === undefined) byPropsHash.set(propsHash, item.id);
    cases.push({
      caseId: item.id,
      caseKey: item.id,
      props: item.props,
      propsHash,
      aliasOfCaseId: item.aliasOf ?? firstWithProps ?? null,
      referenceAssetId: item.referenceAssetId ?? null,
      expectedGeometry: item.expectedGeometry ?? null,
      casePolicyHash: casePolicyHashOf(manifest, item.id),
      declaredPolicyProfile: manifest.policy?.profile ?? null,
      // W3: допуски геометрии (`allowPaintOverflow`/`expectedClip`) — вход вердикта гейта, а не
      // только материал хэша; без них манифест объявлял бы намерение, которого никто не читает.
      ...(manifest.policy?.perCase?.[item.id] ? { casePolicy: manifest.policy.perCase[item.id] } : {}),
      // W5a: происхождение эталона — вход нормализации размеров гейта `visual`.
      ...(item.cropLineage ? { cropLineage: item.cropLineage } : {}),
      // W5b: координата случая в семье — вход `variantFamily` группировки ремедиаций.
      ...(item.dims ? { dims: item.dims } : {}),
    });
  }
  if (!cases.some((item) => item.aliasOfCaseId === null)) {
    throw new ApiError(422, "empty_case_set", "Every case aliased away; nothing to capture");
  }
  return cases;
}
