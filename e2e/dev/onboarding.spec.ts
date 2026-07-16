import { expect, test, type APIRequestContext } from "@playwright/test";

const api = "/api";
let createdId: string | null = null;

async function cleanup(request: APIRequestContext) {
  if (!createdId) return;
  const draft = await request.get(`${api}/prototypes/${createdId}/draft`);
  if (draft.status() === 404) return;
  const { rev } = await draft.json() as { rev: number };
  const deleted = await request.delete(`${api}/prototypes/${createdId}`, { data: { baseRev: rev } });
  expect(deleted.status()).toBe(204);
}

test.describe("new prototype onboarding", () => {
  test.afterAll(async ({ request }) => cleanup(request));

  test("Новый прототип → редактор", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Новый прототип" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Создание прототипа" });
    await dialog.getByLabel("Название прототипа").fill(`Onboarding E2E ${Date.now()}`);
    await dialog.getByLabel("Дизайн-система").selectOption("wireframe");
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/prototypes") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Создать прототип" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    createdId = ((await response.json()) as { id: string }).id;
    await expect(page).toHaveURL(new RegExp(`/p/${createdId}/edit$`));
    const canvas = page.getByRole("region", { name: "Холст редактора" });
    await expect(canvas).toBeVisible();
    await expect(canvas.getByText("Набросайте структуру будущего сценария.", { exact: true })).toBeVisible();
  });
});
