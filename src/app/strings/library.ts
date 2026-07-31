// Строки custom-only библиотеки компонентов.

import { pluralRu } from "./common";

export const library = {
  title: "Библиотека компонентов",
  // Заголовок-хиро: акцент — ровно один фрагмент (курсив + красный).
  heroPrefix: "Библиотека",
  heroAccent: "живых",
  heroRest: "компонентов",
  // Подзаголовок хиро объясняет, что за экран и что даёт карточка: до редизайна
  // пользователь видел список имён и не понимал, зачем он тут.
  subtitle: (components: number, systems: number) =>
    `${components} ${pluralRu(components, ["компонент", "компонента", "компонентов"])} в ${systems} ${pluralRu(systems, ["дизайн-системе", "дизайн-системах", "дизайн-системах"])}. Откройте карточку — внутри живое превью, параметры и прототипы, где компонент уже стоит.`,
  subtitleEmpty: "Опубликуйте первый компонент через API — он появится здесь с живым превью и списком использований.",
  publishCta: "Опубликовать компонент",
  publishDialogAria: "Как опубликовать компонент",
  publishDialogTitle: "Как опубликовать компонент",
  publishDialogBody: "Компоненты публикуются через HTTP API — интерфейса авторинга в easy-ui нет. Два запроса, и компонент появится в библиотеке.",
  close: "Закрыть",
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
  previewMissing: "Живого превью нет: у компонента не заданы example-props",
  previewAria: (componentName: string) => `Живое превью компонента ${componentName}`,
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
  emptyTitle: "В библиотеке пока нет компонентов",
  emptyDescription: "Добавьте и опубликуйте первый пользовательский компонент через API — после публикации он появится в библиотеке.",
  emptyCreateStep: "Создайте компонент с исходником TSX:",
  emptyPublishStep: "Опубликуйте подготовленную версию:",
  emptyApiLink: "Открыть описание API",
  noDescription: "Без описания",
  // Поиск по работе (волна 3) и бейджи канона/устаревания.
  searchLabel: "Поиск по задаче",
  searchPlaceholder: "например: navbar успеха, кнопка оплаты",
  searchEmpty: "Ничего не нашлось. Попробуйте другое слово — поиск смотрит на имя, описание, роль и уровень.",
  canonicalBadge: "Канонический",
  canonicalBadgeTitle: (roles: string[]) => `Канонический компонент для ролей: ${roles.join(", ")}`,
  deprecatedBadge: "Устаревший",
  deprecatedBadgeTitle: "Последняя публикация компонента переведена в deprecated или superseded",
  replacementLink: (name: string) => `Замена: ${name}`,
  usagesTreeAria: "Дерево использования компонента",
  openInEditor: "Редактор",
  // Волна 5: переключатель разделов библиотеки.
  sectionsAria: "Разделы библиотеки",
  tabComponents: "Компоненты",
  tabCompositions: "Композиции",
} as const;

// Волна 5: раздел версионированных композиций (read-only витрина).
export const compositions = {
  title: "Композиции",
  listAria: "Композиции",
  loading: "Загружаем композиции…",
  unavailable: "Композиции недоступны.",
  select: "Выберите композицию слева, чтобы посмотреть её параметры, слоты и использование.",
  emptyTitle: "Композиций пока нет",
  emptyDescription: "Композиция — это переиспользуемый фрагмент экрана с параметрами и слотами. Соберите её в редакторе прототипа и опубликуйте — после этого она появится здесь.",
  emptyGuideTitle: "Как добавить композицию",
  emptyCreateStep: "Создайте композицию из выделения на экране:",
  emptyPublishStep: "Опубликуйте подготовленную ревизию:",
  emptyApiLink: "Открыть описание API",
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
