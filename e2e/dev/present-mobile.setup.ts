import { expect, type APIRequestContext } from "@playwright/test";
import { STARTER_STACK, STARTER_TEXT, starterizePrototype } from "../starter-ds.fixture";

const DEV_API = "/api";

const flowOverlayDoc = {
  version: 1,
  id: "e2e-mobile-flow-overlay",
  name: "E2E mobile flow Overlay",
  device: "mobile",
  startScreen: "main",
  state: {},
  screens: [{
    id: "main",
    name: "Long flow",
    spec: {
      root: "root",
      elements: {
        root: { type: STARTER_STACK, props: { gap: "md" }, children: ["long-content", "overlay"] },
        "long-content": { type: "Image", props: { src: "/e2e-missing-placeholder.svg", alt: "Длинный flow-контент", width: 360, height: 1400 } },
        overlay: { type: "Overlay", props: { placement: "bottom", inset: "md", scrim: false }, children: ["overlay-copy"] },
        "overlay-copy": { type: STARTER_TEXT, props: { text: "Flow Overlay" } },
      },
    },
  }],
} as const;

const canvasDoc = {
  version: 1,
  id: "e2e-mobile-canvas",
  name: "E2E mobile canvas boundaries",
  device: "mobile",
  startScreen: "boundary",
  state: {},
  screens: [
    { id: "boundary", name: "420×920 boundary", canvas: { width: 420, height: 920 } },
    { id: "long", name: "420×1200 long", canvas: { width: 420, height: 1200 } },
  ].map((screen) => ({
    ...screen,
    spec: {
      root: "root",
      elements: {
        root: { type: STARTER_STACK, props: { gap: "md" }, children: ["heading", "overlay"] },
        heading: { type: STARTER_TEXT, props: { text: screen.name } },
        overlay: { type: "Overlay", props: { placement: "bottom-right", inset: "md", scrim: false }, children: ["overlay-copy"] },
        "overlay-copy": { type: STARTER_TEXT, props: { text: `Canvas Overlay ${screen.id}` } },
      },
    },
  })),
} as const;

const tabletWideDoc = {
  version: 1,
  id: "e2e-tablet-wide-flow",
  name: "E2E wide tablet flow",
  device: "tablet",
  startScreen: "wide",
  state: {},
  screens: [{
    id: "wide",
    name: "Wide tablet content",
    spec: {
      root: "root",
      elements: {
        root: { type: STARTER_STACK, props: { gap: "md" }, children: ["wide-content"] },
        "wide-content": { type: "Image", props: { src: "/e2e-missing-placeholder.svg", alt: "Широкий планшетный контент", width: 900, height: 240 } },
      },
    },
  }],
} as const;

async function createFixture(request: APIRequestContext, doc: object): Promise<void> {
  const response = await request.post(`${DEV_API}/prototypes`, { data: { doc: starterizePrototype(doc as Record<string, unknown>) } });
  expect(response.status(), await response.text()).toBe(201);
}

export async function provisionMobilePresentationFixtures(request: APIRequestContext) {
  for (const doc of [flowOverlayDoc, canvasDoc, tabletWideDoc]) {
    await createFixture(request, doc);
  }
}
