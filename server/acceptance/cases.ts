/**
 * Набор верификационных случаев run'а (план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md`
 * §2 A2/A7, §5 W1a; RFC §4.2).
 *
 * Источник случаев в W1a — **именованные examples кандидата** (`definition.examples`, они же
 * `bootstrap.examples` капчур-поверхности). Case-set-манифест (`component_case_sets`) приезжает
 * в W2 и заменит этот источник, поэтому здесь нет ни одной ссылки на будущую таблицу: набор
 * строится из уже посаженного `CandidateEntry.extracted.meta`.
 *
 * Два инварианта постановки:
 * - **Потолок проверяется до дедупа** (план §4, мера 4): `acceptanceMaxCasesPerRun` ограничивает
 *   заявленный набор, а не то, что от него осталось после схлопывания алиасов, — иначе клиент мог
 *   бы прислать 500 одинаковых случаев и пройти лимит.
 * - **Дубликат props становится алиасом, а не вторым капчуром** (A7): `alias_of_case_id`
 *   указывает на первый случай с тем же `propsHash`; съёмка одна, вердикт наследуется (D10).
 */
import { ApiError } from "../http";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import type { CropSourceSurface, ReferenceSurface } from "../../src/acceptance/caseSetSchema";
import type { CandidateEntry } from "../components/candidates";
import type { CasePolicyValues, CaseSurface } from "./ids";
import { acceptanceMaxCasesPerRun } from "./policies";

/**
 * Поверхность съёмки по умолчанию. Общая на набор (в W2 её задаёт `capture` манифеста), входит в
 * `case_fingerprint` — менять её значение без bump'а `CASE_FINGERPRINT_ALGO_VERSION` нельзя:
 * накопленный reuse относится к другой поверхности.
 */
export const DEFAULT_CASE_SURFACE: CaseSurface = { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" };

/**
 * Charset имён случаев (W2 задаёт его для манифеста; здесь он применяется к `caseId`, потому что
 * из `caseId` строятся имена записей evidence — защита от zip-slip и от путей вне run-каталога).
 */
export const CASE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/**
 * Тот же алгоритм, что `propsHashOf` капчур-сервиса (`server/screenshot/service.ts`) и
 * `propsHashBrowser` поверхности: sha256 канонизованного JSON. Дублируется намеренно — серверная
 * функция не экспортирована, а зона W1a не правит `screenshot/service.ts`; расхождение поймал бы
 * exact-match handshake капчура.
 */
export function propsHashOf(props: unknown): string {
  return sha256(canonicalStringify(props ?? {}));
}

/**
 * Разрешённая привязка ребёнка слота (план `docs/plans/2026-08-05-slot-acceptance.md` §A3/A4).
 *
 * Манифест case-set объявляет ребёнка **по имени и точной версии** (`{type, version, props}`), а
 * сервер разрешает пин в неизменяемую строку публикации: отсюда `componentId`/`bundleHash`, без
 * которых кадр невоспроизводим (то же соображение, что у замороженных пинов прототипа,
 * `src/capture/protocol.ts`). `index` — позиция ребёнка внутри своего слота, то есть **порядок
 * рендера**: два одинаковых набора детей в разном порядке дают разные пиксели и обязаны давать
 * разные отпечатки.
 *
 * `name` и `props` в кадровый отпечаток не входят (их представляют `componentId`+`version` и
 * `propsHash`), но нужны потребителям: bootstrap капчур-поверхности и evidence.
 */
export interface ResolvedSlotBinding {
  /** Ключ слота; `default` — неявный слот `children` (§A2a). */
  slot: string;
  /** Позиция внутри слота, с нуля: порядок рендера входит в кадр. */
  index: number;
  componentId: string;
  /** Имя опубликованного компонента (глобально уникально, не переименовывается). */
  name: string;
  version: number;
  bundleHash: string;
  props: Record<string, unknown>;
  propsHash: string;
  /**
   * Вложенные дети (план 2026-08-06 §W6): собственные слоты этого ребёнка, уже разрешённые до
   * опубликованных пинов. **Отсутствует, а не пусто** — набор глубины 1 обязан давать прежние
   * `slotsHash` и кадровый отпечаток.
   */
  children?: ResolvedSlotBinding[];
}

export interface AcceptanceCase {
  caseId: string;
  caseKey: string;
  props: Record<string, unknown>;
  propsHash: string;
  /** Целевой случай, чей вердикт наследуется (дубликат props), либо `null`. */
  aliasOfCaseId: string | null;
  /**
   * Поля case-set-пути (W2). Examples-путь их не заполняет: у именованного example нет ни эталона,
   * ни ожидаемых габаритов, ни per-case политики — вместо них действуют заглушки `ids.ts`.
   */
  referenceAssetId?: string | null;
  expectedGeometry?: { width: number; height: number } | null;
  casePolicyHash?: string;
  /**
   * `policy.profile` case-set-манифеста — **декларация** набора о том, по какому профилю он
   * задуман. Ран исполняется профилем запроса (`policyId`), но декларация входит в вердиктный слой
   * отпечатка (D-B): её смена меняет смысл вердикта, и переиспользовать старый нельзя.
   */
  declaredPolicyProfile?: string | null;
  /**
   * Сами per-case допуски манифеста (W2), а не только их хэш: гейт `geometry` v2 (W3) читает
   * `allowPaintOverflow`/`expectedClip` как вход вердикта. Хэш остаётся ключом инвалидации reuse,
   * значения — входом политики; дублирования нет, это две разные роли одного объекта.
   */
  casePolicy?: CasePolicyValues;
  /**
   * Происхождение эталона (§19.5 фидбэка): прямоугольник внутри родительского узла Figma. Читает
   * его нормализация размеров гейта `visual` (W5a) — эталон обрезается до кадра случая **до**
   * сравнения, иначе вырезка из макета никогда не сойдётся с paint-кадром компонента.
   */
  cropLineage?: { parentNodeId?: string; rect: [number, number, number, number]; sourceSurface?: CropSourceSurface };
  /**
   * Чем является ассет эталона (W5, фидбэк P1): `"paint"` — уже каноническая канва случая
   * (сегодняшнее поведение и дефолт потребителя), `"content-hug"` — вырезка по содержимому,
   * которую сервер сам паддит до канвы. Вход слоя сравнения: его смена ⇒ re-diff, не recompute.
   */
  referenceSurface?: ReferenceSurface;
  /** Смещение content-hug эталона в канве, device px; по умолчанию `margin × dsf` (W5). */
  referencePlacement?: { x: number; y: number };
  /**
   * Координаты случая в измерениях семьи (`cases[].dims` манифеста W2). В `case_fingerprint` не
   * входят намеренно: смена координаты не меняет ни съёмку, ни вердикт — это ярлык для отчёта.
   * Читает их группировка ремедиаций (W5b): общие значения измерений участников группы образуют
   * её `variantFamily`.
   */
  dims?: Record<string, string>;
  /**
   * Ключи маркеров для детальных измерений геометрии (≤20; пусто — корневой маркер, W3).
   * Манифест их пока не объявляет: контракт готов, поверхность в case-set появится вместе с
   * потребителем, а не «на всякий случай».
   */
  geometryDetailKeys?: string[];
  /**
   * Разрешённые дети слотов (§A4), в порядке рендера. **Инвариант: отсутствует, а не `[]`/`null`** —
   * `canonicalStringify` выбрасывает только `undefined`, поэтому пустой массив дал бы другой
   * кадровый отпечаток, чем случай вовсе без слотов, и молча инвалидировал бы весь накопленный
   * reuse slot-free наборов. Заполняет поле только `resolveSlotBindings` (case-set-путь);
   * examples-путь слотов не знает.
   */
  slotBindings?: ResolvedSlotBinding[];
  /**
   * sha256 разрешённого кортежа `[{slot,index,componentId,version,bundleHash,propsHash}]` — тот же
   * пре-образ, что у кадрового слоя отпечатка (§A3). Персистится (`acceptance_cases.slots_hash`,
   * миграция v31) и служит ключом покрытия, рукопожатия капчура и evidence. В отпечатки **не
   * входит**: он производная уже захэшированных по значениям входов кадра. Тот же инвариант
   * «отсутствует, а не пусто».
   */
  slotsHash?: string;
}

/** `caseId` из имени example: сам ключ, если он в charset, иначе стабильный хэш-суррогат. */
export function caseIdOf(caseKey: string): string {
  return CASE_NAME_PATTERN.test(caseKey) ? caseKey : `case_${sha256(caseKey).slice(0, 32)}`;
}

/**
 * Examples кандидата. `definition.examples` — канон (до 8 штук, extract их уже провалидировал);
 * одиночный `definition.example` поддержан как случай `example`, иначе компонент со старым
 * определением не имел бы ни одного случая.
 */
export function candidateExamples(entry: CandidateEntry): Record<string, Record<string, unknown>> {
  const meta = entry.extracted?.meta;
  if (!meta) return {};
  if (meta.examples !== undefined && Object.keys(meta.examples).length > 0) return meta.examples;
  if (meta.example !== undefined) return { example: meta.example };
  return {};
}

export interface BuildCasesInput {
  /** Явный набор (в W1a — из тела запроса); по умолчанию — examples кандидата. */
  cases?: { key: string; props: Record<string, unknown> }[];
  maxCases?: number;
}

/**
 * Строит набор случаев run'а. Доменные отказы — те же коды, что в RFC §4.2:
 * `422 empty_case_set` (нечего снимать) и `422 case_set_too_large` (потолок ёмкости).
 */
export function buildCases(entry: CandidateEntry, input: BuildCasesInput = {}): AcceptanceCase[] {
  const source = input.cases ?? Object.entries(candidateExamples(entry))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, props]) => ({ key, props }));
  if (source.length === 0) {
    throw new ApiError(422, "empty_case_set", "Candidate has no named examples to verify; publish definition.examples or pass an explicit case set");
  }
  const max = input.maxCases ?? acceptanceMaxCasesPerRun;
  if (source.length > max) {
    throw new ApiError(422, "case_set_too_large", `Case set exceeds the per-run limit of ${max} cases (${source.length} requested)`);
  }
  const cases: AcceptanceCase[] = [];
  const byPropsHash = new Map<string, string>();
  const seenIds = new Set<string>();
  for (const item of source) {
    const caseId = caseIdOf(item.key);
    if (seenIds.has(caseId)) {
      throw new ApiError(422, "duplicate_case_id", `Duplicate case id after normalization: ${caseId}`);
    }
    seenIds.add(caseId);
    const propsHash = propsHashOf(item.props);
    const target = byPropsHash.get(propsHash);
    if (target === undefined) byPropsHash.set(propsHash, caseId);
    cases.push({ caseId, caseKey: item.key, props: item.props, propsHash, aliasOfCaseId: target ?? null });
  }
  // Все случаи схлопнулись в алиасы без цели — конструктивно невозможно (первый всегда цель),
  // но инвариант проверяется явно: D10 требует отказа, а не пустого прогона.
  if (!cases.some((item) => item.aliasOfCaseId === null)) {
    throw new ApiError(422, "empty_case_set", "Every case aliased away; nothing to capture");
  }
  return cases;
}
