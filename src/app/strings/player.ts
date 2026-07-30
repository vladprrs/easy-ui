// Строки плеера: загрузчик прототипа, шапка, сайдбар экранов, device-переключатель,
// interaction inspector (?debug=1). Authored-контент экранов не трогаем (W0-5).

export const loader = {
  loadingPrototype: "Загрузка прототипа…",
  loadingComponents: "Загрузка компонентов…",
  missingTitle: "Прототип не найден",
  missingBody: "Такого прототипа не существует.",
  missingVersionTitle: (version: number) => `Версия ${version} не опубликована`,
  missingVersionBody: (version: number) => `У этого прототипа нет опубликованной версии ${version}.`,
  openCurrent: "Открыть текущую",
  toGallery: "К галерее",
  loadErrorTitle: "Не удалось загрузить прототип",
  archivedTitle: "Прототип в архиве",
  archivedBody: "Эта ревизия использует удалённые компоненты и больше не может быть отображена.",
} as const;

/** document.title плеера: имя прототипа (+версия) и текущий экран (W0-3). */
export const playerDocumentTitle = (docName: string, screenName: string, version?: number) =>
  version === undefined ? `${docName} · ${screenName}` : `${docName} v${version} · ${screenName}`;

export const player = {
  back: "Назад",
  restart: "Начать сначала",
  present: "Презентация",
  // Презентация не умеет сценарный контекст: `stripScenarioSearch` срезает
  // `flow`/`step`. Раньше это происходило молча — теперь сказано в подписи (W4-11).
  presentWithoutScenario: "Презентация · без сценария",
  note: "Заметка",
  statusBarToggle: "Скрыть статус-бар",
  notePanelAria: "Заметка к экрану",
  screensAria: "Экраны",
  screensCollapse: "Свернуть список экранов",
  screensExpand: "Развернуть список экранов",
  zoomAria: "Масштаб",
  zoomFit: "Вписать",
  zoomActual: "100%",
  zoomIn: "Увеличить масштаб",
  zoomOut: "Уменьшить масштаб",
  zoomPercent: (percent: number) => `${percent}%`,
  deviceAria: "Устройство",
  desktopOverlayUnavailable: "Desktop-превью недоступно для Overlay на экране без canvas.",
  devicePreviewAria: "Превью прототипа на устройстве",
  screenErrorTitle: "Не удалось отобразить экран",
  screenErrorContext: (prototypeId: string, screenId: string) => `Прототип: ${prototypeId} · Экран: ${screenId}`,
  screenMissingTitle: "Экран не найден",
  screenMissingBody: (docName: string) => `В прототипе «${docName}» нет такого экрана.`,
  // Баннер сброса состояния флоу (W1-5): bootstrap-вход не на стартовом экране.
  flowResetMessage: "Состояние флоу сброшено — ссылка вела в середину флоу.",
  flowResetRestart: "Начать сначала",
  flowResetDismiss: "Скрыть уведомление о сбросе",
  hotkeysTitle: "Горячие клавиши",
  hotkeysClose: "Закрыть подсказку",
  versionsAria: "Версии прототипа",
  draftVersion: "Черновик",
  publishedVersion: (version: number, date: string) => `Версия ${version} · ${date}`,
  unpublishedChanges: "есть неопубликованные изменения",
  nonLatestVersion: (version: number, date: string) => `Версия ${version} от ${date}`,
  openLatestPublished: "Открыть актуальную",
  scenarioAria: "Навигация по сценарию",
  scenarioTreeAria: "Дерево сценариев",
  scenarioAllLink: "Все сценарии на странице прототипа",
  scenarioNone: "Без сценария",
  // Пилюля выбора сценария (W4-1): назначение контрола живёт внутри самой пилюли,
  // поэтому отдельной серой подписи «Сценарий» рядом больше нет.
  scenarioPill: (name: string) => `Сценарий: ${name}`,
  scenarioStep: (current: number, total: number) => `Шаг ${current} из ${total}`,
  // Полоса всегда показывает «Шаг N из M» (W4-7). Когда шаг не определён,
  // числитель — «?», а причина дописывается следующим фрагментом статуса.
  scenarioStepUnknown: (total: number) => `Шаг ? из ${total}`,
  scenarioPrevious: "Предыдущий шаг",
  scenarioNext: "Следующий шаг",
  // Подписи кнопок полосы включают хоткей (W4-6): ← → закреплены за экранами
  // документа, шаги сценария ходят по Shift+←/→.
  scenarioPreviousHotkey: "Предыдущий шаг · Shift+←",
  scenarioNextHotkey: "Следующий шаг · Shift+→",
  scenarioStepsAria: "Шаги сценария",
  scenarioOutside: "Текущий экран вне сценария",
  scenarioAmbiguous: "Шаг не определён",
  // Один контрол вместо россыпи кнопок «К шагу 1» / «Шаг 2» / «Шаг 5» (W4-7).
  scenarioResolveAria: "Шаг сценария",
  scenarioResolveOutside: "Выберите шаг сценария",
  scenarioResolveAmbiguous: "Выберите вхождение экрана",
  scenarioOccurrence: (step: number) => `Шаг ${step}`,
  scenarioStepOption: (step: number, screenName: string) => `Шаг ${step} · ${screenName}`,
  scenarioGuidedBrowse: "Экран открывается в текущем состоянии сессии; промежуточные действия не выполняются.",
  /** Доступное имя «···»-меню плеера (W4-3). */
  moreActions: "Ещё действия",
  versionShort: (version: number) => `v${version}`,
  // Оверлей интерактивных зон (план 2026-07-29 §7 T3). «цель вычисляется» —
  // формулировка только этого оверлея: классификацию перехода `$if` не меняет.
  zonesToggle: (visible: boolean) => `Зоны переходов · ${visible ? "вкл" : "выкл"}`,
  zonesMisclickHint: "Клик мимо активной зоны подсвечивает доступные переходы",
  zonesOverlayAria: "Зоны переходов текущего экрана",
  zoneTo: (screenName: string) => `→ ${screenName}`,
  /** Номер шага цели в текущем сценарии (W4-5). */
  zoneStep: (step: number) => `шаг ${step}`,
  zoneComputed: "цель вычисляется",
  zoneDynamic: "→ цель вычисляется",
  zoneNoTarget: "без перехода",
  zoneMore: (count: number) => `+${count}`,
} as const;

/** Человекочитаемая дата публикации в продуктовом русском интерфейсе. */
export const formatPlayerDate = (value: string) => new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
}).format(new Date(value));

export const playerHotkeys = {
  previous: "Предыдущий экран",
  next: "Следующий экран",
  // Шаги сценария — отдельная ось навигации (W4-6, триаж M4-D): ← → остаются за
  // экранами документа, потому что сценарий есть далеко не у каждого прототипа.
  stepPrevious: "Предыдущий шаг сценария",
  stepNext: "Следующий шаг сценария",
  restart: "Начать сначала",
  zoom: "Вписать / 100%",
  exitPresent: "Вернуться в плеер",
  help: "Показать или скрыть эту подсказку",
} as const;

/** document.title режима презентации (W1-2). */
export const presentDocumentTitle = (docName: string, version?: number) =>
  version === undefined ? `${docName} · Презентация` : `${docName} v${version} · Презентация`;

/** document.title публичной share-презентации (W3-3). */
export const shareDocumentTitle = (docName: string, version: number) =>
  `${docName} v${version} · Просмотр`;

// Режим презентации (W1-2): только прототип на экране + минимальная оснастка.
export const present = {
  pagerAria: "Экраны презентации",
  counter: (current: number, total: number) => `${current} / ${total}`,
  openInApp: "Открыть в easy-ui",
  exitHint: "Esc — вернуться в плеер",
  screenDot: (name: string) => `Экран «${name}»`,
} as const;

// Мини-HUD мобильной презентации (W2-1).
export const presentHud = {
  fabAria: "Открыть управление презентацией",
  panelAria: "Управление презентацией",
  close: "Закрыть управление презентацией",
  returnToPlayer: "Вернуться в плеер",
  /** Автоскрытие без подписи выглядело поломкой: панель пропадала молча (W4-14). */
  autoHideHint: "Панель скроется через 4 секунды — «···» вернёт её",
} as const;

export const share = {
  action: "Поделиться",
  dialogTitle: "Поделиться прототипом",
  close: "Закрыть",
  version: "Опубликованная версия",
  ttl: "Срок действия",
  ttlDay: "1 день",
  ttlWeek: "7 дней",
  ttlMonth: "30 дней",
  create: "Создать ссылку",
  creating: "Создаём…",
  noPublishedVersions: "Сначала опубликуйте версию прототипа.",
  createdLabel: "Новая ссылка",
  copy: "Скопировать",
  copied: "Скопировано",
  qrLabel: "QR-код ссылки",
  activeTitle: "Активные ссылки",
  activeEmpty: "Активных ссылок пока нет.",
  activeItem: (version: number, expires: string) => `Версия ${version} · до ${expires}`,
  sessions: (count: number) => `активных сессий: ${count}`,
  revoke: "Отозвать",
  loading: "Загрузка ссылок…",
  viewerLabel: "Защищённый просмотр",
  loadError: "Не удалось загрузить ссылки.",
  createError: "Не удалось создать ссылку.",
  revokeError: "Не удалось отозвать ссылку.",
} as const;

// Проверки взаимодействия: рекордер и клиентский прогон (волна 6, план 2026-07-27).
// Терминология (план 2026-07-29 §1): записи рекордера — это **«Проверки»**
// (`expectScreen`/`expectText`/`expectDisabled` — assertions), а «Сценарии» — это флоу
// документа. Схема, API и имя таблицы `prototype_scenarios` не менялись.
export const scenarios = {
  action: "Проверки",
  panelAria: "Проверки взаимодействия",
  title: "Проверки",
  close: "Закрыть панель проверок",
  listAria: "Сохранённые проверки",
  empty: "Проверок пока нет — запишите первую.",
  loading: "Загрузка проверок…",
  loadError: "Не удалось загрузить проверки.",
  saveError: "Не удалось сохранить проверку.",
  deleteError: "Не удалось удалить проверку.",
  record: "Записать",
  recording: "Идёт запись",
  stop: "Остановить запись",
  recordHint: "Кликайте по прототипу — клики и переходы попадают в шаги.",
  stepsAria: "Шаги проверки",
  stepsEmpty: "Шагов пока нет.",
  stepRemove: "Удалить шаг",
  nameLabel: "Название проверки",
  namePlaceholder: "Например: оплата бонусами",
  save: "Сохранить",
  saving: "Сохраняем…",
  saved: "Проверка сохранена.",
  discard: "Сбросить",
  replay: "Прогнать",
  replaying: "Прогон…",
  edit: "Открыть",
  delete: "Удалить",
  /** Второй клик подтверждает удаление проверки (S6): окно ~2 с, подпись меняется. */
  deleteConfirm: "Удалить?",
  addExpectation: "Добавить ожидание",
  expectationType: "Тип ожидания",
  expectationValue: "Значение",
  add: "Добавить",
  cancel: "Отмена",
  stepTypeLabel: {
    click: "клик",
    expectScreen: "ожидание экрана",
    expectText: "ожидание текста",
    setState: "запись состояния",
    expectState: "ожидание состояния",
    expectDisabled: "ожидание блокировки",
  } as const,
  statusLabel: { pass: "ок", fail: "провал", stale: "устарел" } as const,
  runSummary: (passed: number, total: number, stale: number) =>
    stale ? `${passed}/${total} ок · устаревших: ${stale}` : `${passed}/${total} ок`,
  runFailed: "Проверка разошлась с прототипом.",
  runPassed: "Проверка проходит.",
  pointerLabel: "Указатель состояния (/path)",
  valueLabel: "Значение (JSON)",
  invalidValue: "Значение должно быть корректным JSON.",
  invalidStep: "Шаг заполнен неверно.",
  ownerOnly: "Сохранять проверки может только владелец прототипа.",
} as const;

export const inspector = {
  title: "Инспектор",
  panelAria: "Инспектор взаимодействий",
  filterAria: "Фильтр записей",
  clear: "Очистить",
  entriesAria: "Записи инспектора",
  empty: "Записей пока нет — повзаимодействуйте с прототипом.",
  payloadInvalid: "payload не прошёл валидацию",
  skipped: "пропущено ($if = false)",
  fontsTitle: "Шрифты (document.fonts)",
  fontsAria: "Статусы шрифтов",
  fontsEmpty: "Шрифты не зарегистрированы.",
  // Вкладки инспектора (волна 1, план 2026-07-27)
  tabsAria: "Разделы инспектора",
  tabLog: "Журнал",
  tabTree: "Дерево",
  treeAria: "Дерево компонентов экрана",
  treeEmpty: "На экране нет элементов.",
  treeUnavailable: "Дерево доступно только для отрисованного экрана.",
  treeHint: "Клик по прототипу выбирает ближайший элемент дерева.",
  treeHost: "host",
  treeCustom: "custom",
  treeRect: (width: number, height: number) => `${width}×${height} px`,
  treeRectLabel: "getBoundingClientRect",
  treeRectInstances: (count: number) => `вхождений: ${count}`,
  treeNotRendered: "Элемент не отрисован на экране.",
  treeRegion: "регион",
  treeSlot: "слот",
  treeScope: "scope",
  treeAtomic: "atomic",
  treeVersion: "версия",
  treeStatus: "статус",
  treePropsDiff: "Пропы ≠ объявленного дефолта",
  treePropsDiffEmpty: "нет",
} as const;
