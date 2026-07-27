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
  // Волна 3: поиск по работе, бейджи канона/устаревания и граф использования.
  searchLabel: "Поиск по задаче",
  searchPlaceholder: "например: navbar успеха, кнопка оплаты",
  searchEmpty: "Ничего не нашлось. Попробуйте другое слово — поиск смотрит на имя, описание, роль и уровень.",
  canonicalBadge: "Канонический",
  canonicalBadgeTitle: (roles: string[]) => `Канонический компонент для ролей: ${roles.join(", ")}`,
  deprecatedBadge: "Устаревший",
  deprecatedBadgeTitle: "Последняя публикация компонента переведена в deprecated или superseded",
  replacementLink: (name: string) => `Замена: ${name}`,
  headUsageTitle: "Используется в head",
  headUsageLoading: "Считаем использование…",
  headUsageError: "Не удалось загрузить использование.",
  headUsageNone: "Ни один прототип не использует компонент в головной ревизии.",
  headUsageCount: (count: number) => `${count} ${pluralRu(count, ["прототип", "прототипа", "прототипов"])}`,
  showUsages: "Показать usages",
  hideUsages: "Скрыть usages",
  usagesTreeAria: "Дерево использования компонента",
  openInEditor: "Редактор",
  openInPlayer: "Плеер",
  immutableUsageTitle: "Зафиксировано публикациями",
  immutableUsageEntry: (name: string, version: number, componentVersion: number) => `${name} · публикация v${version} → компонент v${componentVersion}`,
  safeToRemove: "Компонент нигде не используется — его можно безопасно удалить.",
  similarTitle: "Похожие компоненты",
  metaRoles: "Роли (canonicalFor)",
  metaScope: "Scope",
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
