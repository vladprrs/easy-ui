import { evaluateVisibility, resolveElementProps, type VisibilityCondition } from "@json-render/core";
import type { StateModel } from "@json-render/react";
import type { PrototypeDoc } from "../prototype/schema";
import type { ScenarioStep } from "../prototype/scenario";
import { scenarioEntryScreen } from "../prototype/scenario";
import { getAtPointer } from "../prototype/pointer";
import { docSurfaces, surfaceOf } from "../prototype/surfaces";
import { EasyUiActionRuntime, type EmitContext, type RawAction } from "./actionRuntime";

/**
 * Клиентский раннер сценариев (волна 6, план 2026-07-27 §«Волна 6»).
 *
 * Чистая функция поверх {@link EasyUiActionRuntime}: DOM не нужен, поэтому один и
 * тот же прогон работает и для черновика, и для неизменяемой версии, и в юнит-тесте.
 * Серверного headless-прогона нет — он вырезан триажем ревью плана.
 *
 * **Документ на входе уже раскрыт.** `src/api/client.ts` раскрывает композиции
 * (`expandCompositions`) до того, как документ попадает в плеер, поэтому ключи шагов
 * — это ключи раскрытого документа (`<hostKey>$<innerKey>` для внутренностей
 * композиции). Рекордер пишет ровно тот ключ, что стоит в `data-eui-key`, а раннер
 * ищет его в том же раскрытом документе — специальной обработки `$` не требуется.
 *
 * **Дрейф ревизии не является провалом.** Ключи элементов скоупны ревизии: экран
 * пересобрали, композицию перевыпустили — ключ исчез. Такой шаг получает статус
 * `stale` и не роняет прогон; `fail` остаётся за настоящими нарушениями ожиданий.
 */

export type ScenarioStepStatus = "pass" | "fail" | "stale";

export interface ScenarioStepResult {
  index: number;
  status: ScenarioStepStatus;
  /** Стабильный машинный ключ причины (RU-строки живут в UI). */
  message?: string;
  /** Экран, на котором шаг был выполнен. */
  screenId: string;
}

export interface ScenarioRunResult {
  /** `pass`, если ни один шаг не `fail`: `stale` — дрейф ревизии, а не провал. */
  status: "pass" | "fail";
  steps: ScenarioStepResult[];
  failed: number;
  stale: number;
  /** Экран, на котором прогон закончился. */
  screenId: string;
  /** Ошибки рантайма, накопленные за прогон (несуществующая навигация и т. п.). */
  errors: string[];
}

/** Максимум элементов, обходимых при поиске текста, — защита от патологических repeat. */
const WALK_BUDGET = 5_000;
/** Максимум элементов repeat-массива, разворачиваемых при поиске текста. */
const REPEAT_SCAN_LIMIT = 50;

type Screen = PrototypeDoc["screens"][number];
type Element = Screen["spec"]["elements"][string];

interface ElementContext {
  key: string;
  element: Element;
  repeatItem?: unknown;
  repeatIndex?: number;
  repeatBasePath?: string;
  /** `repeat.key` ближайшего repeat-предка — источник `$itemKey` при dispatch. */
  repeatKey?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * Обходит отрисовываемое дерево экрана, повторяя правила рантайма: невидимые
 * поддеревья пропускаются, `repeat` разворачивается по элементам массива состояния
 * (сам repeat-элемент рендерится один раз в окружающем контексте).
 */
function walkScreen(screen: Screen, state: StateModel, visit: (context: ElementContext) => boolean | void): void {
  const { elements, root } = screen.spec;
  let budget = WALK_BUDGET;
  let stopped = false;
  const visible = (element: Element, context: Omit<ElementContext, "key" | "element">): boolean =>
    element.visible === undefined
      ? true
      : evaluateVisibility(element.visible as VisibilityCondition, { stateModel: state, repeatItem: context.repeatItem, repeatIndex: context.repeatIndex });

  const walk = (key: string, context: Omit<ElementContext, "key" | "element">, seen: ReadonlySet<string>): void => {
    if (stopped || budget-- <= 0 || seen.has(key)) return;
    const element = elements[key];
    if (!element) return;
    if (!visible(element, context)) return;
    if (visit({ key, element, ...context }) === true) { stopped = true; return; }
    const children = element.children ?? [];
    if (!children.length) return;
    const nextSeen = new Set([...seen, key]);
    if (element.repeat) {
      const items = getAtPointer(state, element.repeat.statePath).value;
      if (!Array.isArray(items)) return;
      for (const [index, item] of items.slice(0, REPEAT_SCAN_LIMIT).entries()) {
        for (const child of children) {
          walk(child, {
            repeatItem: item,
            repeatIndex: index,
            repeatBasePath: `${element.repeat.statePath}/${index}`,
            repeatKey: element.repeat.key,
          }, nextSeen);
        }
      }
      return;
    }
    for (const child of children) walk(child, context, nextSeen);
  };
  walk(root, {}, new Set());
}

function resolveProps(element: Element, state: StateModel, context: ElementContext): Record<string, unknown> {
  try {
    return resolveElementProps(element.props, {
      stateModel: state,
      repeatItem: context.repeatItem,
      repeatIndex: context.repeatIndex,
      repeatBasePath: context.repeatBasePath,
    });
  } catch { return element.props; }
}

/** Собирает все строковые значения пропа (в т. ч. вложенные) для поиска текста. */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") { into.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, into); return; }
  if (isObject(value)) { for (const item of Object.values(value)) collectStrings(item, into); }
}

/**
 * Сессия прогона: рантайм действий плюс отслеживание текущего экрана.
 *
 * Навигация не трогает роутер — она живёт внутри сессии, поэтому прогон никогда не
 * уводит открытый плеер с экрана и может выполняться параллельно живому сеансу.
 */
/** Позиция сессии: экран каждой поверхности плюс сфокусированная (план multi-surface, D12). */
interface SessionPosition {
  screenBySurface: Record<string, string>;
  focused: string;
}

export class ScenarioSession {
  readonly runtime: EasyUiActionRuntime;
  readonly errors: string[] = [];
  readonly openedUrls: string[] = [];
  private position: SessionPosition;
  private history: SessionPosition[] = [];

  constructor(private readonly doc: PrototypeDoc, startScreen?: string) {
    this.position = this.startPosition(startScreen);
    this.runtime = new EasyUiActionRuntime({
      initialState: doc.state,
      computed: doc.computed,
      screenIds: new Set(doc.screens.map((screen) => screen.id)),
      deps: {
        // Навигация двигает экран **той** поверхности, которой принадлежит цель, и
        // переносит на неё фокус — ровно как живой плеер (D6).
        navigate: (screenId) => {
          const focused = surfaceOf(this.doc, screenId).id;
          this.history.push(this.position);
          this.position = { screenBySurface: { ...this.position.screenBySurface, [focused]: screenId }, focused };
          return Promise.resolve();
        },
        back: () => { const previous = this.history.pop(); if (previous !== undefined) this.position = previous; return Promise.resolve(); },
        // restart сбрасывает **все** поверхности на их startScreen (D12).
        restart: () => { this.history = []; this.position = this.startPosition(); return Promise.resolve(); },
        openUrl: (url) => { this.openedUrls.push(url); return Promise.resolve(); },
      },
      onError: (message) => { this.errors.push(message); },
    });
  }

  private startPosition(startScreen?: string): SessionPosition {
    const screenBySurface = Object.fromEntries(docSurfaces(this.doc).map((surface) => [surface.id, surface.startScreen]));
    const entry = startScreen ?? this.doc.startScreen;
    const focused = surfaceOf(this.doc, entry).id;
    screenBySurface[focused] = entry;
    return { screenBySurface, focused };
  }

  /** Экран сфокусированной поверхности (для одно-поверхностного документа — просто текущий). */
  get screenId(): string { return this.position.screenBySurface[this.position.focused]!; }
  get screen(): Screen | undefined { return this.doc.screens.find((screen) => screen.id === this.screenId); }
  get state(): StateModel { return this.runtime.store.get("/") as StateModel; }

  /** Экран поверхности; `undefined` — неизвестная поверхность. */
  screenOfSurface(surfaceId: string): string | undefined { return this.position.screenBySurface[surfaceId]; }

  /**
   * `expectScreen` сверяется с картой: экран любой поверхности проверяется по **своей**
   * поверхности, поэтому шаг про вторую панель не требует переноса фокуса (D12).
   */
  isCurrent(screenId: string): boolean {
    return this.position.screenBySurface[surfaceOf(this.doc, screenId).id] === screenId;
  }

  /** Отрисованные сейчас экраны: сфокусированный первым, затем остальные панели. */
  get activeScreens(): Screen[] {
    const ids = [this.screenId, ...Object.entries(this.position.screenBySurface)
      .filter(([surfaceId]) => surfaceId !== this.position.focused)
      .map(([, screenId]) => screenId)];
    return ids.flatMap((id) => {
      const screen = this.doc.screens.find((item) => item.id === id);
      return screen ? [screen] : [];
    });
  }
}

/** Ищет элемент по ключу среди отрисовываемых узлов текущего экрана. */
function findRendered(screen: Screen, state: StateModel, key: string): ElementContext | null {
  let found: ElementContext | null = null;
  walkScreen(screen, state, (context) => {
    if (context.key !== key) return;
    found = context;
    return true;
  });
  return found;
}

/**
 * Ищет элемент среди **активных** экранов сессии (D11: на дуо-доке смонтированы обе
 * панели, кликнуть можно и по несфокусированной). Сфокусированный экран проверяется
 * первым, поэтому одно-поверхностный документ ведёт себя как раньше.
 */
function locateElement(session: ScenarioSession, state: StateModel, elementKey: string): { screen: Screen; context: ElementContext | null } | null {
  const declaring = session.activeScreens.filter((screen) => screen.spec.elements[elementKey]);
  if (!declaring.length) return null;
  for (const screen of declaring) {
    const context = findRendered(screen, state, elementKey);
    if (context) return { screen, context };
  }
  return { screen: declaring[0]!, context: null };
}

async function runStep(step: ScenarioStep, session: ScenarioSession, index: number): Promise<ScenarioStepResult> {
  const screenId = session.screenId;
  const result = (status: ScenarioStepStatus, message?: string): ScenarioStepResult =>
    ({ index, status, screenId, ...(message ? { message } : {}) });
  const screen = session.screen;
  if (!screen) return result("stale", `screen_missing:${screenId}`);
  const state = session.state;

  switch (step.type) {
    case "expectScreen": {
      if (!session.screen) return result("stale", `screen_missing:${step.screenId}`);
      // Карта поверхностей: экран сверяется со **своей** панелью (D12).
      return session.isCurrent(step.screenId) ? result("pass") : result("fail", `expected_screen:${step.screenId}`);
    }
    case "click": {
      const located = locateElement(session, state, step.elementKey);
      // Ключ ревизионно-скоупный: пропал ключ — это дрейф, а не провал сценария.
      if (!located) return result("stale", `element_missing:${step.elementKey}`);
      const context = located.context;
      if (!context) return result("fail", `element_not_rendered:${step.elementKey}`);
      const bindings = context.element.on?.press as RawAction | RawAction[] | undefined;
      // Обработчик мог исчезнуть вместе с переработкой экрана — тоже дрейф ревизии.
      if (!bindings) return result("stale", `no_press_binding:${step.elementKey}`);
      const emit: EmitContext = {
        event: "press",
        payload: undefined,
        elementId: step.elementKey,
        ...(context.repeatIndex === undefined ? {} : { itemIndex: context.repeatIndex }),
        ...(context.repeatKey !== undefined && isObject(context.repeatItem) ? { itemKey: context.repeatItem[context.repeatKey] } : {}),
      };
      const before = session.errors.length;
      await session.runtime.dispatch(bindings, emit);
      return session.errors.length > before ? result("fail", session.errors[before]!) : result("pass");
    }
    case "expectText": {
      const needle = step.text.toLowerCase();
      let hit = false;
      // Текст ищется на всех активных панелях: статус второй поверхности — такая же
      // часть картинки, как экран сфокусированной.
      for (const active of session.activeScreens) {
        if (hit) break;
        walkScreen(active, state, (context) => {
          const strings: string[] = [];
          collectStrings(resolveProps(context.element, state, context), strings);
          if (strings.some((value) => value.toLowerCase().includes(needle))) { hit = true; return true; }
        });
      }
      return hit ? result("pass") : result("fail", `text_not_found:${step.text}`);
    }
    case "setState": {
      const before = session.errors.length;
      session.runtime.store.set(step.pointer, step.value);
      return session.errors.length > before ? result("fail", session.errors[before]!) : result("pass");
    }
    case "expectState": {
      const actual = getAtPointer(state, step.pointer);
      return deepEqual(actual.value, step.value) ? result("pass") : result("fail", `state_mismatch:${step.pointer}`);
    }
    case "expectDisabled": {
      const located = locateElement(session, state, step.elementKey);
      if (!located) return result("stale", `element_missing:${step.elementKey}`);
      const context = located.context;
      if (!context) return result("fail", `element_not_rendered:${step.elementKey}`);
      const props = resolveProps(context.element, state, context);
      return props.disabled === true ? result("pass") : result("fail", `not_disabled:${step.elementKey}`);
    }
  }
}

export interface RunScenarioOptions {
  /** Экран входа; по умолчанию — ведущий `expectScreen` шага 1 либо `doc.startScreen`. */
  startScreen?: string;
  /** Готовая сессия (замер состояния снаружи); по умолчанию создаётся новая. */
  session?: ScenarioSession;
  /** Прогресс-колбэк: вызывается после каждого шага (подсветка текущего шага в UI). */
  onStep?: (result: ScenarioStepResult, all: readonly ScenarioStepResult[]) => void;
}

/**
 * Прогоняет сценарий по документу. Возвращает статус каждого шага; выполнение не
 * прерывается на `fail` — автору полезно видеть, где именно сценарий разошёлся
 * с прототипом дальше по цепочке.
 */
export async function runScenario(steps: readonly ScenarioStep[], doc: PrototypeDoc, options: RunScenarioOptions = {}): Promise<ScenarioRunResult> {
  const session = options.session ?? new ScenarioSession(doc, options.startScreen ?? scenarioEntryScreen(steps, doc.startScreen));
  const results: ScenarioStepResult[] = [];
  for (const [index, step] of steps.entries()) {
    const result = await runStep(step, session, index);
    results.push(result);
    options.onStep?.(result, results);
  }
  const failed = results.filter((item) => item.status === "fail").length;
  return {
    status: failed ? "fail" : "pass",
    steps: results,
    failed,
    stale: results.filter((item) => item.status === "stale").length,
    screenId: session.screenId,
    errors: [...session.errors],
  };
}
