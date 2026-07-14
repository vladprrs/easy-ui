import type { CatalogComponent } from "../api/client";
import { designSystems } from "../designSystems";
import { prototypeDocSchema, type PrototypeDoc } from "../prototype/schema";

/** Increment when the onboarding documents change in a backwards-incompatible way. */
export const BUILTIN_TEMPLATE_VERSION = 1;

export type BuiltinDesignSystemId = keyof typeof designSystems;

export function isBuiltinDesignSystem(id: string): id is BuiltinDesignSystemId {
  return Object.hasOwn(designSystems, id);
}

type TemplateFactory = (id: string, name: string) => PrototypeDoc;

const shadcnTemplate: TemplateFactory = (id, name) => prototypeDocSchema.parse({
  version: 1,
  id,
  name,
  description: "Стартовый прототип на дизайн-системе Shadcn.",
  designSystem: "shadcn",
  device: "mobile",
  startScreen: "welcome",
  state: {},
  screens: [
    {
      id: "welcome",
      name: "Первый экран",
      spec: {
        root: "card",
        elements: {
          card: { type: "Card", props: { title: name }, children: ["copy", "next"] },
          copy: { type: "Text", props: { text: "Начните собирать пользовательский сценарий." } },
          next: { type: "Button", props: { label: "Продолжить" }, on: { press: { action: "navigate", params: { screenId: "next-step" } } } },
        },
      },
    },
    {
      id: "next-step",
      name: "Следующий шаг",
      spec: {
        root: "card",
        elements: {
          card: { type: "Card", props: { title: "Следующий шаг" }, children: ["copy", "back"] },
          copy: { type: "Text", props: { text: "Замените этот контент своими экранами." } },
          back: { type: "Button", props: { label: "Назад" }, on: { press: { action: "back", params: {} } } },
        },
      },
    },
  ],
});

const wireframeTemplate: TemplateFactory = (id, name) => prototypeDocSchema.parse({
  version: 1,
  id,
  name,
  description: "Стартовый прототип на дизайн-системе Wireframe.",
  designSystem: "wireframe",
  device: "mobile",
  startScreen: "outline",
  state: {},
  screens: [
    {
      id: "outline",
      name: "Черновик",
      spec: {
        root: "card",
        elements: {
          card: { type: "Card", props: { title: name }, children: ["stack"] },
          stack: { type: "Stack", props: { gap: "md" }, children: ["heading", "copy", "next"] },
          heading: { type: "Heading", props: { text: "Первый экран", level: 1 } },
          copy: { type: "Text", props: { text: "Набросайте структуру будущего сценария." } },
          next: { type: "Button", props: { label: "Следующий шаг" }, on: { press: { action: "navigate", params: { screenId: "next-step" } } } },
        },
      },
    },
    {
      id: "next-step",
      name: "Следующий шаг",
      spec: {
        root: "card",
        elements: {
          card: { type: "Card", props: { title: "Следующий шаг" }, children: ["stack"] },
          stack: { type: "Stack", props: { gap: "md" }, children: ["copy", "back"] },
          copy: { type: "Text", props: { text: "Добавьте детали или новый переход." } },
          back: { type: "Button", props: { label: "Назад" }, on: { press: { action: "back", params: {} } } },
        },
      },
    },
  ],
});

const builtinTemplates: Record<BuiltinDesignSystemId, TemplateFactory> = {
  shadcn: shadcnTemplate,
  wireframe: wireframeTemplate,
};

export function buildBuiltinPrototypeTemplate(systemId: BuiltinDesignSystemId, id: string, name: string): PrototypeDoc {
  return builtinTemplates[systemId](id, name);
}

function isPropsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Published custom-component examples are validated against their definitions by the API.
 * Without an example the browser cannot safely infer required props from registry metadata.
 */
export function findCustomStarterComponent(systemId: string, components: CatalogComponent[]): CatalogComponent | null {
  return components.find((component) => component.designSystem === systemId && isPropsObject(component.example)) ?? null;
}

export function buildCustomPrototypeTemplate(systemId: string, component: CatalogComponent, id: string, name: string): PrototypeDoc {
  if (component.designSystem !== systemId || !isPropsObject(component.example)) {
    throw new Error(`Custom design system ${systemId} has no valid starter component`);
  }
  return prototypeDocSchema.parse({
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
      spec: {
        root: "starter",
        elements: { starter: { type: component.name, props: component.example } },
      },
    }],
  });
}

export function createPrototypeId(now = Date.now(), random = Math.random()): string {
  return `prototype-${now.toString(36)}-${Math.floor(random * 0x1000000).toString(36).padStart(5, "0")}`;
}
