// Строки CJM-вида (W0-5). CJM — доменный термин из allowlist, не переводится.

import { pluralRu, screensCount } from "./common";

/** document.title CJM-вида: имя прототипа (+версия) (W0-3). */
export const cjmDocumentTitle = (docName: string, version?: number) =>
  version === undefined ? `${docName} · CJM` : `${docName} v${version} · CJM`;

export const cjm = {
  screensAria: "Экраны CJM",
  metadataAria: "Метаданные CJM",
  screensLabel: "Количество экранов",
  flowsLabel: "Количество сценариев",
  designSystemLabel: "Дизайн-система",
  screensCount,
  flowsCount: (count: number) => `${count} ${pluralRu(count, ["сценарий", "сценария", "сценариев"])}`,
  lanesAria: "Дорожки сценариев CJM",
  mainLaneName: "Главный сценарий",
  unassignedLaneName: "Вне сценариев",
  unassignedCount: (count: number) => `Вне сценариев, ${count}`,
  unassignedAria: "Экраны вне сценариев",
  showMore: "показать ещё",
  legendAria: "Легенда рёбер сценариев",
  verifiedStatic: "Подтверждённый переход",
  verifiedDynamic: "Динамический переход",
  verifiedMissing: "Переход не найден",
  edgesAria: "Рёбра сценариев",
  edgeTitle: (from: string, to: string, kind: "main" | "fork" | "branch" | "return", verified: "static" | "dynamic" | "missing") => `${from} → ${to}; ${kind}; ${verified}`,
  edgeDescription: (from: string, to: string, kind: "main" | "fork" | "branch" | "return", verified: "static" | "dynamic" | "missing") => `${from} → ${to}. Ребро ${kind}, проверка: ${verified}`,
  tileErrorTitle: "Экран не удалось отобразить",
  noContent: "Нет содержимого",
  transitionsAria: "Переходы экрана",
  transitionTo: (screenName: string) => `→ ${screenName}`,
  dynamicTransition: "динамический переход",
  demoState: "демо-состояние",
  openScreenAria: (screenName: string, docName: string) => `Открыть экран «${screenName}» прототипа «${docName}» в плеере`,
} as const;
