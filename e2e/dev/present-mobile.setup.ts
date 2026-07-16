import { expect, test, type APIRequestContext } from "@playwright/test";

const DEV_API = "http://127.0.0.1:8787/api";

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
        root: { type: "Stack", props: { direction: "vertical", gap: "md" }, children: ["long-content", "overlay"] },
        "long-content": { type: "Image", props: { src: "/e2e-missing-placeholder.svg", alt: "Длинный flow-контент", width: 360, height: 1400 } },
        overlay: { type: "Overlay", props: { placement: "bottom", inset: "md", scrim: false }, children: ["overlay-copy"] },
        "overlay-copy": { type: "Badge", props: { text: "Flow Overlay", variant: "secondary" } },
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
        root: { type: "Stack", props: { direction: "vertical", gap: "md" }, children: ["heading", "overlay"] },
        heading: { type: "Heading", props: { text: screen.name, level: "h1" } },
        overlay: { type: "Overlay", props: { placement: "bottom-right", inset: "md", scrim: false }, children: ["overlay-copy"] },
        "overlay-copy": { type: "Badge", props: { text: `Canvas Overlay ${screen.id}`, variant: "secondary" } },
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
        root: { type: "Stack", props: { direction: "vertical", gap: "md" }, children: ["wide-content"] },
        "wide-content": { type: "Image", props: { src: "/e2e-missing-placeholder.svg", alt: "Широкий планшетный контент", width: 900, height: 240 } },
      },
    },
  }],
} as const;

function modalDoc(kind: "Dialog" | "Drawer") {
  const stateKey = `${kind.toLowerCase()}Open`;
  return {
    version: 1,
    id: `e2e-mobile-${kind.toLowerCase()}`,
    name: `E2E mobile ${kind}`,
    device: "mobile",
    startScreen: "modal",
    state: { [stateKey]: true },
    screens: [{
      id: "modal",
      name: `${kind} open`,
      spec: {
        root: "root",
        elements: {
          root: { type: "Stack", props: { direction: "vertical", gap: "md" }, children: ["long-content", "modal"] },
          "long-content": { type: "Image", props: { src: "/e2e-missing-placeholder.svg", alt: `Фон под ${kind}`, width: 360, height: 1400 } },
          modal: { type: kind, props: { title: `E2E ${kind}`, description: `Открытый ${kind}`, openPath: `/${stateKey}` }, children: ["close"] },
          close: {
            type: "Button",
            props: { label: `Закрыть ${kind}`, variant: "secondary" },
            on: { press: { action: "setState", params: { statePath: `/${stateKey}`, value: false } } },
          },
        },
      },
    }],
  } as const;
}

async function createFixture(request: APIRequestContext, doc: object): Promise<void> {
  const response = await request.post(`${DEV_API}/prototypes`, { data: { doc } });
  expect(response.status(), await response.text()).toBe(201);
}

test("provision mobile presentation fixtures over the dev API", async ({ request }) => {
  for (const doc of [flowOverlayDoc, canvasDoc, tabletWideDoc, modalDoc("Dialog"), modalDoc("Drawer")]) {
    await createFixture(request, doc);
  }
});
