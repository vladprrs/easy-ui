import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { STARTER_BUTTON, STARTER_DS_ID, STARTER_STACK, STARTER_TEXT } from "../starter-ds.fixture";

const api = "/api";

test("custom component hooks, events, state templates, and published navigation work", async ({ request, page }) => {
  const source = await readFile("server/fixtures/rating-stars.tsx", "utf8");
  expect((await request.post(`${api}/components`, {
    data: { id: "ui-rating-stars", name: "UiRatingStars", source, designSystem: STARTER_DS_ID },
  })).status()).toBe(201);
  expect((await request.post(`${api}/components/ui-rating-stars/publish`, { data: { baseRev: 1 } })).status()).toBe(201);

  const doc = {
    version: 1,
    id: "custom-rating-flow",
    name: "Custom rating flow",
    designSystem: STARTER_DS_ID,
    device: "mobile",
    startScreen: "rating",
    state: { rating: 3 },
    screens: [
      {
        id: "rating", name: "Rating", spec: { root: "card", elements: {
          card: { type: STARTER_STACK, props: { gap: "md" }, children: ["stars", "value", "next"] },
          stars: { type: "UiRatingStars", props: { value: 3 }, on: { press: { action: "setState", params: { statePath: "/rating", value: 4 } } } },
          value: { type: STARTER_TEXT, props: { text: { $template: "Rating: ${/rating}" } } },
          next: { type: STARTER_BUTTON, props: { label: "Next" }, on: { press: { action: "navigate", params: { screenId: "done" } } } },
        } },
      },
      {
        id: "done", name: "Done", spec: { root: "card", elements: {
          card: { type: STARTER_STACK, props: { gap: "md" }, children: ["copy", "back"] },
          copy: { type: STARTER_TEXT, props: { text: "Published custom component" } },
          back: { type: STARTER_BUTTON, props: { label: "Back" }, on: { press: { action: "back", params: {} } } },
        } },
      },
    ],
  };
  expect((await request.post(`${api}/prototypes`, { data: { doc } })).status()).toBe(201);
  expect((await request.post(`${api}/prototypes/custom-rating-flow/publish`, { data: { baseRev: 1 } })).status()).toBe(201);

  await page.goto("/p/custom-rating-flow");
  await expect(page).toHaveURL(/\/p\/custom-rating-flow\/s\/rating$/);
  const stars = page.getByRole("button", { name: "★★★" });
  await expect(stars).toBeVisible();
  await stars.click();
  await expect(page.getByText("Rating: 4")).toBeVisible();
  await expect(page.getByRole("button", { name: "★★★★" })).toBeVisible();

  await page.goto("/p/custom-rating-flow/v/1");
  await expect(page).toHaveURL(/\/p\/custom-rating-flow\/v\/1\/s\/rating$/);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/\/p\/custom-rating-flow\/v\/1\/s\/done$/);
  await page.getByLabel("Превью прототипа на устройстве").getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/p\/custom-rating-flow\/v\/1\/s\/rating$/);
});
