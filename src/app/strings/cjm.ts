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
  legendAria: "Легенда рёбер сценариев",
  verifiedStatic: "Подтверждённый переход",
  verifiedDynamic: "Динамический переход",
  verifiedMissing: "Переход не найден",
  edgesAria: "Рёбра сценариев",
  edgeTitle: (from: string, to: string, kind: "main" | "fork" | "branch" | "return", verified: "static" | "dynamic" | "missing") => `${from} → ${to}; ${kind}; ${verified}`,
  edgeDescription: (from: string, to: string, kind: "main" | "fork" | "branch" | "return", verified: "static" | "dynamic" | "missing") => `${from} → ${to}. Ребро ${kind}, проверка: ${verified}`,
  // Переключатель режимов CJM (план 2026-07-29 §6.1, T2b). На линейном документе
  // (без `doc.flows`) переключатель скрыт: показывать нечего, кроме ленты «Экраны CJM».
  viewSwitchAria: "Режим CJM",
  viewScenarios: "Сценарии",
  viewLanes: "Дорожки",
  // Простыня «Сценарии»: секции по флоу в DFS-порядке дерева `flow.parentId`.
  sheetAria: "Сценарии прототипа",
  treeAria: "Дерево сценариев",
  sheetStepsAria: (flowName: string) => `Экраны сценария «${flowName}»`,
  sheetScreensCount: screensCount,
  /** `M` считается по обратному индексу `screenFlowIndex` и включает сам сценарий (M ≥ 1). */
  sheetInFlows: (count: number) => `в ${count} ${pluralRu(count, ["сценарии", "сценариях", "сценариях"])}`,
  sheetCopyLink: "Скопировать ссылку",
  sheetLinkCopied: "Ссылка скопирована",
  sheetCopyFailed: "Не удалось скопировать ссылку",
  sheetOpenInPlayer: "Открыть в плеере",
  sheetEmptySteps: "В сценарии нет шагов",
  /** Per-step метка проходимости: у дочерних флоу это единственный индикатор (§3). */
  stepVerified: (verified: "static" | "dynamic" | "missing") =>
    verified === "static" ? "Подтверждённый переход" : verified === "dynamic" ? "Динамический переход" : "Переход не найден",
  tileErrorTitle: "Экран не удалось отобразить",
  noContent: "Нет содержимого",
  transitionsAria: "Переходы экрана",
  transitionTo: (screenName: string) => `→ ${screenName}`,
  dynamicTransition: "динамический переход",
  demoState: "демо-состояние",
  openScreenAria: (screenName: string, docName: string) => `Открыть экран «${screenName}» прототипа «${docName}» в плеере`,
} as const;
