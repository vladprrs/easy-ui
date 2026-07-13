// Строки библиотеки компонентов (W0-5). Storybook и Figma — собственные имена,
// не переводятся; названия историй и имена компонентов — authored-контент.

import { pluralRu } from "./common";

export const library = {
  title: "Библиотека компонентов",
  loadingSystems: "Загружаем дизайн-системы…",
  systemsUnavailable: "Дизайн-системы недоступны.",
  designSystemsAria: "Дизайн-системы",
  statusFiltersAria: "Фильтры статусов",
  componentsAria: "Компоненты",
  retry: "Повторить",
  noComponents: "Компоненты ещё не опубликованы.",
  loadingStorybook: "Загружаем Storybook…",
  storybookUnavailable: "Storybook недоступен; пользовательские компоненты по-прежнему видны.",
  loadingCatalog: "Загружаем каталог пользовательских компонентов…",
  catalogUnavailable: "Каталог пользовательских компонентов недоступен.",
  selectComponent: "Выберите компонент, чтобы посмотреть детали.",
  openInStorybook: "Открыть в Storybook",
  storyPreviewTitle: "Превью истории",
  customBadge: "Пользовательский компонент",
  customSectionSuffix: "пользовательские",
  linkedToFigma: "Связан с Figma",
  previewTitle: (componentName: string) => `Превью компонента ${componentName}`,
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
// заголовков Storybook-историй (parseStorybookTitle) и atomicLevelLabel.
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
