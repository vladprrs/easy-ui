import { z } from "zod";
import { spaceToken, type ComponentLayout } from "../../designSystems/types";

/**
 * Token layout композиций v3 (план 2026-08-03 §5 W8e, граница D7).
 *
 * `element.layout` — **декларация в токенах**, которая при раскрытии компилируется в props
 * существующих примитивов spacing/layout-контракта v1 (`docs/prototype-format.md`,
 * «Spacing & layout contract v1»). Новых рантайм-примитивов не появляется: после раскрытия
 * в документе остаются обычные props, а `layout` исчезает — как `when` и `$switch`.
 *
 * Компиляция **детерминирована и не зависит от метаданных**: имена целевых props
 * фиксированы таблицей ниже. Иначе клиентское раскрытие (`src/api/client.ts`, у которого
 * карты определений нет) давало бы другое дерево, чем серверное. Метаданные компонента
 * (`ComponentLayout`) используются только для диагностики `composition/layout-unsupported`
 * — так же, как `componentRoles` в W8c.
 */

export const COMPOSITION_LAYOUT_ISSUE_CODE = "composition/layout-unsupported";

const spaceTokenSchema = z.enum(spaceToken);
export const COMPOSITION_RADIUS_TOKENS = ["none", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "full"] as const;
/** Токены/доли размера: сырые px недопустимы по построению (закрытые перечисления). */
export const COMPOSITION_SIZE_TOKENS = ["auto", "full", "1/2", "1/3", "2/3", "1/4", "3/4"] as const;
export const COMPOSITION_ALIGN_TOKENS = ["start", "center", "end", "stretch", "baseline"] as const;
export const COMPOSITION_JUSTIFY_TOKENS = ["start", "center", "end", "between", "around"] as const;

const sizeTokenSchema = z.enum(COMPOSITION_SIZE_TOKENS);

export const compositionLayoutSchema = z.strictObject({
  flow: z.strictObject({
    kind: z.literal("flex"),
    direction: z.enum(["vertical", "horizontal"]),
    /** Перенос — только opt-in: контракт v1 умеет назвать лишь включающие значения. */
    wrap: z.literal(true).optional(),
  }).optional(),
  gap: spaceTokenSchema.optional(),
  padding: spaceTokenSchema.optional(),
  paddingX: spaceTokenSchema.optional(),
  paddingY: spaceTokenSchema.optional(),
  align: z.enum(COMPOSITION_ALIGN_TOKENS).optional(),
  justify: z.enum(COMPOSITION_JUSTIFY_TOKENS).optional(),
  sizing: z.strictObject({
    width: sizeTokenSchema.optional(),
    height: sizeTokenSchema.optional(),
    grow: z.boolean().optional(),
    basis: sizeTokenSchema.optional(),
    /**
     * Потолок высоты элемента (план 2026-08-06 §W5 T5b, строка 10 фидбэка). Единственное значение
     * — `"viewport"`: «не выше stage-контейнера». Компилируется в одноимённый prop **токеном**, а
     * не CSS-строкой `100%`: сырые px/проценты закрытые перечисления не пропускают by construction,
     * и никакого измерения окна тут нет — потолок задаёт сам stage-контейнер (граница §19).
     */
    maxHeight: z.literal("viewport").optional(),
  }).refine((sizing) => Object.keys(sizing).length > 0, "sizing must declare at least one of width, height, grow, basis, maxHeight").optional(),
  /**
   * Владение прокруткой (там же): элемент прокручивает **свой** контент, а не сцену за собой.
   * Осмысленно вместе с `sizing.maxHeight` — потолок без прокрутки клипает, прокрутка без потолка
   * ничего не ограничивает; связку выбирает автор, схема оба фасета оставляет независимыми.
   */
  scroll: z.boolean().optional(),
  radius: z.enum(COMPOSITION_RADIUS_TOKENS).optional(),
  clip: z.boolean().optional(),
  /** Роль/токен фона дизайн-системы, не сырой цвет. */
  background: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "background must be a design-system token").max(60).optional(),
}).refine((layout) => Object.keys(layout).length > 0, "layout must declare at least one facet");

export type CompositionLayout = z.output<typeof compositionLayoutSchema>;

/** Все props, которые может занять компиляция layout (для проверки конфликта с авторскими). */
export const COMPOSITION_LAYOUT_PROPS = [
  "gap", "padding", "paddingX", "paddingY", "direction", "wrap",
  "align", "justify", "width", "height", "grow", "basis", "maxHeight", "scroll", "radius", "clip", "background",
] as const;

const SPACING_FACETS = ["gap", "padding", "paddingX", "paddingY"] as const;

/**
 * Компиляция в props. Таблица фиксирована:
 * `gap`/`padding`/`paddingX`/`paddingY` — канонические имена контракта v1;
 * `flow` → `direction`/`wrap`; `sizing` → `width`/`height`/`grow`/`basis`/`maxHeight`;
 * остальные фасеты (включая `scroll`) — одноимённые props.
 */
export function compileLayout(layout: CompositionLayout): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const facet of SPACING_FACETS) if (layout[facet] !== undefined) props[facet] = layout[facet];
  if (layout.flow) {
    props.direction = layout.flow.direction;
    if (layout.flow.wrap) props.wrap = true;
  }
  if (layout.align !== undefined) props.align = layout.align;
  if (layout.justify !== undefined) props.justify = layout.justify;
  if (layout.sizing) {
    if (layout.sizing.width !== undefined) props.width = layout.sizing.width;
    if (layout.sizing.height !== undefined) props.height = layout.sizing.height;
    if (layout.sizing.grow !== undefined) props.grow = layout.sizing.grow;
    if (layout.sizing.basis !== undefined) props.basis = layout.sizing.basis;
    if (layout.sizing.maxHeight !== undefined) props.maxHeight = layout.sizing.maxHeight;
  }
  if (layout.scroll !== undefined) props.scroll = layout.scroll;
  if (layout.radius !== undefined) props.radius = layout.radius;
  if (layout.clip !== undefined) props.clip = layout.clip;
  if (layout.background !== undefined) props.background = layout.background;
  return props;
}

/** Какие props займёт этот `layout` (детерминированно, без значений). */
export const compiledLayoutProps = (layout: CompositionLayout): string[] => Object.keys(compileLayout(layout));

export interface LayoutSupportIssue {
  message: string;
  code: string;
}

/**
 * Диагностика поддержки: элемент, чей `type` не несёт layout-контракта v1, не может
 * получить token layout. Карта контрактов есть только у сервера (`definition_meta`),
 * поэтому проверка выполняется, лишь когда карта передана в раскрытие.
 *
 * Диагностируются ровно те фасеты, которые контракт v1 **умеет назвать**: spacing-props и flow.
 * `radius`/`clip`/`background`, а с W5 также `sizing.maxHeight` и `scroll`, метаданными не
 * описаны вовсе — выдумывать по ним отказ значило бы объявить неподдерживаемым всё подряд;
 * их поддержку по-прежнему судит собственная схема props компонента.
 */
export function layoutSupportIssues(
  type: string,
  layout: CompositionLayout,
  contract: ComponentLayout | undefined,
): LayoutSupportIssue[] {
  const issues: LayoutSupportIssue[] = [];
  const unsupported = (message: string) => issues.push({ message, code: COMPOSITION_LAYOUT_ISSUE_CODE });
  if (!contract || contract.version !== 1) {
    unsupported(`element type ${type} does not declare the layout contract v1 and cannot take a token layout`);
    return issues;
  }
  const spacing = contract.spacing ?? [];
  for (const facet of SPACING_FACETS) {
    if (layout[facet] === undefined || spacing.includes(facet)) continue;
    unsupported(`element type ${type} does not declare the ${facet} spacing prop`);
  }
  if (layout.flow) {
    const flow = contract.flow;
    if (!flow) unsupported(`element type ${type} declares no flex flow`);
    else {
      const direction = flow.direction;
      if (typeof direction === "string") {
        unsupported(`element type ${type} has a fixed ${direction} flow direction; drop layout.flow (it is inherent to the component)`);
      } else if (direction.prop !== "direction") {
        unsupported(`element type ${type} drives its flow direction through the "${direction.prop}" prop, which token layout does not compile; set it in props`);
      } else if (!(layout.flow.direction === "vertical" ? direction.vertical : direction.horizontal).includes(layout.flow.direction)) {
        unsupported(`element type ${type} does not accept "${layout.flow.direction}" as its ${layout.flow.direction} direction value`);
      }
      if (layout.flow.wrap) {
        if (!flow?.wrap) unsupported(`element type ${type} does not declare a wrap prop`);
        else if (flow.wrap.prop !== "wrap" || !flow.wrap.enabled.includes(true)) {
          unsupported(`element type ${type} enables wrapping through "${flow.wrap.prop}"; token layout compiles wrap: true only`);
        }
      }
    }
  }
  return issues;
}
