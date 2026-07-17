import { readFile } from "node:fs/promises";
import type { APIRequestContext } from "@playwright/test";

export const STARTER_DS_ID = "e2e-starter";
export const STARTER_BUTTON = "StarterButton";
export const STARTER_TEXT = "StarterText";
export const STARTER_STACK = "StarterStack";

type JsonObject = Record<string, unknown>;

type StarterDescription = {
  id: string;
  name: string;
  description: string;
  components: Array<{ id: string; name: string; source: string }>;
};

async function expectStatus(step: string, response: { status(): number; text(): Promise<string> }, allowed: number[]) {
  if (allowed.includes(response.status())) return;
  throw new Error(`starter fixture: ${step} failed with HTTP ${response.status()}: ${await response.text()}`);
}

/** Publish the declarative B3 starter design system exactly as checked in. */
export async function ensureStarterDesignSystem(request: APIRequestContext, api = "/api"): Promise<void> {
  const root = "test/fixtures/starter";
  const description = JSON.parse(await readFile(`${root}/design-system.json`, "utf8")) as StarterDescription;
  const createdSystem = await request.post(`${api}/design-systems`, {
    data: { id: description.id, name: description.name, description: description.description },
  });
  await expectStatus("create design system", createdSystem, [201, 409]);

  for (const component of description.components) {
    const existing = await request.get(`${api}/components/${component.id}`);
    if (existing.status() !== 404) {
      await expectStatus(`read component ${component.id}`, existing, [200]);
      continue;
    }
    const source = await readFile(`${root}/${component.source}`, "utf8");
    const created = await request.post(`${api}/components`, {
      data: { id: component.id, name: component.name, source, designSystem: description.id },
    });
    await expectStatus(`create component ${component.id}`, created, [201]);
    const published = await request.post(`${api}/components/${component.id}/publish`, { data: { baseRev: 1 } });
    await expectStatus(`publish component ${component.id}`, published, [201]);
  }
}

/** Create a prototype through the public API and optionally publish its first immutable version. */
export async function ensureStarterPrototype(
  request: APIRequestContext,
  doc: JsonObject,
  options: { api?: string; publish?: boolean; message?: string } = {},
): Promise<void> {
  const api = options.api ?? "/api";
  const id = String(doc.id);
  const existing = await request.get(`${api}/prototypes/${id}`);
  if (existing.status() === 404) {
    const created = await request.post(`${api}/prototypes`, {
      data: { doc, message: options.message ?? "E2E starter API fixture" },
    });
    await expectStatus(`create prototype ${id}`, created, [201]);
  } else {
    await expectStatus(`read prototype ${id}`, existing, [200]);
  }

  if (options.publish === false) return;
  const metaResponse = await request.get(`${api}/prototypes/${id}`);
  await expectStatus(`read prototype metadata ${id}`, metaResponse, [200]);
  const meta = await metaResponse.json() as { headRev: number; latestVersion: number | null };
  if (meta.latestVersion === null) {
    const published = await request.post(`${api}/prototypes/${id}/publish`, {
      data: { baseRev: meta.headRev, message: options.message ?? "E2E starter API fixture" },
    });
    await expectStatus(`publish prototype ${id}`, published, [201]);
  }
}

function starterElement(value: unknown): JsonObject {
  const element = value as JsonObject;
  const type = String(element.type);
  const props = (element.props ?? {}) as JsonObject;
  const shared = Object.fromEntries(Object.entries(element).filter(([key]) => !["type", "props"].includes(key)));

  if (type === "Image") {
    return {
      ...shared,
      type,
      props: {
        src: typeof props.src === "string" ? props.src : "/design/cjm-ui/assets/mascot-laptop.png",
        alt: typeof props.alt === "string" ? props.alt : "E2E fixture image",
        ...(typeof props.width === "number" ? { width: props.width } : {}),
        ...(typeof props.height === "number" ? { height: props.height } : {}),
        ...(typeof props.objectFit === "string" ? { objectFit: props.objectFit } : {}),
      },
    };
  }
  if (type === "Hotspot" || type === "Overlay" || type === "@eui/FlowRoot") return { ...shared, type, props };

  if (type === "Button" || type === "Link") {
    return {
      ...shared,
      type: STARTER_BUTTON,
      props: {
        label: props.label ?? props.text ?? "Continue",
        ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
      },
    };
  }

  if (Array.isArray(element.children)) {
    const gap = ["none", "xs", "sm", "md", "lg", "xl"].includes(String(props.gap)) ? props.gap : "md";
    return { ...shared, type: STARTER_STACK, props: { gap } };
  }

  return {
    ...shared,
    type: STARTER_TEXT,
    props: { text: props.text ?? props.label ?? props.title ?? props.description ?? type },
  };
}

/** Convert historical test documents to a custom-only catalog before API creation. */
export function starterizePrototype(doc: JsonObject, overrides: Partial<JsonObject> = {}): JsonObject {
  const screens = (doc.screens as JsonObject[]).map((screen) => {
    const spec = screen.spec as JsonObject;
    const elements = spec.elements as Record<string, unknown>;
    return {
      ...screen,
      spec: { ...spec, elements: Object.fromEntries(Object.entries(elements).map(([key, value]) => [key, starterElement(value)])) },
    };
  });
  return { ...doc, ...overrides, designSystem: STARTER_DS_ID, screens };
}

export async function starterPrototypeFromFile(path: string, overrides: Partial<JsonObject> = {}): Promise<JsonObject> {
  return starterizePrototype(JSON.parse(await readFile(path, "utf8")) as JsonObject, overrides);
}

/** Core cross-surface documents shared by dev and production-preview projects. */
export async function ensureStarterPrototypeSuite(request: APIRequestContext, api = "/api"): Promise<void> {
  for (const name of ["checkout", "branching-checkout", "flows-perf", "hello-world", "settings", "scale-demo", "composition-demo"] as const) {
    await ensureStarterPrototype(request, await starterPrototypeFromFile(`test/fixtures/${name}.json`), { api });
  }
  const declarative = JSON.parse(await readFile("test/fixtures/starter/prototype.json", "utf8")) as JsonObject;
  await ensureStarterPrototype(request, declarative, { api });
}

export async function provisionStarterFixtures(request: APIRequestContext, api = "/api"): Promise<void> {
  await ensureStarterDesignSystem(request, api);
  await ensureStarterPrototypeSuite(request, api);
}
