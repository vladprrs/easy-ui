import type { APIRequestContext } from "@playwright/test";
import { ensureStarterPrototype, starterizePrototype } from "./starter-ds.fixture";

export const SCREEN_REGIONS_ID = "e2e-screen-regions";
export const SCREEN_REGIONS_GALLERY_ID = "e2e-screen-regions-gallery";
/** Canvas-экран 390×1722 для проверки телефонной сцены плеера (высота фрейма каноническая). */
export const SCREEN_REGIONS_CANVAS_ID = "e2e-player-canvas";

const screenRegionsDoc = {
  version: 1,
  id: SCREEN_REGIONS_ID,
  name: "E2E screen regions",
  device: "mobile",
  startScreen: "regions",
  state: {},
  screens: [
    {
      id: "regions",
      name: "Regions",
      spec: {
        root: "root",
        elements: {
          root: { type: "@eui/FlowRoot", props: {}, children: ["status", "header", "content", "footer", "overlay"] },
          status: { type: "Text", props: { text: "9:41 · E2E status" }, region: "statusBar" },
          header: { type: "Text", props: { text: "E2E fixed header" }, region: "header" },
          content: {
            type: "Image",
            props: { src: "/e2e-screen-regions-long.svg", alt: "E2E long region content", width: 360, height: 1400 },
          },
          footer: { type: "Stack", props: { gap: "none" }, region: "footer", children: ["next"] },
          next: {
            type: "Button",
            props: { label: "Open regionless screen" },
            on: { press: { action: "navigate", params: { screenId: "plain" } } },
          },
          overlay: {
            type: "Overlay",
            props: { placement: "bottom", inset: "md", scrim: false },
            children: ["overlay-copy"],
          },
          "overlay-copy": { type: "Text", props: { text: "E2E overlay above footer" } },
        },
      },
    },
    {
      id: "plain",
      name: "No regions",
      spec: {
        root: "root",
        elements: {
          root: { type: "@eui/FlowRoot", props: {}, children: ["plain-content"] },
          "plain-content": {
            type: "Image",
            props: { src: "/e2e-screen-regions-plain.svg", alt: "E2E regionless content", width: 360, height: 1200 },
          },
        },
      },
    },
  ],
} as const;

const galleryHostOnlyDoc = {
  version: 1,
  id: SCREEN_REGIONS_GALLERY_ID,
  name: "E2E screen regions gallery host-only",
  device: "mobile",
  startScreen: "gallery",
  state: {},
  screens: [{
    id: "gallery",
    name: "Gallery host-only",
    spec: {
      root: "root",
      elements: {
        root: { type: "@eui/FlowRoot", props: {}, children: ["status", "header", "content", "footer"] },
        status: {
          type: "Image",
          props: { src: "/e2e-gallery-status.svg", alt: "Gallery inline status", width: 360, height: 20 },
          region: "statusBar",
        },
        header: {
          type: "Image",
          props: { src: "/e2e-gallery-header.svg", alt: "Gallery inline header", width: 360, height: 44 },
          region: "header",
        },
        content: {
          type: "Image",
          props: { src: "/e2e-gallery-content.svg", alt: "Gallery inline content", width: 360, height: 120 },
        },
        footer: {
          type: "Image",
          props: { src: "/e2e-gallery-footer.svg", alt: "Gallery inline footer", width: 360, height: 48 },
          region: "footer",
        },
      },
    },
  }],
} as const;

// Canvas-экран 390×1722: «телефон» вдвое длиннее каноника. Плеер обязан держать
// высоту фрейма канонической (844), а сам canvas скроллить вертикально до низа.
// Наполнение: верхний маркер, тяжёлый филлер и нижний маркер — чтобы низ canvas был
// достижим скроллом. Ширина filler 390 совпадает с canvas.width.
const canvasTallDoc = {
  version: 1,
  id: SCREEN_REGIONS_CANVAS_ID,
  name: "E2E player canvas tall",
  device: "mobile",
  startScreen: "canvas",
  state: {},
  screens: [{
    id: "canvas",
    name: "Canvas 390×1722",
    canvas: { width: 390, height: 1722 },
    spec: {
      root: "root",
      elements: {
        root: { type: "Stack", props: { gap: "none" }, children: ["canvas-top", "canvas-filler", "canvas-bottom"] },
        "canvas-top": { type: "Text", props: { text: "E2E canvas top" } },
        "canvas-filler": {
          type: "Image",
          props: { src: "/e2e-player-canvas-filler.svg", alt: "E2E canvas filler", width: 390, height: 1600 },
        },
        "canvas-bottom": { type: "Text", props: { text: "E2E canvas bottom" } },
      },
    },
  }],
} as const;

export async function provisionScreenRegionFixtures(request: APIRequestContext, api = "/api"): Promise<void> {
  await ensureStarterPrototype(request, starterizePrototype(screenRegionsDoc), { api });
  await ensureStarterPrototype(request, starterizePrototype(galleryHostOnlyDoc), { api });
  await ensureStarterPrototype(request, starterizePrototype(canvasTallDoc), { api });
}
