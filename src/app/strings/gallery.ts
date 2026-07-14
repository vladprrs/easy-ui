// Строки галереи прототипов (W0-5).

export const gallery = {
  title: "Прототипы",
  subtitle: "Выберите флоу, чтобы открыть его первый экран.",
  loading: "Загружаем прототипы…",
  apiUnavailable: "API недоступен",
  designSystemsAria: "Дизайн-системы",
  allSystems: "Все",
  noDescription: "Без описания",
  deviceLabel: "Устройство",
  screensLabel: "Экраны",
  systemLabel: "Система",
  editorLink: "Редактор",
  presentLink: "Презентация",
  emptyFiltered: "Нет прототипов с выбранной дизайн-системой.",
  empty: "Прототипов пока нет.",
} as const;

export { deviceNames } from "./common";

export const versionLink = (version: number) => `Версия v${version}`;
export const cjmVersionLink = (version: number) => `CJM v${version}`;
