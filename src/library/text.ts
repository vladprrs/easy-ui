/**
 * Общая текстовая нормализация каталога: используется и клиентским поиском библиотеки
 * (`src/library/libraryModel.ts`), и серверным матчером дубликатов (`server/catalog/`).
 * Держится в `src/`, потому что импорт идёт в направлении `src → server` (как для
 * `src/designSystems` и `src/catalog`); обратного направления в проекте нет.
 *
 * Детерминизм обязателен: на этих функциях стоят и ранжирование выдачи, и решение
 * «создавать компонент или переиспользовать», которое пишется в аудит.
 */

/** Токены слова: RU/EN-безопасный split по не-буквам и не-цифрам. */
export const tokenize = (value: string): string[] =>
  value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);

/**
 * IDF по корпусу описаний. Без него моно-вендорная лексика («экран», «оплата», «карта»)
 * систематически завышает сходство: в каталоге одной дизайн-системы такие токены есть почти
 * у каждой записи. Сглаживание `1 + ln((N + 1) / (df + 1))` не даёт нулей на токене,
 * встречающемся во всех документах, и не требует спецкейса для пустого корпуса.
 *
 * Значение корпус-относительно: публикация несвязанного компонента меняет вес токена.
 * Поэтому фикстуры обязаны пинить собственный корпус, а в аудит-запись сохраняется
 * `policyVersion` — иначе score невоспроизводим задним числом.
 */
export function buildIdf(documents: readonly string[]): Map<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of new Set(tokenize(document))) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const total = documents.length;
  const idf = new Map<string, number>();
  for (const [token, frequency] of documentFrequency) {
    idf.set(token, 1 + Math.log((total + 1) / (frequency + 1)));
  }
  return idf;
}

/** Вес незнакомого токена: он не встречался в корпусе, значит максимально различающий. */
export const idfWeight = (idf: ReadonlyMap<string, number>, token: string): number =>
  idf.get(token) ?? 1 + Math.log(idf.size + 1);

/**
 * IDF-взвешенное пересечение двух текстов, нормированное на вес объединения (взвешенный
 * Jaccard). 0 — общих значимых токенов нет, 1 — множества значимых токенов совпадают.
 * Пустой с обеих сторон вход даёт 0: «сигнал неприменим» решается вызывающим кодом
 * (матчер исключает такой сигнал из суммы и перенормирует веса), а не молчаливой единицей.
 */
export function idfOverlap(left: string, right: string, idf: ReadonlyMap<string, number>): number {
  const leftTokens = new Set(tokenize(left)), rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0, union = 0;
  for (const token of new Set([...leftTokens, ...rightTokens])) {
    const weight = idfWeight(idf, token);
    union += weight;
    if (leftTokens.has(token) && rightTokens.has(token)) intersection += weight;
  }
  return union === 0 ? 0 : intersection / union;
}
