import { expect, test } from "@playwright/test";
import {
  CUSTOM_DS_ID,
  CUSTOM_DS_PROTOTYPE_ID,
  ensureComponentPageFixtures,
} from "./custom-ds.fixture";

// Runs as the "dev-setup" Playwright project; the "dev" project depends on it, so every dev
// e2e run has the custom-DS prototype available (see custom-ds.fixture.ts for the contract).
test("provision custom design system fixture over the dev API", async ({ request }) => {
  await ensureComponentPageFixtures(request);

  const meta = await request.get(`http://127.0.0.1:8787/api/prototypes/${CUSTOM_DS_PROTOTYPE_ID}`);
  expect(meta.ok()).toBeTruthy();
  expect(await meta.json()).toMatchObject({
    id: CUSTOM_DS_PROTOTYPE_ID,
    designSystem: CUSTOM_DS_ID,
    latestVersion: 1,
  });
});
