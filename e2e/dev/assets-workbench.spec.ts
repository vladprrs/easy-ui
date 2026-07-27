import { expect, test } from "@playwright/test";

// 1×1 PNG с полностью прозрачным пикселем — валиден по magic bytes серверной проверки.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#f00"/></svg>';

test("asset workbench lists uploads with metadata, heuristics and the usage graph", async ({ page }) => {
  const png = await page.request.post("/api/assets", {
    multipart: { file: { name: "workbench-logo.png", mimeType: "image/png", buffer: Buffer.from(PNG_BASE64, "base64") } },
  });
  expect(png.ok()).toBeTruthy();
  const pngId = (await png.json()).id as string;
  const svg = await page.request.post("/api/assets", {
    multipart: { file: { name: "workbench-logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from(SVG, "utf8") } },
  });
  expect(svg.ok()).toBeTruthy();

  await page.goto("/assets");
  const grid = page.getByLabel("Сетка ассетов");
  const card = grid.getByRole("button").filter({ hasText: "workbench-logo.png" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("image/png");
  // Эвристика по имени: рядом лежит SVG с той же основой имени.
  await expect(card).toContainText("есть SVG с таким же именем · эвристика");

  // MIME-фасет сужает выдачу.
  await page.getByLabel("Фильтр по MIME").getByRole("button", { name: /image\/svg\+xml/ }).click();
  await expect(grid.getByRole("button").filter({ hasText: "workbench-logo.svg" })).toBeVisible();
  await expect(grid.getByRole("button").filter({ hasText: "workbench-logo.png" })).toHaveCount(0);
  await page.getByLabel("Фильтр по MIME").getByRole("button", { name: "Все типы" }).click();

  // Поиск по префиксу непрозрачного id.
  await page.getByLabel("Поиск по id или имени файла").fill(pngId.slice("asset_".length, "asset_".length + 8));
  await expect(grid.getByRole("button")).toHaveCount(1);
  await page.getByLabel("Поиск по id или имени файла").fill("");

  await card.click();
  const details = page.getByLabel("Карточка ассета");
  await expect(details.getByText(pngId, { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Копировать id" })).toBeVisible();
  // Свежая загрузка ни к чему не привязана — граф использования это и говорит.
  await expect(details.getByText("Ассет не закреплён нигде — его ничто не удерживает.")).toBeVisible();
  // Клиентский замер: 1×1 PNG с alpha-каналом.
  await expect(details).toContainText("есть прозрачные пиксели");
});
