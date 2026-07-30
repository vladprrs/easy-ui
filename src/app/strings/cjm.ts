// Строки вью `/p/:id/cjm`. «CJM» осталось именем кода и маршрута, но из видимых
// подписей, `document.title` и aria выведено (план 2026-07-31, S1): пользователь
// видит «Сценарии».

import { pluralRu, screensCount } from "./common";

/** document.title вью разбора: имя прототипа (+версия) (W0-3). */
export const cjmDocumentTitle = (docName: string, version?: number) =>
  version === undefined ? `${docName} · Сценарии` : `${docName} v${version} · Сценарии`;

export const cjm = {
  screensAria: "Экраны прототипа",
  lanesAria: "Дорожки сценариев",
  mainLaneName: "Главный сценарий",
  unassignedLaneName: "Вне сценариев",
  // Плашка статична и видна в обоих режимах (W2-6): покрытие сценариями — то самое
  // число, ради которого экран и открывают, и прятать его за раскрытием нельзя.
  unassignedCount: (count: number) => `Вне сценариев · ${screensCount(count)}`,
  unassignedAria: "Экраны вне сценариев",
  verifiedStatic: "Подтверждённый переход",
  verifiedDynamic: "Динамический переход",
  verifiedMissing: "Переход не найден",
  edgesAria: "Рёбра сценариев",
  edgeTitle: (from: string, to: string, kind: "main" | "fork" | "branch" | "return", verified: "static" | "dynamic" | "missing") => `${from} → ${to}; ${kind}; ${verified}`,
  edgeDescription: (from: string, to: string, kind: "main" | "fork" | "branch" | "return", verified: "static" | "dynamic" | "missing") => `${from} → ${to}. Ребро ${kind}, проверка: ${verified}`,
  // Переключатель режимов разбора (план 2026-07-29 §6.1, T2b). На линейном документе
  // (без `doc.flows`) переключатель скрыт: показывать нечего, кроме ленты экранов.
  // Живёт в канве над счётчиками, а не в actions хрома (план 2026-07-31, S1):
  // `PrototypeChrome` рендерится ещё из плеера и редактора, где `layout` неизвестен.
  viewSwitchAria: "Режим просмотра",
  viewScenarios: "Сценарии",
  viewLanes: "Дорожки",
  // Actions хрома на вью разбора. «без сценария» — явная подпись: презентация
  // срезает `flow`/`step`, и тихая потеря контекста запрещена (план 2026-07-31, M7).
  share: "Поделиться",
  present: "Презентация · без сценария",
  // Простыня «Сценарии»: секции по флоу в DFS-порядке дерева `flow.parentId`.
  sheetAria: "Сценарии прототипа",
  treeAria: "Дерево сценариев",
  sheetStepsAria: (flowName: string) => `Экраны сценария «${flowName}»`,
  sheetScreensCount: screensCount,
  /** `M` считается по обратному индексу `screenFlowIndex` и включает сам сценарий (M ≥ 1). */
  sheetInFlows: (count: number) => `в ${count} ${pluralRu(count, ["сценарии", "сценариях", "сценариях"])}`,
  // Короткие лейблы кнопок секции (макет 02): в ряду с заголовком и метаданными
  // длинные подписи ломали строку. Состояния копирования сбрасываются через 2 с,
  // поэтому «Ссылка скопирована» — временная подпись той же кнопки.
  sheetCopyLink: "Ссылка",
  sheetLinkCopied: "Ссылка скопирована",
  sheetCopyFailed: "Не удалось скопировать",
  sheetOpenInPlayer: "В плеер →",
  sheetEmptySteps: "В сценарии нет шагов",
  /** Клик по тайлу простыни открывает кадр (лайтбокс) — жест не должен быть скрытым (W2-7). */
  sheetTileHint: "Клик по кадру открывает его крупно; «В плеер →» запускает сценарий с первого шага.",
  // Дерево ниже 1024px: колонка уезжает в поповер, а не исчезает вместе с
  // ориентацией «где я» (W2-4).
  treeMenuLabel: "Сценарии",
  // Простыня без единого сценария: правки `flows` в UI нет, поэтому CTA нет —
  // только объяснение, где размечаются сценарии (план 2026-07-31, m3(ux)).
  sheetEmptyTitle: "Экраны",
  sheetEmptyBody: "У прототипа нет сценариев: экраны показаны как есть, без порядка прохождения. Сценарии задаются массивом flows в документе прототипа — формат описан в docs/prototype-format.md.",
  /** Per-step метка проходимости: у дочерних флоу это единственный индикатор (§3). */
  stepVerified: (verified: "static" | "dynamic" | "missing") =>
    verified === "static" ? "Подтверждённый переход" : verified === "dynamic" ? "Динамический переход" : "Переход не найден",
  tileErrorTitle: "Экран не удалось отобразить",
  noContent: "Нет содержимого",
  // Подписи дорожек — служебные: они про геометрию, а не про смысл сценария
  // (`flow.description` про смысл и живёт в простыне). Номер шага 1-based — как
  // «шаг N» в простыне и лайтбоксе (план 2026-07-31, W3-3).
  laneForkAfter: (step: number) => `ветвится после шага ${step}`,
  /** Точки ветвления нет: ветка начинается вне главной линии и вливается в неё. */
  laneMergeBefore: (step: number) => `вливается в главную линию перед шагом ${step}`,
  laneDetached: "вне главной линии",
  /** Клик по тайлу дорожек и линейной ленты ведёт в плеер — жест ничем не обозначен. */
  laneTileHint: "Клик по кадру открывает экран в плеере.",
  openScreenAria: (screenName: string, docName: string) => `Открыть экран «${screenName}» прототипа «${docName}» в плеере`,
  // Ряд счётчиков режима «Сценарии» (макет 02).
  countersAria: "Сводка прототипа",
  counterScreens: "экранов",
  counterFlows: "сценариев",
  // Третий счётчик — связность шагов, трёхчастная (план 2026-07-31, W2-1).
  // Слово «проверки» из счётчиков выведено: в плеере так называется рекордер
  // (`strings/player.ts`), и одно слово на два разных смысла путало. Прежняя пара
  // «12 проверок» + «3 не проверено» ещё и врала: `dynamic` — валидная авторская
  // конструкция (навигация через `$event`), а не непроверенный переход.
  counterConnectivity: "связность шагов",
  connectivityConfirmed: (count: number) => `${count} подтверждено`,
  connectivityDynamic: (count: number) => `${count} ${pluralRu(count, ["динамический", "динамических", "динамических"])}`,
  connectivityMissing: (count: number) => `${count} не найдено`,
  connectivityLegendAria: "Легенда связности шагов",
  readinessReady: "Готов к публикации",
  readinessGaps: (count: number) => `${count} ${pluralRu(count, ["переход не найден", "перехода не найдено", "переходов не найдено"])}`,
  // На линейном документе (без `flows`) считать связность не по чему: ячейка
  // готовности показывала «Готов к публикации» и хвалила пустоту (W2-1).
  countersLinearTitle: "Сценарии не размечены",
  countersLinearBody: "Экраны показаны линейной лентой в порядке документа — связность шагов считать не по чему.",
  print: "Печать",
  sheetHint: "Экраны переиспользуются между сценариями: один и тот же экран может быть шагом сразу нескольких.",
  stepNumber: (index: number) => `шаг ${index}`,
} as const;

// Лайтбокс экрана (макет 03).
export const lightbox = {
  aria: (screenName: string) => `Экран «${screenName}»`,
  breadcrumbAria: "Путь до экрана",
  stepOf: (step: number, total: number) => `шаг ${step} / ${total}`,
  zonesToggle: (visible: boolean) => `Зоны переходов · ${visible ? "вкл" : "выкл"}`,
  zonesHidden: "Зоны переходов выключены",
  noTransitions: "С этого экрана переходов нет",
  targetTo: (screenName: string) => `→ ${screenName}`,
  targetStep: (step: number) => `шаг ${step}`,
  targetInFlow: "в текущем сценарии",
  targetOtherFlow: "вне текущего сценария",
  targetComputed: "→ цель вычисляется",
  openInPlayer: "В плеер →",
  previous: "Предыдущий шаг",
  next: "Следующий шаг",
  close: "Закрыть",
  thumbnailsAria: (flowName: string) => `Шаги сценария «${flowName}»`,
} as const;
