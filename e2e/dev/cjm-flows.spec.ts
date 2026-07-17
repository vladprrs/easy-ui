import { expect, test, type Locator, type Page } from "@playwright/test";

const branchingPath = "/p/branching-checkout/cjm";

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

async function mountedUnassigned(section: Locator) {
  return section.locator(".cjm-tile").count();
}

test("limit fixture keeps unassigned tiles collapsed and reveals one measured batch at a time", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/p/flows-perf/cjm");

  await expect(page.getByTestId("cjm-lane-label")).toHaveCount(12);
  await expect(page.locator("[data-cjm-node]")).toHaveCount(178);
  const toggle = page.getByRole("button", { name: "Вне сценариев, 61" });
  const section = toggle.locator("xpath=..");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await mountedUnassigned(section)).toBe(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(section.locator(".cjm-tile")).toHaveCount(20);

  const elapsed = await section.evaluate(async (node) => {
    const button = [...node.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "показать ещё")!;
    const started = performance.now();
    button.click();
    while (node.querySelectorAll(".cjm-tile").length !== 40) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return performance.now() - started;
  });
  expect(elapsed).toBeLessThan(1_500);
  await expect(section.locator(".cjm-tile")).toHaveCount(40);

  await section.getByRole("button", { name: "показать ещё" }).click();
  await expect(section.locator(".cjm-tile")).toHaveCount(60);
  await section.getByRole("button", { name: "показать ещё" }).click();
  await expect(section.locator(".cjm-tile")).toHaveCount(61);
  await expect(section.getByRole("button", { name: "показать ещё" })).toHaveCount(0);
});
