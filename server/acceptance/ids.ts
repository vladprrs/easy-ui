/**
 * Идентичность candidate acceptance: build fingerprint, candidate id, case fingerprint, run id.
 *
 * Источники: RFC `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md` §5 (+амендмент D1)
 * и план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md` §3 D1.
 *
 * Два инварианта, которые здесь нельзя нарушать:
 *
 * 1. **Всё component-scoped.** `candidate_id` содержит `componentId`+`designSystem`+`rev`, а
 *    `case_fingerprint` — `candidateId`. Один `source_hash` законно принадлежит нескольким
 *    компонентам (`server/components/candidates.ts`, `componentIds` — множество), поэтому ключ
 *    без `componentId` коллидировал бы между компонентами и давал cross-owner disclosure через
 *    reuse (триаж E1/B1).
 * 2. **Политика вне сборочного отпечатка.** `policyProfileHash` в `build_fingerprint` не входит
 *    (триаж V12: политика — вход вердикта, не сборки); он живёт на ране. `catalogRevision` вне
 *    идентичности по той же причине — это глобальный хэш каталога.
 *
 * Канонизация — общая `canonicalStringify` (та же, что для propsHash/bundleHash), поэтому порядок
 * ключей во входном объекте на хэш не влияет.
 */
import { canonicalStringify } from "../../src/capture/canonicalJson";
import {
  comparisonSurfaceProjection, verdictSurfaceProjection,
  type ClipExpectation, type ExpectedSurfaces, type GeometrySurface,
} from "../../src/acceptance/surfaces";
import { GEOMETRY_CONTRACT_VERSION, GEOMETRY_OWNERSHIP_CONTRACT_VERSION } from "../../src/capture/geometry.mjs";
import { canonicalReadinessPolicy, DEFAULT_READINESS_POLICY, type ReadinessPolicy } from "../../src/capture/readinessPolicy";
import { captureV4Enabled, COMPARISON_POLICY_VERSION } from "../capture/captureV4";
import { GEOMETRY_OWNERSHIP_POLICY_VERSION, geometryOwnershipEnabled } from "../capture/geometryOwnership";
import { rendererFingerprint } from "../capture/renderer";
import type { AcceptanceCase, RunOverlayNode } from "./cases";
import type { AcceptancePolicy, GateMode, GateName, GeometryTolerances, VisualTolerances } from "./policies";

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

const hashOf = (payload: unknown): string => sha256(canonicalStringify(payload));

/**
 * Версия схемы `case_fingerprint`. Каждая волна, меняющая смысл входов (W2 — case-set-политики,
 * W3 — geometry 2.0, W4 — readiness/env, W5a — визуальный гейт), **обязана** её поднять: это
 * единственный механизм автоматической инвалидации накопленного reuse. Признанная плата за
 * поэтапность (план §3 D1).
 *
 * **История номера — честная, без задним числом переписанных обещаний.**
 *
 * - Версия 5 объявлялась «последней запланированной» (W5a family-плана), и пакет
 *   renderer-contract-2 (§2.2 N5) объявлял **ровно один** bump — в R1, где менялась схема входа
 *   (`captureEnvFingerprint` → `rendererFingerprint`). К моменту R1 значение уже было 5, поэтому
 *   номер тогда не двигался: вход поменял и имя ключа, и значение.
 * - **Версия 6 — санкционированный второй bump** (план `docs/plans/2026-08-04-acceptance-pipeline-feedback.md`,
 *   решение D-B). Отпечаток случая перестал быть плоским: он расслоён на `frameFingerprint`
 *   (входы съёмки), `comparisonFingerprint` (входы сравнения) и `verdictPolicyHash` (входы
 *   вердикта), а examples-путь перестал хэшировать заглушку `CASE_POLICY_HASH_V0` вместо реального
 *   профиля рана. Это другая модель случая, а не другие значения внутри прежней, поэтому
 *   накопленный прод-кэш обязан быть инвалидирован — плата признана планом (D-B, §W1).
 *
 * - **Версия 7 — санкционированный третий bump** (план `docs/plans/2026-08-05-slot-acceptance.md`,
 *   §A4). Кадр случая перестал быть кадром одиночного компонента: в него может входить дерево
 *   **запинованных опубликованных детей** слотов (`slotBindings`). Ни один прежний вход при этом
 *   не поменял ни имени, ни значения — slot-free случай хэшируется байт-в-байт как раньше
 *   (`frameFingerprint` не версионируется, инвариант закреплён golden-тестом
 *   `f29b0c49…` в `ids.test.ts`), — поэтому формально можно было бы номер не двигать. Двигаем
 *   осознанно: модель случая расширилась, и накопленные вердикты сняты **без** знания о детях;
 *   держать их валидными значило бы обещать, что старый вердикт учитывал слоты. Плата —
 *   глобальная инвалидация reuse; она отрабатывает пересчётом и re-diff'ом без пересъёмки, но
 *   **только пока включён `EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE=1`** (иначе каскад
 *   короткозамыкается в `runner.ts`, и семьи уедут в полную пересъёмку).
 *
 * Инвариант «в пакете renderer-contract-2 bump ровно один» остался верен для **того** пакета;
 * bump'ы 6 и 7 принадлежат другим планам и закреплены тестами `server/capture/renderer.test.ts` и
 * `server/acceptance/ids.test.ts` уже как «версия === 7».
 */
export const CASE_FINGERPRINT_ALGO_VERSION = 7;

/**
 * Хэш readiness-политики (W4) — тот же алгоритм, что у клиента
 * (`src/capture/readinessPolicy.ts#readinessPolicyHash`): sha256 канонизованной политики. Здесь
 * он синхронный (Bun), там — через WebCrypto; вход общий, поэтому значения совпадают, и гейт
 * `readiness` сверяет опубликованный поверхностью хэш именно с этим.
 */
export function readinessPolicyHashOf(policy: ReadinessPolicy): string {
  return sha256(canonicalReadinessPolicy(policy));
}

export const DEFAULT_READINESS_POLICY_HASH = readinessPolicyHashOf(DEFAULT_READINESS_POLICY);

/**
 * Отпечаток рендерера (план 2026-08-03 renderer-contract-2 §3 E1, §5 R1).
 *
 * Снятый `captureEnvFingerprintOf` был `sha256({platform, arch, readinessPolicyHash})` — то есть
 * **не менялся от апгрейда chromium**, и reuse `acceptance_case_results` переживал смену
 * рендерера (дыра §1.3 того плана). Теперь на его месте `rendererFingerprint`: объявленный,
 * серверный, до-капчурный отпечаток фактически запускаемого бинаря, шрифтового стека образа,
 * детерминизм-флагов запуска и той же readiness-политики (`server/capture/renderer.ts`).
 *
 * Наблюдённая проба окружения (`src/capture/env.ts#observedCaptureEnvFingerprint`) осталась
 * наблюдением: она снимается **в странице**, приезжает в evidence и метрики гейта `readiness`,
 * но ключом reuse быть не может — `case_fingerprint` считается до съёмки.
 */
export const DEFAULT_RENDERER_FINGERPRINT = rendererFingerprint(DEFAULT_READINESS_POLICY_HASH);
/**
 * Заглушка per-case политики для examples-пути: у именованного example манифеста нет, а значит
 * нет ни профиля, ни допусков. Case-set-путь (W2) подставляет вместо неё `casePolicyHashOf`
 * (`caseSets.ts`).
 *
 * **С ALGO 6 она больше не входит в отпечаток случая** (план 2026-08-04, D-B): вердиктный слой
 * хэширует реальную эффективную политику рана по значениям, поэтому examples-ран под
 * `--policy pixel-strict-v1` инвалидирует reuse честно, а не притворяется, что политики нет.
 * Константа осталась значением колонки `acceptance_cases.case_policy_hash` (она NOT NULL и
 * читается отчётами), но ключом reuse — нет.
 */
export const CASE_POLICY_HASH_V0 = "case-policy-v0";

/**
 * Поле вокруг компонента в кадре `probe:"paint"` — вход **нормализации канвы** сравнения
 * (`DEFAULT_PAINT_MARGIN_PX`, `server/screenshot/service.ts:120`). Продублировано здесь константой,
 * а не импортом: `ids.ts` — фундамент идентичности, и тянуть в него капчур-помпу ради одного
 * числа значило бы завести цикл импорта ради читаемости. Расхождение поймал бы тест
 * `ids.test.ts` («канва сравнения = layout + 2×margin×dsf»).
 */
export const COMPARISON_PAINT_MARGIN_PX = 64;

/**
 * **История входов сборочного отпечатка — почему W9 его не трогала.**
 *
 * Волна runtime schema defaults (план 2026-08-07 §1.6, §W9) вводит опт-ин
 * `capabilities.runtimeSchemaDefaults`, который меняет то, какие props доезжают до компонента, —
 * то есть меняет пиксели. Естественным рефлексом было бы добавить его сюда четвёртым входом.
 * Этого делать **не нужно и нельзя**: capability объявляется в **исходнике** компонента, значит
 * уже учтён `sourceHash`, значит `buildFingerprint` и производный `candidateId` сдвигаются сами.
 * Отдельное поле было бы вторым учётом того же факта — и первым в этом файле входом, который
 * невозможно получить из артефактов сборки (пришлось бы тащить сюда разобранную meta).
 *
 * Требование AC §11.2 («default semantics входят в candidate fingerprint») выполнено этим же
 * путём; дифференциальный тест «добавление флага в исходник сдвигает candidate id» стоит в
 * `ids.test.ts` и доказывает именно механизм `sourceHash`, а не совпадение чисел.
 *
 * Аварийный `EASYUI_RUNTIME_DEFAULTS_DISABLED` в отпечатки не входит **сознательно**
 * (render-affecting, триаж O-m16): env — не свойство сборки, и хэшировать окружение процесса
 * значило бы делать отпечатки невоспроизводимыми. Цена названа и оплачена в другом месте —
 * предупреждением `runtime_defaults_disabled` в `accept-status`
 * (`server/components/runtimeDefaults.ts`).
 */
export interface BuildFingerprintInput {
  sourceHash: string;
  bundleHash: string;
  hostAbiVersion: number;
  /** `= designSystemMetaVersion` (факт receipt); `null` для ДС без темы. */
  themeVersion: number | null;
}

export function buildFingerprint(input: BuildFingerprintInput): string {
  return hashOf({
    sourceHash: input.sourceHash,
    bundleHash: input.bundleHash,
    hostAbiVersion: input.hostAbiVersion,
    themeVersion: input.themeVersion,
  });
}

export interface CandidateIdInput {
  componentId: string;
  designSystem: string;
  rev: number;
  buildFingerprint: string;
}

export function candidateId(input: CandidateIdInput): string {
  return `cand_${hashOf({
    componentId: input.componentId,
    designSystem: input.designSystem,
    rev: input.rev,
    buildFingerprint: input.buildFingerprint,
  })}`;
}

export const CANDIDATE_ID_PATTERN = /^cand_[0-9a-f]{64}$/;
export const isCandidateId = (value: string): boolean => CANDIDATE_ID_PATTERN.test(value);

export interface CaseSurface {
  viewport: { width: number; height: number };
  dsf: number;
  theme: string;
  /**
   * Режим поверхности (план 2026-08-06 §W5 T5c.2). Внутренний ключ намеренно называется `mode`, а
   * не `surface`: поле манифеста — `capture.surface`, и `surface.surface` в `FIELD_LAYERS` читалось
   * бы как опечатка.
   *
   * **Отсутствует** у hug-поверхности (и у всякого доволнового набора) — кладётся условным спредом
   * в `surfaceOfManifest`, поэтому пре-образ `frameFingerprint` существующих кейсов остаётся
   * байт-в-байт прежним, а хеши не сдвигаются.
   */
  mode?: "viewport";
}

// ------------------------------------------------ три слоя отпечатка (D-B)

/**
 * **Слой 1 — кадр.** Ровно те входы, от которых зависят сами пиксели: кто снимается, что
 * снимается, на какой поверхности, по какой политике готовности и каким рендерером. Совпал
 * frameFingerprint — значит, пересъёмка ничего нового не даст, и кадр из CAS законно
 * переиспользуется (re-diff/recompute).
 */
export interface FrameFingerprintInput {
  candidateId: string;
  caseKey: string;
  propsHash: string;
  surface: CaseSurface;
  readinessPolicyHash: string;
  rendererFingerprint: string;
  /**
   * Дети слотов (план 2026-08-05 §A4), в порядке рендера. Подмножество `ResolvedSlotBinding`:
   * `name`/`props` сюда не едут — имя однозначно определяется `componentId`, а значения props уже
   * представлены `propsHash`.
   *
   * **Хэшируется условно** (`definedOnly`): `frameFingerprint` не версионируется, поэтому
   * slot-free вход обязан давать байт-в-байт тот же хэш, что до появления слотов. Пустой массив
   * нормализуется в «поля нет» — иначе `[]` отличался бы от отсутствия и тихо инвалидировал бы
   * прод-кэш (инвариант «отсутствует, а не пусто», `cases.ts#ResolvedSlotBinding`).
   */
  slotBindings?: readonly FrameSlotBinding[];
  /**
   * **Candidate dependency overlay** случая (волна 2026-08-07 §W3), в порядке `componentId`.
   * Кадровый слой по существу: узел overlay подменяет байты, которые рисуются внутри кадра.
   *
   * Кладётся **условным спредом** (`definedOnly`): `frameFingerprint` не версионируется, поэтому
   * overlay-free вход обязан давать байт-в-байт тот же хэш, что до волны, — это доказывает
   * golden-тест `ids.test.ts`.
   */
  candidateOverlay?: readonly RunOverlayNode[];
  /**
   * **Поле краски случая по сторонам** (BR-02, план 2026-08-08 §2). Кадровый вход по существу: с
   * другим полем это буквально другие пиксели (другой размер растра и другое место компонента в нём).
   *
   * Кладётся **условным спредом** (`definedOnly`): `frameFingerprint` не версионируется, поэтому
   * случай без объявленного поля обязан давать байт-в-байт тот же хэш, что до волны, — это
   * доказывает дифференциальный golden-тест `ids.test.ts`. Тот же паттерн, что у `slotBindings` и
   * `candidateOverlay`.
   */
  paintPaddingPx?: { top: number; right: number; bottom: number; left: number };
  /**
   * **Хэш содержимого темы** субъекта (BR-03, план 2026-08-08 §3, ревью M6). Кадровый вход по
   * существу: иконки темы рисуются внутри кадра, а их версия до волны в отпечаток не входила —
   * барьер дожидался бы реестра, а переиспользовался бы растр с прежней иконкой.
   *
   * Условный спред (`definedOnly`), тот же паттерн, что у `paintPaddingPx`: при выключенной волне
   * ключа нет вовсе, и `frameFingerprint` остаётся байт-в-байт доволновым (golden-тест `ids.test.ts`).
   */
  themeContentHash?: string;
  /**
   * **Владение геометрией узлов** случая (BR-05, план 2026-08-08 §5). Кадровый вход не по
   * пикселям, а по **контракту измерения**: кейс с декларацией требует кадра, снятого волной
   * (`preTransformBounds`, роли узлов, decoration-прозрачный `rootBounds`), и переиспользовать под
   * него доволновой кадр нельзя — восстанавливать decoration-семантику из фактов, которых в нём
   * нет, значило бы выдумывать их. Именно поэтому такой кейс заодно получает
   * `geometryContractVersion: 3`.
   *
   * Условный спред (`definedOnly`), тот же паттерн, что у `paintPaddingPx`/`themeContentHash`:
   * кейс без декларации даёт байт-в-байт доволновой `frameFingerprint`.
   */
  geometryOwnership?: Readonly<Record<string, { role: string; participatesIn: readonly string[] }>>;
}

/** Кадровое подмножество разрешённой привязки слота (`ResolvedSlotBinding` без `name`/`props`). */
export interface FrameSlotBinding {
  slot: string;
  index: number;
  componentId: string;
  /** Отсутствует у overlay-узла (§W3): его место занимает `candidate.candidateId`. */
  version?: number;
  bundleHash: string;
  propsHash: string;
  /** Overlay-происхождение ребёнка (§W3); в пре-образ едет **только** `candidateId`. */
  candidate?: { candidateId: string };
  /**
   * Вложенные дети (план 2026-08-06 §W6). Кладётся **условным спредом** ровно так же, как само
   * поле `slotBindings`: дерево глубины 1 обязано давать байт-в-байт прежний `frameFingerprint`,
   * иначе волна вложенности молча инвалидировала бы каждый прод-кадр со слотами.
   */
  children?: readonly FrameSlotBinding[];
}

/** Проекция дерева слотов в пре-образ кадрового отпечатка (рекурсивна с W6). */
function frameSlotProjection(bindings: readonly FrameSlotBinding[]): Record<string, unknown>[] {
  return bindings.map((child) => ({
    slot: child.slot,
    index: child.index,
    componentId: child.componentId,
    // §W3: у пиннутого ребёнка — версия, у overlay-узла — `candidate: {candidateId}` на её месте.
    // Оба ключа условны, поэтому пиннутое дерево остаётся байт-в-байт доволновым.
    ...(child.version === undefined ? {} : { version: child.version }),
    ...(child.candidate === undefined ? {} : { candidate: { candidateId: child.candidate.candidateId } }),
    bundleHash: child.bundleHash,
    propsHash: child.propsHash,
    ...(child.children === undefined || child.children.length === 0
      ? {}
      : { children: frameSlotProjection(child.children) }),
  }));
}

/**
 * `geometryContractVersion` — кадровый вход, а не bump `CASE_FINGERPRINT_ALGO_VERSION` (план
 * 2026-08-06 §1.3, находка F1): ALGO в `frameFingerprint` **не входит**, поэтому его подъём
 * оставил бы прод-кадры валидными и тихо перенёс бы вердикты со старой семантикой `layoutBounds`
 * на новую. Условный спред `> 1` держит до-W2 значение (`1`) байт-нейтральным: включи его
 * безусловно — и сдвинулись бы даже кадры, снятые до появления самого понятия версии.
 *
 * Второй параметр — **только для тестов** (дифференциальная проверка «смена версии ⇒ другой
 * кадр» и воспроизведение до-W2 golden'а); рабочий путь его не передаёт.
 */
export function frameFingerprint(
  input: FrameFingerprintInput,
  geometryContractVersion: number = GEOMETRY_CONTRACT_VERSION,
): string {
  const slots = input.slotBindings !== undefined && input.slotBindings.length > 0
    ? frameSlotProjection(input.slotBindings)
    : undefined;
  // BR-05: контракт измерения кейса с объявленным владением — 3. Условность **манифестная**
  // (известна до съёмки), а не «по результату измерения»: отпечатки считаются при постановке рана
  // и как ключ reuse, поэтому условность по факту замера дала бы кейсу два разных fingerprint
  // (блокер B1 раунда 2 ревью плана).
  const contractVersion = input.geometryOwnership === undefined
    ? geometryContractVersion
    : GEOMETRY_OWNERSHIP_CONTRACT_VERSION;
  return hashOf(definedOnly({
    candidateId: input.candidateId,
    caseKey: input.caseKey,
    propsHash: input.propsHash,
    surface: input.surface,
    readinessPolicyHash: input.readinessPolicyHash,
    rendererFingerprint: input.rendererFingerprint,
    slotBindings: slots,
    // §W3: пустой overlay нормализуется в «поля нет» той же мерой, что и пустое дерево слотов.
    candidateOverlay: input.candidateOverlay !== undefined && input.candidateOverlay.length > 0
      ? input.candidateOverlay.map((node) => ({ ...node }))
      : undefined,
    // BR-03: тот же условный вход — выключенная волна не кладёт ключа, кадр прежний.
    themeContentHash: input.themeContentHash,
    // BR-02: поля нет — ключа нет вовсе (`definedOnly`), поэтому доволновой кадр байт-в-байт прежний.
    paintPaddingPx: input.paintPaddingPx === undefined
      ? undefined
      : {
        top: input.paintPaddingPx.top, right: input.paintPaddingPx.right,
        bottom: input.paintPaddingPx.bottom, left: input.paintPaddingPx.left,
      },
    // BR-05: декларация владения — вход **и** значением, и версией контракта измерения. Значение
    // различает две разные декларации; версия говорит «этот кадр обязан быть снят волной».
    geometryOwnership: input.geometryOwnership === undefined
      ? undefined
      : Object.fromEntries(Object.entries(input.geometryOwnership)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => [key, { role: value.role, participatesIn: [...value.participatesIn] }])),
    ...(contractVersion > 1 ? { geometryContractVersion: contractVersion } : {}),
  }));
}

/**
 * `overlay_hash` рана (§W3, миграция v33): sha256 канонизованного списка резолвнутых узлов.
 *
 * Отдельная величина, а не производная `frameFingerprint`: promote сверяет **набор ранов** на
 * идентичность графа зависимостей (`422 overlay_hash_mismatch`) до всякого разбора кадров, а
 * кадровые отпечатки у разных шардов семьи различны по построению.
 */
export function overlayHashOf(nodes: readonly RunOverlayNode[]): string {
  return hashOf(nodes.map((node) => ({ ...node })));
}

/**
 * **Слой 2 — сравнение.** Входы, которые меняют **метрики** расхождения, не трогая кадр: эталон,
 * его нормализация и допуск сводимости размеров. Инвариант D1: любое поле, участвующее в
 * построении нормализованного эталона (`padTo`/placement/crop), обязано быть здесь — иначе его
 * смену «пересчитали» бы по старым метрикам, что и есть тихий stale-вердикт.
 *
 * `referenceSurface`/`referencePlacement`/`cropLineage.sourceSurface` — поля W5 (content-hug
 * reference). `undefined` канонизуется **отсутствием ключа**, поэтому манифест, который их не
 * объявляет, даёт ровно тот же `comparisonFingerprint`, что до W5: инвариант неизменности legacy
 * (D13) держится здесь, а не только в гейте.
 */
export interface ComparisonFingerprintInput {
  referenceAssetId: string | null;
  /** W5-слот: `"content-hug" | "paint"`. */
  referenceSurface?: string | null;
  /** W5-слот: смещение эталона внутри канонической канвы. */
  referencePlacement?: { x: number; y: number } | null;
  cropLineage?: { parentNodeId?: string; rect: readonly number[]; sourceSurface?: string } | null;
  /**
   * W4-слот: декларативный контракт сравнения случая (`comparison.matte`). Матирование меняет
   * **входы** диффа — обе картинки кладутся на объявленный цвет до любой метрики, — поэтому его
   * смена обязана давать re-diff сохранённого кадра, а не пересчёт по старым числам.
   */
  comparison?: { matte?: string } | null;
  /**
   * W4-слот: именованный пресет бюджета растрового текста. Тоже слой сравнения, хотя читает его
   * вердикт: пресет опирается на `edgeResidual`, которого в доволновых метриках нет вовсе, и
   * «пересчитать» его по сохранённым числам невозможно — честный путь один, re-diff.
   */
  textAaBudget?: string | null;
  /** Ожидаемые габариты layout-корня: они же определяют `padTo` нормализации (D1). */
  expectedGeometry?: { width: number; height: number } | null;
  /**
   * Четыре поверхности геометрии (волна 2026-08-07). В **этот** слой входит только проекция
   * `referenceExport`: она описывает сам эталон, то есть вход нормализации канвы. Ожидания
   * `root`/`layoutUnion`/`paint` мерит браузер — они вердиктные, и гнать из-за них re-diff значило
   * бы платить сравнением за арифметику (N15).
   */
  expectedSurfaces?: ExpectedSurfaces | null;
  /** Поверхность, в координатах которой строится канва: чистый вход сравнения. */
  comparisonSurface?: GeometrySurface | null;
  /** Допуск сводимости размеров профиля (`policy.visual.maxDimensionDeltaPx`). */
  maxDimensionDeltaPx: number;
  /** Параметры канвы кадра: поле вокруг компонента и плотность пикселей. */
  paintMarginPx: number;
  deviceScaleFactor: number;
  /**
   * **Версия политики сравнения** (BR-04, план 2026-08-08 §4). Кладётся условным спредом ровно
   * тогда, когда capture-группа волны активна (`EASYUI_CAPTURE_V4_DISABLED` снят), и это её
   * единственный механизм инвалидации: точная канва при объявленном `padTo`, запрет неявного
   * zero-pad, процент по поверхности сравнения и проверка масштаба эталона меняют **смысл кода**, не
   * трогая ни одного поля манифеста, — сохранённые под старой семантикой метрики обязаны перестать
   * переиспользоваться (ревью B2 раунда 2).
   *
   * Почему не bump `CASE_FINGERPRINT_ALGO_VERSION`: ALGO инвалидирует **весь** накопленный reuse,
   * включая случаи без канвы сравнения, которых волна не касается вовсе. Условный спред двигает
   * ровно слой сравнения и ровно у тех кейсов, которые по новым правилам и сравниваются.
   */
  comparisonPolicyVersion?: number;
}

const definedOnly = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

export function comparisonFingerprintOf(input: ComparisonFingerprintInput): string {
  return hashOf(definedOnly({
    referenceAssetId: input.referenceAssetId,
    referenceSurface: input.referenceSurface ?? undefined,
    referencePlacement: input.referencePlacement ?? undefined,
    cropLineage: input.cropLineage === null || input.cropLineage === undefined
      ? undefined
      : definedOnly({
        parentNodeId: input.cropLineage.parentNodeId,
        rect: [...input.cropLineage.rect],
        sourceSurface: input.cropLineage.sourceSurface,
      }),
    comparison: input.comparison === null || input.comparison === undefined
      ? undefined
      : definedOnly({ matte: input.comparison.matte }),
    textAaBudget: input.textAaBudget ?? undefined,
    expectedGeometry: input.expectedGeometry ?? undefined,
    // Проекция, а не всё поле: объявление одного лишь `root` обязано оставить сравнение нетронутым.
    // Пустая проекция канонизуется отсутствием ключа — доволновой случай байт-в-байт прежний.
    expectedSurfaces: comparisonSurfaceProjection(input.expectedSurfaces),
    comparisonSurface: input.comparisonSurface ?? undefined,
    maxDimensionDeltaPx: input.maxDimensionDeltaPx,
    paintMarginPx: input.paintMarginPx,
    deviceScaleFactor: input.deviceScaleFactor,
    // BR-04: ключа нет при выключенной группе — доволновое сравнение байт-в-байт прежнее.
    comparisonPolicyVersion: input.comparisonPolicyVersion,
  }));
}

/**
 * **Слой 3 — вердикт.** Снимок эффективной политики случая **по значениям**, а не по хэшу: без
 * значений дельта старой и новой политики невычислима, а без дельты пересчёт вердикта пришлось бы
 * заменять слепым переносом (D0/D14). Именно этот объект пишется в
 * `acceptance_case_results.verdict_policy_json`, а его хэш — в `verdict_policy_hash` (валидатор
 * снимка: не сошёлся ⇒ снимок не наш ⇒ recapture).
 */
/**
 * Значения per-case политики манифеста (`policy.perCase.<id>`) — один тип на все три роли:
 * вердиктный снимок, вход отпечатка и вход гейта. Держать три копии литерала было бы приглашением
 * их разъехать (W3, план 2026-08-06).
 */
export interface CasePolicyValues {
  maxRawDiffPct?: number;
  allowPaintOverflow?: boolean;
  expectedClip?: boolean;
  sizeDeltaPx?: number;
  overflowBudgetPx?: { top?: number; right?: number; bottom?: number; left?: number };
}

export interface VerdictPolicySnapshot {
  policyProfileId: string;
  /** Роли гейтов эффективной политики рана (`requireVisual` набора уже применён). */
  gates: Record<GateName, GateMode>;
  requireVisual: boolean;
  allowExceptions: boolean;
  /** Профильный потолок визуального расхождения. */
  maxRawDiffPct: number;
  geometry: { overflowPx: number; sizeDeltaPx: number; offsetPx: number };
  /**
   * Per-case допуски манифеста (W2) — они же перекрывают профильные. W3 (план 2026-08-06)
   * добавляет числа: `sizeDeltaPx` (побеждает `geometry.sizeDeltaPx`) и per-side
   * `overflowBudgetPx`. Оба — вердиктный слой: их смена пересчитывается без пересъёмки.
   */
  perCase: CasePolicyValues | null;
  /**
   * Именованный пресет бюджета растрового текста случая (W4). Двухслойное поле — как
   * `expectedGeometry`: он и вход сравнения (требует `edgeResidual`), и вход вердикта (сдвигает
   * `fail → pass`), поэтому его дельта обязана быть **видимой** пересчёту, а не только промахом
   * `comparisonFingerprint`.
   *
   * Кладётся **условным спредом** в `verdictPolicySnapshotOf`: ключ со значением `null` у каждого
   * случая сдвинул бы `verdictPolicyHash` всего накопленного прод-кэша.
   */
  textAaBudget?: string;
  /** Ожидаемые габариты: вход допусков геометрии (и, в W5, нормализации эталона — D1). */
  expectedGeometry: { width: number; height: number } | null;
  /**
   * Вердиктная проекция поверхностей (`root`/`layoutUnion`/`paint`) и ожидание клипа — оба
   * **условным спредом** при явной декларации (§1.1, N3): ключ со значением `null` у каждого случая
   * сдвинул бы `verdict_policy_hash` всего накопленного прод-кэша, то есть прогнал бы вердиктный
   * каскад по корпусу ради поля, которого ни один доволновой манифест не объявлял.
   *
   * `comparisonSurface` сюда **не** входит: он вход сравнения, а не вердикта (триаж C-m1).
   */
  expectedSurfaces?: ExpectedSurfaces;
  clipExpectation?: ClipExpectation;
  /** `policy.profile` манифеста: декларация набора, влияющая на смысл вердикта. */
  declaredPolicyProfile: string | null;
  /**
   * **Владение геометрией узлов** случая (BR-05) — вердиктная половина двухслойного поля: краска
   * объявленного узла перестаёт блокировать, а поверхность `paint` наблюдается с поправкой на
   * владение. Условный спред: ключ со значением `null` у каждого случая сдвинул бы
   * `verdict_policy_hash` всего накопленного прод-кэша.
   */
  geometryOwnership?: Readonly<Record<string, { role: string; participatesIn: readonly string[] }>>;
  /**
   * **Версия политики вердикта волны владения геометрией** (BR-05,
   * `server/capture/geometryOwnership.ts`). Кладётся условным спредом ровно тогда, когда группа
   * активна, и это единственный механизм инвалидации **авто-правила**: оно не меняет ни одного
   * пикселя и ни одного поля манифеста, а меняет прочтение уже снятых фактов, — то есть стоит
   * recompute'а, а не пересъёмки. Симметрично `comparisonPolicyVersion` слоя сравнения (BR-04).
   */
  geometryOwnershipPolicyVersion?: number;
}

export function verdictPolicyHashOf(snapshot: VerdictPolicySnapshot): string {
  return hashOf(snapshot);
}

/** Структурный минимум случая, нужный отпечаткам. Полный тип — `AcceptanceCase` (`cases.ts`). */
export interface CaseFingerprintCase {
  caseKey: string;
  propsHash: string;
  referenceAssetId?: string | null;
  expectedGeometry?: { width: number; height: number } | null;
  cropLineage?: { parentNodeId?: string; rect: readonly number[]; sourceSurface?: string } | null;
  casePolicy?: CasePolicyValues;
  declaredPolicyProfile?: string | null;
  /** W5-слоты (см. `ComparisonFingerprintInput`). */
  referenceSurface?: string | null;
  referencePlacement?: { x: number; y: number } | null;
  /** W4-слоты сравнения (см. `ComparisonFingerprintInput`); `textAaBudget` ещё и вердиктный. */
  comparison?: { matte?: string } | null;
  textAaBudget?: string | null;
  /**
   * Поверхности геометрии (волна 2026-08-07). Двухслойное поле, но **не** двумя копиями значения:
   * в сравнение уезжает проекция `referenceExport`, в вердикт — `root|layoutUnion|paint`.
   */
  expectedSurfaces?: ExpectedSurfaces | null;
  comparisonSurface?: GeometrySurface | null;
  clipExpectation?: ClipExpectation | null;
  /**
   * Дети слотов (план 2026-08-05 §A4). Поле обязано быть **и здесь, и в `caseFingerprintsOf`**:
   * тотальность `FIELD_LAYERS` доказывает только то, что слой у поля объявлен, но не то, что поле
   * доехало до хэша, — молчаливый пропуск здесь дал бы «классифицировано как frame, а кадр не
   * двигает». Поэтому дифференциальные тесты стоят на уровне `caseFingerprintsOf`, а не
   * `frameFingerprint`.
   */
  slotBindings?: readonly FrameSlotBinding[];
  /**
   * Overlay набора (§W3). Как и `slotBindings`, поле обязано быть **и здесь, и в
   * `caseFingerprintsOf`**: тотальность `FIELD_LAYERS` доказывает только объявленный слой, но не
   * то, что значение доехало до хэша.
   */
  candidateOverlay?: readonly RunOverlayNode[];
  /**
   * Поле краски по сторонам (BR-02). Как `slotBindings`/`candidateOverlay`, поле обязано быть **и
   * здесь, и в `caseFingerprintsOf`**: тотальность `FIELD_LAYERS` доказывает только объявленный
   * слой, но не то, что значение доехало до пре-образа хэша.
   */
  paintPaddingPx?: { top: number; right: number; bottom: number; left: number } | null;
  /**
   * Хэш содержимого темы (BR-03). Как и поля выше, обязан быть **и здесь, и в `caseFingerprintsOf`**:
   * объявленный слой не доказывает, что значение доехало до пре-образа хэша.
   */
  themeContentHash?: string | null;
  /**
   * Владение геометрией узлов (BR-05). Как и поля выше, обязано быть **и здесь, и в
   * `caseFingerprintsOf`**: объявленный слой не доказывает, что значение доехало до пре-образа.
   */
  geometryOwnership?: Readonly<Record<string, { role: string; participatesIn: readonly string[] }>> | null;
}

export function verdictPolicySnapshotOf(policy: AcceptancePolicy, item: CaseFingerprintCase): VerdictPolicySnapshot {
  const surfaces = verdictSurfaceProjection(item.expectedSurfaces);
  return {
    policyProfileId: policy.id,
    gates: { ...policy.gates },
    requireVisual: policy.requireVisual,
    allowExceptions: policy.allowExceptions,
    maxRawDiffPct: policy.visual.maxRawDiffPct,
    geometry: { ...policy.geometry },
    perCase: item.casePolicy ? { ...item.casePolicy } : null,
    ...(item.textAaBudget === undefined || item.textAaBudget === null ? {} : { textAaBudget: item.textAaBudget }),
    ...(surfaces === undefined ? {} : { expectedSurfaces: surfaces }),
    ...(item.clipExpectation === undefined || item.clipExpectation === null ? {} : { clipExpectation: item.clipExpectation }),
    expectedGeometry: item.expectedGeometry ?? null,
    declaredPolicyProfile: item.declaredPolicyProfile ?? null,
    ...(item.geometryOwnership === undefined || item.geometryOwnership === null
      ? {}
      : { geometryOwnership: item.geometryOwnership }),
    // BR-05: точка чтения тумблера одна на продукт — постановка рана и раннер не могут разойтись.
    ...(geometryOwnershipEnabled() ? { geometryOwnershipPolicyVersion: GEOMETRY_OWNERSHIP_POLICY_VERSION } : {}),
  };
}

export interface CaseFingerprintInput {
  algoVersion: number;
  frame: string;
  comparison: string;
  verdictPolicy: string;
}

/** Итоговый ключ полного reuse: совпали все три слоя — совпал и вердикт. */
export function caseFingerprint(input: CaseFingerprintInput): string {
  return hashOf({
    algoVersion: input.algoVersion,
    frame: input.frame,
    comparison: input.comparison,
    verdictPolicy: input.verdictPolicy,
  });
}

export interface CaseFingerprints {
  frame: string;
  comparison: string;
  verdictPolicy: string;
  case: string;
  verdictPolicySnapshot: VerdictPolicySnapshot;
}

export interface CaseFingerprintsInput {
  candidateId: string;
  surface: CaseSurface;
  /** **Эффективная** политика рана (`requireVisual` набора уже применён `effectivePolicy`). */
  policy: AcceptancePolicy;
  case: CaseFingerprintCase;
}

/**
 * Единственный расчёт отпечатков случая (D7): его зовёт и постановка (`createRun`), и раннер.
 * Двух реализаций быть не должно — расхождение между ними означало бы, что `case_fingerprint`
 * строки рана и строки результата разные, и reuse промахивался бы всегда (тест «case_fingerprint
 * строки рана == строки результата»).
 */
export function caseFingerprintsOf(input: CaseFingerprintsInput): CaseFingerprints {
  const readinessHash = readinessPolicyHashOf(input.policy.readiness);
  const frame = frameFingerprint({
    candidateId: input.candidateId,
    caseKey: input.case.caseKey,
    propsHash: input.case.propsHash,
    surface: input.surface,
    readinessPolicyHash: readinessHash,
    rendererFingerprint: rendererFingerprint(readinessHash),
    // Условный спред той же формы, что у W5-слотов сравнения ниже: поле, которого нет, не должно
    // появиться ключом со значением `undefined` — и, что важнее, оно не должно быть **забыто**
    // здесь (гейт `FIELD_LAYERS` этого не ловит). Пустой массив нормализует `frameFingerprint`.
    ...(input.case.slotBindings === undefined ? {} : { slotBindings: input.case.slotBindings }),
    // §W3: тот же условный спред. Overlay-free набор обязан остаться байт-в-байт доволновым.
    ...(input.case.candidateOverlay === undefined ? {} : { candidateOverlay: input.case.candidateOverlay }),
    // BR-02: тот же условный спред. Случай без объявленного поля обязан остаться доволновым.
    ...(input.case.paintPaddingPx === undefined || input.case.paintPaddingPx === null
      ? {}
      : { paintPaddingPx: input.case.paintPaddingPx }),
    // BR-03: тот же условный спред. Набор, снятый при выключенной волне, остаётся доволновым.
    ...(input.case.themeContentHash === undefined || input.case.themeContentHash === null
      ? {}
      : { themeContentHash: input.case.themeContentHash }),
    // BR-05: тот же условный спред. Случай без декларации остаётся доволновым байт-в-байт.
    ...(input.case.geometryOwnership === undefined || input.case.geometryOwnership === null
      ? {}
      : { geometryOwnership: input.case.geometryOwnership }),
  });
  const comparison = comparisonFingerprintOf({
    referenceAssetId: input.case.referenceAssetId ?? null,
    ...(input.case.referenceSurface === undefined ? {} : { referenceSurface: input.case.referenceSurface }),
    ...(input.case.referencePlacement === undefined ? {} : { referencePlacement: input.case.referencePlacement }),
    ...(input.case.cropLineage === undefined ? {} : { cropLineage: input.case.cropLineage }),
    // W4: тот же условный спред. Поле, которого нет, обязано отсутствовать вплоть до пре-образа
    // хэша — иначе каждый уже снятый случай сменил бы `comparisonFingerprint` без единой причины.
    ...(input.case.comparison === undefined ? {} : { comparison: input.case.comparison }),
    ...(input.case.textAaBudget === undefined ? {} : { textAaBudget: input.case.textAaBudget }),
    // Тот же условный спред: поле, которого нет, обязано отсутствовать вплоть до пре-образа хэша.
    ...(input.case.expectedSurfaces === undefined ? {} : { expectedSurfaces: input.case.expectedSurfaces }),
    ...(input.case.comparisonSurface === undefined ? {} : { comparisonSurface: input.case.comparisonSurface }),
    expectedGeometry: input.case.expectedGeometry ?? null,
    maxDimensionDeltaPx: input.policy.visual.maxDimensionDeltaPx,
    paintMarginPx: COMPARISON_PAINT_MARGIN_PX,
    deviceScaleFactor: input.surface.dsf,
    // BR-04: версия семантики сравнения — условный вход. Точка чтения тумблера одна на продукт
    // (`captureV4Enabled`), поэтому постановка рана и раннер не могут разойтись в отпечатке.
    ...(captureV4Enabled() ? { comparisonPolicyVersion: COMPARISON_POLICY_VERSION } : {}),
  });
  const snapshot = verdictPolicySnapshotOf(input.policy, input.case);
  const verdictPolicy = verdictPolicyHashOf(snapshot);
  return {
    frame,
    comparison,
    verdictPolicy,
    case: caseFingerprint({ algoVersion: CASE_FINGERPRINT_ALGO_VERSION, frame, comparison, verdictPolicy }),
    verdictPolicySnapshot: snapshot,
  };
}

// ------------------------------------- тотальность разбиения полей по слоям (D3)

/**
 * Слой, в который поле входит. `report-only` — единственное значение, означающее «в отпечатки не
 * входит вовсе», и оно требует **письменного** обоснования у каждого поля: молчаливое «нигде» —
 * ровно та дыра, из-за которой смена `expectedGeometry`/`cropLineage` давала полный stale reuse.
 */
export type FieldLayer = "frame" | "comparison" | "verdict" | "report-only";

type PolicyLeaf =
  | Exclude<keyof AcceptancePolicy, "visual" | "geometry">
  | `visual.${keyof VisualTolerances}`
  | `geometry.${keyof GeometryTolerances}`;
type CaseLeaf = keyof AcceptanceCase;
type SurfaceLeaf = `surface.${keyof CaseSurface}`;

/** Все поля, влияющие на случай приёмки. Новое поле обязано появиться здесь — иначе не соберётся. */
export type LayeredField = PolicyLeaf | CaseLeaf | SurfaceLeaf;

/**
 * Разбиение полей политики и случая по слоям отпечатка (D3).
 *
 * Тотальность держится **типом**: `satisfies Record<LayeredField, …>` не даст добавить поле в
 * `AcceptancePolicy`/`AcceptanceCase`/`CaseSurface`, не назвав его слой. Дефолт для нового поля —
 * `"frame"` (перестраховка: лишняя пересъёмка дешевле тихого stale-вердикта), но выбирается он
 * человеком осознанно, а не выводится молчанием.
 */
export const FIELD_LAYERS = {
  // --- политика профиля
  id: ["verdict"],
  gates: ["verdict"],
  requireVisual: ["verdict"],
  allowExceptions: ["verdict"],
  "visual.maxRawDiffPct": ["verdict"],
  // Допуск сводимости размеров решает, состоится ли сравнение вообще, — это вход нормализации.
  "visual.maxDimensionDeltaPx": ["comparison"],
  "geometry.overflowPx": ["verdict"],
  "geometry.sizeDeltaPx": ["verdict"],
  "geometry.offsetPx": ["verdict"],
  // Политика readiness исполняется поверхностью **во время съёмки**: её смена меняет кадр.
  readiness: ["frame"],
  // Выборка determinism решает, снимается ли случай дважды.
  determinismSampleSize: ["frame"],
  maxInfraRetries: ["frame"],
  // Ёмкость и дедлайн рана: ни кадра, ни метрик, ни вердикта случая не меняют.
  maxJobsPerRun: ["report-only"],
  runDeadlineMs: ["report-only"],

  // --- случай
  caseKey: ["frame"],
  propsHash: ["frame"],
  props: ["frame"],
  geometryDetailKeys: ["frame"],
  referenceAssetId: ["comparison"],
  cropLineage: ["comparison"],
  // W5: чем является ассет и куда он кладётся в канве — входы построения нормализованного эталона,
  // а значит comparison по инварианту D1. Кадр они не трогают: пересъёмка их не касается.
  referenceSurface: ["comparison"],
  referencePlacement: ["comparison"],
  // W4: matte меняет **входы** сравнения (обе картинки ложатся на объявленный цвет до метрик) —
  // чистый comparison-слой, кадр он не трогает.
  comparison: ["comparison"],
  // …а пресет — двухслойный: он читается вердиктом, но опирается на `edgeResidual`, которого в
  // доволновых метриках нет, поэтому его появление обязано пройти re-diff, а не recompute.
  textAaBudget: ["comparison", "verdict"],
  // D1: `expectedGeometry` — двухслойное поле. Оно и допуск вердикта геометрии, и (с W5) `padTo`
  // нормализации content-hug эталона, поэтому его смена обязана давать re-diff, а не recompute.
  expectedGeometry: ["comparison", "verdict"],
  // Волна 2026-08-07: объединение двух проекций (N15). Слой объявлен как union, а хэшируется поле
  // **по проекциям**: `referenceExport` → comparison (re-diff), `root|layoutUnion|paint` → verdict
  // (дешёвый recompute). Одна общая декларация со сплитом в реализации честнее, чем два поля-
  // близнеца в манифесте.
  expectedSurfaces: ["comparison", "verdict"],
  // Поверхность сравнения меняет **канву**, то есть вход диффа: чистый comparison.
  comparisonSurface: ["comparison"],
  // Ожидание клипа — утверждение о фактах, уже снятых кадром: пересчитывается без единого пикселя.
  clipExpectation: ["verdict"],
  casePolicy: ["verdict"],
  // Хэш per-case политики манифеста — производная `casePolicy`/`requireVisual`, уже учтённых по
  // значениям; с ALGO 6 он в отпечатки не входит (см. `CASE_POLICY_HASH_V0`).
  casePolicyHash: ["report-only"],
  // Идентичность строки, не вход вердикта: `caseId` адресует случай, `aliasOfCaseId` говорит, что
  // своей съёмки у него нет (вердикт наследуется от цели один-в-один).
  caseId: ["report-only"],
  aliasOfCaseId: ["report-only"],
  // Координата случая в семье — ярлык отчёта (§W5b): ни кадра, ни метрик, ни вердикта.
  dims: ["report-only"],
  declaredPolicyProfile: ["verdict"],
  // Дети слотов рисуются внутри кадра: их состав, версии, бандлы, props и **порядок** — прямые
  // входы пикселей, значит кадровый слой (план 2026-08-05 §A4).
  slotBindings: ["frame"],
  // §W3 (волна 2026-08-07): узлы overlay подменяют байты **внутри кадра** — их состав, кандидаты и
  // бандлы это прямые входы пикселей, значит кадровый слой. Цена принята планом (триаж C-m10):
  // поле общее на набор, поэтому узел, не дотягивающийся до конкретного кейса, всё равно двигает
  // его кадр; дедуп по достижимости не строится.
  candidateOverlay: ["frame"],
  // Хэш разрешённого дерева слотов — производная `slotBindings`, уже захэшированных по значениям
  // кадровым слоем (та же логика, что у `casePolicyHash`). Он живёт как ключ покрытия, рукопожатия
  // капчура и evidence, но входом отпечатка быть не должен: иначе один и тот же факт учитывался бы
  // дважды, а рассинхрон хэша со своими же значениями стал бы неотличим от смены состава детей.
  slotsHash: ["report-only"],
  // BR-02 (план 2026-08-08 §2): поле краски по сторонам — прямой вход пикселей (другой размер
  // растра, другое место компонента в нём), значит кадровый слой. Канву сравнения оно **не**
  // двигает: comparison margin остаётся comparison-owned, а кандидатский растр приводится к канве
  // перед диффом, поэтому второго слоя (`comparison`) у поля нет и re-diff оно не стоит.
  paintPaddingPx: ["frame"],
  // BR-03: hint предзагрузки. `report-only` с письменным обоснованием (D3 требует его у каждого
  // такого поля): подсказка не меняет ни пикселей, ни метрик, ни вердикта — сервер обязан
  // обнаружить ресурсы сам, а вход отпечатка означал бы, что чужая подсказка гонит пересъёмку.
  preloadAssets: ["report-only"],
  // BR-03 (план 2026-08-08 §3, ревью M6): хэш содержимого темы — прямой вход пикселей (иконки
  // темы рисуются внутри кадра), значит кадровый слой. Канву сравнения он не двигает: эталон
  // приезжает файлом и от темы не зависит.
  themeContentHash: ["frame"],
  // BR-05 (план 2026-08-08 §5): владение геометрией — **двухслойное** поле, и оба слоя настоящие.
  // `frame`: декларация требует кадра, снятого под контрактом измерения 3 (доволновой кадр не
  // несёт `preTransformBounds`, и восстановить по нему decoration-семантику нечем) — поэтому
  // такой кейс заодно получает `geometryContractVersion: 3`. `verdict`: она же меняет прочтение
  // фактов (краска декорации не блокирует, поверхность `paint` наблюдается с поправкой), и это
  // пересчитывается по сохранённым метрикам без единого пикселя.
  geometryOwnership: ["frame", "verdict"],

  // --- поверхность
  "surface.viewport": ["frame"],
  "surface.dsf": ["frame", "comparison"],
  "surface.theme": ["frame"],
  // W5: режим поверхности меняет саму сцену съёмки (внутренний узел вьюпорта, stage host, маргин
  // кадра) — чистый кадровый слой; переиспользовать hug-кадр для viewport-кейса нельзя.
  "surface.mode": ["frame"],
} as const satisfies Record<LayeredField, readonly FieldLayer[]>;

/** `"acc_" + uuid` (RFC §3.3). Формат валидируется на чтении — из `runId` выводится путь evidence (D4). */
export const runId = (): string => `acc_${crypto.randomUUID()}`;

export const RUN_ID_PATTERN = /^acc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isRunId = (value: string): boolean => RUN_ID_PATTERN.test(value);
