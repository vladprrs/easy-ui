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
  screenshotAlt: (title: string) => `Скриншот: ${title}`,
  evidenceDiffPixels: "Пиксели диффа / знаменатель",
  evidenceMetricOptions: "Параметры метрики",
  evidenceCandidateMeta: "Метаданные кандидата",
  uploadReference: "+ Загрузить эталон",
  newReference: "Новый эталон",
  close: "Закрыть",
  optionPrototypeScreen: "Экран прототипа",
  optionComponent: "Компонент",
  notePlaceholder: "заметка (необязательно)",
  choosePngFirst: "Сначала выберите PNG-файл",
  uploading: "Загрузка…",
  saveReference: "Сохранить эталон",
} as const;

export const runStatusLabel = (status: RunStatus): string => {
  switch (status) {
    case "pass": return "Пройдено";
    case "fail": return "Расхождение";
    case "error": return "Ошибка";
    case "reference_missing": return "Нет эталона";
    case "running": return "Выполняется…";
  }
};

export const referenceScopeLabel = (scope: unknown): string =>
  scope === "prototype-screen" ? "Экран прототипа" : scope === "component" ? "Компонент" : "Неизвестная область";
