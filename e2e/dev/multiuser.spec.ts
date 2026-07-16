import { expect, test, type APIRequestContext } from "@playwright/test";
import { authenticatedRequest, E2E_MEMBER_NAME, E2E_MEMBER_PASSWORD } from "../auth";
import { STARTER_DS_ID, STARTER_TEXT } from "../starter-ds.fixture";

function doc(id: string, name: string) {
  return {
    version: 1, id, name, designSystem: STARTER_DS_ID, device: "mobile", startScreen: "main", state: {},
    screens: [{ id: "main", name: "Main", spec: { root: "copy", elements: { copy: { type: STARTER_TEXT, props: { text: name } } } } }],
  };
}

async function ensurePrototype(request: APIRequestContext, id: string, name: string, status: "private" | "published" = "private") {
  const existing = await request.get(`/api/prototypes/${id}`);
  let currentStatus: string | undefined;
  if (existing.status() === 404) {
    const created = await request.post("/api/prototypes", { data: { doc: doc(id, name), message: "multiuser e2e" } });
    expect(created.status(), await created.text()).toBe(201);
    currentStatus = "private";
  } else currentStatus = (await existing.json() as { status: string }).status;
  if (currentStatus !== status) {
    if (currentStatus === "archived") {
      const restored = await request.post(`/api/prototypes/${id}/status`, { data: { status: "private" } });
      expect(restored.status(), await restored.text()).toBe(200);
      currentStatus = "private";
    }
    if (currentStatus !== status) {
      const changed = await request.post(`/api/prototypes/${id}/status`, { data: { status } });
      expect(changed.status(), await changed.text()).toBe(200);
    }
  }
}

test("gallery tabs publish, archive, and restore from the owner card", async ({ page, request }) => {
  const id = "gallery-status-e2e";
  const name = "Gallery status fixture";
  await ensurePrototype(request, id, name);
  await page.goto("/");
  const card = () => page.getByRole("listitem").filter({ hasText: name });
  await expect(page.getByRole("button", { name: "Мои" })).toHaveAttribute("aria-pressed", "true");
  await card().getByRole("button", { name: "В архив" }).click();
  await page.getByRole("button", { name: "Архив", exact: true }).click();
  await expect(card()).toBeVisible();
  await card().getByRole("button", { name: "Вернуть из архива" }).click();
  await page.getByRole("button", { name: "Мои", exact: true }).click();
  await card().getByRole("button", { name: "Опубликовать" }).click();
  await page.getByRole("button", { name: "Общие", exact: true }).click();
  await expect(card()).toBeVisible();
  await expect(card().getByRole("button", { name: "Снять с публикации" })).toBeVisible();
});

test("non-owner principal sees published meta, not private meta, and no revision history", async ({ request, baseURL }) => {
  expect(baseURL).toBeTruthy();
  const createdUser = await request.post("/api/users", { data: { name: E2E_MEMBER_NAME, password: E2E_MEMBER_PASSWORD } });
  expect([201, 409]).toContain(createdUser.status());
  await ensurePrototype(request, "principal-published-e2e", "Principal published", "published");
  await ensurePrototype(request, "principal-private-e2e", "Principal private", "private");

  const member = await authenticatedRequest(baseURL!, { username: E2E_MEMBER_NAME, password: E2E_MEMBER_PASSWORD });
  expect((await member.get("/api/prototypes/principal-published-e2e")).status()).toBe(200);
  expect((await member.get("/api/prototypes/principal-private-e2e")).status()).toBe(404);
  expect((await member.get("/api/prototypes/principal-published-e2e/revisions")).status()).toBe(403);
  await member.dispose();
});
