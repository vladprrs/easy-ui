// Общий словарь product chrome (план 2026-07-13, W0-5, «Сквозные решения» п.1).
// Локализуется только хром продукта; authored-контент прототипов, имена
// компонентов/props и тексты Storybook-историй не трогаем.
// Allowlist доменных терминов без перевода: CJM, Storybook, API, Basic Auth.

/** Русская плюрализация: forms = [1 экран, 2 экрана, 5 экранов]. */
export function pluralRu(count: number, forms: readonly [one: string, few: string, many: string]): string {
  const abs = Math.abs(Math.trunc(count));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export const screensCount = (count: number) => `${count} ${pluralRu(count, ["экран", "экрана", "экранов"])}`;

/** Названия типов устройств — используются в галерее, плеере и редакторе. */
export const deviceNames = {
  mobile: "Телефон",
  tablet: "Планшет",
  desktop: "Компьютер",
} as const;

export const common = {
  retry: "Повторить",
  close: "Закрыть",
  backToGallery: "В галерею",
} as const;

// App-шелл: главная навигация и страница 404.
export const appShell = {
  navGallery: "Галерея",
  navLibrary: "Библиотека",
  navVisual: "Визуальные проверки",
  navDebug: "Отладка",
  mainNavAria: "Основная навигация",
  notFoundKicker: "Ошибка 404",
  notFoundTitle: "Страница не найдена",
  notFoundBody: "Такой страницы нет — возможно, прототип был удалён или ссылка устарела.",
  notFoundCta: "В галерею",
} as const;

// Единый хром прототипа /p/* (WF-4): крошка, сегменты вью, version/draft-бейджи.
export const prototypeChrome = {
  breadcrumbAria: "Хлебные крошки",
  gallery: "Галерея",
  viewsAria: "Разделы прототипа",
  player: "Плеер",
  cjm: "CJM",
  editor: "Редактор",
  draftBadge: "черновик",
  versionBadge: (version: number) => `v${version}`,
} as const;

export interface ApiErrorDetails {
  /** Оригинальное серверное сообщение — используется как fallback-дополнение. */
  message?: string;
  currentRev?: number;
  currentVersion?: number;
  status?: number;
}

// Человекочитаемые сообщения по ApiError.code (server/contracts.ts, errorCatalog + доменные коды).
const API_ERROR_MESSAGES: Record<string, string> = {
  invalid_request: "Некорректный запрос к API",
  base_rev_required: "Не указана базовая ревизия (baseRev)",
  not_found: "Не найдено",
  prototype_not_found: "Прототип не найден",
  screen_not_found: "Экран не найден",
  version_not_found: "Версия не найдена",
  revision_not_found: "Ревизия не найдена",
  reference_not_found: "Эталон не найден",
  run_not_found: "Прогон не найден",
  job_not_found: "Задача не найдена",
  asset_not_found: "Ассет не найден",
  method_not_allowed: "Операция не поддерживается",
  already_exists: "Такой идентификатор уже занят",
  already_published: "Эта ревизия уже опубликована",
  conflict: "Конфликт изменений",
  status_conflict: "Статус уже изменён кем-то другим",
  invalid_transition: "Недопустимая смена статуса",
  payload_too_large: "Слишком большой запрос",
  asset_too_large: "Файл слишком большой",
  unsupported_media_type: "Неподдерживаемый тип содержимого",
  unsupported_asset_type: "Неподдерживаемый тип файла",
  asset_type_mismatch: "Тип файла не совпадает с содержимым",
  invalid_reference_asset: "Файл не подходит для эталона",
  validation_failed: "Документ не прошёл валидацию",
  invalid_props: "Некорректные props компонента",
  invalid_viewport: "Некорректные размеры вьюпорта",
  invalid_threshold: "Некорректный порог сравнения",
  queue_full: "Очередь скриншотов переполнена — попробуйте позже",
  screenshot_unavailable: "Скриншоты недоступны на этом сервере",
  event_schema_not_serializable: "Схема события не сериализуется",
  http_error: "Не удалось выполнить запрос к API",
};

/** Русское сообщение по коду ошибки API с fallback для неизвестных кодов. */
export function formatApiError(code: string, details: ApiErrorDetails = {}): string {
  const base = API_ERROR_MESSAGES[code];
  if (code === "revision_conflict" || code === "version_conflict") {
    const current = details.currentRev ?? details.currentVersion;
    return current === undefined
      ? "Конфликт изменений — данные уже обновлены кем-то другим"
      : `Конфликт изменений — текущая ${code === "version_conflict" ? "версия" : "ревизия"}: ${current}`;
  }
  if (base) return base;
  const suffix = details.message ? `: ${details.message}` : "";
  return `Ошибка API (${code}${details.status !== undefined ? `, HTTP ${details.status}` : ""})${suffix}`;
}
