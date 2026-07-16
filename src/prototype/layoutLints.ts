import type { ComponentDefinition } from "../catalog/definitions";
import { unwrapZodSchema, zodObjectShape } from "../catalog/zodIntrospect";
import { resolveSpacingScale } from "../designSystems/spacingScale";
import { spaceTokens, type SpaceToken } from "../designSystems/types";
import type { PrototypeDoc } from "./schema";
import type { ValidationIssue } from "./types";

export const layoutLintCodes = [
  "layout/spacer-chain",
  "layout/spacer-heavy",
  "layout/spacer-vs-gap",
  "layout/default-props-noise",
  "layout/legacy-numeric-spacing",
  "layout/classname-positioning",
] as const;

export type LayoutLintCode = (typeof layoutLintCodes)[number];

type Element = PrototypeDoc["screens"][number]["spec"]["elements"][string];
type LocatedElement = { screenIndex: number; key: string; element: Element; definition?: ComponentDefinition };
type Axis = "vertical" | "horizontal";

// TODO(2027-01-15): remove after all surviving YpSpacer versions publish layout.spacer metadata.
const LEGACY_SPACER_ALLOWLIST = new Set(["YpSpacer"]);
const LEGACY_NUMERIC_SPACING_PROPS: ReadonlyArray<readonly [component: string, prop: string]> = [["YpSpacer", "size"]];

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isDirective = (value: unknown): boolean => object(value) && Object.keys(value).some((key) => key.startsWith("$"));
const isStatic = (value: unknown): boolean => {
  if (isDirective(value)) return false;
  if (Array.isArray(value)) return value.every(isStatic);
  return !object(value) || Object.values(value).every(isStatic);
};
const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
};
const escapePointer = (part: string | number): string => String(part).replaceAll("~", "~0").replaceAll("/", "~1");
const elementPath = (screenIndex: number, key: string): string => `/screens/${screenIndex}/spec/elements/${escapePointer(key)}`;
const warning = (code: LayoutLintCode, located: LocatedElement, message: string): ValidationIssue => ({
  code,
  path: elementPath(located.screenIndex, located.key),
  message,
});

const isSpacer = (located: LocatedElement): boolean => located.definition?.layout?.spacer === true || LEGACY_SPACER_ALLOWLIST.has(located.element.type);

function fieldValue(element: Element, definition: ComponentDefinition | undefined, prop: string): { known: boolean; value?: unknown } {
  if (Object.hasOwn(element.props, prop)) {
    const value = element.props[prop];
    return isStatic(value) ? { known: true, value } : { known: false };
  }
  if (!definition) return { known: false };
  const field = zodObjectShape(definition.props)?.[prop];
  if (!field) return { known: false };
  const info = unwrapZodSchema(field);
  return info.hasDefault && isStatic(info.defaultValue) ? { known: true, value: info.defaultValue } : { known: false };
}

function directionFor(located: LocatedElement): Axis | null {
  const flow = located.definition?.layout?.flow;
  if (!flow) return null;
  if (typeof flow.direction === "string") return flow.direction;
  const direction = fieldValue(located.element, located.definition, flow.direction.prop);
  if (!direction.known) return null;
  const key = scalarKey(direction.value);
  if (flow.direction.vertical.some((value) => scalarKey(value) === key)) return "vertical";
  if (flow.direction.horizontal.some((value) => scalarKey(value) === key)) return "horizontal";
  return null;
}

const scalarKey = (value: unknown): string => `${value === null ? "null" : typeof value}:${String(value)}`;

function spacerAxis(located: LocatedElement): Axis | null {
  const axis = fieldValue(located.element, located.definition, "axis");
  return axis.known && (axis.value === "vertical" || axis.value === "horizontal") ? axis.value : null;
}

function exactTokenForPx(value: unknown, scale: Record<SpaceToken, string>): SpaceToken | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return spaceTokens.find((token) => scale[token] === `${value}px`) ?? null;
}

function replacementMessage(values: unknown[], scale: Record<SpaceToken, string>, target: string): string {
  const tokens = values.map((value) => exactTokenForPx(value, scale));
  const exact = tokens.length > 0 && tokens.every((token) => token !== null && token === tokens[0]);
  return exact
    ? `replace them with ${target}="${tokens[0]}" (an exact pixel equivalent)`
    : `replace them with a spacing token on ${target}; no exact token can be inferred`;
}

function riskyClassToken(token: string): boolean {
  const utility = token.slice(token.lastIndexOf(":") + 1).replace(/^!/, "");
  if (/^(?:absolute|fixed|sticky|static|relative)$/.test(utility)) return true;
  if (/^-?(?:inset(?:-[xy])?|top|right|bottom|left)-.+$/.test(utility)) return true;
  if (/^-?z-.+$/.test(utility)) return true;
  return /^-?m(?:[xytrblse])?-.+$/.test(utility);
}

export function classNamePositioningTokens(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  return value.trim().split(/\s+/).filter(Boolean).filter(riskyClassToken);
}

function defaultPropCount(located: LocatedElement): number {
  if (!located.definition) return 0;
  const shape = zodObjectShape(located.definition.props);
  if (!shape) return 0;
  let count = 0;
  for (const [name, value] of Object.entries(located.element.props)) {
    if (!isStatic(value)) continue;
    const field = shape[name];
    if (!field) continue;
    const info = unwrapZodSchema(field);
    if (info.hasDefault && deepEqual(value, info.defaultValue)) count += 1;
  }
  return count;
}

/** Layout advisories are intentionally independent from structural validation and never return errors. */
export function lintPrototypeLayouts(
  doc: PrototypeDoc,
  definitions: Record<string, ComponentDefinition>,
  options: { themeTokens?: Record<string, string | number> } = {},
): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  // Validation has no client-side access to custom-DS themes. Unknown systems therefore resolve canonically.
  const scale = resolveSpacingScale(doc.designSystem, options.themeTokens);
  const numericOccurrences = new Map<string, { value: number; items: LocatedElement[] }>();

  for (const [screenIndex, screen] of doc.screens.entries()) {
    const locatedByKey = new Map<string, LocatedElement>();
    for (const [key, element] of Object.entries(screen.spec.elements)) {
      locatedByKey.set(key, { screenIndex, key, element, definition: definitions[element.type] });
    }
    const all = [...locatedByKey.values()];
    const spacers = all.filter(isSpacer);

    if (spacers.length >= 8 && spacers.length / all.length > 0.25) {
      warnings.push(warning("layout/spacer-heavy", spacers[0]!, `screen uses ${spacers.length} spacer elements out of ${all.length} (>25%); prefer parent spacing primitives`));
    }

    for (const parent of all) {
      const groups = new Map<string, LocatedElement[]>();
      for (const childKey of parent.element.children ?? []) {
        const child = locatedByKey.get(childKey);
        if (!child) continue;
        const slot = child.element.slot ?? "default";
        const group = groups.get(slot) ?? [];
        group.push(child);
        groups.set(slot, group);
      }
      for (const [slot, children] of groups) {
        let start = 0;
        while (start < children.length) {
          if (!isSpacer(children[start]!)) { start += 1; continue; }
          let end = start + 1;
          while (end < children.length && isSpacer(children[end]!)) end += 1;
          if (end - start >= 2) {
            const chain = children.slice(start, end);
            warnings.push(warning("layout/spacer-chain", chain[0]!, `${chain.length} consecutive spacers in ${slot === "default" ? "the default slot" : `slot "${slot}"`}; ${replacementMessage(chain.map((item) => item.element.props.size), scale, "the parent gap")}`));
          }
          start = end;
        }
      }

      const flow = parent.definition?.layout?.flow;
      if (flow && parent.definition?.layout?.spacing?.includes("gap")) {
        const direction = directionFor(parent);
        const gap = Object.hasOwn(parent.element.props, "gap")
          ? fieldValue(parent.element, parent.definition, "gap")
          : (() => {
              const resolved = fieldValue(parent.element, parent.definition, "gap");
              return resolved.known ? resolved : { known: true, value: undefined };
            })();
        if (direction && gap.known && (gap.value === undefined || gap.value === "none")) {
          const slot = flow.slot ?? "default";
          const compatible = (groups.get(slot) ?? []).filter((child) => isSpacer(child) && spacerAxis(child) === direction);
          if (compatible.length > 0) {
            warnings.push(warning("layout/spacer-vs-gap", parent, `${parent.key} has ${compatible.length} ${direction} spacer child${compatible.length === 1 ? "" : "ren"}; ${replacementMessage(compatible.map((item) => item.element.props.size), scale, "gap")}`));
          }
        }
      }
    }

    for (const located of all) {
      const defaults = defaultPropCount(located);
      if (defaults >= 5) warnings.push(warning("layout/default-props-noise", located, `${located.key} explicitly repeats ${defaults} schema defaults; omit default-valued props`));

      const classTokens = classNamePositioningTokens(located.element.props.className);
      if (classTokens?.length) warnings.push(warning("layout/classname-positioning", located, `${located.key} uses layout-sensitive className utilities: ${classTokens.join(" ")}; use component layout props instead`));

      for (const [component, prop] of LEGACY_NUMERIC_SPACING_PROPS) {
        if (located.element.type !== component) continue;
        const value = located.element.props[prop];
        if (typeof value !== "number" || !Number.isFinite(value) || value === 0 || value === 1) continue;
        const mapKey = `${component}\u0000${prop}\u0000${value}`;
        const entry = numericOccurrences.get(mapKey) ?? { value, items: [] };
        entry.items.push(located);
        numericOccurrences.set(mapKey, entry);
      }
    }
  }

  for (const { value, items } of numericOccurrences.values()) {
    if (items.length < 5) continue;
    const token = exactTokenForPx(value, scale);
    const advice = token
      ? `replace with spacing token "${token}" (an exact ${value}px equivalent)`
      : "replace with a semantic spacing token; there is no exact token equivalent";
    warnings.push(warning("layout/legacy-numeric-spacing", items[0]!, `${items.length} YpSpacer.size occurrences repeat ${value}px; ${advice}`));
  }

  return warnings;
}
