import { useEffect } from "react";

/** Базовое имя приложения — суффикс каждого title и fallback без страницы (W0-3). */
export const APP_TITLE = "easy-ui";

/** «{title} — easy-ui»; пустой/отсутствующий title схлопывается в базовое имя. */
export function formatDocumentTitle(title?: string | null): string {
  const trimmed = title?.trim();
  return trimmed ? `${trimmed} — ${APP_TITLE}` : APP_TITLE;
}

/**
 * Ставит document.title страницы. Восстановление при размонтировании не нужно:
 * каждая страница ставит свой title сама (план 2026-07-13, W0-3).
 *
 * - строка → «{title} — easy-ui» (пустая строка → «easy-ui»);
 * - null → базовый «easy-ui» (страница явно без собственного имени);
 * - undefined → пропуск: title этого рендера принадлежит другому компоненту
 *   (например, PrototypeLoader после загрузки уступает его странице-потребителю).
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title === undefined) return;
    document.title = formatDocumentTitle(title);
  }, [title]);
}
