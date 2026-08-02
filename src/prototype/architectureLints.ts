import type { ComponentDefinition } from "../catalog/definitions";
import { hostPrimitiveNames } from "../catalog/hostPrimitives/definitions";
import { FLOW_ROOT_TYPE } from "../catalog/hostPrimitives/flowRoot.definition";
import { isComponentScope, type ComponentScope } from "../designSystems/scope";
import { ARCHITECTURE_LINT_CODES, type ArchitectureExemption, type ArchitectureLintCode, type PrototypeDoc } from "./schema";
import type { ArchitectureExemptedIssue, ValidationIssue } from "./types";

/**
 * Архитектурные lint-правила (план 2026-07-27, волна 2 §2.3).
 *
 * Жёсткие инварианты (заданы адверсариальными ревью плана):
 *
 * 1. **Только явный `scope`/`allowedAsRoot`.** Ни одно правило не выводит роль из
 *    `atomicLevel`: 96 из 124 прод-экранов — один custom-компонент в корне, вывод
 *    залил бы их предупреждениями.
 * 2. **Всё — warnings.** `validatePrototype` не получает нового способа отдать 422.
 * 3. Правила целиком выключены для служебных видов прототипа
 *    (`component-gallery`, `evidence`, `visual-reference`, `composition-fixture`).
 * 4. Сработавшее `architecture.exemptions`-исключение снимает issue и возвращается
 *    отдельным списком `exempted` (волна 4 показывает его в readiness-отчёте).
 */

export const architectureLintCodes = ARCHITECTURE_LINT_CODES;
export type { ArchitectureLintCode };

/** Виды прототипа, для которых архитектурные правила не применяются. */
export const ARCHITECTURE_EXEMPT_KINDS: readonly string[] = [
  "component-gallery",
  "evidence",
  "visual-reference",
  "composition-fixture",
];

/**
 * Служебный ли вид прототипа (план 2026-08-02, P9). Список тот же, что снимает
 * архитектурные линты: галереи компонентов, evidence-экраны, визуальные эталоны и
 * фикстуры композиций законно состоят из несвязанных экранов и «мёртвых» кнопок.
 */
export const isServicePrototypeDocKind = (kind: string | undefined): boolean =>
  kind !== undefined && ARCHITECTURE_EXEMPT_KINDS.includes(kind);

export type { ArchitectureExemptedIssue };

export interface ArchitectureLintResult {
  warnings: ValidationIssue[];
  /** Issue'ы, снятые `architecture.exemptions` — для readiness-отчёта. */
  exempted: ArchitectureExemptedIssue[];
  /**
   * Ключи `<screenIndex>/<elementKey>`, для которых уже выдано архитектурное
   * предупреждение о вложенности: `validate.ts` подавляет для них дублирующий
   * atomic-nesting warning.
   */
  nestingReported: ReadonlySet<string>;
}

type Screen = PrototypeDoc["screens"][number];
type Element = Screen["spec"]["elements"][string];

const escapePointer = (part: string): string => part.replaceAll("~", "~0").replaceAll("/", "~1");
const elementPath = (screenIndex: number, key: string): string => `/screens/${screenIndex}/spec/elements/${escapePointer(key)}`;

const explicitScope = (definition: ComponentDefinition | undefined): ComponentScope | undefined =>
  isComponentScope(definition?.scope) ? definition.scope : undefined;

/** Компонент считается custom, когда это не host-примитив и его definition известен. */
const isCustomType = (type: string, definitions: Record<string, ComponentDefinition>): boolean =>
  !hostPrimitiveNames.has(type) && Boolean(definitions[type]);

interface Pending {
  code: ArchitectureLintCode;
  screenIndex: number;
  screenId: string;
  key: string;
  message: string;
}

export function lintPrototypeArchitecture(
  doc: PrototypeDoc,
  definitions: Record<string, ComponentDefinition>,
  options: { kind?: string } = {},
): ArchitectureLintResult {
  const empty: ArchitectureLintResult = { warnings: [], exempted: [], nestingReported: new Set() };
  if (options.kind !== undefined && ARCHITECTURE_EXEMPT_KINDS.includes(options.kind)) return empty;

  const pending: Pending[] = [];
  const nestingReported = new Set<string>();
  const push = (code: ArchitectureLintCode, screen: Screen, screenIndex: number, key: string, message: string) => {
    pending.push({ code, screenIndex, screenId: screen.id, key, message });
  };

  for (const [screenIndex, screen] of doc.screens.entries()) {
    const elements = screen.spec.elements;
    const rootKey = screen.spec.root;
    const rootElement: Element | undefined = elements[rootKey];
    if (!rootElement) continue;

    // Корневые позиции: сам root и — когда корень это `@eui/FlowRoot` — его прямые
    // дети (регионы и контент верхнего уровня живут именно там).
    const rootPositions = new Set<string>([rootKey]);
    const flowRootChildren = rootElement.type === FLOW_ROOT_TYPE ? (rootElement.children ?? []) : [];
    for (const child of flowRootChildren) rootPositions.add(child);

    // --- arch/monolith-root -------------------------------------------------
    // Расширение существующего monolithic-screen lint'а: тот же вопрос («экран —
    // один компонент?»), но теперь виден и сквозь обёртку `@eui/FlowRoot`.
    const totalElements = Object.keys(elements).length;
    const monolithKey = rootElement.type === FLOW_ROOT_TYPE && flowRootChildren.length === 1 && totalElements === 2
      ? flowRootChildren[0]!
      : totalElements === 1 ? rootKey : undefined;
    const monolithElement = monolithKey ? elements[monolithKey] : undefined;
    const monolithDefinition = monolithElement ? definitions[monolithElement.type] : undefined;
    if (monolithKey && monolithElement && monolithDefinition && isCustomType(monolithElement.type, definitions)
      && !(monolithElement.children?.length)) {
      const scope = explicitScope(monolithDefinition);
      const level = monolithDefinition.atomicLevel;
      if (scope === "section" || scope === "shell" || scope === "screen") {
        push("arch/monolith-root", screen, screenIndex, monolithKey,
          `monolithic screen: root ${monolithElement.type} is a single custom ${scope}-scope component with no children; consider composing it from design-system elements`);
      } else if (monolithKey === rootKey && (level === "organism" || level === "page")) {
        // Наследуемая ветка (до волны 2): смотрит только на прямой корень экрана и
        // на atomicLevel — расширять её на FlowRoot нельзя, иначе зальёт прод.
        push("arch/monolith-root", screen, screenIndex, monolithKey,
          `monolithic screen: root ${monolithElement.type} is a single custom ${level} with no children; consider composing it from design-system elements`);
      }
    }

    // Регионы: элемент с маркером `region` и всё его поддерево.
    const regionOf = new Map<string, string>();
    {
      const walk = (key: string, region: string | undefined, seen: Set<string>) => {
        if (seen.has(key)) return;
        seen.add(key);
        const element = elements[key];
        if (!element) return;
        const current = element.region ?? region;
        if (current) regionOf.set(key, current);
        for (const child of element.children ?? []) walk(child, current, seen);
      };
      walk(rootKey, undefined, new Set());
    }

    for (const [key, element] of Object.entries(elements)) {
      const definition = definitions[element.type];
      if (!definition) continue;
      const custom = isCustomType(element.type, definitions);
      const scope = explicitScope(definition);
      const isRootPosition = rootPositions.has(key);

      // --- arch/root-not-allowed --------------------------------------------
      if (isRootPosition && definition.allowedAsRoot === false) {
        push("arch/root-not-allowed", screen, screenIndex, key,
          `${element.type} declares allowedAsRoot: false but is used in a root position of the screen`);
      }

      // --- arch/screen-scope-nested -----------------------------------------
      if (scope === "screen" && !isRootPosition) {
        nestingReported.add(`${screenIndex}/${key}`);
        push("arch/screen-scope-nested", screen, screenIndex, key,
          `${element.type} has scope "screen" but is nested inside the screen instead of being its root`);
      }

      // --- arch/region-owns-page --------------------------------------------
      const region = regionOf.get(key);
      if (region && (scope === "shell" || scope === "screen")) {
        nestingReported.add(`${screenIndex}/${key}`);
        push("arch/region-owns-page", screen, screenIndex, key,
          `${region} region contains ${element.type} with scope "${scope}": a region must not own the page`);
      }

      // --- arch/ownership-unexplained ---------------------------------------
      if (custom && (scope === "shell" || scope === "screen") && !definition.ownership?.reason) {
        push("arch/ownership-unexplained", screen, screenIndex, key,
          `${element.type} has scope "${scope}" but its definition declares no ownership.reason`);
      }

      // --- arch/bounded-as-owner --------------------------------------------
      if (definition.sourceBounded === true && (isRootPosition || element.region !== undefined)) {
        push("arch/bounded-as-owner", screen, screenIndex, key,
          `${element.type} declares sourceBounded: true and must not ${isRootPosition ? "be the screen root" : `own the ${element.region} region`}`);
      }
    }
  }

  // Одно предупреждение на пару (элемент, правило); порядок стабилен.
  const seen = new Set<string>();
  const exemptions = doc.architecture?.exemptions ?? [];
  const warnings: ValidationIssue[] = [];
  const exempted: ArchitectureExemptedIssue[] = [];
  for (const entry of pending) {
    const dedupeKey = `${entry.code}|${entry.screenIndex}|${entry.key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const path = elementPath(entry.screenIndex, entry.key);
    const match = findExemption(exemptions, entry);
    if (match) {
      exempted.push({
        code: entry.code,
        screenId: entry.screenId,
        elementKey: entry.key,
        path,
        message: entry.message,
        reason: match.reason,
        ...(match.provenance ? { provenance: match.provenance } : {}),
      });
      continue;
    }
    warnings.push({ code: entry.code, path, message: entry.message });
  }
  return { warnings, exempted, nestingReported };
}

function findExemption(exemptions: readonly ArchitectureExemption[], entry: Pending): ArchitectureExemption | undefined {
  return exemptions.find((exemption) => exemption.rule === entry.code
    && exemption.screenId === entry.screenId
    && (exemption.elementKey === undefined || exemption.elementKey === entry.key));
}
