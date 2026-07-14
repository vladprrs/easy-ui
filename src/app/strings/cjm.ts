// Строки CJM-вида (W0-5). CJM — доменный термин из allowlist, не переводится.

import { screensCount } from "./common";

/** document.title CJM-вида: имя прототипа (+версия) (W0-3). */
export const cjmDocumentTitle = (docName: string, version?: number) =>
  version === undefined ? `${docName} · CJM` : `${docName} v${version} · CJM`;

export const cjm = {
  screensAria: "Экраны CJM",
  metadataAria: "Метаданные CJM",
  screensLabel: "Количество экранов",
  designSystemLabel: "Дизайн-система",
  screensCount,
  tileErrorTitle: "Экран не удалось отобразить",
  noContent: "Нет содержимого",
  transitionsAria: "Переходы экрана",
  transitionTo: (screenName: string) => `→ ${screenName}`,
  dynamicTransition: "динамический переход",
  demoState: "демо-состояние",
  openScreenAria: (screenName: string, docName: string) => `Открыть экран «${screenName}» прототипа «${docName}» в плеере`,
} as const;
