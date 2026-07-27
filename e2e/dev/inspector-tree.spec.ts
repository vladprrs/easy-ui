import { expect, test } from "@playwright/test";

// Вкладка «Дерево» debug-инспектора плеера (волна 1, план 2026-07-27).

test("the inspector tree tab highlights the element it selects and follows a click in the prototype", async ({ page }) => {
  await page.goto("/p/hello-world/s/welcome?debug=1");
  const stage = page.getByLabel("Превью прототипа на устройстве");
  const panel = page.getByRole("complementary", { name: "Инспектор взаимодействий" });
  await expect(stage.getByText("Hello, Ada!")).toBeVisible();

  // Плеер перемонтирует рантайм после загрузки кастомных компонентов: открываем
  // вкладку, пока дерево не окажется на месте.
  const tree = panel.getByRole("list", { name: "Дерево компонентов экрана" });
  await expect(async () => {
    await panel.getByRole("tab", { name: "Дерево" }).click();
    await expect(tree.getByRole("button", { name: "StarterStack · card" })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  // Выбор узла в дереве подсвечивает ровно тот DOM-узел, что несёт data-eui-key.
  await tree.locator('[data-eui-tree-key="greeting"]').click();
  const layer = page.getByTestId("inspector-tree-highlights");
  const highlight = layer.locator('[data-eui-highlight-key="greeting"]');
  await expect(highlight).toBeVisible();
  // Сам маркер — span с display:contents, поэтому сверяем с его отрисованным потомком.
  const markerBox = await page.locator('[data-eui-key="greeting"] > *').first().boundingBox();
  const highlightBox = await highlight.boundingBox();
  expect(markerBox).not.toBeNull();
  expect(highlightBox).not.toBeNull();
  expect(Math.abs(highlightBox!.x - markerBox!.x)).toBeLessThan(4);
  expect(Math.abs(highlightBox!.width - markerBox!.width)).toBeLessThan(4);
  await expect(page.getByTestId("inspector-tree-detail")).toContainText("getBoundingClientRect");

  // Клик по прототипу выбирает ближайший [data-eui-key] и переносит подсветку.
  await stage.getByText("Hello, Ada!").click();
  await expect(tree.locator('[data-eui-tree-key="greeting"]')).toHaveAttribute("aria-current", "true");
  await expect(layer.locator('[data-eui-highlight-key="greeting"]')).toBeVisible();

  // Интерактивность прототипа не тронута: press по кнопке по-прежнему навигирует.
  await stage.getByRole("button", { name: "Details" }).click();
  await expect(page).toHaveURL(/\/p\/hello-world\/s\/details\?debug=1$/);
});

test("the log tab keeps working and the tree tab leaves no highlight behind", async ({ page }) => {
  await page.goto("/p/hello-world/s/welcome?debug=1");
  const stage = page.getByLabel("Превью прототипа на устройстве");
  const panel = page.getByRole("complementary", { name: "Инспектор взаимодействий" });
  await expect(stage.getByText("Hello, Ada!")).toBeVisible();

  const log = panel.getByLabel("Записи инспектора");
  await expect(async () => {
    await panel.getByRole("tab", { name: "Дерево" }).click();
    await expect(panel.getByRole("list", { name: "Дерево компонентов экрана" })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await panel.getByRole("tab", { name: "Журнал" }).click();
  await expect(log).toBeVisible();

  await stage.getByText("Hello, Ada!").click();
  await expect(page.getByTestId("inspector-tree-highlights")).toHaveCount(0);
  await stage.getByRole("button", { name: "Details" }).click();
  await expect(log).toContainText("navigate");
});
