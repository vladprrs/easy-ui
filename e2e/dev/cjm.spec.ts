import { expect, test } from "@playwright/test";

const checkoutNotes = [
  "Покупатель замечает новинку в каталоге и открывает карточку товара.",
  "Покупатель изучает кроссовки, цену и добавляет товар в корзину.",
  "В корзине лежит одна пара кроссовок, заказ готов к оформлению.",
  "Покупатель проверяет предзаполненные данные доставки и переходит к оплате.",
  "Оплата завершена, покупатель получает подтверждение заказа.",
];

test("checkout CJM opens from gallery and preserves player history semantics", async ({ page }) => {
  await page.goto("/");
  const checkoutCard = page.getByRole("listitem").filter({ hasText: "Мобильное оформление заказа" });
  await checkoutCard.getByRole("link", { name: "CJM", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/cjm$/);

  const journey = page.getByRole("list", { name: "Экраны CJM" });
  await expect(journey).toBeVisible();
  await expect(journey).not.toHaveAttribute("aria-hidden", "true");

  // Лента ленива (T2a): все пять обёрток в DOM, живых тайлов в покое меньше.
  await expect(journey.locator("li[data-screen-id]")).toHaveCount(5);
  await expect(journey.locator("[data-lazy-mounted]")).toHaveCount(5);
  expect(await journey.locator('[data-lazy-mounted="true"]').count()).toBeLessThan(5);

  // Печать форсирует монтирование: только так печать и Ctrl+F видят весь путь.
  await page.emulateMedia({ media: "print" });
  await expect(journey.locator('[data-lazy-mounted="true"]')).toHaveCount(5);
  await expect(journey.locator("[data-lazy-placeholder]")).toHaveCount(0);
  for (const screenName of ["Каталог", "Товар", "Корзина", "Оформление", "Успех"]) {
    await expect(page.getByRole("heading", { name: screenName, exact: true })).toHaveCount(1);
  }
  for (const note of checkoutNotes) await expect(page.getByText(note, { exact: true })).toHaveCount(1);
  await expect(page.getByText("Лёгкие кроссовки × 1", { exact: true })).toHaveCount(1);

  // mount-once: экранный режим сохраняет уже смонтированные тайлы и их ссылки.
  await page.emulateMedia({ media: null });
  await expect(journey.locator('[data-lazy-mounted="true"]')).toHaveCount(5);

  expect(await page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none");
  const cartOverlay = page.getByRole("link", { name: /Открыть экран «Корзина».*в плеере/ });
  await expect(cartOverlay).toBeVisible();
  await cartOverlay.click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  await expect(page.getByRole("button", { name: "Назад" })).toBeDisabled();
  // The tile link opens a NEW player session with fresh document state (CJM stateOverrides are
  // tile-only). Since checkout@2 the cart totals are $cond-driven, so with /cart/count = 0 the
  // checkout button is correctly disabled here.
  await expect(page.getByRole("button", { name: "Оформить" })).toBeDisabled();

  await page.goBack();
  await expect(page).toHaveURL(/\/p\/checkout\/cjm$/);
  await expect(page.getByRole("list", { name: "Экраны CJM" })).toBeVisible();

  await page.getByRole("link", { name: "Плеер", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);
  await page.getByRole("link", { name: "CJM", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/cjm$/);
});

test("checkout CJM supports direct load and rejects an unknown version", async ({ page }) => {
  await page.goto("/p/checkout/cjm");
  await expect(page.getByRole("list", { name: "Экраны CJM" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Мобильное оформление заказа" })).toBeVisible();

  // Unknown published version (W0-4): a dedicated state with working escape links.
  await page.goto("/p/checkout/v/999/cjm");
  await expect(page.getByRole("heading", { name: "Версия 999 не опубликована" })).toBeVisible();
  await expect(page.getByRole("link", { name: "К галерее" })).toBeVisible();
  await page.getByRole("link", { name: "Открыть текущую" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/cjm$/);
  await expect(page.getByRole("list", { name: "Экраны CJM" })).toBeVisible();

  // Same state in the player at /p/:id/v/N; «Открыть текущую» lands on the draft player.
  await page.goto("/p/checkout/v/99");
  await expect(page.getByRole("heading", { name: "Версия 99 не опубликована" })).toBeVisible();
  await page.getByRole("link", { name: "Открыть текущую" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);

  // A missing prototype still reads as prototype-not-found.
  await page.goto("/p/no-such-proto/v/1");
  await expect(page.getByRole("heading", { name: "Прототип не найден" })).toBeVisible();
});

test("settings CJM connects measured tile centers and labels authored transitions", async ({ page }) => {
  await page.goto("/p/settings/cjm");

  const metadata = page.getByLabel("Метаданные CJM");
  await expect(metadata.getByText("3 экрана", { exact: true })).toBeVisible();
  await expect(metadata.getByText("e2e-starter", { exact: true })).toBeVisible();

  // Все три обёртки в DOM с первого layout, поэтому коннекторы меряются и без живых тайлов.
  const journey = page.getByRole("list", { name: "Экраны CJM" });
  await expect(journey.locator("[data-lazy-mounted]")).toHaveCount(3);
  await page.emulateMedia({ media: "print" });
  await expect(journey.locator('[data-lazy-mounted="true"]')).toHaveCount(3);
  await expect(page.getByText("→ О приложении", { exact: true })).toHaveCount(1);
  await expect(page.getByText("→ Конфиденциальность", { exact: true })).toHaveCount(1);
  await page.emulateMedia({ media: null });

  const connectors = page.getByTestId("cjm-connector");
  await expect(connectors).toHaveCount(2);
  const endpoints = await connectors.evaluateAll((nodes) => nodes.map((node) => {
    const svg = node as SVGSVGElement;
    const source = svg.parentElement!.getBoundingClientRect();
    const target = svg.parentElement!.nextElementSibling!.getBoundingClientRect();
    const line = svg.querySelector('[data-testid="cjm-connector-line"]') as SVGPathElement;
    const matrix = line.getScreenCTM()!;
    const start = line.getPointAtLength(0).matrixTransform(matrix);
    const end = line.getPointAtLength(line.getTotalLength()).matrixTransform(matrix);
    return {
      sourceDelta: Math.hypot(start.x - source.right, start.y - (source.top + source.height / 2)),
      targetDelta: Math.hypot(end.x - target.left, end.y - (target.top + target.height / 2)),
    };
  }));
  for (const endpoint of endpoints) {
    expect(endpoint.sourceDelta).toBeLessThan(1);
    expect(endpoint.targetDelta).toBeLessThan(1);
  }
});

/**
 * Иерархия сценариев на фикстуре `flows-tree` (план 2026-07-29 §7 T2b): дефолтный режим
 * «Сценарии» и advanced-режим дорожек за `?view=lanes`.
 */
const treeFlowOrder = ["main-line", "payments-hub", "phone-transfer-shortcut", "receipt-leaf", "history-line"];

test("flows-tree opens in the scenarios sheet, reads a child branch end-to-end and switches to lanes", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/p/flows-tree/cjm");

  // Секции — в DFS-порядке дерева `flow.parentId`, с отступом по глубине.
  const sheetSections = page.locator(".cjm-sheet-section");
  await expect(sheetSections).toHaveCount(5);
  expect(await sheetSections.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.flowId))).toEqual(treeFlowOrder);
  expect(await sheetSections.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.flowDepth))).toEqual(["1", "2", "3", "3", "1"]);

  const tree = page.getByRole("tree", { name: "Дерево сценариев" });
  await expect(tree.getByRole("treeitem")).toHaveCount(5);
  await expect(tree.getByRole("treeitem").first()).toHaveAttribute("aria-current", "true");

  // Ключевая ценность простыни: у дочернего флоу оба шага — якоря главной линии,
  // и в дорожках собственных тайлов у них нет. Здесь ветка читается целиком.
  const shortcut = sheetSections.nth(2);
  await expect(shortcut.locator("li[data-flow-step]")).toHaveCount(2);
  await expect(shortcut.getByRole("heading", { name: "Быстрый перевод из раздела" })).toBeVisible();
  await expect(shortcut.locator('[data-verified="missing"]')).toHaveCount(1);
  await expect(sheetSections.first().locator('[data-verified="static"]')).toHaveCount(4);

  // Ленивость (обёртка T2a): счёт по факту — тайлов в этом режиме больше, чем `layout.tileCount`.
  const wrappers = await page.locator(".cjm-sheet [data-lazy-mounted]").count();
  expect(wrappers).toBe(14);
  expect(await page.locator('.cjm-sheet [data-lazy-mounted="true"]').count()).toBeLessThan(wrappers);

  await expect(sheetSections.nth(3).getByRole("link", { name: "Открыть в плеере" }))
    .toHaveAttribute("href", "/p/flows-tree/s/transfer-receipt?flow=receipt-leaf&step=0");
  await sheetSections.nth(3).getByRole("button", { name: "Скопировать ссылку" }).click();
  await expect(sheetSections.nth(3).getByRole("button", { name: "Ссылка скопирована" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("/p/flows-tree/cjm?flow=receipt-leaf");

  // Дорожки: только корневые флоу, простыня уходит, режим липнет к сегментам хрома.
  await page.getByRole("link", { name: "Дорожки", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/flows-tree\/cjm\?view=lanes$/);
  await expect(page.getByTestId("cjm-lane-label")).toHaveCount(2);
  await expect(page.locator(".cjm-sheet")).toHaveCount(0);
  await expect(page.getByLabel("Легенда рёбер сценариев")).toBeVisible();
  await expect(page.getByRole("link", { name: "Плеер", exact: true })).toHaveAttribute("href", "/p/flows-tree?view=lanes");

  await page.getByRole("link", { name: "Сценарии", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/flows-tree\/cjm$/);
  await expect(page.locator(".cjm-sheet-section")).toHaveCount(5);
});
