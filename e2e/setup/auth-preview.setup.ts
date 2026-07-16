import { expect, test } from "@playwright/test";
import { authenticatedRequest } from "../auth";
import { AUTH_PREVIEW_LEGACY_BASIC, SHARE_PROTOTYPE_ID, SHARE_PROTOTYPE_NAME } from "../share/fixture";
import { ensureStarterDesignSystem, ensureStarterPrototype, starterPrototypeFromFile } from "../starter-ds.fixture";

test("provision an API-owned auth-preview fixture", async ({ baseURL }) => {
  expect(baseURL).toBeTruthy();
  const request = await authenticatedRequest(baseURL!, { legacyBasicAuth: AUTH_PREVIEW_LEGACY_BASIC });
  await ensureStarterDesignSystem(request);
  const doc = await starterPrototypeFromFile("test/fixtures/hello-world.json", {
    id: SHARE_PROTOTYPE_ID,
    name: SHARE_PROTOTYPE_NAME,
    description: "Created by the auth-preview setup project.",
  });
  await ensureStarterPrototype(request, doc, { message: "Auth-preview e2e fixture" });
  await request.dispose();
});
