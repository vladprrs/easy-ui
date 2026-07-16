// Строки custom-only библиотеки компонентов.

import { pluralRu } from "./common";

export const library = {
  title: "Библиотека компонентов",
  loadingSystems: "Загружаем дизайн-системы…",
  systemsUnavailable: "Дизайн-системы недоступны.",
  designSystemsAria: "Дизайн-системы",
  statusFiltersAria: "Фильтры статусов",
  componentsAria: "Компоненты",
  retry: "Повторить",
  emptySystemTitle: "В этой дизайн-системе пока нет компонентов",
  emptySystemDescription: "Добавьте и опубликуйте первый пользовательский компонент через API — после публикации он появится в библиотеке.",
  emptySystemGuideTitle: "Как добавить компонент",
  emptySystemCreateStep: "Создайте компонент с исходником TSX:",
  emptySystemPublishStep: "Опубликуйте подготовленную версию:",
  emptySystemApiLink: "Открыть описание API",
  loadingCatalog: "Загружаем каталог пользовательских компонентов…",
  catalogUnavailable: "Каталог пользовательских компонентов недоступен.",
  selectComponent: "Выберите компонент слева, чтобы посмотреть его описание и живое превью.",
  customBadge: "Пользовательский компонент",
  customSectionSuffix: "пользовательские",
  componentPageLink: "Страница компонента",
  linkedToFigma: "Связан с Figma",
  previewTitle: (componentName: string) => `Превью компонента ${componentName}`,
  previewVariantsAria: "Варианты превью",
  noExampleProps: "Example-props не заданы, поэтому живое превью недоступно.",
  metaSystem: "Система",
  metaAtomicLevel: "Атомарный уровень",
  metaVersion: "Версия",
  metaDescription: "Описание",
  metaEvents: "События",
  metaSlots: "Слоты",
  noDescription: "Без описания",
  none: "Нет",
} as const;

export const figmaBadgeTitle = (fileKey: string, nodeCount: number) =>
  `Figma ${fileKey} · ${nodeCount} ${pluralRu(nodeCount, ["узел", "узла", "узлов"])}`;

// Заголовки секций по уровням Atomic Design. Ключи совпадают со структурой
// atomicLevelLabel.
export const levelSectionLabel: Record<string, string> = {
  Layout: "Лэйаут",
  Atoms: "Атомы",
  Molecules: "Молекулы",
  Organisms: "Организмы",
  Templates: "Шаблоны",
  Pages: "Страницы",
  Other: "Прочее",
};

export const levelSection = (level: string) => levelSectionLabel[level] ?? level;

export const libraryStatusLabels = {
  published: "Опубликован",
  verified: "Проверен",
  "visual-pending": "Ждёт проверки",
  blocked: "Заблокирован",
  rejected: "Отклонён",
} as const;

export const componentStatusLabels = {
  deprecated: "Устаревший",
  superseded: "Заменён",
  rejected: "Отклонён",
  archived: "В архиве",
} as const;
