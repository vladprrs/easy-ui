/**
 * Группировка ремедиаций (план §5 W5b; фидбэк §19.6: «если 20 состояний расходятся из-за одного
 * shared icon, агент обязан получить одну remediation group, а не 20 независимых failures»).
 *
 * Вход — уже классифицированные случаи (`server/visual/causes.ts`), выход — группы «одна правка».
 * Ключ группы:
 *
 * ```
 * remediationKey = sha256(canonicalJson({
 *   causeCode,                 // код причины из таксономии §19.6
 *   bbox,                      // сигнатура области: bbox, нормированный к layout-контуру и
 *                              // квантованный в сетку 8×8 (см. QUANTIZATION_GRID)
 *   elementKey,                // ближайший виновник из effectSources геометрии v2, если назван
 *   variantFamily,             // общие значения измерений семьи (`cases[].dims` манифеста W2)
 * }))
 * ```
 *
 * Два решения, без которых группировка не сходится с требованием §19.6:
 *
 * 1. **Квантование обязательно.** Пиксельные bbox'ы одной и той же сломанной иконки в 20 состояниях
 *    не совпадают байт-в-байт (текст рядом другой длины, кнопка шире). Сетка 8×8 по нормированным
 *    координатам склеивает их в одну ячейку, оставаясь достаточно грубой, чтобы иконка в шапке и
 *    иконка в подвале не слились.
 * 1b. **Названный виновник вытесняет пиксели.** Если классификатор атрибутировал причину
 *    (`elementKey` из `effectSources` геометрии v2), в ключ едет он, а `bbox` — `null`: один и тот
 *    же элемент в 20 состояниях занимает 20 слегка разных прямоугольников, и любая сетка рано или
 *    поздно разрежет их по границе ячейки. Сигнатура области остаётся в отчёте (`bboxSignature`)
 *    как ориентир для читателя и работает ключом там, где виновника назвать не удалось.
 *
 * 2. **`variantFamily` — производная группы, а не её вход.** Если положить в ключ полный `dims`
 *    случая, 20 состояний с разными координатами в матрице дали бы 20 групп — ровно то, что фидбэк
 *    запрещает. Поэтому группы формируются по `{causeCode, bbox, elementKey}`, а `variantFamily` —
 *    **пересечение** измерений участников (что у них общего: «все состояния темы dark») — входит в
 *    ключ уже посчитанным. Ключ остаётся полным по составу и уникальным по построению.
 *
 * Классификация и группировка **никогда** не влияют на pass/fail (§2/§10 плана): это отчёт поверх
 * готовых вердиктов.
 */
import { canonicalStringify } from "../../src/capture/canonicalJson";
import type { VisualCause, VisualCauseCode } from "../visual/causes";

/** Разрешение сетки квантования нормированных bbox'ов. */
export const QUANTIZATION_GRID = 8;

export interface BboxSignature { x: number; y: number; width: number; height: number; grid: number }

export interface RemediationCaseInput {
  caseId: string;
  /** Причины случая, отсортированные классификатором по убыванию `confidence`. */
  causes: VisualCause[];
  /** Координаты случая в измерениях семьи (`cases[].dims` манифеста W2). */
  dims?: Record<string, string> | null;
}

export interface RemediationGroup {
  key: string;
  cause: { code: VisualCauseCode; confidence: number; detail: string };
  bboxSignature: BboxSignature | null;
  sharedElementKey: string | null;
  /** Что общего у измерений участников группы; `null` — общего нет либо `dims` не объявлены. */
  variantFamily: Record<string, string> | null;
  cases: string[];
  caseCount: number;
  suggestion: string;
}

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** Шаблон следующей правки по коду причины — то, ради чего таксономия и заведена (§19.6). */
export const REMEDIATION_SUGGESTIONS: Record<VisualCauseCode, string> = {
  "surface-tint": "Compare the surface fill/background token of the component with the reference: the whole area is tinted, so one token or one wrapper background explains every listed case.",
  "edge-radius-stroke": "Check border width, corner radius and outline tokens on the named element: the difference is a thin strip along the perimeter.",
  "geometry-shift": "The content is drawn at the wrong offset — check padding, margin or alignment of the container rather than the rendering of its children.",
  "text-raster-residual": "Only anti-aliasing-level pixels differ: verify the font family/weight actually loaded and that the reference was rendered at the same device scale factor before touching the component.",
  "missing-late-asset": "The frame was captured while resources were still failing or in flight: fix the asset reference (or its readiness policy) and recapture; the pixel verdict says nothing until then.",
  "alpha-compositing": "Opacity, blend mode or backdrop differs rather than colour: check the alpha of the layer and of anything painted underneath it.",
  "effect-overflow": "A shadow/blur/outline paints outside the layout box: either declare it (`allowPaintOverflow` in the case-set policy) or contain the effect on the named element.",
  "descendant-outside-mask": "Something paints beyond the component's own ownership mask: find the named descendant and clip it, or move it out of this component.",
  unclassified: "No classifier matched: open diff.png plus geometry.json from the evidence archive and file the missing signal, do not guess a fix.",
};

const clampCell = (value: number, max: number): number => Math.max(0, Math.min(max, value));

/**
 * Квантованная сигнатура области. `x/y` — левый верхний угол в ячейках сетки, `width/height` —
 * размер в ячейках, **не меньше одной**: область нулевой ширины после квантования исчезла бы, и
 * тонкая рамка потеряла бы позицию.
 */
export function quantizeBbox(norm: { x: number; y: number; width: number; height: number }): BboxSignature {
  const grid = QUANTIZATION_GRID;
  return {
    x: clampCell(Math.floor(norm.x * grid), grid - 1),
    y: clampCell(Math.floor(norm.y * grid), grid - 1),
    width: Math.max(1, clampCell(Math.ceil(norm.width * grid), grid)),
    height: Math.max(1, clampCell(Math.ceil(norm.height * grid), grid)),
    grid,
  };
}

/** Причина, по которой группируется случай: самая уверенная из названных (список уже отсортирован). */
export const primaryCauseOf = (causes: VisualCause[]): VisualCause | null => causes[0] ?? null;

/** Пересечение измерений: пары `имя=значение`, одинаковые у **всех** участников группы. */
export function sharedVariantFamily(dims: (Record<string, string> | null | undefined)[]): Record<string, string> | null {
  if (dims.length === 0 || dims.some((item) => item === null || item === undefined)) return null;
  const [first, ...rest] = dims as Record<string, string>[];
  const shared: Record<string, string> = {};
  for (const [name, value] of Object.entries(first!)) {
    if (rest.every((other) => other[name] === value)) shared[name] = value;
  }
  return Object.keys(shared).length === 0 ? null : shared;
}

export function remediationKeyOf(input: {
  causeCode: VisualCauseCode;
  bbox: BboxSignature | null;
  elementKey: string | null;
  variantFamily: Record<string, string> | null;
}): string {
  return sha256(canonicalStringify(input));
}

/**
 * Группирует случаи в ремедиации. Случай попадает **ровно в одну** группу — по своей первой
 * (самой уверенной) причине: случай с тремя причинами, разложенный по трём группам, вернул бы
 * читателю ту же россыпь независимых провалов, от которой группировка и спасает.
 *
 * Сортировка: сначала самые массовые группы (одна правка чинит больше всего случаев), затем — по
 * уверенности причины, затем по ключу (детерминизм отчёта).
 */
export function groupRemediations(cases: RemediationCaseInput[]): RemediationGroup[] {
  interface Bucket {
    cause: VisualCause;
    bbox: BboxSignature | null;
    elementKey: string | null;
    caseIds: string[];
    dims: (Record<string, string> | null | undefined)[];
    confidence: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const item of cases) {
    const cause = primaryCauseOf(item.causes);
    if (!cause) continue;
    const bbox = cause.region ? quantizeBbox(cause.region.norm) : null;
    const elementKey = cause.elementKey ?? null;
    // Виновник назван ⇒ он и есть идентичность группы; сигнатура области остаётся справочной.
    const bucketKey = canonicalStringify({ code: cause.code, bbox: elementKey === null ? bbox : null, elementKey });
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      bucket.caseIds.push(item.caseId);
      bucket.dims.push(item.dims);
      // Представитель группы — самый уверенный случай: от него и описание, и справочная сигнатура.
      if (cause.confidence > bucket.confidence) {
        bucket.confidence = cause.confidence; bucket.cause = cause; bucket.bbox = bbox;
      }
    } else {
      buckets.set(bucketKey, {
        cause, bbox, elementKey,
        caseIds: [item.caseId], dims: [item.dims], confidence: cause.confidence,
      });
    }
  }

  const groups = [...buckets.values()].map((bucket): RemediationGroup => {
    const variantFamily = sharedVariantFamily(bucket.dims);
    return {
      key: remediationKeyOf({
        causeCode: bucket.cause.code,
        bbox: bucket.elementKey === null ? bucket.bbox : null,
        elementKey: bucket.elementKey,
        variantFamily,
      }),
      cause: { code: bucket.cause.code, confidence: bucket.confidence, detail: bucket.cause.detail },
      bboxSignature: bucket.bbox,
      sharedElementKey: bucket.elementKey,
      variantFamily,
      cases: [...bucket.caseIds].sort(),
      caseCount: bucket.caseIds.length,
      suggestion: REMEDIATION_SUGGESTIONS[bucket.cause.code],
    };
  });

  return groups.sort((left, rightItem) =>
    rightItem.caseCount - left.caseCount
    || rightItem.cause.confidence - left.cause.confidence
    || (left.key < rightItem.key ? -1 : left.key > rightItem.key ? 1 : 0));
}
