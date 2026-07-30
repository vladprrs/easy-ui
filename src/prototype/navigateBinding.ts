import type { RawActionBinding } from "./runtimeSpec";

/**
 * Цель одного `navigate`-действия внутри одного `on`-биндинга.
 *
 * `conditional` — **дополнительное** поле: наличие `$if` у действия не меняет
 * классификацию перехода (`docs/prototype-format.md`: «Static navigation is
 * recognized even under an action `$if`»), на которой стоят `verifyEdge` и чипы
 * CJM. Формулировку «цель вычисляется» по `conditional` рисует только оверлей
 * зон в плеере.
 */
export type NavigateTarget =
  | { kind: "static"; screenId: string; screenName: string; conditional: boolean }
  | { kind: "dynamic"; conditional: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Разбирает **один** сырой `on`-биндинг (`element.on[event]`, действие или массив
 * действий) в упорядоченный список целей `navigate`. Работает и с авторским
 * документом (`screen.spec.elements[key].on`), и с рантайм-метаданными
 * (`ScreenRenderPlan.metadata[key].on`), поэтому специфицирован на уровне биндинга,
 * а не экрана: связь «ключ элемента → цели» сохраняется, дедупликации нет.
 *
 * Действие без `params.screenId` цели не даёт (`back`/`restart`/прочее);
 * нестроковый `screenId` — динамическая цель, статического ребра не создающая.
 */
export function parseNavigateBinding(binding: RawActionBinding, screenNames: ReadonlyMap<string, string>): NavigateTarget[] {
  const actions = Array.isArray(binding) ? binding : [binding];
  const targets: NavigateTarget[] = [];
  for (const action of actions) {
    if (!isRecord(action) || action.action !== "navigate") continue;
    const params = isRecord(action.params) ? action.params : undefined;
    const target = params?.screenId;
    if (target === undefined) continue;
    const conditional = Object.hasOwn(action, "$if");
    if (typeof target === "string") {
      targets.push({ kind: "static", screenId: target, screenName: screenNames.get(target) ?? target, conditional });
    } else {
      targets.push({ kind: "dynamic", conditional });
    }
  }
  return targets;
}
