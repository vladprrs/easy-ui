# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dev/present.spec.ts >> presentation hotkeys browse, restart, show help, and direct Esc exits
- Location: e2e/dev/present.spec.ts:47:1

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\/p\/hello-world\/present\/s\/details$/
Received string:  "http://localhost:5173/p/hello-world/present/s/welcome"
Timeout: 5000ms

Call log:
  - Expect "toHaveURL" with timeout 5000ms
    14 × unexpected value "http://localhost:5173/p/hello-world/present/s/welcome"

```

```yaml
- main:
  - region "Превью прототипа на устройстве":
    - paragraph: Name
    - paragraph: Hello, Ada!
    - button "Details"
  - navigation "Экраны презентации"
  - text: 1 / 2
  - button "Начать сначала"
  - link "Открыть в easy-ui":
    - /url: /p/hello-world/s/welcome
```

# Test source

```ts
  1  | import { expect, test } from "@playwright/test";
  2  | 
  3  | // Режим презентации (W1-2): только прототип на экране, интерактивный флоу,
  4  | // Esc — возврат в плеер, deep-link на экран, пригодность на мобильном вьюпорте.
  5  | 
  6  | test("presentation opens from the player, runs the flow, and Esc returns to the player", async ({ page }) => {
  7  |   const consoleErrors: string[] = [];
  8  |   page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  9  | 
  10 |   await page.goto("/p/checkout");
  11 |   await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);
  12 |   await page.getByRole("link", { name: "Презентация" }).click();
  13 |   await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/catalog$/);
  14 | 
  15 |   // Только прототип: ни глобального хрома, ни PrototypeChrome.
  16 |   await expect(page.getByRole("link", { name: "Галерея" })).toHaveCount(0);
  17 |   await expect(page.getByTestId("chrome-actions")).toHaveCount(0);
  18 |   // Внутренний вход: подсказка Esc вместо «Открыть в easy-ui».
  19 |   await expect(page.getByText("Esc — вернуться в плеер")).toBeVisible();
  20 |   await expect(page.getByRole("link", { name: "Открыть в easy-ui" })).toHaveCount(0);
  21 | 
  22 |   // Полный клик-флоу: каталог → товар → корзина.
  23 |   await page.getByRole("button", { name: "Открыть карточку кроссовок" }).click();
  24 |   await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/product$/);
  25 |   await page.getByRole("button", { name: "В корзину" }).click();
  26 |   await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/cart$/);
  27 |   await expect(page.getByText("Лёгкие кроссовки × 1")).toBeVisible();
  28 | 
  29 |   // Esc возвращает в плеер на тот же экран.
  30 |   await page.keyboard.press("Escape");
  31 |   await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  32 |   await expect(page.getByRole("link", { name: "Галерея" })).toBeVisible();
  33 | 
  34 |   expect(consoleErrors).toEqual([]);
  35 | });
  36 | 
  37 | test("deep link opens the requested screen and offers an easy-ui entry", async ({ page }) => {
  38 |   await page.goto("/p/checkout/present/s/product");
  39 |   await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/product$/);
  40 |   await expect(page.getByRole("button", { name: "В корзину" })).toBeVisible();
  41 |   const openInApp = page.getByRole("link", { name: "Открыть в easy-ui" });
  42 |   await expect(openInApp).toBeVisible();
  43 |   await openInApp.click();
  44 |   await expect(page).toHaveURL(/\/p\/checkout\/s\/product$/);
  45 | });
  46 | 
  47 | test("presentation hotkeys browse, restart, show help, and direct Esc exits", async ({ page }) => {
  48 |   await page.goto("/p/hello-world/present");
  49 |   await expect(page).toHaveURL(/\/p\/hello-world\/present\/s\/welcome$/);
  50 |   await page.keyboard.press("ArrowRight");
> 51 |   await expect(page).toHaveURL(/\/p\/hello-world\/present\/s\/details$/);
     |                      ^ Error: expect(page).toHaveURL(expected) failed
  52 |   await page.keyboard.press("R");
  53 |   await expect(page).toHaveURL(/\/p\/hello-world\/present\/s\/welcome$/);
  54 |   await expect(page.getByRole("button", { name: "Details" })).toBeVisible();
  55 | 
  56 |   await page.keyboard.press("Shift+/");
  57 |   await expect(page.getByRole("dialog", { name: "Горячие клавиши" })).toBeVisible();
  58 |   await page.keyboard.press("Shift+/");
  59 |   await expect(page.getByRole("dialog", { name: "Горячие клавиши" })).toHaveCount(0);
  60 | 
  61 |   await page.keyboard.press("Escape");
  62 |   await expect(page).toHaveURL(/\/p\/hello-world\/s\/welcome$/);
  63 | });
  64 | 
  65 | test("gallery card opens the presentation at the start screen", async ({ page }) => {
  66 |   await page.goto("/");
  67 |   const card = page.getByRole("listitem").filter({ hasText: "Мобильное оформление заказа" });
  68 |   await card.getByRole("link", { name: "Презентация" }).click();
  69 |   await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/catalog$/);
  70 |   await expect(page.getByRole("button", { name: "Открыть карточку кроссовок" })).toBeVisible();
  71 | });
  72 | 
  73 | test.describe("mobile customer viewport", () => {
  74 |   test.use({ viewport: { width: 390, height: 844 } });
  75 | 
  76 |   test("presentation fits 390px without cropping and stays interactive", async ({ page }) => {
  77 |     await page.goto("/p/checkout/present");
  78 |     await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/catalog$/);
  79 |     const cta = page.getByRole("button", { name: "Открыть карточку кроссовок" });
  80 |     await expect(cta).toBeVisible();
  81 | 
  82 |     // Без горизонтальной прокрутки и обрезков: фрейм скейлится в вьюпорт.
  83 |     expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  84 |     const stage = page.getByRole("region", { name: "Превью прототипа на устройстве" });
  85 |     const box = (await stage.boundingBox())!;
  86 |     expect(box.x).toBeGreaterThanOrEqual(0);
  87 |     expect(box.x + box.width).toBeLessThanOrEqual(390 + 1);
  88 | 
  89 |     // Флоу кликается на мобильном вьюпорте.
  90 |     await cta.click();
  91 |     await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/product$/);
  92 |   });
  93 | });
  94 | 
```