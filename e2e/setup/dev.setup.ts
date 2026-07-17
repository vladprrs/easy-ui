import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { authenticatedRequest } from "../auth";
import { ensureComponentPageFixtures, CUSTOM_DS_ID, CUSTOM_DS_PROTOTYPE_ID } from "../dev/custom-ds.fixture";
import { provisionMobilePresentationFixtures } from "../dev/present-mobile.setup";
import { provisionScreenRegionFixtures } from "../screen-regions.fixture";
import { ensureStarterPrototype, provisionStarterFixtures, STARTER_DS_ID } from "../starter-ds.fixture";

export const DEV_STORAGE_STATE = ".e2e-data/storage/dev.json";
export const LEGACY_ARCHIVE_ID = "v15-archived-legacy";

test("login and provision dev fixtures through the Vite origin", async ({ baseURL }) => {
  expect(baseURL).toBeTruthy();
  await mkdir(".e2e-data/storage", { recursive: true });
  const request = await authenticatedRequest(baseURL!, { storageStatePath: DEV_STORAGE_STATE });
  await provisionStarterFixtures(request);
  await provisionScreenRegionFixtures(request);
  await ensureComponentPageFixtures(request);
  await provisionMobilePresentationFixtures(request);
  await ensureStarterPrototype(request, {
    version: 1,
    id: LEGACY_ARCHIVE_ID,
    name: "V15 archived legacy prototype",
    designSystem: STARTER_DS_ID,
    device: "mobile",
    startScreen: "legacy",
    state: {},
    screens: [{ id: "legacy", name: "Legacy", spec: { root: "image", elements: { image: { type: "Image", props: { src: "/design/cjm-ui/assets/mascot-laptop.png", alt: "Legacy placeholder" } } } } }],
  });
  await promisify(execFile)("bun", ["e2e/setup/prepare-legacy-db.mjs", ".e2e-data/dev/easy-ui.db", LEGACY_ARCHIVE_ID]);
  const meta = await request.get(`/api/prototypes/${CUSTOM_DS_PROTOTYPE_ID}`);
  expect(meta.ok()).toBeTruthy();
  expect(await meta.json()).toMatchObject({ id: CUSTOM_DS_PROTOTYPE_ID, designSystem: CUSTOM_DS_ID, latestVersion: 1 });
  await request.dispose();
});
