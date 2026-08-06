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
import {
  CASE_SET_MAX_EXPECTED_TUPLES, CASE_SET_MAX_SLOT_DEPTH, CASE_SET_MAX_SLOT_NODES,
  COVERAGE_MISSING_TUPLES_LIMIT, DEFAULT_SLOT_KEY, caseSetManifestSchema,
  expectedTuplesOf,
  type CaseSetCase, type CaseSetManifest, type CaseSetSlotBindings, type CaseSetSlotChild,
  type CropSourceSurface,
} from "../../src/acceptance/caseSetSchema";
import { ApiError } from "../http";
import type { CandidateEntry } from "../components/candidates";
import { propsHashOf, type AcceptanceCase, type ResolvedSlotBinding } from "./cases";
import { COMPARISON_PAINT_MARGIN_PX, type CaseSurface } from "./ids";
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

// --------------------------------------------------------- слот-биндинги (план 2026-08-05 §A1–A3)

/**
 * Статусы публикации ребёнка, принимаемые **симметрично** при PUT и на старте рана (§A2).
 *
 * Асимметричный гейт («только active при PUT») сломал бы документированный идемпотентный повтор
 * PUT: promote авто-supersede'ит предыдущие версии, поэтому байт-в-байт тот же манифест переставал
 * бы приниматься в тот момент, когда любой ребёнок получает новую версию. Тот же набор статусов,
 * что у рендерабельных пинов прототипа (`repos/prototypes.ts` — `RENDERABLE_PIN_STATUS`).
 */
const SLOT_PIN_ACCEPTED_STATUS = new Set(["active", "deprecated", "superseded"]);

export interface PublishedSlotPin {
  componentId: string;
  name: string;
  version: number;
  status: string;
  bundleHash: string;
  designSystem: string;
  definitionMeta: string;
}

/**
 * Пин ребёнка по **имени и точной версии** (§A2). Ни `componentPinByVersion` (адресуется id и любым
 * статусом), ни name-based «последняя активная» из `validation.ts:205-208` этого не делают.
 *
 * Форма запроса повторяет `snapshotDefinitions` (`server/validation.ts:200-208`):
 * - `c.deleted_at IS NULL` — зарезервированное имя soft-deleted компонента резолвиться не должно,
 *   иначе пин указывал бы на надгробие;
 * - дизайн-система берётся у **ревизии** (`cr.design_system`), а не у компонента: это единственный
 *   источник, по которому судит и снапшот прототипа.
 *
 * `designSystem === null` — «не фильтровать» (нужно, чтобы отличить «не опубликован» от «чужая ДС»
 * и выдать правильный код отказа).
 *
 * `options.includeDeleted` снимает фильтр надгробия — им пользуется **только** режим
 * `"reconstruction"` (§A5, T2.1): пины уже были авторизованы на постановке рана, и soft-delete
 * ребёнка посреди рана не имеет права превратить существующую строку публикации в «отсутствующую».
 */
export function publishedPinByNameAndVersion(
  db: Database, name: string, version: number, designSystem: string | null,
  options: { includeDeleted?: boolean } = {},
): PublishedSlotPin | null {
  const select = `SELECT c.id componentId, c.name name, cp.version version, cp.status status,
      cp.bundle_hash bundleHash, cp.definition_meta definitionMeta, cr.design_system designSystem
    FROM components c
    JOIN component_publishes cp ON cp.component_id=c.id AND cp.version=?
    JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
    WHERE c.name=?${options.includeDeleted === true ? "" : " AND c.deleted_at IS NULL"}`;
  const row = designSystem === null
    ? db.query(select).get(version, name)
    : db.query(`${select} AND cr.design_system=?`).get(version, name, designSystem);
  return (row as PublishedSlotPin | null) ?? null;
}

/** JSON-безопасность props ребёнка: тот же обход, что `validatePropsAgainstSchema` (`screenshot/service.ts`). */
function jsonSafeChildProps(node: unknown): boolean {
  if (node === null) return true;
  const kind = typeof node;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(node as number);
  if (Array.isArray(node)) return node.every(jsonSafeChildProps);
  if (kind === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // `$…` — директивы рендерера (`$asset`/`$cond`/…), `__eui…` — служебные ключи рантайма.
      // Их нельзя вносить в bootstrap ребёнка: они исполнились бы как код разметки, а не данные.
      if (key.startsWith("$") || key.startsWith("__eui")) return false;
      if (!jsonSafeChildProps(value)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Консервативная сверка props ребёнка со схемой **запиненной** версии: object-ность, `required`,
 * типы примитивов верхнего уровня. Тот же объём, что у `validatePropsAgainstSchema` — шире
 * проверять нельзя без полного JSON-Schema валидатора, а уже это ловит опечатку в имени prop'а.
 */
function childPropsIssue(props: Record<string, unknown>, meta: unknown): string | null {
  const schema = (meta as { propsJsonSchema?: unknown } | null)?.propsJsonSchema;
  if (!schema || typeof schema !== "object") return null;
  const shape = schema as { required?: unknown; properties?: Record<string, { type?: unknown }> };
  if (Array.isArray(shape.required)) {
    for (const key of shape.required) {
      if (typeof key === "string" && !(key in props)) return `missing required prop: ${key}`;
    }
  }
  for (const [key, definition] of Object.entries(shape.properties ?? {})) {
    if (!(key in props) || definition?.type === undefined || typeof definition.type !== "string") continue;
    const value = props[key];
    const matches = definition.type === "string" ? typeof value === "string"
      : definition.type === "number" || definition.type === "integer" ? typeof value === "number"
      : definition.type === "boolean" ? typeof value === "boolean"
      : definition.type === "array" ? Array.isArray(value)
      : definition.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : definition.type === "null" ? value === null
      : true;
    if (!matches) return `prop ${key} must be of type ${definition.type}`;
  }
  return null;
}

/** `definition_meta` последней активной публикации компонента (общий вход warning-проверок). */
function publishedDefinitionMeta(db: Database, componentId: string): Record<string, unknown> | null {
  const row = db.query(`SELECT definition_meta FROM component_publishes
    WHERE component_id=? AND status='active' ORDER BY version DESC LIMIT 1`).get(componentId) as { definition_meta: string } | null;
  if (!row) return null;
  try {
    const meta = JSON.parse(row.definition_meta) as unknown;
    return meta !== null && typeof meta === "object" ? meta as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * Слот-факты **хозяина слота**: какие именованные слоты он объявляет и умеет ли он их вообще.
 * Хозяин корневого уровня — субъект приёмки (его последняя публикация), хозяин вложенного уровня
 * (§W6) — запиненная публикация ребёнка-родителя. `null` — метаданных нет, судить нечем.
 */
interface SlotHostFacts {
  declaredSlots: Set<string>;
  namedSlotsCapable: boolean;
}

function slotHostFactsOf(meta: Record<string, unknown> | null): SlotHostFacts | null {
  if (meta === null) return null;
  const slots = Array.isArray(meta.slots) ? (meta.slots as unknown[]).filter((s): s is string => typeof s === "string") : [];
  return {
    declaredSlots: new Set(slots),
    namedSlotsCapable: (meta.capabilities as { namedSlots?: unknown } | undefined)?.namedSlots === true,
  };
}

/** Слот-факты **запиненной публикации** ребёнка — хозяин вложенного уровня (§W6). */
function slotHostOf(pin: PublishedSlotPin): { slots: Set<string>; capable: boolean; name: string } | null {
  let meta: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(pin.definitionMeta) as unknown;
    meta = parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch { meta = null; }
  const facts = slotHostFactsOf(meta);
  return facts === null ? null
    : { slots: facts.declaredSlots, capable: facts.namedSlotsCapable, name: `${pin.name} v${pin.version}` };
}

/**
 * Проверки слот-биндингов (§A2, вложенность — план 2026-08-06 §W6). Разделение труда с рантаймом:
 *
 * - **Опубликованные факты** (ребёнок существует, версия запинена, статус рендерабелен, ДС та же,
 *   props сходятся со схемой пина, props JSON-безопасны) — жёсткие 422 **здесь**: они не зависят
 *   ни от головы кандидата, ни от момента запуска.
 * - **Факты головы кандидата** (есть ли такой именованный слот, объявлен ли `capabilities.namedSlots`)
 *   — при PUT только warning'и: голова кандидата законно отличается от последней публикации, а
 *   манифест часто готовится **до** правки компонента. Жёсткий отказ по ним — на старте рана (T2.1).
 * - **Дефолтный слот целиком вне обеих проверок членства** (§A2a): он неявный, компоненты его не
 *   объявляют, и требовать его в `slots` значило бы запретить карусель из 9 детей.
 */
function validateSlotBindings(db: Database, manifest: CaseSetManifest, componentId: string, warnings: string[]): void {
  const bound = manifest.cases.filter((item) => item.slotBindings !== undefined);
  if (bound.length === 0) return;

  const subject = db.query("SELECT design_system FROM components WHERE id=?")
    .get(componentId) as { design_system: string } | null;
  // Компонента нет в БД (валидация манифеста в тестах/дорутовых путях) — ДС не с чем сверять;
  // выдумывать отказ по несуществующему факту хуже, чем не проверять его.
  const designSystem = subject?.design_system ?? null;

  // Мемоизация в пределах одного вызова: потолок набора — 64 случая × 96 узлов дерева, и без
  // неё один PUT давал бы тысячи одинаковых запросов (триаж раунда 1, «accepted minors»).
  const memo = new Map<string, PublishedSlotPin | null>();
  const pinOf = (name: string, version: number): PublishedSlotPin | null => {
    const key = `${version} ${name}`;
    if (!memo.has(key)) memo.set(key, publishedPinByNameAndVersion(db, name, version, designSystem));
    return memo.get(key) ?? null;
  };

  const subjectFacts = slotHostFactsOf(publishedDefinitionMeta(db, componentId));

  for (const item of bound) {
    // Тотал узлов считается **по случаю** целиком (§W6): 8 слотов × 12 детей = 96 — ровно тот
    // максимум, который был выразим до волны, поэтому граничный плоский манифест остаётся валиден.
    let nodes = 0;

    /**
     * Рекурсивный обход дерева слотов случая. `depth` — уровень **детей**, которых обходит вызов
     * (дети случая — 1). `host` — тот, **в чей** слот кладут: у корня это последняя публикация
     * субъекта (голова кандидата может законно отличаться → warning), у вложенного уровня —
     * `definition_meta` запиненной публикации родителя (факт неизменный → отказ сразу).
     */
    const visit = (
      bindings: CaseSetSlotBindings,
      at: (string | number)[],
      depth: number,
      host: { facts: SlotHostFacts | null; kind: "candidate" | "published"; name: string },
      ancestors: readonly string[],
    ): void => {
      for (const [slot, children] of Object.entries(bindings)) {
        children.forEach((child, index) => {
          const nodeAt = [...at, slot, index];
          const where = `case ${item.id}, slot "${slot}"[${index}]${depth > 1 ? ` nested under ${host.name} (depth ${depth})` : ""}`;
          if (depth > CASE_SET_MAX_SLOT_DEPTH) {
            throw new ApiError(422, "slot_depth_exceeded",
              `${where}: slot trees are limited to ${CASE_SET_MAX_SLOT_DEPTH} levels below the case;`
              + " flatten the binding or publish the nested composition as a component of its own",
              { issues: [issue(nodeAt, `depth ${depth} exceeds the limit of ${CASE_SET_MAX_SLOT_DEPTH}`)] });
          }
          nodes += 1;
          if (nodes > CASE_SET_MAX_SLOT_NODES) {
            throw new ApiError(422, "slot_nodes_exceeded",
              `Case ${item.id} declares more than ${CASE_SET_MAX_SLOT_NODES} slot children across its whole tree;`
              + " split the state into several cases",
              { issues: [issue(nodeAt, `the slot tree of a case holds at most ${CASE_SET_MAX_SLOT_NODES} nodes`)] });
          }
          const props = child.props ?? {};
          if (!jsonSafeChildProps(props)) {
            throw new ApiError(422, "slot_props_dynamic",
              `${where}: child ${child.type} declares $- or __eui-prefixed props;`
              + " slot children take plain JSON data, not renderer directives",
              { issues: [issue([...nodeAt, "props"], "props must be JSON-safe and free of $-/__eui-prefixed keys")] });
          }
          const pin = pinOf(child.type, child.version);
          if (!pin) {
            // Строка нашлась бы без фильтра по ДС — значит ребёнок из другой системы, и это другой
            // отказ: «не опубликован» увёл бы автора искать несуществующую публикацию.
            const foreign = designSystem === null ? null : publishedPinByNameAndVersion(db, child.type, child.version, null);
            if (foreign) {
              throw new ApiError(422, "slot_component_design_system_mismatch",
                `${where}: binds ${child.type} v${child.version} from design system`
                + ` ${foreign.designSystem}, but ${componentId} belongs to ${designSystem}`,
                { issues: [issue(nodeAt, `child design system ${foreign.designSystem} != ${designSystem}`)] });
            }
            throw new ApiError(422, "slot_component_not_published",
              `${where}: binds ${child.type} v${child.version}, which is not a published component version`,
              { issues: [issue(nodeAt, `unknown or unpublished component version: ${child.type} v${child.version}`)] });
          }
          if (!SLOT_PIN_ACCEPTED_STATUS.has(pin.status)) {
            throw new ApiError(422, "slot_component_not_published",
              `${where}: binds ${child.type} v${child.version}, whose publish status is ${pin.status} and does not render`,
              { issues: [issue(nodeAt, `publish status ${pin.status} is not renderable`)] });
          }
          // Цикл считается по **всему пути** (§W6): субъект приёмки — нулевой предок, поэтому одним
          // правилом ловятся и прямая самоссылка, и «внук равен деду».
          if (ancestors.includes(pin.componentId)) {
            throw new ApiError(422, "slot_self_reference",
              `${where}: binds ${child.type} v${child.version}, which already renders this subtree`
              + ` (${[...ancestors, pin.componentId].join(" → ")})`,
              { issues: [issue(nodeAt, "a slot subtree cannot bind the subject component or any of its own ancestors")] });
          }
          const childMeta = JSON.parse(pin.definitionMeta) as unknown;
          const propsIssue = childPropsIssue(props, childMeta);
          if (propsIssue !== null) {
            throw new ApiError(422, "slot_props_invalid",
              `${where}: child ${child.type} v${child.version} has invalid props — ${propsIssue}`,
              { issues: [issue([...nodeAt, "props"], propsIssue)] });
          }
          // Коды warning'ов — часть контракта (`slot_pin_deprecated`/`slot_pin_superseded`, дом. паттерн
          // `repos/prototypes.ts:155-158`); поверхность здесь — строки, поэтому код идёт префиксом.
          if (pin.status === "deprecated") {
            warnings.push(`slot_pin_deprecated: ${where} pins ${child.type} v${child.version}, which is deprecated`);
          } else if (pin.status === "superseded") {
            warnings.push(`slot_pin_superseded: ${where} pins ${child.type} v${child.version}, which is superseded`);
          }
          // Вложенные слоты ребёнка (§W6): хозяином их проверки членства становится сам ребёнок.
          if (child.slotBindings !== undefined) {
            visit(child.slotBindings, [...nodeAt, "slotBindings"], depth + 1, {
              facts: slotHostFactsOf(childMeta !== null && typeof childMeta === "object" ? childMeta as Record<string, unknown> : null),
              kind: "published",
              name: `${child.type} v${child.version}`,
            }, [...ancestors, pin.componentId]);
          }
        });

        // Дефолтный слот из проверки членства исключён целиком: он неявный и в `slots` не
        // объявляется никогда (§A2a) — на любом уровне дерева.
        if (slot === DEFAULT_SLOT_KEY || host.facts === null) continue;
        const { declaredSlots, namedSlotsCapable } = host.facts;
        if (host.kind === "candidate") {
          // Факты головы кандидата — warning'и: голова законно отличается от последней публикации,
          // а жёсткий отказ по ним выносит старт рана (§A2).
          if (!namedSlotsCapable) {
            warnings.push(`case ${item.id}: slot "${slot}" is a named slot, but the last published version of`
              + ` ${componentId} declares no capabilities.namedSlots; the candidate head is authoritative and this is`
              + " re-checked as a refusal when the run starts");
          } else if (!declaredSlots.has(slot)) {
            warnings.push(`case ${item.id}: slot "${slot}" is not among the named slots of the last published version of`
              + ` ${componentId} (${[...declaredSlots].sort().join(", ") || "none"}); re-checked as a refusal when the run starts`);
          }
        // Родитель вложенного уровня — **запиненная публикация**: её метаданные неизменны, ждать
        // старта рана незачем, а слот, которого у неё нет, тихо выбросил бы детей из кадра.
        } else if (!namedSlotsCapable) {
          throw new ApiError(422, "slot_bindings_unsupported",
            `Case ${item.id}: ${host.name} declares no capabilities.namedSlots, so its named slot "${slot}" cannot be`
            + " bound (only the implicit default slot is bindable for it)",
            { issues: [issue([...at, slot], `${host.name} declares no capabilities.namedSlots`)] });
        } else if (!declaredSlots.has(slot)) {
          throw new ApiError(422, "slot_unknown",
            `Case ${item.id}: ${host.name} declares no named slot "${slot}"`
            + ` (${[...declaredSlots].sort().join(", ") || "none"})`,
            { issues: [issue([...at, slot], `unknown named slot of ${host.name}`)] });
        }
      }

      // §A2a: дефолтный слот доступен любому компоненту, который рендерит `children`, а «рендерит ли»
      // по метаданным неразрешимо. Поэтому — warning, а не отказ: он лишь напоминает проверить, что
      // компонент вообще что-то делает с детьми.
      if (host.kind === "candidate" && bindings[DEFAULT_SLOT_KEY] !== undefined && host.facts !== null
        && !host.facts.namedSlotsCapable && host.facts.declaredSlots.size === 0) {
        warnings.push(`case ${item.id}: binds the default slot, but the last published version of ${componentId}`
          + " declares neither named slots nor a slot capability — make sure the component renders its children");
      }
    };

    visit(item.slotBindings!, ["cases", item.id, "slotBindings"], 1,
      { facts: subjectFacts, kind: "candidate", name: componentId }, [componentId]);
  }
}

/**
 * **Ключ дедупа PUT-времени** (§A3). Живёт только в памяти и никогда не персистится: нормализованные
 * биндинги манифеста — по ребёнку `{type, version, propsHash}` — поэтому `props: {}` и отсутствующий
 * `props` схлопываются, как и должны. Порядок ключей слотов не важен (`canonicalStringify`), порядок
 * детей внутри слота — важен: это порядок рендера, и он меняет кадр.
 *
 * Не путать с `slotsHash` (`slotsHashOf`): тот считается по **резолвнутым** пинам, персистится и
 * входит в отпечаток кадра. Две разные величины, которые никогда не сравниваются друг с другом.
 */
export function dedupSlotsKeyOf(slotBindings: CaseSetSlotBindings | undefined): string | null {
  if (slotBindings === undefined) return null;
  // Нормализация рекурсивна (§W6): дерево различается и вложенным содержимым тоже, а два случая с
  // одинаковыми props и разными внуками — два разных кадра.
  const normalizeChild = (child: CaseSetSlotChild): Record<string, unknown> => ({
    type: child.type, version: child.version, propsHash: propsHashOf(child.props),
    // Условный ключ: набор глубины 1 обязан давать ровно прежний ключ дедупа.
    ...(child.slotBindings === undefined ? {} : { slotBindings: normalize(child.slotBindings) }),
  });
  const normalize = (bindings: CaseSetSlotBindings): Record<string, unknown> => Object.fromEntries(
    Object.entries(bindings).map(([slot, children]) => [slot, children.map(normalizeChild)]));
  const normalized = normalize(slotBindings);
  // Пустой объект биндингов ничем не отличается от их отсутствия — иначе он давал бы «другой» кадр
  // при одинаковых props (та же нормализация, что `props: {}` ≡ absent).
  if (Object.keys(normalized).length === 0) return null;
  return sha256(canonicalStringify(normalized));
}

/** Ключ дедупа случая: props + биндинги. Слот-free манифест вырождается ровно в сегодняшний `propsHash`. */
export function caseDedupKeyOf(item: Pick<CaseSetCase, "props" | "slotBindings">): string {
  return `${propsHashOf(item.props)}:${dedupSlotsKeyOf(item.slotBindings) ?? "-"}`;
}

/** Резолвнутый ребёнок слота — ровно те поля, которые входят в `slotsHash` и в отпечаток кадра. */
export interface ResolvedSlotTuple {
  slot: string;
  index: number;
  componentId: string;
  version: number;
  bundleHash: string;
  propsHash: string;
  /** Вложенные дети (§W6). Отсутствует у листа — и у **всего** дерева глубины 1. */
  children?: readonly ResolvedSlotTuple[];
}

/**
 * **`slotsHash`** (§A3): sha256 списка резолвнутых кортежей — тот же прообраз, что у входа
 * отпечатка кадра. Проекция явная: вызывающий может передать более богатый объект (с `name`/`props`),
 * и хэш от этого не сдвинется. Само разрешение биндингов приезжает в T2.1 — здесь живёт только
 * функция хэширования, потому что её прообраз обязан быть определён в одном месте.
 */
export function slotsHashOf(bindings: readonly ResolvedSlotTuple[]): string {
  return sha256(canonicalStringify(slotsHashProjection(bindings)));
}

/**
 * Проекция дерева в пре-образ хэша. `children` кладётся **условным спредом** (§W6): набор глубины 1
 * обязан давать байт-в-байт тот же `slots_hash`, что до волны вложенности, — иначе она молча
 * инвалидировала бы все прод-кадры со слотами.
 */
function slotsHashProjection(bindings: readonly ResolvedSlotTuple[]): Record<string, unknown>[] {
  return bindings.map((binding) => ({
    slot: binding.slot, index: binding.index, componentId: binding.componentId,
    version: binding.version, bundleHash: binding.bundleHash, propsHash: binding.propsHash,
    ...(binding.children === undefined || binding.children.length === 0
      ? {}
      : { children: slotsHashProjection(binding.children) }),
  }));
}

/**
 * Применяется ли `cropLineage.rect` к байтам ассета (W5). Отсутствующий `sourceSurface` — это
 * legacy-семантика «ассет = экспорт родительского узла, вырезай», и она обязана остаться
 * побайтово прежней (D13). Объявленные `content-hug`/`paint` означают «уже вырезано»: rect
 * остаётся provenance'ом, и повторный crop (`136×32 → 116×12` из фидбэка) не случается.
 */
export function cropIsApplied(lineage: { sourceSurface?: CropSourceSurface } | undefined): boolean {
  if (lineage === undefined) return false;
  return lineage.sourceSurface === undefined || lineage.sourceSurface === "figma-node";
}

/**
 * Две проверки происхождения эталона (§W5):
 *
 * 1. **`crop_rect_out_of_bounds`** — rect, который применяется к ассету, обязан целиком в него
 *    помещаться. Сегодня воркер молча клампит вырезку по краям, то есть сравнивает не то, что
 *    объявлено; отказ при PUT дешевле, чем 49 случаев с тихо усечённым эталоном.
 * 2. **`crop_lineage_conflict`** — `referenceSurface:"content-hug"` вместе с crop'ом значит
 *    «вырежи из узла и получишь content-hug». Любой другой `sourceSurface` при этом утверждает,
 *    что ассет уже content-hug/paint, и одновременно требует его резать: два взаимоисключающих
 *    утверждения об одном ассете — отказ, а не выбор одного из них наугад.
 */
function validateCropLineage(manifest: CaseSetManifest, assetDims: Map<string, { width: number; height: number } | null>): void {
  for (const item of manifest.cases) {
    const lineage = item.cropLineage;
    if (lineage === undefined) continue;
    if (item.referenceSurface === "content-hug" && lineage.sourceSurface !== "figma-node") {
      throw new ApiError(422, "crop_lineage_conflict",
        `Case ${item.id} declares referenceSurface "content-hug" with a cropLineage, so the asset must be the parent node`
        + " export: set cropLineage.sourceSurface to \"figma-node\", or drop cropLineage if the asset is already cropped",
        { issues: [issue(["cases", item.id, "cropLineage", "sourceSurface"], `expected "figma-node", got ${JSON.stringify(lineage.sourceSurface ?? null)}`)] });
    }
    if (!cropIsApplied(lineage)) continue;
    const dims = item.referenceAssetId === undefined ? null : assetDims.get(item.referenceAssetId) ?? null;
    // Размеров нет (не-растр или доисторическая строка) — проверять нечем; выдумывать отказ хуже.
    if (dims === null) continue;
    const [x, y, width, height] = lineage.rect;
    if (x + width > dims.width || y + height > dims.height) {
      throw new ApiError(422, "crop_rect_out_of_bounds",
        `Case ${item.id}: cropLineage.rect [${lineage.rect.join(", ")}] does not fit the ${dims.width}×${dims.height} reference asset`,
        { issues: [issue(["cases", item.id, "cropLineage", "rect"], `rect exceeds the ${dims.width}×${dims.height} asset`)] });
    }
  }
}

/**
 * Warning «`expectedGeometry` похож на padded-канву» (§W5). Эвристика ровно та, что описал фидбэк:
 * автор, увидевший `264×160` в диагностике упавшего сравнения, вписывает эту канву в
 * `expectedGeometry`, и геометрия начинает судить layout-корень против канвы — 12/12 fail.
 *
 * Признак: `expectedGeometry` совпадает с размерами самого эталона (в его масштабе — 1× или dsf),
 * и вычитание `2×margin` всё ещё оставляет положительный корень. Это warning, не отказ: канва,
 * случайно равная корню, теоретически возможна, а блокировать PUT из-за похожести нельзя.
 */
function paddedCanvasWarnings(manifest: CaseSetManifest, assetDims: Map<string, { width: number; height: number } | null>): string[] {
  const dsf = manifest.capture.deviceScaleFactor ?? 2;
  const margin = COMPARISON_PAINT_MARGIN_PX;
  const warnings: string[] = [];
  for (const item of manifest.cases) {
    const expected = item.expectedGeometry;
    if (!expected || item.referenceSurface === "content-hug") continue;
    if (expected.width <= 2 * margin || expected.height <= 2 * margin) continue;
    const dims = item.referenceAssetId === undefined ? null : assetDims.get(item.referenceAssetId) ?? null;
    if (dims === null) continue;
    const matches = [1, dsf].some((scale) => dims.width === expected.width * scale && dims.height === expected.height * scale);
    if (!matches) continue;
    warnings.push(`case ${item.id}: expectedGeometry ${expected.width}×${expected.height} equals the reference canvas;`
      + ` expectedGeometry is the LAYOUT ROOT, not the padded comparison canvas (root is probably`
      + ` ${expected.width - 2 * margin}×${expected.height - 2 * margin}) — see referenceSurface:"content-hug"`);
  }
  return warnings;
}

/**
 * Потолок декартова произведения (план 2026-08-04 §W6, C5/C16). Считается **перемножением длин**,
 * поэтому 8 осей по 64 значения отвергаются за микросекунды — до того, как кто-нибудь попробует
 * материализовать 2.8·10^14 tuples. Вызывается и валидацией манифеста, и `coverageOf`: второй путь
 * достижим на уже сохранённых наборах (`GET /coverage`) и на манифестах, приехавших мимо PUT.
 */
export function assertCoverageWithinCeiling(manifest: CaseSetManifest): number {
  const expected = expectedTuplesOf(manifest.dimensions);
  if (expected > CASE_SET_MAX_EXPECTED_TUPLES) {
    const sizes = Object.entries(manifest.dimensions ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, values]) => `${name}=${values.length}`).join(" × ");
    throw new ApiError(422, "case_set_coverage_too_large",
      `The declared dimensions span ${Number.isFinite(expected) ? expected : "more than 2^53"} tuples (${sizes}),`
      + ` above the ceiling of ${CASE_SET_MAX_EXPECTED_TUPLES}; split the family or drop an axis from \`dimensions\``,
      { issues: [issue(["dimensions"], `Cartesian product exceeds ${CASE_SET_MAX_EXPECTED_TUPLES} tuples`)] });
  }
  return expected;
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
  // Потолок произведения — **до** любой работы с покрытием (C5/C16): это чистая арифметика над
  // длинами, и она обязана отсекать декартову бомбу раньше, чем кто-либо начнёт строить tuples.
  assertCoverageWithinCeiling(manifest);

  const byId = new Map<string, typeof manifest.cases[number]>();
  for (const item of manifest.cases) {
    if (byId.has(item.id)) throw new ApiError(422, "duplicate_case_id", `Duplicate case id: ${item.id}`);
    byId.set(item.id, item);
  }

  // Эталоны: существование в реестре ассетов (канон `parseFigmaInput`, `server/figma.ts`) и —
  // с W5 — сводимость `cropLineage.rect` с реальными размерами PNG.
  const assetDims = new Map<string, { width: number; height: number } | null>();
  for (const item of manifest.cases) {
    if (item.referenceAssetId === undefined) continue;
    const row = db.query("SELECT width,height FROM assets WHERE id=?")
      .get(item.referenceAssetId) as { width: number | null; height: number | null } | null;
    if (!row) {
      throw new ApiError(422, "asset_not_found", "A referenced case asset does not exist",
        { issues: [issue(["cases", item.id, "referenceAssetId"], `unknown asset: ${item.referenceAssetId}`)] });
    }
    assetDims.set(item.referenceAssetId, row.width !== null && row.height !== null ? { width: row.width, height: row.height } : null);
  }

  validateCropLineage(manifest, assetDims);

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
    // §A3: алиас наследует **кадр** цели, а кадр теперь зависит и от содержимого слотов. Алиас с
    // другими биндингами объявлял бы «сними один раз» про два разных изображения.
    if (dedupSlotsKeyOf(target.slotBindings) !== dedupSlotsKeyOf(item.slotBindings)) {
      throw new ApiError(422, "invalid_alias_target",
        `Case ${item.id} aliases ${item.aliasOf} but declares different slotBindings;`
        + " an alias must repeat both the props and the slot bindings of its target");
    }
  }

  // Per-case политика на алиасе (D16, план 2026-08-04): вердикт алиаса **всегда** идентичен
  // вердикту цели (D10), своей съёмки и своего сравнения у него нет. Допуск, адресованный алиасу,
  // не может быть исполнен ничем — это не «мягкое игнорирование», а объявленное намерение, которое
  // никогда не сбудется, поэтому отказ, а не warning.
  for (const [caseId, casePolicy] of Object.entries(manifest.policy?.perCase ?? {})) {
    const target = byId.get(caseId);
    if (target?.aliasOf !== undefined) {
      throw new ApiError(422, "per_case_policy_on_alias",
        `Case ${caseId} is an alias of ${target.aliasOf}; per-case policy must be declared on the alias target, not on the alias`);
    }
    // W3 (план 2026-08-06): «вся краска за контуром ожидаема» и «ожидаемо вот столько» — разные
    // намерения об одном вердикте. Молча выбрать одно из них сервер не вправе: бюджет, тихо
    // перекрытый `allowPaintOverflow: true`, никогда бы не сработал, и автор бы об этом не узнал.
    if (casePolicy.allowPaintOverflow !== undefined && casePolicy.overflowBudgetPx !== undefined) {
      throw new ApiError(422, "case_policy_conflict",
        `Case ${caseId} declares both allowPaintOverflow and overflowBudgetPx; keep the blanket allowance or the per-side budget, not both`,
        { issues: [issue(["policy", "perCase", caseId], "allowPaintOverflow and overflowBudgetPx are mutually exclusive")] });
    }
  }

  const warnings: string[] = [];
  // Слот-биндинги: опубликованные факты — жёсткие отказы, факты головы кандидата — warning'и (§A2).
  // Место в порядке проверок не случайно: после алиасов (их правило про биндинги уже применено) и
  // **до** дедупа — дедуп ниже опирается на биндинги, и опираться на непроверенные нельзя.
  validateSlotBindings(db, manifest, componentId, warnings);

  // Дубли props без `aliasOf`: явный отказ. Матрица обязана платить за каждый кадр осознанно.
  // Ключ — пара (props, слоты) (§A3): два состояния Figma, отличающиеся только содержимым слота,
  // это два разных кадра, и схлопывать их в `duplicate_case_props` было прямой причиной того, что
  // SMS-модуль не проходил приёмку. Манифест без биндингов вырождается ровно в прежний `propsHash`.
  const firstByDedupKey = new Map<string, string>();
  for (const item of manifest.cases) {
    const key = caseDedupKeyOf(item);
    const first = firstByDedupKey.get(key);
    if (first === undefined) { firstByDedupKey.set(key, item.id); continue; }
    if (item.aliasOf === undefined) {
      throw new ApiError(422, "duplicate_case_props",
        `Cases ${first} and ${item.id} declare identical props and slot bindings; mark the duplicate with aliasOf: "${first}"`);
    }
  }

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
  warnings.push(...paddedCanvasWarnings(manifest, assetDims));
  for (const item of manifest.cases) {
    if (item.referenceSurface === "content-hug" && item.expectedGeometry === undefined) {
      warnings.push(`case ${item.id}: referenceSurface "content-hug" without expectedGeometry —`
        + " the canonical canvas will be derived from the measured layoutBounds of the run");
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
 * защита от ручной правки БД, а не рабочий путь.
 *
 * Отказ — **именованный** `ApiError`, а не голый `Error` (план 2026-08-05, «Rollback policy»):
 * манифест со `slotBindings` не читается сборкой, выпущенной до этой волны (`strictObject` при
 * повторном разборе), и такой откат обязан деградировать в типизованный отказ с адресом набора, а
 * не в непрозрачную 500 где-то внутри promote. Статус — 422: запрос ссылается на набор, который
 * эта сборка сервера прочитать не может, и повтор запроса ничего не изменит.
 */
export function manifestOfRow(row: CaseSetRow): CaseSetManifest {
  const parsed = caseSetManifestSchema.safeParse(JSON.parse(row.manifest_json));
  if (!parsed.success) {
    throw new ApiError(422, "case_set_manifest_unreadable",
      `Stored case-set manifest ${row.case_set_id} cannot be read by this server build`
      + " (it was written by a newer build, or the row was edited by hand)",
      { issues: parsed.error.issues });
  }
  return parsed.data;
}

export interface CoverageReport {
  dimensions: Record<string, string[]>;
  expectedTuples: number;
  presentTuples: number;
  /** Первые `COVERAGE_MISSING_TUPLES_LIMIT` незакрытых ячеек; полное число — в `missingCount`. */
  missingTuples: Record<string, string>[];
  missingCount: number;
  /** `true` — список ячеек усечён (план 2026-08-04 §W6): читать `missingCount`, а не `.length`. */
  truncated: boolean;
  duplicates: { tuple: Record<string, string>; caseIds: string[] }[];
  /**
   * **Слот-осведомлённое** число кадров набора (§A5): случаи, которые действительно снимаются, то
   * есть не схлопнулись в алиас ни явным `aliasOf`, ни дедупом по паре (props, слоты). Ровно это
   * число агент подставляет в `expectedCases` promote'а — до слот-биндингов оно совпадало с числом
   * различных props, а теперь два состояния с одинаковыми props и разными слотами дают два кадра.
   */
  frameCases: number;
}

/**
 * Эффективная цель алиаса для каждого случая (`null` — случай снимается сам). Единственный источник
 * правды и для `buildCasesFromManifest`, и для `frameCases` покрытия: разъехавшись, они дали бы
 * `expectedCases`, не совпадающий с числом реально снятых кадров.
 */
function aliasTargetsOf(manifest: CaseSetManifest): Map<string, string | null> {
  const firstByDedupKey = new Map<string, string>();
  const targets = new Map<string, string | null>();
  for (const item of manifest.cases) {
    const key = caseDedupKeyOf(item);
    const first = firstByDedupKey.get(key);
    if (first === undefined && item.aliasOf === undefined) firstByDedupKey.set(key, item.id);
    targets.set(item.id, item.aliasOf ?? first ?? null);
  }
  return targets;
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
  const frameCases = [...aliasTargetsOf(manifest).values()].filter((target) => target === null).length;
  if (names.length === 0) {
    return {
      dimensions: {}, expectedTuples: 0, presentTuples: manifest.cases.length,
      missingTuples: [], missingCount: 0, truncated: false, duplicates: [], frameCases,
    };
  }
  // Первым делом — арифметика (C5/C16). Ниже стоит перебор произведения, и он допустим ровно
  // потому, что произведение уже доказано не превышающим потолок.
  const expectedTuples = assertCoverageWithinCeiling(manifest);
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

  // Одометр по осям вместо `flatMap`-материализации: полный список ячеек в памяти не нужен
  // никому — нужны их число и первые `COVERAGE_MISSING_TUPLES_LIMIT` незакрытых.
  const missingTuples: Record<string, string>[] = [];
  let missingCount = 0;
  const counters = names.map(() => 0);
  for (let index = 0; index < expectedTuples; index++) {
    const tuple: Record<string, string> = {};
    for (let axis = 0; axis < names.length; axis++) tuple[names[axis]!] = dimensions[names[axis]!]![counters[axis]!]!;
    if (!present.has(keyOf(tuple))) {
      missingCount += 1;
      if (missingTuples.length < COVERAGE_MISSING_TUPLES_LIMIT) missingTuples.push(tuple);
    }
    for (let axis = names.length - 1; axis >= 0; axis--) {
      counters[axis] = counters[axis]! + 1;
      if (counters[axis]! < dimensions[names[axis]!]!.length) break;
      counters[axis] = 0;
    }
  }

  const duplicates = [...present.values()].filter((entry) => entry.caseIds.length > 1)
    .map((entry) => ({ tuple: entry.tuple, caseIds: entry.caseIds }));
  return {
    dimensions: Object.fromEntries(names.map((name) => [name, dimensions[name]!])),
    expectedTuples,
    presentTuples: present.size,
    missingTuples,
    missingCount,
    truncated: missingCount > missingTuples.length,
    duplicates,
    frameCases,
  };
}

/**
 * Набор случаев рана из манифеста (аналог `buildCases` для examples-пути).
 *
 * **Не вызывать напрямую** (§A5): единственные легальные вызывающие — `casesOfRun` (все пути
 * оркестратора и evidence) и dry-run роут, который зовёт `casesOfRun` же. Разрешение слот-пинов —
 * свойство **построения набора**, а не одной точки вызова: раз забытое на одном из четырёх путей,
 * оно превращается в кадр, снятый с пустыми слотами, при том же `frame_fingerprint`.
 *
 * Алиасы: явный `aliasOf` манифеста, плюс дедуп поверх — на случай, когда манифест объявил алиас, а
 * пара совпала ещё с чьей-то (валидация выше это уже запретила, но набор строится оборонительно:
 * **пара (props, слоты) никогда не снимается дважды**, A7 + план 2026-08-05 §A3).
 *
 * Ключ дедупа — тот же `caseDedupKeyOf`, что у отказа `duplicate_case_props`. До слот-биндингов он
 * был только `propsHash`, и этого хватало, чтобы набор, прошедший PUT с двумя состояниями одних
 * props и разных слотов, всё равно схлопывался здесь в один кадр (алиасы не снимаются вовсе,
 * `orchestrator.ts:517`) — то есть матрица выглядела бы пройденной, ничего не проверив.
 * Ключ считается по **манифесту**, до разрешения пинов, поэтому порядок построения не меняется.
 */
export function buildCasesFromManifest(manifest: CaseSetManifest): AcceptanceCase[] {
  if (manifest.cases.length > acceptanceMaxCasesPerRun) {
    throw new ApiError(422, "case_set_too_large",
      `Case set exceeds the per-run limit of ${acceptanceMaxCasesPerRun} cases (${manifest.cases.length} declared)`);
  }
  const cases: AcceptanceCase[] = [];
  const targets = aliasTargetsOf(manifest);
  for (const item of manifest.cases) {
    const propsHash = propsHashOf(item.props);
    cases.push({
      caseId: item.id,
      caseKey: item.id,
      props: item.props,
      propsHash,
      aliasOfCaseId: targets.get(item.id) ?? null,
      referenceAssetId: item.referenceAssetId ?? null,
      expectedGeometry: item.expectedGeometry ?? null,
      casePolicyHash: casePolicyHashOf(manifest, item.id),
      declaredPolicyProfile: manifest.policy?.profile ?? null,
      // W3: допуски геометрии (`allowPaintOverflow`/`expectedClip`) — вход вердикта гейта, а не
      // только материал хэша; без них манифест объявлял бы намерение, которого никто не читает.
      ...(manifest.policy?.perCase?.[item.id] ? { casePolicy: manifest.policy.perCase[item.id] } : {}),
      // W5a: происхождение эталона — вход нормализации размеров гейта `visual`.
      ...(item.cropLineage ? { cropLineage: item.cropLineage } : {}),
      // W5: чем является ассет и куда он кладётся в канонической канве. Дефолты **не**
      // подставляются здесь: отсутствующее поле обязано остаться отсутствующим до самого
      // `comparisonFingerprint`, иначе legacy-манифесты сменили бы отпечаток (D13).
      ...(item.referenceSurface ? { referenceSurface: item.referenceSurface } : {}),
      ...(item.referencePlacement ? { referencePlacement: item.referencePlacement } : {}),
      // W5b: координата случая в семье — вход `variantFamily` группировки ремедиаций.
      ...(item.dims ? { dims: item.dims } : {}),
    });
  }
  if (!cases.some((item) => item.aliasOfCaseId === null)) {
    throw new ApiError(422, "empty_case_set", "Every case aliased away; nothing to capture");
  }
  return cases;
}

// ------------------------------------------- разрешение слот-пинов набора (§A5, T2.1)

/**
 * Режим разрешения биндингов (§A5). Два режима — не оптимизация, а два **разных вопроса**:
 *
 * - `"gating"` (постановка рана, dry-run/PUT-parity): «можно ли вообще снимать эту матрицу?».
 *   Полная политика статусов §A2 плюс факты головы кандидата — принадлежность именованного слота
 *   `extracted.meta.slots` и объявленный `capabilities.namedSlots`. Отказ — 422 до создания рана.
 * - `"reconstruction"` (восстановление набора уже бегущего рана после потери памяти процесса):
 *   «чем этот ран был поставлен?». Пины были авторизованы на постановке, поэтому режим **слеп к
 *   статусу и к надгробию**: архивация или soft-delete ребёнка посреди рана не имеет права
 *   изменить отпечатки уже созданных случаев — иначе восстановленный набор считал бы другой
 *   `frame_fingerprint`, чем персистированный, и весь durable-инвариант рассыпался бы. Отказ —
 *   только на физически отсутствующей строке публикации (строки публикаций не удаляются; отказ
 *   оборонительный).
 *
 * v3.1/F3: съёмка архивированного ребёнка всё равно невозможна (`ComponentRepo.bundle` не отдаёт
 * нерендерабельные статусы) — и это правильно: реконструкция отвечает за отпечатки и evidence, а
 * невозможность снять кадр обязана всплыть **именованным** отказом капчур-гейта
 * (`slot_component_not_published` в `gates[].detail` случая), а не тихо подменить набор.
 */
export type SlotResolutionMode = "gating" | "reconstruction";

export interface ResolveSlotBindingsInput {
  db: Database;
  /** Субъект приёмки: его ДС фильтрует пины, а совпадение с ребёнком — self-reference (ловится при PUT). */
  componentId: string;
  designSystem: string | null;
  /**
   * Голова кандидата — источник фактов о слотах. `null` означает «кандидата нет» (dry-run): его
   * факты проверять нечем, и они остаются warning'ами PUT, а не отказом (§A5, dry-run).
   */
  candidateEntry: CandidateEntry | null;
  manifest: CaseSetManifest;
  cases: AcceptanceCase[];
  mode: SlotResolutionMode;
}

/**
 * Разрешает объявленные манифестом биндинги в `ResolvedSlotBinding[]` + `slotsHash` (§A3/§A5).
 *
 * Порядок — это кадр: слоты обходятся в порядке ключей манифеста, дети — в порядке массива, а
 * `index` — позиция ребёнка **внутри своего слота**. Дефолтный слот участвует наравне с
 * именованными (§A2a) и в дереве съёмки представляется отсутствием `slot`.
 *
 * Инвариант «отсутствует, а не пусто»: случай без биндингов возвращается **тем же объектом**, а
 * пустой объект биндингов (`{}`, схема его допускает) не создаёт ни `slotBindings`, ни `slotsHash` —
 * иначе slot-free наборы сменили бы кадровый отпечаток (§A4).
 */
export function resolveSlotBindings(input: ResolveSlotBindingsInput): AcceptanceCase[] {
  const bindingsById = new Map(input.manifest.cases
    .filter((item) => item.slotBindings !== undefined)
    .map((item) => [item.id, item.slotBindings!] as const));
  if (bindingsById.size === 0) return input.cases;

  // Мемоизация в пределах одного разрешения — та же мера, что в `validateSlotBindings`: потолок
  // набора (64 × 8 × 12) иначе дал бы тысячи одинаковых запросов на каждую постановку рана.
  const memo = new Map<string, PublishedSlotPin | null>();
  const pinOf = (name: string, version: number): PublishedSlotPin | null => {
    const key = `${version} ${name}`;
    if (!memo.has(key)) {
      memo.set(key, input.mode === "gating"
        ? publishedPinByNameAndVersion(input.db, name, version, input.designSystem)
        // Реконструкция: без ДС-фильтра, без фильтра надгробия и без разбора статуса — вопрос
        // ровно один, «существует ли строка публикации».
        : publishedPinByNameAndVersion(input.db, name, version, null, { includeDeleted: true }));
    }
    return memo.get(key) ?? null;
  };

  const meta = input.candidateEntry?.extracted?.meta ?? null;
  const declaredSlots = new Set<string>(Array.isArray(meta?.slots) ? meta.slots : []);
  const namedSlotsCapable = meta?.capabilities?.namedSlots === true;

  /**
   * Разрешение одного уровня. `hostSlots`/`hostCapable` — факты того, в чьи слоты кладут: у корня
   * это голова кандидата, у вложенного уровня (§W6) — `definition_meta` запиненной публикации
   * родителя. `null`-факты означают «судить нечем» и проверку членства снимают.
   */
  const resolveLevel = (
    caseId: string,
    bindings: CaseSetSlotBindings,
    host: { slots: Set<string>; capable: boolean; name: string } | null,
  ): ResolvedSlotBinding[] => {
    const resolved: ResolvedSlotBinding[] = [];
    for (const [slot, children] of Object.entries(bindings)) {
      // Факты головы кандидата — жёсткий отказ **на старте рана** (при PUT это были warning'и):
      // здесь голова уже зафиксирована кандидатом, и снимать матрицу, чей слот компонент не
      // объявляет, значит снимать пустой слот и объявить матрицу пройденной. Дефолтный слот из
      // обеих проверок исключён целиком (§A2a) — на любом уровне дерева.
      if (input.mode === "gating" && host !== null && slot !== DEFAULT_SLOT_KEY) {
        if (!host.capable) {
          throw new ApiError(422, "slot_bindings_unsupported",
            `Case ${caseId} binds the named slot "${slot}", but ${host.name} declares no`
            + " capabilities.namedSlots; only the default slot can be bound for it");
        }
        if (!host.slots.has(slot)) {
          throw new ApiError(422, "slot_unknown",
            `Case ${caseId} binds the slot "${slot}", which is not among the named slots of`
            + ` ${host.name} (${[...host.slots].sort().join(", ") || "none"})`);
        }
      }
      children.forEach((child, index) => {
        const pin = pinOf(child.type, child.version);
        if (!pin) {
          throw new ApiError(422, "slot_component_not_published",
            `Case ${caseId}: slot "${slot}" binds ${child.type} v${child.version}, which is not a published`
            + " component version");
        }
        if (input.mode === "gating" && !SLOT_PIN_ACCEPTED_STATUS.has(pin.status)) {
          throw new ApiError(422, "slot_component_not_published",
            `Case ${caseId}: slot "${slot}" binds ${child.type} v${child.version}, whose publish status is`
            + ` ${pin.status} and does not render`);
        }
        const props = child.props ?? {};
        // Вложенный уровень разрешается **до** записи родителя: `children` обязан быть отсутствующим
        // ключом, а не пустым массивом (инвариант «отсутствует, а не пусто» — §A4).
        const nested = child.slotBindings === undefined ? [] : resolveLevel(caseId, child.slotBindings, slotHostOf(pin));
        resolved.push({
          slot, index,
          componentId: pin.componentId,
          name: pin.name,
          version: pin.version,
          bundleHash: pin.bundleHash,
          props,
          propsHash: propsHashOf(props),
          ...(nested.length === 0 ? {} : { children: nested }),
        });
      });
    }
    return resolved;
  };

  return input.cases.map((item) => {
    const bindings = bindingsById.get(item.caseId);
    if (bindings === undefined) return item;
    const resolved = resolveLevel(item.caseId, bindings,
      meta === null ? null : { slots: declaredSlots, capable: namedSlotsCapable, name: `candidate ${input.componentId}` });
    if (resolved.length === 0) return item;
    return { ...item, slotBindings: resolved, slotsHash: slotsHashOf(resolved) };
  });
}

export type CasesOfRunInput = Omit<ResolveSlotBindingsInput, "cases">;

/**
 * **Единственный** легальный способ построить набор случаев рана из манифеста (§A5).
 *
 * `buildCasesFromManifest` + `resolveSlotBindings` — одна операция, потому что случай без
 * разрешённых пинов это не «случай попроще», а случай с другим кадром: тот же
 * `frame_fingerprint`, но пустые слоты на картинке. Все потребители обязаны звать именно эту
 * функцию: постановка рана (`orchestrator.startRun`), durable-реконструкция (`orchestrator.runCases`),
 * evidence (`manifestOf`) и dry-run (`routes/caseSets.ts`). Исключение ровно одно и оно
 * задокументировано у места вызова — `baselineVerdictPolicies`: снимок вердиктной политики не
 * читает ни одного слот-поля, и разрешать там пины значило бы ходить в БД за фактами, которые
 * никуда не войдут (и отказывать по чужому, давно завершённому рану).
 */
export function casesOfRun(input: CasesOfRunInput): AcceptanceCase[] {
  return resolveSlotBindings({ ...input, cases: buildCasesFromManifest(input.manifest) });
}
