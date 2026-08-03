import { COMPOSITION_TYPE, SLOT_TYPE } from "../catalog/hostPrimitives/composition.definition";
import { hostPrimitiveNames } from "../catalog/hostPrimitives/definitions";
import { prototypeActionSchemas } from "../catalog/actions";
import type { ComponentLayout } from "../designSystems/types";
import {
  COMPOSITION_ELEMENTS_LIMIT, COMPOSITION_PARAMS_LIMIT, COMPOSITION_SLOTS_LIMIT,
  compositionDocSchema, expandCompositions,
  type CompositionCatalogEntry, type CompositionDoc,
} from "./composition";
import { paramPlaceholder } from "./compositionV3/params";
import type { PrototypeDoc } from "./schema";

/**
 * Анализатор композиционного кандидата (план 2026-08-03 §5 W8g).
 *
 * Вопрос, на который он отвечает: **выразима ли конструкция средствами composition v3**
 * или продуктовый блок обязан уехать в TSX. Три исхода (те же, что печатает workbench W9):
 *
 * - `composition` — тело раскрывается декларативно, ownership-компонент не нужен;
 * - `extend-component` — тело сводится к одному компоненту с вариациями props: композиция
 *   здесь лишний уровень косвенности, дешевле расширить сам компонент;
 * - `needs-ownership-component` — в теле есть то, чего в v3 нет по построению (таймеры,
 *   асинхронность, скролл/измерения DOM, собственные действия, бизнес-состояние) либо
 *   конструкция не влезает в лимиты формата.
 *
 * Правила **консервативные и объяснимые**: каждый вердикт сопровождается `reasons`
 * (код + человеческое сообщение + ключ элемента), а каждая невыразимая фича — записью
 * `unsupported` с подсказкой. Анализатор **чист**: ни БД, ни сети, ни записи; черновик,
 * не проходящий строгую схему, всё равно анализируется (авторинг идёт итеративно).
 */

export type CompositionVerdict = "composition" | "extend-component" | "needs-ownership-component";

export interface CompositionAnalyzeReason {
  /** Стабильный машиночитаемый код (`analyze/*`, `limit/*`, `expansion/*`). */
  code: string;
  message: string;
  /** Авторский ключ элемента тела, если причина локальна. */
  elementKey?: string;
}

export interface CompositionUnsupportedFeature {
  /** Класс невыразимой конструкции: `timer`, `async-data`, `scroll`, … */
  feature: string;
  elementKey: string;
  hint: string;
}

export interface CompositionAnalyzeStats {
  elements: number;
  params: number;
  slots: number;
  /** Типы элементов тела (без host-примитивов), отсортированы. */
  componentTypes: string[];
  branches: number;
  switches: number;
  repeats: number;
  actionParams: number;
  nestedCompositions: number;
}

export interface CompositionAnalysis {
  verdict: CompositionVerdict;
  reasons: CompositionAnalyzeReason[];
  unsupported: CompositionUnsupportedFeature[];
  /** Прошёл ли документ строгую схему композиции (черновик может не проходить). */
  schemaValid: boolean;
  stats: CompositionAnalyzeStats;
}

export interface CompositionAnalyzeContext {
  /** Роли `canonicalFor` по имени типа — только у сервера; влияет на диагностику слотов. */
  componentRoles?: Readonly<Record<string, readonly string[]>>;
  /** Layout-контракты компонентов — тоже только у сервера (`composition/layout-unsupported`). */
  componentLayouts?: Readonly<Record<string, ComponentLayout | undefined>>;
}

export interface CompositionAnalyzeInput {
  /** Документ композиции: кандидат или черновик (строгая валидность необязательна). */
  doc: unknown;
  context?: CompositionAnalyzeContext;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Действия, которые умеет исполнять рантайм прототипа. Всё прочее — поведение владельца. */
const HOST_ACTIONS: ReadonlySet<string> = new Set(Object.keys(prototypeActionSchemas));
const STATE_ACTIONS: ReadonlySet<string> = new Set(["setState", "pushState", "removeState"]);
/** Больше двух мутаций стейта в одном обработчике — это бизнес-логика, а не клик по макету. */
const STATE_MUTATIONS_LIMIT = 2;

/** Директивы, известные формату (props композиции v3 и документа прототипа). */
const KNOWN_DIRECTIVES: ReadonlySet<string> = new Set([
  "$param", "$switch", "$item", "$index", "$asset", "$state", "$cond", "$if",
]);

/**
 * Эвристики невыразимых классов. Сопоставляются с **нормализованным** (нижний регистр,
 * без разделителей) именем события, действия или prop'а — так `onScrollEnd`, `scroll_end`
 * и `scrollEnd` дают один и тот же вердикт.
 *
 * Имена props сканируются **только у host-примитивов**: значение prop'а кастомного
 * компонента — это его собственный контракт (`stickyFooter` у экрана владеет липкостью сам,
 * и композиция, которая его передаёт, совершенно выразима). А host-примитиву поведение
 * передать некому — там такое имя действительно означает недостающего владельца.
 */
const UNSUPPORTED_PATTERNS: ReadonlyArray<{ feature: string; test: RegExp; hint: string }> = [
  {
    feature: "timer",
    test: /(delay|timeout|interval|debounce|throttle|countdown|autoplay|autorotate|tick)/,
    hint: "Composition expansion is static: there is no clock. Own the timing inside a component and expose its result as props.",
  },
  {
    feature: "async-data",
    test: /(fetch|xhr|request|poll|subscribe|websocket|promise|endpoint|apiurl|apipath|graphql)/,
    hint: "Compositions cannot perform I/O. Fetch inside an ownership component, or pass the already-resolved data as a param.",
  },
  {
    feature: "scroll",
    test: /(scroll|sticky|infinite|virtuali)/,
    hint: "Scroll position and scroll-driven behaviour are runtime concerns; a composition only lays elements out.",
  },
  {
    feature: "dom-measurement",
    test: /(measure|observer|intersect|boundingrect|offsetwidth|offsetheight|clientwidth|clientheight|viewportwidth|viewportheight|elementsize)/,
    hint: "Nothing in a composition can read the DOM. Measure inside a component that owns the element.",
  },
];

const normalizeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

interface LooseElement {
  type: string;
  props: Record<string, unknown>;
  children: string[];
  on: Record<string, unknown>;
  when?: unknown;
  repeatParam?: unknown;
  layout?: unknown;
  repeat?: unknown;
}

interface LooseDoc {
  version: number;
  params: Record<string, { type?: unknown }>;
  slots: string[];
  root: string;
  elements: Record<string, LooseElement>;
}

/** Терпимое к черновику чтение документа: чего нет — того нет, падать анализатор не имеет права. */
function readLooseDoc(raw: unknown): LooseDoc {
  const doc = isObject(raw) ? raw : {};
  const spec = isObject(doc.spec) ? doc.spec : {};
  const rawElements = isObject(spec.elements) ? spec.elements : {};
  const elements: Record<string, LooseElement> = {};
  for (const [key, value] of Object.entries(rawElements)) {
    const element = isObject(value) ? value : {};
    elements[key] = {
      type: typeof element.type === "string" ? element.type : "",
      props: isObject(element.props) ? element.props : {},
      children: Array.isArray(element.children) ? element.children.filter((child): child is string => typeof child === "string") : [],
      on: isObject(element.on) ? element.on : {},
      when: element.when,
      repeatParam: element.repeatParam,
      layout: element.layout,
      repeat: element.repeat,
    };
  }
  const rawSlots = doc.slots;
  const slots = Array.isArray(rawSlots)
    ? rawSlots.filter((slot): slot is string => typeof slot === "string")
    : isObject(rawSlots) ? Object.keys(rawSlots) : [];
  return {
    version: typeof doc.version === "number" ? doc.version : 0,
    params: isObject(doc.params) ? (doc.params as Record<string, { type?: unknown }>) : {},
    slots,
    root: typeof spec.root === "string" ? spec.root : "",
    elements,
  };
}

/** Плоский список действий обработчика (одно действие или их цепочка). */
const handlerActions = (binding: unknown): Record<string, unknown>[] => {
  if (Array.isArray(binding)) return binding.filter(isObject);
  return isObject(binding) ? [binding] : [];
};

class Findings {
  readonly reasons: CompositionAnalyzeReason[] = [];
  readonly unsupported: CompositionUnsupportedFeature[] = [];
  private readonly seen = new Set<string>();

  reason(code: string, message: string, elementKey?: string): void {
    const key = `reason\0${code}\0${message}\0${elementKey ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.reasons.push({ code, message, ...(elementKey === undefined ? {} : { elementKey }) });
  }

  feature(feature: string, elementKey: string, hint: string, message: string): void {
    const key = `feature\0${feature}\0${elementKey}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.unsupported.push({ feature, elementKey, hint });
    this.reason(`unsupported/${feature}`, message, elementKey);
  }
}

/** Имена, по которым видно невыразимую фичу: props (включая вложенные ключи), события, действия. */
function scanNames(elementKey: string, names: Iterable<{ name: string; where: string }>, findings: Findings): void {
  for (const { name, where } of names) {
    const normalized = normalizeName(name);
    for (const pattern of UNSUPPORTED_PATTERNS) {
      if (!pattern.test.test(normalized)) continue;
      findings.feature(pattern.feature, elementKey, pattern.hint,
        `${where} "${name}" on element "${elementKey}" implies ${pattern.feature}, which composition v3 cannot express`);
    }
  }
}

function analyzeElement(key: string, element: LooseElement, findings: Findings, stats: { switches: number; actionParams: number }): void {
  const names: { name: string; where: string }[] = [];
  // Кастомный компонент владеет своими props сам — сканируются только host-примитивы.
  const scanProps = element.type === "" || hostPrimitiveNames.has(element.type);

  const walk = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, [...path, String(index)])); return; }
    if (!isObject(value)) return;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0]!.startsWith("$")) {
      const directive = keys[0]!;
      if (directive === "$switch") stats.switches += 1;
      if (!KNOWN_DIRECTIVES.has(directive)) {
        findings.feature("dynamic-directive", key,
          "Only the documented directives ($param, $switch, $item, $index, $asset, $state, $cond) survive expansion; anything else needs code that owns it.",
          `props directive "${directive}" on element "${key}" is not part of the prototype format`);
        return;
      }
      if (directive === "$switch" || directive === "$cond") { walk(value[directive], [...path, directive]); return; }
      return;
    }
    for (const [name, item] of Object.entries(value)) {
      if (scanProps) names.push({ name, where: "prop" });
      walk(item, [...path, name]);
    }
  };
  walk(element.props, []);

  for (const [event, binding] of Object.entries(element.on)) {
    names.push({ name: event, where: "event" });
    const actions = handlerActions(binding);
    // `{"$param": "…"}` в позиции обработчика — параметр-действие (W8d), а не действие.
    if (actions.length === 1 && typeof actions[0]!.$param === "string") { stats.actionParams += 1; continue; }
    let mutations = 0;
    for (const action of actions) {
      const name = action.action;
      if (typeof name !== "string") continue;
      names.push({ name, where: "action" });
      if (STATE_ACTIONS.has(name)) mutations += 1;
      if (HOST_ACTIONS.has(name)) continue;
      findings.feature("custom-action", key,
        "The prototype runtime executes a closed set of actions (navigate/back/openUrl/restart/setState/pushState/removeState). Custom behaviour belongs to an ownership component.",
        `handler "${event}" on element "${key}" invokes an unknown action "${name}"`);
    }
    if (mutations > STATE_MUTATIONS_LIMIT) {
      findings.feature("business-state", key,
        "A handler that rewrites several pieces of state at once encodes business rules; make it a component that owns the rule and emits one event.",
        `handler "${event}" on element "${key}" performs ${mutations} state mutations, more than the ${STATE_MUTATIONS_LIMIT} a declarative composition is expected to carry`);
    }
  }

  scanNames(key, names, findings);
}

/** Ссылки на вложенные композиции — probe-раскрытие их всё равно не разрешит (анализатор чист). */
const nestedCompositionIssue = (message: string): boolean =>
  message.includes("unknown or unpublished composition");

/** Коды раскрытия, означающие «не влезает в формат», а не «автор ошибся». */
const LIMIT_CODES: Readonly<Record<string, string>> = {
  "composition/expanded-elements": "limit/expanded-elements",
  "composition/tree-depth": "limit/tree-depth",
  "composition/depth": "limit/nesting-depth",
  "composition/repeat-max-items": "limit/repeat-items",
};

function probeExpansion(doc: CompositionDoc, context: CompositionAnalyzeContext | undefined, findings: Findings): void {
  const params = Object.fromEntries(Object.entries(doc.params).flatMap(([name, declared]) => {
    const fallback = "default" in declared ? declared.default : undefined;
    if (fallback !== undefined) return [[name, fallback]];
    if (declared.required) return [[name, paramPlaceholder(declared)]];
    return [];
  }));
  const probe = {
    version: 1 as const,
    id: "composition-analyze",
    name: "Composition analyze",
    designSystem: "analyze",
    startScreen: "probe",
    state: {},
    screens: [{
      id: "probe",
      name: "Probe",
      spec: {
        root: "probe",
        elements: {
          probe: {
            type: COMPOSITION_TYPE,
            props: { composition: "candidate", ...(Object.keys(params).length ? { params } : {}) },
          },
        },
      },
    }],
  } as unknown as PrototypeDoc;
  const compositions: Record<string, CompositionCatalogEntry> = { candidate: { doc, version: 1, status: "active" } };
  const expanded = expandCompositions(probe, {
    compositions,
    // Точки ссылки у анализатора нет: детей у слотов нет по построению — контракт слотов
    // проверяется там, где композицию действительно используют (как в publish-probe).
    validateSlotContract: false,
    componentRoles: context?.componentRoles,
    componentLayouts: context?.componentLayouts,
  });
  for (const issue of expanded.issues) {
    if (nestedCompositionIssue(issue.message)) continue;
    const limit = issue.code ? LIMIT_CODES[issue.code] : undefined;
    if (limit) {
      findings.feature(limit, doc.spec.root,
        "The construct outgrows the composition budget; split it or give the block its own component.",
        `expansion budget exceeded: ${issue.message}`);
      continue;
    }
    findings.reason(`expansion/${issue.code ?? "issue"}`, `expansion reports: ${issue.message}`);
  }
}

/**
 * Анализ композиционного кандидата. Чистая функция: одинаковый вход — одинаковый вердикт.
 */
export function analyzeComposition(input: CompositionAnalyzeInput): CompositionAnalysis {
  const findings = new Findings();
  const loose = readLooseDoc(input.doc);
  const parsed = compositionDocSchema.safeParse(input.doc);

  const entries = Object.entries(loose.elements);
  const counters = { switches: 0, actionParams: 0 };
  for (const [key, element] of entries) analyzeElement(key, element, findings, counters);

  const branches = entries.filter(([, element]) => element.when !== undefined).length;
  const repeats = entries.filter(([, element]) => element.repeatParam !== undefined).length;
  const nested = entries.filter(([, element]) => element.type === COMPOSITION_TYPE).length;
  const slotElements = entries.filter(([, element]) => element.type === SLOT_TYPE);
  const material = entries.filter(([, element]) => element.type !== SLOT_TYPE);
  const componentTypes = [...new Set(material.map(([, element]) => element.type).filter((type) => type && !hostPrimitiveNames.has(type)))].sort();

  const stats: CompositionAnalyzeStats = {
    elements: entries.length,
    params: Object.keys(loose.params).length,
    slots: loose.slots.length,
    componentTypes,
    branches,
    switches: counters.switches,
    repeats,
    actionParams: counters.actionParams,
    nestedCompositions: nested,
  };

  // --- лимиты формата: превышение делает конструкцию невыразимой, а не просто невалидной ---
  if (stats.elements > COMPOSITION_ELEMENTS_LIMIT) {
    findings.feature("limit/elements", loose.root || "spec",
      `A composition body is capped at ${COMPOSITION_ELEMENTS_LIMIT} elements; split the block or let a component own part of it.`,
      `body declares ${stats.elements} elements, over the ${COMPOSITION_ELEMENTS_LIMIT} a composition may carry`);
  }
  if (stats.params > COMPOSITION_PARAMS_LIMIT) {
    findings.feature("limit/params", loose.root || "spec",
      `A composition is capped at ${COMPOSITION_PARAMS_LIMIT} params; a surface that wide is a component contract, not a composition.`,
      `body declares ${stats.params} params, over the ${COMPOSITION_PARAMS_LIMIT} a composition may carry`);
  }
  if (stats.slots > COMPOSITION_SLOTS_LIMIT) {
    findings.feature("limit/slots", loose.root || "spec",
      `A composition is capped at ${COMPOSITION_SLOTS_LIMIT} slots.`,
      `body declares ${stats.slots} slots, over the ${COMPOSITION_SLOTS_LIMIT} a composition may carry`);
  }

  if (parsed.success) {
    probeExpansion(parsed.data, input.context, findings);
  } else {
    // Черновик анализируется, но нераспознанная форма — самостоятельная причина: строгая
    // схема и есть определение выразимости, поэтому её нарушения перечисляются явно.
    for (const issue of parsed.error.issues.slice(0, 20)) {
      findings.reason("analyze/schema-invalid", `${issue.path.join("/") || "doc"}: ${issue.message}`);
    }
  }

  if (findings.unsupported.length) {
    findings.reason("analyze/needs-ownership",
      `the body uses ${findings.unsupported.length} construct(s) composition v3 cannot express (${[...new Set(findings.unsupported.map((entry) => entry.feature))].join(", ")})`);
    return { verdict: "needs-ownership-component", reasons: findings.reasons, unsupported: findings.unsupported, schemaValid: parsed.success, stats };
  }

  // --- «расширить компонент»: тело сводится к одному компоненту с вариациями props ---
  const singleComponent = material.length === 1 && slotElements.length === 0 && stats.slots === 0;
  const sameTypeVariants = material.length > 1 && slotElements.length === 0 && stats.slots === 0 && nested === 0
    && new Set(material.map(([, element]) => element.type)).size === 1
    && material.every(([key, element]) => key === loose.root || element.when !== undefined);
  if (singleComponent || sameTypeVariants) {
    const type = material[0]?.[1].type ?? "";
    if (type && !hostPrimitiveNames.has(type)) {
      findings.reason(singleComponent ? "analyze/single-element-body" : "analyze/component-variations",
        singleComponent
          ? `the body is a single "${type}" element with parameterised props: a composition adds an indirection level without adding structure — extend the component's own contract instead`
          : `the body is ${material.length} mutually exclusive "${type}" elements: these are variations of one component's props, not a composed block`,
        loose.root || undefined);
      return { verdict: "extend-component", reasons: findings.reasons, unsupported: [], schemaValid: parsed.success, stats };
    }
    findings.reason("analyze/host-primitive-body",
      `the body is a single host primitive ("${type || "unknown"}"): there is no component contract to extend, so it stays a composition`,
      loose.root || undefined);
  }

  findings.reason("analyze/expressible",
    `the body is expressible with composition v3: ${material.length} element(s), ${stats.slots} slot(s), ${branches} conditional branch(es), ${counters.switches} prop switch(es), ${repeats} parameterised repeat(s)`);
  return { verdict: "composition", reasons: findings.reasons, unsupported: [], schemaValid: parsed.success, stats };
}
