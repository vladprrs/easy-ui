import type { AtomicLevel } from "./types";

/**
 * Architecture scope of a component (план 2026-07-27, волна 2 §2.1).
 *
 * `scope` отвечает на вопрос «какой кусок экрана компонент **владеет**», в
 * отличие от `atomicLevel`, который описывает лишь размер/сложность:
 *
 * - `primitive` — контрол или элемент внутри секции;
 * - `section`   — самостоятельный блок экрана (список, карточка, навбар);
 * - `shell`     — каркас экрана (скроллер, панель, safe-area), владеет
 *                 геометрией вьюпорта, но не контентом;
 * - `screen`    — целый экран одним компонентом.
 *
 * ВАЖНО: архитектурные lint-правила (`src/prototype/architectureLints.ts`)
 * используют **только явно объявленный** `scope`. `inferScopeFromAtomicLevel`
 * существует исключительно для отображения (инспектор, библиотека) и для
 * backfill-скрипта; вызывать её из lint'а запрещено — 96 из 124 прод-экранов
 * состоят из одного custom-компонента и утонули бы в предупреждениях.
 */
export const COMPONENT_SCOPES = ["primitive", "section", "shell", "screen"] as const;
export type ComponentScope = (typeof COMPONENT_SCOPES)[number];

export const isComponentScope = (value: unknown): value is ComponentScope =>
  typeof value === "string" && (COMPONENT_SCOPES as readonly string[]).includes(value);

/** Порядок владения: чем больше, тем крупнее кусок экрана принадлежит компоненту. */
export const scopeRank: Record<ComponentScope, number> = {
  primitive: 1,
  section: 2,
  shell: 3,
  screen: 4,
};

/** Scope'ы, владеющие экраном или его каркасом (owner-роль). */
export const OWNER_SCOPES: readonly ComponentScope[] = ["shell", "screen"];
export const isOwnerScope = (scope: ComponentScope | undefined): boolean =>
  scope !== undefined && (OWNER_SCOPES as readonly string[]).includes(scope);

/**
 * Отображательный вывод scope из atomic level. **Не** источник правды для lint'а.
 */
export function inferScopeFromAtomicLevel(level: AtomicLevel | undefined): ComponentScope | undefined {
  switch (level) {
    case "atom":
    case "molecule":
      return "primitive";
    case "organism":
      return "section";
    case "template":
      return "shell";
    case "page":
      return "screen";
    default:
      return undefined;
  }
}

/** Метаданные владения: почему компонент имеет право владеть экраном/каркасом. */
export interface ComponentOwnership {
  reason: string;
  provenance?: string;
}

/**
 * Компоненты, у которых `atomicLevel` не отражает реальную роль: канонические
 * каркасы Yandex Pay объявлены как organism/molecule, но владеют геометрией
 * экрана. Используется backfill-скриптом (`scripts/backfill-component-scope.ts`).
 */
export const SCOPE_BACKFILL_OVERRIDES: Readonly<Record<string, ComponentScope>> = Object.freeze({
  "yp-screen": "shell",
  "yp-panel": "shell",
  "yp-app-home-shell": "shell",
  "yp-scroll-area": "shell",
});

export interface ScopeBackfillCandidate {
  /** Идентификатор компонента (slug), например `yp-screen`. */
  id: string;
  name: string;
  atomicLevel?: AtomicLevel;
  /** Уже объявленный в исходнике scope, если он есть. */
  currentScope?: ComponentScope;
}

export interface ScopeBackfillPlanEntry extends ScopeBackfillCandidate {
  nextScope?: ComponentScope;
  action: "set" | "keep" | "skip";
  source: "override" | "atomicLevel" | "declared" | "unknown";
  /** Объявленный scope расходится с выводом по правилу — повод для ручной ревизии. */
  conflict?: boolean;
}

const DEFINITION_OPENING = /export\s+const\s+definition\s*(?::[^=]*?)?=\s*\{/;
/** `scope:` уже объявлен на верхнем уровне definition (грубая, но достаточная проверка). */
const DECLARED_SCOPE = /\n\s{0,4}scope\s*:\s*["']/;

export type ScopeInsertResult =
  | { ok: true; source: string }
  | { ok: false; reason: "no-definition" | "already-declared" };

/**
 * Вставляет `scope: "<scope>"` первым полем объявленного `definition` в TSX-исходнике
 * компонента. Чистая функция: backfill-скрипт (`scripts/backfill-component-scope.ts`)
 * печатает результат в dry-run и отправляет его в API только по `--apply`.
 */
export function insertDefinitionScope(source: string, scope: ComponentScope): ScopeInsertResult {
  const match = DEFINITION_OPENING.exec(source);
  if (!match) return { ok: false, reason: "no-definition" };
  const bodyStart = match.index + match[0].length;
  if (DECLARED_SCOPE.test(source.slice(bodyStart))) return { ok: false, reason: "already-declared" };
  return { ok: true, source: `${source.slice(0, bodyStart)}\n  scope: "${scope}",${source.slice(bodyStart)}` };
}

/**
 * Чистая функция планирования backfill'а: по каталогу компонентов решает, какой
 * `scope` проставить. Ничего не пишет — CLI печатает результат (dry-run) и
 * применяет его только по `--apply`.
 */
export function planScopeBackfill(candidates: readonly ScopeBackfillCandidate[]): ScopeBackfillPlanEntry[] {
  return candidates.map((candidate) => {
    const override = SCOPE_BACKFILL_OVERRIDES[candidate.id];
    const target = override ?? inferScopeFromAtomicLevel(candidate.atomicLevel);
    const source: ScopeBackfillPlanEntry["source"] = override
      ? "override"
      : candidate.currentScope !== undefined
        ? "declared"
        : candidate.atomicLevel !== undefined ? "atomicLevel" : "unknown";
    if (candidate.currentScope !== undefined) {
      return {
        ...candidate,
        action: "keep",
        source: "declared",
        ...(target !== undefined && target !== candidate.currentScope ? { conflict: true } : {}),
      };
    }
    if (target === undefined) return { ...candidate, action: "skip", source };
    return { ...candidate, nextScope: target, action: "set", source };
  });
}
