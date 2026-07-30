import { expect, test, type Locator, type Page } from "@playwright/test";

// Дорожки — advanced-режим за `?view=lanes` (T2b): дефолт `/p/:id/cjm` — «Сценарии».
const branchingPath = "/p/branching-checkout/cjm?view=lanes";

async function expectOrthogonalEdgesAvoidTiles(page: Page) {
  const failures = await page.locator(".cjm-edges-overlay").evaluate((svg) => {
    const tolerance = 2.5;
    const tiles = [...svg.closest(".cjm-grid")!.querySelectorAll<HTMLElement>("[data-cjm-node]")]
      .map((node) => ({ key: node.dataset.cjmNode!, rect: node.getBoundingClientRect() }));

    const pointOnBoundary = (point: DOMPoint, rect: DOMRect) => {
      const insideX = point.x >= rect.left - tolerance && point.x <= rect.right + tolerance;
      const insideY = point.y >= rect.top - tolerance && point.y <= rect.bottom + tolerance;
      return (insideY && Math.min(Math.abs(point.x - rect.left), Math.abs(point.x - rect.right)) <= tolerance)
        || (insideX && Math.min(Math.abs(point.y - rect.top), Math.abs(point.y - rect.bottom)) <= tolerance);
    };
    const crossesInterior = (a: DOMPoint, b: DOMPoint, rect: DOMRect) => {
      const left = rect.left + tolerance;
      const right = rect.right - tolerance;
      const top = rect.top + tolerance;
      const bottom = rect.bottom - tolerance;
      if (Math.abs(a.y - b.y) <= 0.5) {
        return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
      }
      if (Math.abs(a.x - b.x) <= 0.5) {
        return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
      }
      return true;
    };

    return [...svg.querySelectorAll<SVGGElement>("g[data-from][data-to]")].flatMap((group) => {
      const polyline = group.querySelector("polyline")!;
      const matrix = polyline.getScreenCTM()!;
      const length = polyline.getTotalLength();
      const start = polyline.getPointAtLength(0).matrixTransform(matrix);
      const end = polyline.getPointAtLength(length).matrixTransform(matrix);
      const from = group.dataset.from!;
      const to = group.dataset.to!;
      const fromRect = tiles.find((tile) => tile.key === from)!.rect;
      const toRect = tiles.find((tile) => tile.key === to)!.rect;
      const edgeFailures: string[] = [];
      if (!pointOnBoundary(start, fromRect)) edgeFailures.push(`${from} start is not on its tile boundary`);
      if (!pointOnBoundary(end, toRect)) edgeFailures.push(`${to} end is not on its tile boundary`);

      const points = [...polyline.points].map((point) => new DOMPoint(point.x, point.y).matrixTransform(matrix));
      for (let index = 0; index < points.length - 1; index += 1) {
        for (const tile of tiles) {
          if (tile.key === from || tile.key === to) continue;
          if (crossesInterior(points[index]!, points[index + 1]!, tile.rect)) {
            edgeFailures.push(`${from} -> ${to} segment ${index} crosses ${tile.key}`);
          }
        }
      }
      return edgeFailures;
    });
  });
  expect(failures).toEqual([]);
}

test("branching checkout renders ordered scenario lanes and a verified edge legend", async ({ page }) => {
  await page.goto(branchingPath);

  const labels = page.getByTestId("cjm-lane-label");
  await expect(labels).toHaveCount(3);
  await expect(labels).toHaveText([
    /Успешная оплата/,
    /Отказ банка и повторная оплата/,
    /Отмена заказа/,
  ]);
  await expect(page.getByLabel("Метаданные CJM").getByText("3 сценария", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Вне сценариев/ })).toHaveCount(0);

  const edges = page.locator(".cjm-edges-overlay g[data-edge-kind]");
  await expect(edges).toHaveCount(10);
  await expect(page.locator('.cjm-edges-overlay g[data-edge-kind="main"]')).toHaveCount(4);
  await expect(page.locator('.cjm-edges-overlay g[data-edge-kind="fork"]')).toHaveCount(2);
  await expect(page.locator('.cjm-edges-overlay g[data-edge-kind="branch"]')).toHaveCount(3);
  await expect(page.locator('.cjm-edges-overlay g[data-edge-kind="return"]')).toHaveCount(1);
  await expect(page.locator('.cjm-edges-overlay g[data-verified="static"]')).toHaveCount(10);

  const attributes = await edges.evaluateAll((groups) => groups.map((group) => ({
    kind: group.getAttribute("data-edge-kind"),
    verified: group.getAttribute("data-verified"),
    from: group.getAttribute("data-from"),
    to: group.getAttribute("data-to"),
  })));
  expect(attributes.every((edge) => edge.kind && edge.verified && edge.from && edge.to)).toBe(true);

  const legend = page.getByLabel("Легенда рёбер сценариев");
  await expect(legend).toContainText("Подтверждённый переход");
  await expect(legend).toContainText("Динамический переход");
  await expect(legend).toContainText("Переход не найден");
});

test("overlay endpoints touch endpoint tiles and every orthogonal segment avoids other tiles", async ({ page }) => {
  await page.goto(branchingPath);
  await expect(page.locator(".cjm-edges-overlay g[data-edge-kind]")).toHaveCount(10);
  await expectOrthogonalEdgesAvoidTiles(page);
});

test("branch flows reuse each shared main section instead of drawing duplicate edges", async ({ page }) => {
  await page.goto(branchingPath);
  const edges = page.locator(".cjm-edges-overlay g[data-edge-kind]");
  await expect(edges).toHaveCount(10);

  for (let index = 0; index < 4; index += 1) {
    const shared = page.locator(`.cjm-edges-overlay g[data-from="flow:happy-path:${index}"][data-to="flow:happy-path:${index + 1}"]`);
    await expect(shared).toHaveCount(1);
    await expect(shared).toHaveAttribute("data-edge-kind", "main");
  }
  await expect(page.locator('.cjm-edges-overlay g[data-from^="flow:bank-declined"][data-to^="flow:bank-declined"]')).toHaveCount(0);
});

/**
 * Гейт ленивости (T2a) — **детерминированные счётчики**, а не миллисекунды:
 * `retries: 0`, проект `dev` гоняет Vite dev-server и development-сборку React,
 * а CI — общий runner, поэтому wall-clock здесь ничего не доказывает.
 */
interface LazyCounters {
  wrappers: number;
  mounted: number;
  tiles: number;
  placeholders: number;
}

async function lazyCounters(page: Page, root: string): Promise<LazyCounters> {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) throw new Error(`Missing scope ${selector}`);
    return {
      wrappers: scope.querySelectorAll("[data-lazy-mounted]").length,
      mounted: scope.querySelectorAll('[data-lazy-mounted="true"]').length,
      tiles: scope.querySelectorAll(".cjm-tile").length,
      placeholders: scope.querySelectorAll("[data-lazy-placeholder]").length,
    };
  }, root);
}

const scrollToEnd = (target: Locator) => target.evaluate((node) => {
  node.scrollLeft = node.scrollWidth;
  node.scrollTop = node.scrollHeight;
});

test("limit fixture mounts lane tiles lazily while every node wrapper stays measurable", async ({ page }) => {
  await page.goto("/p/flows-perf/cjm?view=lanes");

  await expect(page.getByTestId("cjm-lane-label")).toHaveCount(12);
  // Обёртки узлов и геометрия грида не зависят от ленивости: рёбра меряют обёртки,
  // а колонки заданы фиксированным gridTemplateColumns.
  await expect(page.locator("[data-cjm-node]")).toHaveCount(178);
  await expect(page.locator(".cjm-edges-overlay g[data-edge-kind]")).toHaveCount(188);
  // layout.columns + 1: первая колонка грида — подписи дорожек.
  const columns = await page.locator(".cjm-grid").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length);
  expect(columns).toBe(63);

  const resting = await lazyCounters(page, ".cjm-grid");
  expect(resting.wrappers).toBe(178);
  expect(resting.mounted).toBeGreaterThan(0);
  // Ключевой гейт: в покое живых тайлов на порядок меньше, чем узлов.
  expect(resting.mounted).toBeLessThanOrEqual(18);
  expect(resting.tiles).toBe(resting.mounted);
  expect(resting.placeholders).toBe(178 - resting.mounted);

  await scrollToEnd(page.locator(".cjm-grid-scroll"));
  await scrollToEnd(page.locator(".cjm-stage"));
  await expect.poll(async () => (await lazyCounters(page, ".cjm-grid")).mounted).toBeGreaterThan(resting.mounted);
  const scrolled = await lazyCounters(page, ".cjm-grid");
  expect(scrolled.wrappers).toBe(178);
  expect(scrolled.tiles).toBe(scrolled.mounted);
  expect(scrolled.placeholders).toBe(178 - scrolled.mounted);
});

test("unassigned screens stay collapsed, then mount lazily without a batch button", async ({ page }) => {
  await page.goto("/p/flows-perf/cjm?view=lanes");
  await expect(page.locator("[data-cjm-node]")).toHaveCount(178);

  const toggle = page.getByRole("button", { name: "Вне сценариев, 61" });
  const section = page.locator(".cjm-unassigned");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await lazyCounters(page, ".cjm-unassigned")).toMatchObject({ wrappers: 0, tiles: 0 });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(section.locator("[data-lazy-mounted]")).toHaveCount(61);
  // Батчинг по 20 снят: IntersectionObserver — единственный механизм.
  await expect(section.getByRole("button", { name: "показать ещё" })).toHaveCount(0);

  const row = section.getByLabel("Экраны вне сценариев");
  await row.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await lazyCounters(page, ".cjm-unassigned")).mounted).toBeGreaterThan(0);
  const revealed = await lazyCounters(page, ".cjm-unassigned");
  expect(revealed.mounted).toBeLessThanOrEqual(18);
  expect(revealed.tiles).toBe(revealed.mounted);
  expect(revealed.placeholders).toBe(61 - revealed.mounted);

  await scrollToEnd(row);
  await expect.poll(async () => (await lazyCounters(page, ".cjm-unassigned")).mounted).toBeGreaterThan(revealed.mounted);
});

test("print media forces every lane tile to mount so printing and find-in-page are not empty", async ({ page }) => {
  await page.goto(branchingPath);
  await expect(page.locator("[data-cjm-node]")).toHaveCount(10);
  const resting = await lazyCounters(page, ".cjm-grid");
  expect(resting.mounted).toBeLessThan(10);

  await page.emulateMedia({ media: "print" });
  await expect.poll(async () => (await lazyCounters(page, ".cjm-grid")).mounted).toBe(10);
  expect(await lazyCounters(page, ".cjm-grid")).toMatchObject({ wrappers: 10, mounted: 10, tiles: 10, placeholders: 0 });

  await page.emulateMedia({ media: null });
  // mount-once: возврат к экранному режиму ничего не размонтирует.
  expect(await lazyCounters(page, ".cjm-grid")).toMatchObject({ mounted: 10, tiles: 10 });
});
