import type { CompositionWhen } from "./conditions";

/**
 * Трассировка раскрытия композиций (план 2026-08-03 §5 W8g).
 *
 * Коллектор — **опциональный колбэк** в `ExpandCompositionsOptions.trace`: раскрытие
 * ничего не собирает, пока его не передали, поэтому save-путь прототипа и клиентское
 * раскрытие работают ровно как раньше (нулевая стоимость и байт-в-байт те же деревья).
 * Единственный потребитель — `POST /api/compositions/:id/preview-tree`, которому нужно
 * показать автору **фактические** решения раскрытия: какие ветки `when` взяты, какой
 * case выбрал `$switch`, сколько клонов дал `repeatParam`, что произошло со слотами и
 * какие props получил token layout.
 *
 * События эмитятся **только на nested-пути** (`expandRecursiveCompositions`): legacy-путь v1
 * заморожен (D8) и его диспетчер не трогается.
 */

/** Общая часть события: какая композиция и в какой точке ссылки его породила. */
export interface CompositionTraceOrigin {
  compositionId: string;
  /** Публикационная версия композиции (не версия схемы документа). */
  version: number;
  /** Ключ `@eui/Composition`-элемента в авторском документе. */
  hostKey: string;
}

export interface CompositionTraceParamsEvent extends CompositionTraceOrigin {
  /** Значения после варианта, явного `params` и дефолтов объявления. */
  params: Record<string, unknown>;
}

export interface CompositionTraceBranchEvent extends CompositionTraceOrigin {
  /** Раскрытый ключ (`<hostKey>$<innerKey>`) — тот же, что в дереве. */
  elementKey: string;
  innerKey: string;
  when: CompositionWhen;
  /** true — элемент материализовался; false — он и всё его поддерево сняты. */
  taken: boolean;
}

export interface CompositionTraceSwitchEvent extends CompositionTraceOrigin {
  elementKey: string;
  innerKey: string;
  /** Путь внутри props (`"/"`-разделитель), где стоял `$switch`. */
  prop: string;
  param: string;
  /** Выбранный case или `"default"`. */
  case: string;
}

export interface CompositionTraceRepeatEvent extends CompositionTraceOrigin {
  elementKey: string;
  innerKey: string;
  param: string;
  /** Сколько клонов реально построено (после `maxItems` и коллизий ключей). */
  count: number;
}

export interface CompositionTraceSlotEvent extends CompositionTraceOrigin {
  slot: string;
  required: boolean;
  filled: boolean;
  fallbackUsed: boolean;
  /** Ключи детей точки ссылки, замаршрутизированных в слот. */
  children: string[];
}

export interface CompositionTraceLayoutEvent extends CompositionTraceOrigin {
  elementKey: string;
  innerKey: string;
  type: string;
  /** Props, в которые скомпилировался `element.layout`. */
  props: Record<string, unknown>;
}

/** Все колбэки опциональны: потребитель подписывается только на нужное. */
export interface CompositionTrace {
  params?: (event: CompositionTraceParamsEvent) => void;
  branch?: (event: CompositionTraceBranchEvent) => void;
  switch?: (event: CompositionTraceSwitchEvent) => void;
  repeat?: (event: CompositionTraceRepeatEvent) => void;
  slot?: (event: CompositionTraceSlotEvent) => void;
  layout?: (event: CompositionTraceLayoutEvent) => void;
}

/** Собранная трасса одного раскрытия. */
export interface CompositionTraceLog {
  params: CompositionTraceParamsEvent[];
  branches: CompositionTraceBranchEvent[];
  switches: CompositionTraceSwitchEvent[];
  repeats: CompositionTraceRepeatEvent[];
  slots: CompositionTraceSlotEvent[];
  layouts: CompositionTraceLayoutEvent[];
}

/** Коллектор-накопитель: `{ trace, log }` для одного прогона раскрытия. */
export function createCompositionTrace(): { trace: CompositionTrace; log: CompositionTraceLog } {
  const log: CompositionTraceLog = { params: [], branches: [], switches: [], repeats: [], slots: [], layouts: [] };
  return {
    log,
    trace: {
      params: (event) => { log.params.push(event); },
      branch: (event) => { log.branches.push(event); },
      switch: (event) => { log.switches.push(event); },
      repeat: (event) => { log.repeats.push(event); },
      slot: (event) => { log.slots.push(event); },
      layout: (event) => { log.layouts.push(event); },
    },
  };
}
