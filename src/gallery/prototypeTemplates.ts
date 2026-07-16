import type { CatalogComponent } from "../api/client";
import { inputPrototypeDocSchema, type PrototypeDoc } from "../prototype/schema";

/** Increment when the onboarding document changes incompatibly. */
export const TEMPLATE_VERSION = 2;

export function hasUsableComponents(systemId: string, components: CatalogComponent[]): boolean {
  return components.some((component) => component.designSystem === systemId);
}

/**
 * Host-only starter. Image and Hotspot are permanently supplied by the app,
 * so the document never acquires an implicit dependency on a builtin catalog.
 */
export function buildPrototypeTemplate(systemId: string, id: string, name: string): PrototypeDoc {
  return inputPrototypeDocSchema.parse({
    version: 1,
    id,
    name,
    description: `Стартовый прототип на дизайн-системе ${systemId}.`,
    designSystem: systemId,
    device: "mobile",
    startScreen: "start",
    state: {},
    screens: [{
      id: "start",
      name: "Первый экран",
      canvas: { width: 390, height: 844 },
      spec: {
        root: "image",
        elements: {
          image: {
            type: "Image",
            props: { src: "/design/cjm-ui/assets/mascot-laptop.png", alt: name, width: 390, height: 844, objectFit: "cover" },
            children: ["hotspot"],
          },
          hotspot: {
            type: "Hotspot",
            props: { x: 24, y: 720, width: 342, height: 80, ariaLabel: "Начать сначала" },
            on: { press: { action: "restart", params: {} } },
          },
        },
      },
    }],
  });
}

export function createPrototypeId(now = Date.now(), random: () => number = Math.random): string {
  return `prototype-${now.toString(36)}-${Math.floor(random() * 0x1000000).toString(36).padStart(5, "0")}`;
}
