// Строки custom-only библиотеки компонентов.

import { pluralRu } from "./common";

export const library = {
  title: "Библиотека компонентов",
  heroTitle: "Компоненты вашей дизайн-системы",
  subtitle: "Агент использует их в прототипах и добавляет новые, когда нужно.",
  subtitleEmpty: "Агент добавит нужные компоненты при сборке прототипа.",
  designSystemsAria: "Дизайн-системы",
  statusFiltersAria: "Фильтры статусов",
  allSystems: "Все системы",
  allStatuses: "Любой статус",
  retry: "Повторить",
  loading: "Загружаем библиотеку компонентов…",
  unavailable: "Библиотека компонентов недоступна.",
  // Карточка компонента (макет 06).
  statusReady: "готов",
  statusDraft: "черновик",
  statusTitleReady: "У компонента есть активная опубликованная версия",
  statusTitleDraft: "Активной опубликованной версии пока нет",
  cardVersion: (version: number) => `v${version}`,
  cardUsage: (count: number) => count === 0
    ? "пока нигде не используется"
    : `используется в ${count} ${pluralRu(count, ["прототипе", "прототипах", "прототипах"])}`,
  previewMissing: "Превью недоступно: не заданы примерные параметры.",
  previewAria: (componentName: string) => `Превью компонента ${componentName}`,
  // Плашка сбоя инлайн-превью: вид сбоя (метаданные/тема/бандл/рендер) виден только в data-*,
  // пользователю адресован один текст и одно действие.
  previewFailed: "Превью не загрузилось",
  previewReloadRequired: "Обновите страницу, чтобы загрузить превью",
  previewReload: "Обновить страницу",
  // Результаты поиска и фильтров.
  foundTitle: (count: number) => `Нашлось ${count} ${pluralRu(count, ["компонент", "компонента", "компонентов"])}`,
  levelCount: (count: number) => `${count} ${pluralRu(count, ["компонент", "компонента", "компонентов"])}`,
  emptyFiltered: "Под выбранные фильтры ничего не подошло.",
  resetFilters: "Сбросить фильтры",
  emptyTitle: "Компонентов пока нет",
  emptyDescription: "Агент добавит и опубликует нужные компоненты при сборке прототипа.",
  noDescription: "Без описания",
  // Поиск по работе (волна 3) и бейджи канона/устаревания.
  searchLabel: "Поиск по задаче",
  searchPlaceholder: "Например, кнопка оплаты или экран успеха",
  searchEmpty: "Ничего не нашли. Попробуйте описать задачу иначе.",
  canonicalBadge: "Канонический",
  canonicalBadgeTitle: (roles: string[]) => `Канонический компонент для ролей: ${roles.join(", ")}`,
  deprecatedBadge: "Устаревший",
  deprecatedBadgeTitle: "Последняя публикация компонента переведена в deprecated или superseded",
  // Признак `accepted` (RFC candidate-acceptance §7): у активной версии есть acceptance-evidence.
  acceptedBadge: "Принят",
  acceptedBadgeTitle: "Активная версия опубликована через приёмку: за ней стоит пройденный acceptance-run",
  replacementLink: (name: string) => `Замена: ${name}`,
  usagesTreeAria: "Дерево использования компонента",
  openInEditor: "Редактор",
  // Волна 5: переключатель разделов библиотеки.
  sectionsAria: "Разделы библиотеки",
  tabComponents: "Компоненты",
  tabCompositions: "Композиции",
  // Ярусы витрины (план 2026-07-31 §4.5): вместо плоского списка уровней Atomic Design
  // экран ведёт от «что взять» к «что есть» и заканчивает списанным.
  tierRecommended: "Рекомендуем",
  tierHigh: "Страницы, шаблоны и организмы",
  tierMolecules: "Молекулы",
  tierAtoms: "Атомы и лэйаут",
  tierRetired: "Устаревшее",
  // Компактный индекс: превью атома стоит дорого, поэтому оно раскрывается только по действию.
  compactShowPreview: "Показать превью",
  compactPreviewOf: (name: string) => `Превью компонента ${name}`,
} as const;

// Волна 5: раздел версионированных композиций (read-only витрина).
export const compositions = {
  title: "Композиции",
  listAria: "Композиции",
  loading: "Загружаем композиции…",
  unavailable: "Композиции недоступны.",
  select: "Выберите композицию слева, чтобы посмотреть её параметры, слоты и использование.",
  emptyTitle: "Композиций пока нет",
  emptyDescription: "Агент создаёт их из повторяющихся частей прототипов.",
  loadingDetail: "Загружаем композицию…",
  detailUnavailable: "Не удалось загрузить композицию.",
  metaSystem: "Дизайн-система",
  metaId: "Идентификатор",
  metaHeadRev: "Головная ревизия",
  metaLatestVersion: "Последняя публикация",
  metaUpdatedAt: "Обновлена",
  notPublished: "Не опубликована",
  headRevValue: (rev: number) => `rev ${rev}`,
  versionValue: (version: number) => `v${version}`,
  description: "Описание",
  noDescription: "Без описания",
  paramsTitle: "Параметры",
  paramsAria: "Параметры композиции",
  paramsNone: "Параметров нет.",
  paramName: "Параметр",
  paramType: "Тип",
  paramFlags: "Обязательность",
  paramDefault: "По умолчанию",
  paramRequired: "Обязательный",
  paramOptional: "Необязательный",
  paramNoDefault: "—",
  slotsTitle: "Слоты",
  slotsAria: "Слоты композиции",
  slotsNone: "Слотов нет.",
  usageTitle: "Где используется",
  usageLoading: "Считаем использование…",
  usageError: "Не удалось загрузить использование.",
  usageNone: "Ни один прототип не использует композицию в головной ревизии.",
  usageSafeToRemove: "Композиция нигде не используется — её можно безопасно удалить.",
  usageCount: (count: number) => `${count} ${pluralRu(count, ["прототип", "прототипа", "прототипов"])}`,
  usageAria: "Использование композиции в head",
  usageEntryMeta: (kind: string, rev: number, version: number) => `${kind} · rev ${rev} · v${version}`,
  openInEditor: "Редактор",
  openInPlayer: "Плеер",
  immutableTitle: "Зафиксировано публикациями",
  immutableEntry: (prototypeId: string, version: number, compositionVersion: number) =>
    `${prototypeId} · публикация v${version} → композиция v${compositionVersion}`,
  versionsTitle: "Версии",
  versionsAria: "Версии композиции",
  versionsNone: "Опубликованных версий нет.",
  versionEntry: (version: number, rev: number) => `v${version} · rev ${rev}`,
  retry: "Повторить",
  // Блок W9: рекомендательный ответ `POST /api/catalog/candidates` для композиции.
  similarTitle: "Похожие в каталоге",
  similarLoading: "Ищем похожие артефакты…",
  similarUnavailable: "Похожие артефакты недоступны.",
  similarNone: "Похожих артефактов в каталоге нет.",
  similarEntry: (kind: string, score: number) => `${kind === "composition" ? "композиция" : "компонент"} · score ${score}`,
  outcomeLabel: "Рекомендация",
  outcomeNames: {
    "build-composition": "собрать композицию",
    "extend-component": "расширить компонент",
    "new-ownership-component": "нужен ownership-компонент",
  } as Record<string, string>,
} as const;

// `sourceCount` — дополнительные документы lineage сверх primary (план §W1); при их отсутствии
// подпись остаётся прежней.
export const figmaBadgeTitle = (fileKey: string, nodeCount: number, sourceCount = 0) =>
  `Figma ${fileKey} · ${nodeCount} ${pluralRu(nodeCount, ["узел", "узла", "узлов"])}`
  + (sourceCount > 0 ? ` · +${sourceCount} ${pluralRu(sourceCount, ["источник", "источника", "источников"])}` : "");

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
  accepted: "Принят",
} as const;

export const componentStatusLabels = {
  deprecated: "Устаревший",
  superseded: "Заменён",
  rejected: "Отклонён",
  archived: "В архиве",
} as const;
