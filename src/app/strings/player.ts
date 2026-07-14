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
} as const;

/** document.title плеера: имя прототипа (+версия) и текущий экран (W0-3). */
export const playerDocumentTitle = (docName: string, screenName: string, version?: number) =>
  version === undefined ? `${docName} · ${screenName}` : `${docName} v${version} · ${screenName}`;

export const player = {
  back: "Назад",
  restart: "Начать сначала",
  present: "Презентация",
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
} as const;

export const playerHotkeys = {
  previous: "Предыдущий экран",
  next: "Следующий экран",
  restart: "Начать сначала",
  zoom: "Вписать / 100%",
  exitPresent: "Вернуться в плеер",
  help: "Показать или скрыть эту подсказку",
} as const;

/** document.title режима презентации (W1-2). */
export const presentDocumentTitle = (docName: string, version?: number) =>
  version === undefined ? `${docName} · Презентация` : `${docName} v${version} · Презентация`;

// Режим презентации (W1-2): только прототип на экране + минимальная оснастка.
export const present = {
  pagerAria: "Экраны презентации",
  counter: (current: number, total: number) => `${current} / ${total}`,
  openInApp: "Открыть в easy-ui",
  exitHint: "Esc — вернуться в плеер",
  screenDot: (name: string) => `Экран «${name}»`,
} as const;

export const inspector = {
  title: "Инспектор",
  collapsedButton: (count: number) => `Инспектор (${count})`,
  panelAria: "Инспектор взаимодействий",
  filterAria: "Фильтр записей",
  clear: "Очистить",
  collapse: "Свернуть инспектор",
  entriesAria: "Записи инспектора",
  empty: "Записей пока нет — повзаимодействуйте с прототипом.",
  payloadInvalid: "payload не прошёл валидацию",
  skipped: "пропущено ($if = false)",
  fontsTitle: "Шрифты (document.fonts)",
  fontsAria: "Статусы шрифтов",
  fontsEmpty: "Шрифты не зарегистрированы.",
} as const;
