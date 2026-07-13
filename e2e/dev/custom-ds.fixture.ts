import { readFile } from "node:fs/promises";
import type { APIRequestContext } from "@playwright/test";

/**
 * W0-8 custom design system fixture, shared by e2e waves (W1/W2/W5).
 *
 * Seeds cannot contain custom components or custom design systems, so this fixture is
 * provisioned over the dev API (127.0.0.1:8787) by e2e/dev/custom-ds.setup.ts, which the
 * "dev" Playwright project depends on. Every dev run starts from a wiped .e2e-data/dev,
 * so the fixture is created fresh; each step still tolerates "already exists" so the
 * setup stays re-runnable against a warm server.
 *
 * Provisioned objects:
 * - design system `e2e-custom-ds` (registry-only, no builtin provider — the allowlist is
 *   exactly the published custom components assigned to it);
 * - component `e2e-rating-stars` (name `E2eRatingStars`, source server/fixtures/rating-stars.tsx),
 *   published as version 1 in that system;
 * - prototype `custom-ds-demo` (designSystem `e2e-custom-ds`, two screens navigated via the
 *   custom component's `press` event), published as version 1.
 */
export const CUSTOM_DS_ID = "e2e-custom-ds";
export const CUSTOM_DS_COMPONENT_ID = "e2e-rating-stars";
export const CUSTOM_DS_COMPONENT_NAME = "E2eRatingStars";
export const CUSTOM_DS_PROTOTYPE_ID = "custom-ds-demo";

const API = "http://127.0.0.1:8787/api";

export const customDsPrototypeDoc = {
  version: 1,
  id: CUSTOM_DS_PROTOTYPE_ID,
  name: "Custom DS demo — прототип на пользовательской дизайн-системе без builtin-компонентов",
  description:
    "Фикстура W0-8: прототип целиком на кастомной дизайн-системе (реестровая запись без builtin-провайдера). Единственный доступный компонент — опубликованный E2eRatingStars.",
  designSystem: CUSTOM_DS_ID,
  device: "mobile",
  startScreen: "rate",
  state: {},
  screens: [
    {
      id: "rate",
      name: "Оценка на кастомном компоненте",
      spec: {
        root: "stars",
        elements: {
          stars: {
            type: CUSTOM_DS_COMPONENT_NAME,
            props: { value: 3 },
            on: { press: { action: "navigate", params: { screenId: "thanks" } } },
          },
        },
      },
    },
    {
      id: "thanks",
      name: "Экран благодарности",
      spec: {
        root: "stars",
        elements: {
          stars: {
            type: CUSTOM_DS_COMPONENT_NAME,
            props: { value: 5 },
            on: { press: { action: "back", params: {} } },
          },
        },
      },
    },
  ],
} as const;

async function expectStatus(step: string, status: number, allowed: number[]): Promise<void> {
  if (!allowed.includes(status)) throw new Error(`custom-ds fixture: ${step} failed with HTTP ${status}`);
}

/** Provisions the custom-DS fixture over the dev API. Idempotent per warm server. */
export async function ensureCustomDsFixture(request: APIRequestContext): Promise<void> {
  const ds = await request.post(`${API}/design-systems`, {
    data: {
      id: CUSTOM_DS_ID,
      name: "E2E Custom DS",
      description: "Custom design system fixture provisioned by e2e setup (W0-8).",
    },
  });
  await expectStatus("create design system", ds.status(), [201, 409]);

  const source = await readFile("server/fixtures/rating-stars.tsx", "utf8");
  const component = await request.post(`${API}/components`, {
    data: { id: CUSTOM_DS_COMPONENT_ID, name: CUSTOM_DS_COMPONENT_NAME, source, designSystem: CUSTOM_DS_ID },
  });
  await expectStatus("create component", component.status(), [201, 409]);
  const componentPublish = await request.post(`${API}/components/${CUSTOM_DS_COMPONENT_ID}/publish`, {
    data: { baseRev: 1 },
  });
  await expectStatus("publish component", componentPublish.status(), [201, 409]);

  const prototype = await request.post(`${API}/prototypes`, { data: { doc: customDsPrototypeDoc } });
  await expectStatus("create prototype", prototype.status(), [201, 409]);
  const prototypePublish = await request.post(`${API}/prototypes/${CUSTOM_DS_PROTOTYPE_ID}/publish`, {
    data: { baseRev: 1 },
  });
  await expectStatus("publish prototype", prototypePublish.status(), [201, 409]);
}
