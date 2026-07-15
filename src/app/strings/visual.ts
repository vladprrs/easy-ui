// Строки страницы визуальных проверок (W0-5). Имена метрик (exact-rgba,
// pixelmatch-v1) и технические ключи fingerprint не переводятся.

import type { RunStatus } from "../../visual/api";

export const visual = {
  title: "Визуальные проверки",
  subtitle: "Закреплённые эталоны сравниваются с захваченными кандидатами по честному отчёту улик — exact-rgba и pixelmatch-v1, без выдуманных процентов.",
  scopeAria: "Область",
  scopeAll: "Все",
  scopePrototypeScreens: "Экраны прототипов",
  scopeComponents: "Компоненты",
  loadingReferences: "Загружаем эталоны…",
  referencesUnavailable: "Эталоны недоступны.",
  noReferences: "Эталонов пока нет.",
  noRunsYet: "Прогонов ещё не было",
  selectReference: "Выберите эталон.",
  loadingReference: "Загружаем эталон…",
  referenceUnavailable: "Эталон недоступен.",
  thresholdLabel: "Порог, %",
  thresholdInvalid: "Введите число от 0 до 100 процентов.",
  check: "Проверить",
  checking: "Проверяем…",
  runNowHint: "Прогонов ещё не было — запустите проверку, чтобы захватить кандидата.",
  runHistory: "История прогонов",
  noRunsRecorded: "Прогоны не записаны.",
  noMetric: "без метрики",
  frameReference: "Эталон",
  frameCandidate: "Кандидат",
  frameDiff: "Дифф",
  frameUnavailable: "Недоступно",
  referenceUnknown: "Эталон прогона неизвестен",
  screenshotAlt: (title: string) => `Скриншот: ${title}`,
  evidenceDiffPixels: "Пиксели диффа / знаменатель",
  evidenceMetricOptions: "Параметры метрики",
  evidenceCandidateMeta: "Метаданные кандидата",
  captureReference: "+ Снять эталон",
  newReference: "Новый эталон",
  close: "Закрыть",
  optionPrototypeScreen: "Экран прототипа",
  optionComponent: "Компонент",
  modeLabel: "Режим",
  prototypeLabel: "Прототип",
  selectPrototype: "Выберите прототип",
  snapshotLabel: "Ревизия или версия",
  revisionOption: (revision: number) => `Ревизия ${revision}`,
  versionOption: (version: number, revision: number) => `Версия ${version} · ревизия ${revision}`,
  screenLabel: "Экран",
  componentLabel: "Компонент",
  selectComponent: "Выберите компонент",
  versionLabel: "Версия",
  componentVersionOption: (version: number) => `Версия ${version}`,
  scaleLabel: "Масштаб",
  themeLabel: "Тема",
  themeLight: "Светлая",
  themeDark: "Тёмная",
  viewportValue: (width: number, height: number) => `Размер: ${width}×${height} — определён автоматически`,
  viewportUnavailable: "Для этого desktop-экрана нет канонической высоты. Добавьте canvas или сначала используйте существующий эталон.",
  noteLabel: "Заметка",
  notePlaceholder: "заметка (необязательно)",
  loadingCaptureOptions: "Загружаем варианты…",
  captureBaseline: "Снять эталон",
  capturing: "Снимаем эталон…",
  captureQueued: "Снимок ждёт в очереди…",
  captureRunning: "Снимок создаётся…",
  captureFailed: "Не удалось снять эталон.",
  captureMissingResult: "Задание завершилось без результата.",
  stopWaiting: "Перестать ждать",
  waitingStopped: "Ожидание остановлено. Задание продолжает выполняться на сервере.",
  resumeWaiting: "Продолжить ожидание",
  deleteReference: "Удалить эталон",
  deleteConfirm: "Удалить активный эталон? История прогонов сохранится.",
  baselineManaged: "Этот reference управляется baseline-набором и не может быть изменён отдельно.",
} as const;

export const runStatusLabel = (status: RunStatus): string => {
  switch (status) {
    case "pass": return "Пройдено";
    case "fail": return "Расхождение";
    case "error": return "Ошибка";
    case "reference_missing": return "Нет эталона";
    case "reference_unknown": return "Эталон прогона неизвестен";
    case "running": return "Выполняется…";
  }
};

export const referenceScopeLabel = (scope: unknown): string =>
  scope === "prototype-screen" ? "Экран прототипа" : scope === "component" ? "Компонент" : "Неизвестная область";
