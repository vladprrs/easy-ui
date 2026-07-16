import { readFile } from "node:fs/promises";
import type { APIRequestContext } from "@playwright/test";
import { STARTER_DS_ID } from "../starter-ds.fixture";

/**
 * W0-8 custom design system fixture, shared by e2e waves (W1/W2/W5).
 *
 * Seeds cannot contain custom components or custom design systems, so this fixture is
 * provisioned through the Vite `/api` proxy by e2e/setup/dev.setup.ts, which the
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

export const COMPONENT_PAGE_IDS = {
  propsBadge: "e2e-props-badge",
  localState: "e2e-local-state",
  typedEvents: "e2e-typed-events-stars",
  namedSlots: "e2e-named-slots-panel",
  childSensitive: "e2e-child-sensitive",
  legacySlots: "e2e-legacy-slots",
  requiredPair: "e2e-required-pair",
  rejected: "e2e-rejected-badge",
} as const;

const DEV_API = "/api";

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
export async function ensureCustomDsFixture(request: APIRequestContext, api = DEV_API, name = "E2E Custom DS"): Promise<void> {
  const ds = await request.post(`${api}/design-systems`, {
    data: {
      id: CUSTOM_DS_ID,
      name,
      description: "Custom design system fixture provisioned by e2e setup (W0-8).",
    },
  });
  await expectStatus("create design system", ds.status(), [201, 409]);

  const source = await readFile("server/fixtures/rating-stars.tsx", "utf8");
  const component = await request.post(`${api}/components`, {
    data: { id: CUSTOM_DS_COMPONENT_ID, name: CUSTOM_DS_COMPONENT_NAME, source, designSystem: CUSTOM_DS_ID },
  });
  await expectStatus("create component", component.status(), [201, 409]);
  const componentPublish = await request.post(`${api}/components/${CUSTOM_DS_COMPONENT_ID}/publish`, {
    data: { baseRev: 1 },
  });
  await expectStatus("publish component", componentPublish.status(), [201, 409]);

  const prototype = await request.post(`${api}/prototypes`, { data: { doc: customDsPrototypeDoc } });
  await expectStatus("create prototype", prototype.status(), [201, 409]);
  const prototypePublish = await request.post(`${api}/prototypes/${CUSTOM_DS_PROTOTYPE_ID}/publish`, {
    data: { baseRev: 1 },
  });
  await expectStatus("publish prototype", prototypePublish.status(), [201, 409]);
}

type ComponentSeed = {
  id: string;
  name: string;
  fixture: string;
  designSystem?: string;
};

async function componentExists(request: APIRequestContext, api: string, id: string): Promise<boolean> {
  const response = await request.get(`${api}/components/${id}`);
  if (response.status() === 404) return false;
  await expectStatus(`read component ${id}`, response.status(), [200]);
  return true;
}

async function publishFixture(request: APIRequestContext, api: string, seed: ComponentSeed): Promise<void> {
  if (await componentExists(request, api, seed.id)) return;
  const source = await readFile(`server/fixtures/${seed.fixture}`, "utf8");
  const created = await request.post(`${api}/components`, {
    data: { id: seed.id, name: seed.name, source, designSystem: seed.designSystem ?? STARTER_DS_ID },
  });
  await expectStatus(`create component ${seed.id}`, created.status(), [201]);
  const published = await request.post(`${api}/components/${seed.id}/publish`, { data: { baseRev: 1 } });
  await expectStatus(`publish component ${seed.id}`, published.status(), [201]);
}

/** Publishes the W5a component-page fixtures into the selected stateful e2e API. */
export async function ensureComponentPageFixtures(request: APIRequestContext, api = DEV_API, customDsName = "E2E Custom DS"): Promise<void> {
  await ensureCustomDsFixture(request, api, customDsName);

  if (!(await componentExists(request, api, COMPONENT_PAGE_IDS.propsBadge))) {
    const firstSource = await readFile("server/fixtures/props-badge.tsx", "utf8");
    await expectStatus("create props badge", (await request.post(`${api}/components`, {
      data: { id: COMPONENT_PAGE_IDS.propsBadge, name: "E2ePropsBadge", source: firstSource, designSystem: STARTER_DS_ID },
    })).status(), [201]);
    await expectStatus("publish props badge v1", (await request.post(`${api}/components/${COMPONENT_PAGE_IDS.propsBadge}/publish`, {
      data: { baseRev: 1 },
    })).status(), [201]);
    const secondSource = firstSource
      .replace("Props badge version one", "Props badge version two")
      .replaceAll("Version one", "Version two");
    await expectStatus("save props badge v2", (await request.put(`${api}/components/${COMPONENT_PAGE_IDS.propsBadge}`, {
      data: { baseRev: 1, source: secondSource },
    })).status(), [200]);
    await expectStatus("publish props badge v2", (await request.post(`${api}/components/${COMPONENT_PAGE_IDS.propsBadge}/publish`, {
      data: { baseRev: 2 },
    })).status(), [201]);
  }

  await publishFixture(request, api, { id: COMPONENT_PAGE_IDS.localState, name: "E2eLocalState", fixture: "local-state.tsx" });
  await publishFixture(request, api, { id: COMPONENT_PAGE_IDS.typedEvents, name: "E2eTypedEventsStars", fixture: "typed-events-stars.tsx" });
  await publishFixture(request, api, { id: COMPONENT_PAGE_IDS.namedSlots, name: "E2eNamedSlotsPanel", fixture: "named-slots-panel.tsx" });
  await publishFixture(request, api, { id: COMPONENT_PAGE_IDS.childSensitive, name: "E2eChildSensitive", fixture: "child-sensitive.tsx" });
  await publishFixture(request, api, { id: COMPONENT_PAGE_IDS.legacySlots, name: "E2eLegacySlots", fixture: "legacy-slots.tsx" });
  await publishFixture(request, api, { id: COMPONENT_PAGE_IDS.requiredPair, name: "E2eRequiredPair", fixture: "required-pair.tsx" });
  await publishFixture(request, api, {
    id: "e2e-registry-props-badge",
    name: "E2eRegistryPropsBadge",
    fixture: "props-badge.tsx",
    designSystem: CUSTOM_DS_ID,
  });

  if (!(await componentExists(request, api, COMPONENT_PAGE_IDS.rejected))) {
    await publishFixture(request, api, { id: COMPONENT_PAGE_IDS.rejected, name: "E2eRejectedBadge", fixture: "props-badge.tsx" });
    const rejected = await request.post(`${api}/components/${COMPONENT_PAGE_IDS.rejected}/versions/1/status`, {
      data: { status: "rejected", baseStatusRev: 1, reason: "W5a execution gate fixture" },
    });
    await expectStatus("reject component fixture", rejected.status(), [200]);
  }
}
