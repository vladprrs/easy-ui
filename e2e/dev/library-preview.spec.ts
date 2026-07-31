import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ACCENT_DOMINANT,
  ACCENT_SCOPED,
  DOCUMENT_FONT_FAMILY,
  DOMINANT_DS_ID,
  NOVEL_FONT_FAMILY,
  PREVIEW_DS_ID,
  PREVIEW_ICON_NAME,
  PREVIEW_IDS,
  PREVIEW_NAMES,
  ensureLibraryPreviewFixtures,
  previewKey,
} from "./library-preview.fixture";

/**
 * Инлайн-превью библиотеки (план 2026-07-31 §6 «E2E»).
 *
 * Экран заменил per-card iframe `/capture/component/...` на рендер в дереве самой страницы,
 * поэтому проверяется ровно то, что от такой замены ломается первым: метаданные обязаны быть
 * доступны раньше превью, тяжёлое грузиться раньше дешёвого, темы двух систем не пересекаться и
 * не портить хром, а компонент с собственной геометрией экрана — оставаться внутри своей карточки.
 */

const SECTION = {
  recommended: "Рекомендуем",
  high: "Страницы, шаблоны и организмы",
  molecules: "Молекулы",
  atoms: "Атомы и лэйаут",
} as const;

/** Хромные переменные, которые тема превью не имеет права переопределить (план §4.3.1). */
const CHROME_VARS = [
  "--color-eui-brand", "--color-eui-graphite", "--color-eui-ink", "--color-eui-lav",
  "--color-eui-lilac-50", "--color-eui-lilac-100", "--color-eui-lilac-200", "--color-eui-lilac-300",
  "--color-eui-magenta", "--color-eui-orange", "--color-eui-slate-400", "--color-eui-slate-500",
  "--color-eui-slate-700", "--font-eui-display", "--font-eui-ui",
];

const section = (page: Page, name: string): Locator => page.getByRole("list", { name });
const previewIn = (scope: Locator, designSystem: string, id: string): Locator =>
  scope.locator(`[data-component-preview="${previewKey(designSystem, id)}"]`);
const searchBox = (page: Page): Locator => page.getByRole("searchbox");

/** «Витрина готова» = карточка организма из яруса `high` доехала до `ready`. */
async function openLibraryWithPreviews(page: Page): Promise<Locator> {
  await page.goto("/library");
  const high = section(page, SECTION.high);
  const organism = previewIn(high, DOMINANT_DS_ID, PREVIEW_IDS.organism);
  await organism.scrollIntoViewIfNeeded();
  await expect(organism).toHaveAttribute("data-component-preview-state", "ready");
  return high;
}

test.describe("Library inline previews", () => {
  test.beforeAll(async ({ request }) => {
    // Публикация семи компонентов — это семь typecheck+compile подпроцессов.
    test.setTimeout(600_000);
    await ensureLibraryPreviewFixtures(request);
  });

  test("metadata is searchable before a single preview settles", async ({ page }) => {
    // Ответ preview-эндпоинта придерживается: иначе «раньше» между витриной и превью недоказуемо.
    await page.route("**/api/components/*/versions/*/preview*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await route.continue();
    });

    await page.goto("/library");
    await expect(page.locator('main[data-library-ready="true"]')).toBeVisible();
    await expect(page.locator('[data-component-preview-state="queued"], [data-component-preview-state="loading"]').first()).toBeVisible();
    expect(await page.locator('[data-component-preview-state="ready"]').count()).toBe(0);

    await searchBox(page).fill(PREVIEW_NAMES.organism);
    await expect(page.getByRole("link", { name: PREVIEW_NAMES.organism, exact: true })).toHaveCount(1);
    expect(await page.locator('[data-component-preview-state="ready"]').count()).toBe(0);
  });

  test("loads an organism preview while the atoms index mounts none", async ({ page }) => {
    const high = await openLibraryWithPreviews(page);
    await expect(previewIn(high, DOMINANT_DS_ID, PREVIEW_IDS.organism).locator("[data-e2e-preview-organism]")).toHaveText("Organism preview");

    // Компактный индекс атомов не монтирует превью вовсе: они раскрываются только по действию.
    const atoms = section(page, SECTION.atoms);
    await expect(atoms.getByRole("link", { name: PREVIEW_NAMES.atom, exact: true })).toHaveCount(1);
    await expect(atoms.locator("[data-component-preview]")).toHaveCount(0);
  });

  test("promotes an offscreen search result to a loaded preview", async ({ page }) => {
    // Страница не скроллится ни разу: карточка обязана остаться незагруженной ровно потому,
    // что она далеко за краем вьюпорта, а не потому, что мы успели проверить её раньше очереди.
    await page.goto("/library");
    await expect(page.locator('main[data-library-ready="true"]')).toBeVisible();
    await expect(page.locator('[data-component-preview-state="ready"]').first()).toBeVisible();

    // Карточка выбирается по факту, а не по имени: состав ярусов зависит от всей базы, а нужна
    // запись, которая (а) существует на странице в одном экземпляре и (б) лежит далеко за краем.
    const target = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("[data-component-preview]")];
      const counts = new Map<string, number>();
      for (const node of nodes) {
        const key = node.getAttribute("data-component-preview")!;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const node of nodes) {
        const key = node.getAttribute("data-component-preview")!;
        if (counts.get(key) !== 1) continue;
        if (node.getAttribute("data-component-preview-state") !== "idle") continue;
        if (node.getBoundingClientRect().top < window.innerHeight + 1_200) continue;
        const name = node.closest("li")?.querySelector("h3 a")?.textContent?.trim();
        if (name) return { key, name };
      }
      return null;
    });
    expect(target, "витрина обязана иметь незагруженную офскрин-карточку").not.toBeNull();

    const offscreen = page.locator(`[data-component-preview="${target!.key}"]`);
    expect(await offscreen.getAttribute("data-component-preview-state")).toBe("idle");

    await searchBox(page).fill(target!.name);
    const promoted = page.locator(`[data-component-preview="${target!.key}"]`);
    await expect(promoted).toHaveCount(1);
    await expect(promoted).toHaveAttribute("data-component-preview-state", "ready");
  });

  test("expands an atom preview from the keyboard", async ({ page }) => {
    await page.goto("/library");
    const row = section(page, SECTION.atoms).locator("li")
      .filter({ has: page.getByRole("link", { name: PREVIEW_NAMES.atom, exact: true }) });
    const toggle = row.getByRole("button", { name: "Показать превью" });

    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(row.locator("[data-component-preview]")).toHaveAttribute("data-component-preview-state", "ready");
    await expect(row.locator("[data-e2e-preview-atom]")).toHaveText("Atom preview");

    // Фокус остаётся на кнопке, поэтому свернуть её можно тем же способом — пробелом.
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(row.locator("[data-component-preview]")).toHaveCount(0);
  });

  test("re-mounts a scrolled-away preview from the module cache", async ({ page }) => {
    const bundles: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith(`/api/components/${PREVIEW_IDS.organism}/versions/`) && path.endsWith("/bundle.js")) bundles.push(path);
    });

    const high = await openLibraryWithPreviews(page);
    const organism = previewIn(high, DOMINANT_DS_ID, PREVIEW_IDS.organism);
    expect(bundles).toHaveLength(1);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(organism).toHaveAttribute("data-component-preview-state", "idle");
    await expect(organism).toHaveAttribute("data-component-preview-mounted", "false");

    await organism.scrollIntoViewIfNeeded();
    await expect(organism).toHaveAttribute("data-component-preview-state", "ready");
    // Модуль остался в кэше loadCustomComponents — возврат в зону обязан быть бессетевым.
    expect(bundles).toHaveLength(1);
  });

  test("renders every preview inline: no iframe, no per-component metadata request", async ({ page }) => {
    const componentMeta: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "GET" && /^\/api\/components\/[^/]+$/.test(path)) componentMeta.push(path);
    });

    await openLibraryWithPreviews(page);
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(componentMeta).toEqual([]);
  });

  test("keeps the app chrome intact with two design systems on the page", async ({ page }) => {
    const chromeSnapshot = () => page.evaluate((names: string[]) => {
      const root = getComputedStyle(document.documentElement);
      const header = document.querySelector("header")!;
      return {
        body: getComputedStyle(document.body).fontFamily,
        header: getComputedStyle(header).fontFamily,
        vars: Object.fromEntries(names.map((name) => [name, root.getPropertyValue(name).trim()])),
      };
    }, CHROME_VARS);

    await page.goto("/library?libraryPreviews=off");
    await expect(page.locator('main[data-library-ready="true"]')).toBeVisible();
    await expect(page.locator("[data-component-preview]")).toHaveCount(0);
    const baseline = await chromeSnapshot();

    const high = await openLibraryWithPreviews(page);
    const scoped = previewIn(high, PREVIEW_DS_ID, PREVIEW_IDS.scopedAccent);
    await scoped.scrollIntoViewIfNeeded();
    await expect(scoped).toHaveAttribute("data-component-preview-state", "ready");
    // Обе системы живы одновременно — иначе проверка «не пересекаются» ничего не значит.
    await expect(page.locator(`[data-eui-scoped-system="${DOMINANT_DS_ID}"]`).first()).toBeVisible();
    await expect(page.locator(`[data-eui-scoped-system="${PREVIEW_DS_ID}"]`).first()).toBeVisible();

    expect(await chromeSnapshot()).toEqual(baseline);

    // M-2: @font-face семейства, которым набран сам хром, не переобъявляется под /api/assets/*,
    // а незнакомое документу семейство — регистрируется (иначе правило было бы «не грузим ничего»).
    const fonts = await page.evaluate(() => [...document.querySelectorAll("style[data-eui-fonts]")].map((node) => node.textContent ?? ""));
    expect(fonts.join("\n")).not.toContain(DOCUMENT_FONT_FAMILY);
    expect(fonts.join("\n")).toContain(NOVEL_FONT_FAMILY);
  });

  test("keeps a viewport-bounded component inside its card", async ({ page }) => {
    const high = await openLibraryWithPreviews(page);
    const fixed = previewIn(high, DOMINANT_DS_ID, PREVIEW_IDS.fixed);
    await fixed.scrollIntoViewIfNeeded();
    await expect(fixed).toHaveAttribute("data-component-preview-state", "ready");

    const geometry = await page.evaluate(() => {
      const overlay = document.querySelector("[data-e2e-preview-fixed]")!;
      const zone = overlay.closest("[data-component-preview]")!;
      // Containing block фиксированного слоя — трансформированный контент FitToBox.
      const content = overlay.closest("[data-fit-to-box-content]")!;
      const overlayRect = overlay.getBoundingClientRect();
      const zoneRect = zone.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const above = document.elementFromPoint(zoneRect.left + zoneRect.width / 2, Math.max(zoneRect.top - 24, 1));
      return {
        overlay: { top: overlayRect.top, left: overlayRect.left },
        content: { top: contentRect.top, left: contentRect.left },
        escapesAbove: above !== null && above.closest("[data-component-preview]") === zone,
      };
    });

    // `FitToBox` ставит transform всегда, даже при k=1, поэтому `position: fixed` разрешается
    // относительно содержимого карточки, а не вьюпорта: слой начинается там же, где содержимое,
    // и заведомо не в (0, 0) экрана.
    expect(Math.abs(geometry.overlay.top - geometry.content.top)).toBeLessThan(2);
    expect(Math.abs(geometry.overlay.left - geometry.content.left)).toBeLessThan(2);
    expect(geometry.overlay.top).toBeGreaterThan(0);
    expect(geometry.overlay.left).toBeGreaterThan(0);
    // Наружу слой не выходит: `contain: layout paint` обрезает и отрисовку, и попадание курсора.
    expect(geometry.escapesAbove).toBe(false);

    // Хром остаётся кликабельным: click упал бы, перекрой его слой компонента.
    await page.evaluate(() => window.scrollTo(0, 0));
    await searchBox(page).click();
    await expect(searchBox(page)).toBeFocused();
  });

  test("isolates a broken component from its neighbours", async ({ page }) => {
    const high = await openLibraryWithPreviews(page);
    const broken = previewIn(high, DOMINANT_DS_ID, PREVIEW_IDS.broken);
    await broken.scrollIntoViewIfNeeded();

    await expect(broken).toHaveAttribute("data-component-preview-state", "error");
    await expect(broken).toHaveAttribute("data-component-preview-error", "render");
    await expect(broken.getByRole("alert")).toContainText("Превью не загрузилось");
    await expect(broken.getByRole("button", { name: "Повторить" })).toBeVisible();

    for (const id of [PREVIEW_IDS.organism, PREVIEW_IDS.icon, PREVIEW_IDS.accent]) {
      const neighbour = previewIn(high, DOMINANT_DS_ID, id);
      await neighbour.scrollIntoViewIfNeeded();
      await expect(neighbour).toHaveAttribute("data-component-preview-state", "ready");
    }
  });

  test("resolves Icon from the dominant theme and color() from each card's own scope", async ({ page }) => {
    const high = await openLibraryWithPreviews(page);

    const icon = previewIn(high, DOMINANT_DS_ID, PREVIEW_IDS.icon);
    await icon.scrollIntoViewIfNeeded();
    await expect(icon).toHaveAttribute("data-component-preview-state", "ready");
    const image = icon.locator(`img[data-eui-icon="${PREVIEW_ICON_NAME}"]`);
    await expect(image).toHaveAttribute("src", /^\/api\/assets\/asset_[0-9a-f]{64}$/);
    expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);

    // `color()` — чистый var(--eui-color-*): доминирующая система читает его из :root владельца
    // темы, недоминирующая — из инлайн-переменных своей обёртки.
    const dominant = previewIn(high, DOMINANT_DS_ID, PREVIEW_IDS.accent);
    await dominant.scrollIntoViewIfNeeded();
    await expect(dominant.locator("[data-e2e-preview-accent]")).toHaveCSS("background-color", ACCENT_DOMINANT);

    const scoped = previewIn(high, PREVIEW_DS_ID, PREVIEW_IDS.scopedAccent);
    await scoped.scrollIntoViewIfNeeded();
    await expect(scoped).toHaveAttribute("data-component-preview-state", "ready");
    await expect(scoped.locator("[data-e2e-preview-scoped-accent]")).toHaveCSS("background-color", ACCENT_SCOPED);
  });

  test("overrides :root with per-card scoped custom properties", async ({ page }) => {
    const high = await openLibraryWithPreviews(page);
    const scoped = previewIn(high, PREVIEW_DS_ID, PREVIEW_IDS.scopedAccent);
    await scoped.scrollIntoViewIfNeeded();
    await expect(scoped).toHaveAttribute("data-component-preview-state", "ready");

    const surface = scoped.locator(`[data-eui-scoped-surface][data-eui-scoped-system="${PREVIEW_DS_ID}"]`);
    await expect(surface).toHaveCount(1);

    // Реальный computed-value: в jsdom это недоказуемо (T2), поэтому значение читается из браузера.
    const values = await surface.evaluate((node: HTMLElement) => ({
      root: getComputedStyle(document.documentElement).getPropertyValue("--eui-color-e2e-accent").trim(),
      scoped: getComputedStyle(node).getPropertyValue("--eui-color-e2e-accent").trim(),
    }));
    expect(values.root).toBe(ACCENT_DOMINANT);
    expect(values.scoped).toBe(ACCENT_SCOPED);
  });
});
