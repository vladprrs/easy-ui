import type { PrototypeDoc, RegionKind } from "../prototype/schema";

export type Screen = PrototypeDoc["screens"][number];

type ScreenPatch = Partial<Pick<Screen, "name" | "note" | "stateOverrides" | "canvas">>;
type DocMetaPatch = Partial<Pick<PrototypeDoc, "name" | "description" | "startScreen" | "device">>;

function patchObject<T extends object>(value: T, patch: Partial<T>): T {
  let changed = false;
  const next = { ...value };

  for (const key of Object.keys(patch) as (keyof T)[]) {
    const patchValue = patch[key];
    if (patchValue === undefined) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        delete next[key];
        changed = true;
      }
    } else if (!Object.is(value[key], patchValue)) {
      next[key] = patchValue as T[keyof T];
      changed = true;
    }
  }

  return changed ? next : value;
}

export function setElementProps(
  doc: PrototypeDoc,
  screenId: string,
  elementKey: string,
  props: Record<string, unknown>,
): PrototypeDoc {
  const screenIndex = doc.screens.findIndex((screen) => screen.id === screenId);
  if (screenIndex < 0) return doc;
  const screen = doc.screens[screenIndex]!;
  const element = screen.spec.elements[elementKey];
  if (!element || Object.is(element.props, props)) return doc;

  const nextScreen: Screen = {
    ...screen,
    spec: {
      ...screen.spec,
      elements: {
        ...screen.spec.elements,
        [elementKey]: { ...element, props },
      },
    },
  };
  const screens = [...doc.screens];
  screens[screenIndex] = nextScreen;
  return { ...doc, screens };
}

export function setElementRegion(
  doc: PrototypeDoc,
  screenId: string,
  elementKey: string,
  region: RegionKind | undefined,
): PrototypeDoc {
  const screenIndex = doc.screens.findIndex((screen) => screen.id === screenId);
  if (screenIndex < 0) return doc;
  const screen = doc.screens[screenIndex]!;
  const element = screen.spec.elements[elementKey];
  if (!element || element.region === region) return doc;

  const nextElement = { ...element, region };
  if (region === undefined) delete nextElement.region;
  const nextScreen: Screen = {
    ...screen,
    spec: {
      ...screen.spec,
      elements: {
        ...screen.spec.elements,
        [elementKey]: nextElement,
      },
    },
  };
  const screens = [...doc.screens];
  screens[screenIndex] = nextScreen;
  return { ...doc, screens };
}

export function patchScreen(doc: PrototypeDoc, screenId: string, patch: ScreenPatch): PrototypeDoc {
  const screenIndex = doc.screens.findIndex((screen) => screen.id === screenId);
  if (screenIndex < 0) return doc;
  const nextScreen = patchObject<Screen>(doc.screens[screenIndex]!, patch);
  if (nextScreen === doc.screens[screenIndex]) return doc;
  const screens = [...doc.screens];
  screens[screenIndex] = nextScreen;
  return { ...doc, screens };
}

export function patchDocMeta(doc: PrototypeDoc, patch: DocMetaPatch): PrototypeDoc {
  return patchObject<PrototypeDoc>(doc, patch);
}
