import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { authenticatedRequest } from "../auth";
import { ensureComponentPageFixtures } from "../dev/custom-ds.fixture";
import { provisionScreenRegionFixtures } from "../screen-regions.fixture";
import { provisionStarterFixtures } from "../starter-ds.fixture";

export const PREVIEW_STORAGE_STATE = ".e2e-data/storage/preview.json";

test("login through the preview origin", async ({ baseURL }) => {
  expect(baseURL).toBeTruthy();
  await mkdir(".e2e-data/storage", { recursive: true });
  const request = await authenticatedRequest(baseURL!, { storageStatePath: PREVIEW_STORAGE_STATE });
  await provisionStarterFixtures(request);
  await provisionScreenRegionFixtures(request);
  await ensureComponentPageFixtures(request);
  await request.dispose();
});
