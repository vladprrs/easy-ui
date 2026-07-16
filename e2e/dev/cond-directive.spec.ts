import { expect, test } from "@playwright/test";

const api = "/api";

test("a prototype $cond switches branches after an action", async ({ request, page }) => {
  const doc = {
    version: 1,
    id: "conditional-directive-flow",
    name: "Conditional directive flow",
    device: "mobile",
    startScreen: "main",
    state: { enabled: false },
    screens: [{
      id: "main",
      name: "Main",
      spec: {
        root: "card",
        elements: {
          card: { type: "Card", props: { title: "Conditional" }, children: ["status", "toggle"] },
          status: { type: "Text", props: { text: { $cond: { if: { $state: "/enabled" }, then: "Feature enabled", else: "Feature disabled" } } } },
          toggle: { type: "Button", props: { label: "Enable feature" }, on: { press: { action: "setState", params: { statePath: "/enabled", value: true } } } },
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
