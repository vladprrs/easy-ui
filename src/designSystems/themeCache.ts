import { getDesignSystemById, type ThemeContent } from "../api/client";

// Дедупликация темы по дизайн-системе: N карточек библиотеки дают не больше одного запроса на
// систему. Сигнал сюда не прокидывается сознательно — промис общий, и отмена одной карточки не
// имеет права отменить загрузку для остальных.

export interface CachedTheme {
  content: ThemeContent;
  /** Ключ для fontRegistry: `<designSystem>@<metaVersion>`. */
  latestMetaVersion: number | null;
}

const EMPTY: CachedTheme = { content: { tokens: {}, fonts: [], icons: [] }, latestMetaVersion: null };

const cache = new Map<string, Promise<CachedTheme>>();

async function load(designSystem: string): Promise<CachedTheme> {
  try {
    const data = await getDesignSystemById(designSystem);
    return {
      content: { tokens: data.tokens ?? {}, fonts: data.fonts ?? [], icons: data.icons ?? [] },
      latestMetaVersion: data.latestMetaVersion ?? null,
    };
  } catch {
    // Тема — не блокирующая часть превью: отдаём пустую (как useDesignSystemTheme) и снимаем
    // запись, чтобы следующая карточка могла попробовать снова.
    cache.delete(designSystem);
    return EMPTY;
  }
}

export const themeCache = {
  get(designSystem: string): Promise<CachedTheme> {
    const cached = cache.get(designSystem);
    if (cached) return cached;
    const promise = load(designSystem);
    cache.set(designSystem, promise);
    return promise;
  },
};

export function resetThemeCacheForTests(): void {
  cache.clear();
}
