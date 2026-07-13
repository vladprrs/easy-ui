// Строки CJM-вида (W0-5). CJM — доменный термин из allowlist, не переводится.

export const cjm = {
  edit: "Редактировать",
  openPlayer: "Открыть плеер",
  screensAria: "Экраны CJM",
  tileErrorTitle: "Экран не удалось отобразить",
  noContent: "Нет содержимого",
  openScreenAria: (screenName: string, docName: string) => `Открыть экран «${screenName}» прототипа «${docName}» в плеере`,
} as const;
