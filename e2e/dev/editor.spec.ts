import { expect, test, type APIRequestContext } from "@playwright/test";

const api = "/api";
const prototypeId = `editor-e2e-${Date.now()}`;
const screenId = "canvas-screen";
const initialText = "Editor text before change";
const updatedText = "Editor text saved end to end";

const doc = {
  version: 1,
  id: prototypeId,
  name: "Editor E2E prototype",
  device: "desktop",
  startScreen: screenId,
  state: {},
  screens: [
    {
      id: screenId,
      name: "Canvas screen",
      canvas: { width: 900, height: 480 },
      spec: {
        root: "content",
        elements: {
          content: { type: "Stack", props: { direction: "vertical", gap: "md" }, children: ["copy"] },
          copy: { type: "Text", props: { text: initialText } },
        },
      },
    },
    {
      id: "hotspot-screen",
      name: "Hotspot screen",
      canvas: { width: 390, height: 480 },
      spec: {
        root: "hotspot-content",
        elements: {
          "hotspot-content": { type: "Text", props: { text: "Canvas content under hotspot" }, children: ["hotspot"] },
          hotspot: { type: "Hotspot", props: { x: 16, y: 16, width: 220, height: 80, ariaLabel: "E2E hotspot" } },
        },
      },
    },
  ],
};

async function cleanup(request: APIRequestContext) {
  const draft = await request.get(`${api}/prototypes/${prototypeId}/draft`);
  if (draft.status() === 404) return;
  expect(draft.ok()).toBeTruthy();
  const { rev } = await draft.json() as { rev: number };
  const deleted = await request.delete(`${api}/prototypes/${prototypeId}`, { data: { baseRev: rev } });
  expect([204, 404]).toContain(deleted.status());
}

// The dev project is serial and api.spec.ts mutates hello-world, so this test owns a unique prototype.
test.describe("prototype editor", () => {
  test.beforeAll(async ({ request }) => {
    const created = await request.post(`${api}/prototypes`, { data: { doc, message: "Initial E2E revision" } });
    expect(created.status()).toBe(201);
  });

  test.afterAll(async ({ request }) => {
    await cleanup(request);
  });

  test("edits text, saves and publishes it, then opens the immutable player version", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 760, height: 800 });
    await page.goto(`/p/${prototypeId}/edit`);

    const canvas = page.getByRole("region", { name: "Холст редактора" });
    const overlay = canvas.getByTestId("editor-hit-overlay");
    const selectedElement = canvas.locator('span[data-jr-key="copy"]');
    await expect(selectedElement).toContainText(initialText);

    const renderedText = selectedElement.getByText(initialText, { exact: true });
    await page.evaluate(() => document.fonts.ready);
    const elementBox = await renderedText.boundingBox();
    const overlayBox = await overlay.boundingBox();
    expect(elementBox).not.toBeNull();
    expect(overlayBox).not.toBeNull();
    expect(overlayBox!.width).toBeLessThan(doc.screens[0].canvas.width);
    await page.mouse.click(elementBox!.x + elementBox!.width / 2, elementBox!.y + elementBox!.height / 2);

    const inspector = page.getByRole("complementary", { name: "Инспектор" });
    const textInput = inspector.getByLabel("text", { exact: true });
    await expect(textInput).toBeVisible();
    await expect(textInput).toHaveValue(initialText);

    const selectionFrame = canvas.getByTestId("editor-selection-frame").last();
    await expect(selectionFrame).toBeVisible();
    const frameBox = await selectionFrame.boundingBox();
    expect(frameBox).not.toBeNull();
    expect(frameBox!.width).toBeGreaterThan(0);
    expect(frameBox!.height).toBeGreaterThan(0);
    expect(frameBox!.x).toBeLessThan(elementBox!.x + elementBox!.width);
    expect(frameBox!.x + frameBox!.width).toBeGreaterThan(elementBox!.x);
    expect(frameBox!.y).toBeLessThan(elementBox!.y + elementBox!.height);
    expect(frameBox!.y + frameBox!.height).toBeGreaterThan(elementBox!.y);

    await textInput.fill(updatedText);
    await textInput.press("Enter");
    await expect(canvas.getByText(updatedText, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
    const publishDialog = page.getByRole("dialog", { name: "Публикация прототипа" });
    await publishDialog.getByRole("textbox", { name: "Сообщение к версии (необязательно)" }).fill("E2E publish");
    await publishDialog.getByRole("button", { name: "Сохранить и опубликовать", exact: true }).click();
    await expect(page.getByText("v 1 опубликована", { exact: true })).toBeVisible();

    await page.goto(`/p/${prototypeId}/v/1`);
    await expect(page.getByText(updatedText, { exact: true })).toBeVisible();

    await page.goto(`/p/${prototypeId}/edit`);
    await expect(canvas.getByText(updatedText, { exact: true })).toBeVisible();

    // W3-2: dirty restore явно подтверждается, затем editor полностью rebейзится
    // на новую server head и следующий save использует её rev без 409.
    const updatedBox = await canvas.getByText(updatedText, { exact: true }).boundingBox();
    expect(updatedBox).not.toBeNull();
    await page.mouse.click(updatedBox!.x + updatedBox!.width / 2, updatedBox!.y + updatedBox!.height / 2);
    await inspector.getByLabel("text", { exact: true }).fill("Unsaved text to discard");
    await inspector.getByLabel("text", { exact: true }).press("Enter");
    await expect(page.getByText("Не сохранено", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "История", exact: true }).click();
    const history = page.getByRole("region", { name: "История прототипа" });
    await expect(history.getByText("Initial E2E revision", { exact: true })).toBeVisible();
    await history.getByText("Initial E2E revision", { exact: true }).locator("..").locator("..").getByRole("button", { name: "Восстановить" }).click();
    const restoreDialog = page.getByRole("dialog", { name: "Подтверждение восстановления" });
    await expect(restoreDialog).toContainText("Текущие несохранённые правки будут отброшены");
    await restoreDialog.getByRole("button", { name: "Восстановить", exact: true }).click();
    await expect(canvas.getByText(initialText, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Отменить правку/ })).toBeDisabled();
    const saveAfterRestore = page.waitForResponse((response) => response.url().endsWith(`/api/prototypes/${prototypeId}`) && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    expect((await saveAfterRestore).status()).toBe(200);
    await expect(page.getByText("Сохранено", { exact: true })).toBeVisible();
  });
});
