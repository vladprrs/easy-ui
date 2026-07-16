import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { authenticatedRequest } from "../auth";
import { ensureComponentPageFixtures, CUSTOM_DS_ID, CUSTOM_DS_PROTOTYPE_ID } from "../dev/custom-ds.fixture";
import { provisionMobilePresentationFixtures } from "../dev/present-mobile.setup";

export const DEV_STORAGE_STATE = ".e2e-data/storage/dev.json";

test("login and provision dev fixtures through the Vite origin", async ({ baseURL }) => {
  expect(baseURL).toBeTruthy();
  await mkdir(".e2e-data/storage", { recursive: true });
  const request = await authenticatedRequest(baseURL!, { storageStatePath: DEV_STORAGE_STATE });
  await ensureComponentPageFixtures(request);
  await provisionMobilePresentationFixtures(request);
  const meta = await request.get(`/api/prototypes/${CUSTOM_DS_PROTOTYPE_ID}`);
  expect(meta.ok()).toBeTruthy();
  expect(await meta.json()).toMatchObject({ id: CUSTOM_DS_PROTOTYPE_ID, designSystem: CUSTOM_DS_ID, latestVersion: 1 });
  await request.dispose();
});
