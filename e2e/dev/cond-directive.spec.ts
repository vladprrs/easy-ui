import { expect, test } from "@playwright/test";
import { STARTER_BUTTON, STARTER_DS_ID, STARTER_STACK, STARTER_TEXT } from "../starter-ds.fixture";

const api = "/api";

test("a prototype $cond switches branches after an action", async ({ request, page }) => {
  const doc = {
    version: 1,
    id: "conditional-directive-flow",
    name: "Conditional directive flow",
    designSystem: STARTER_DS_ID,
    device: "mobile",
    startScreen: "main",
    state: { enabled: false },
    screens: [{
      id: "main",
      name: "Main",
      spec: {
        root: "card",
        elements: {
          card: { type: STARTER_STACK, props: { gap: "md" }, children: ["status", "toggle"] },
          status: { type: STARTER_TEXT, props: { text: { $cond: { if: { $state: "/enabled" }, then: "Feature enabled", else: "Feature disabled" } } } },
          toggle: { type: STARTER_BUTTON, props: { label: "Enable feature" }, on: { press: { action: "setState", params: { statePath: "/enabled", value: true } } } },
        },
      },
    }],
  };

  expect((await request.post(`${api}/prototypes`, { data: { doc } })).status()).toBe(201);
  await page.goto("/p/conditional-directive-flow");
  await expect(page).toHaveURL(/\/p\/conditional-directive-flow\/s\/main$/);
  await expect(page.getByText("Feature disabled")).toBeVisible();
  await page.getByRole("button", { name: "Enable feature" }).click();
  await expect(page.getByText("Feature enabled")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
