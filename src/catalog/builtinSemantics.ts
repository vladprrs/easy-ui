/**
 * Static name-based semantic metadata for the host content types
 * Image/Hotspot, consumed by
 * `validatePrototype` to emit accessibility / composition / URL warnings.
 *
 * Custom components declare `interactive` / `accessibleLabelProps` / `urlProps`
 * on their own definition (see `ComponentDefinition`).
 */
export type BuiltinSemantics = {
  /** The component is an interactive control (drives the no-handler / a11y warnings). */
  interactive?: boolean;
  /**
   * Self-driven interactive controls manage their own internal UI state and are
   * meaningful standalone (tab switch, dropdown open, external link). They are
   * still `interactive`, but are exempt from the "no handler / no binding" warning.
   */
  selfDriven?: boolean;
  /** Prop names that carry the control's accessible label. */
  accessibleLabelProps?: string[];
  /** Prop names whose value is a URL. */
  urlProps?: string[];
};

export const BUILTIN_SEMANTICS: Record<string, BuiltinSemantics> = {
  Hotspot: { interactive: true, accessibleLabelProps: ["ariaLabel"] },
  Image: { urlProps: ["src"] },
};

/** Local-path prefixes served by the player runtime; URL-prop warnings skip these. */
export const PUBLIC_RUNTIME_PATH_PREFIXES = ["/api/assets/", "/design/", "/fonts/", "/images/"];

export const isPublicRuntimePath = (value: string): boolean =>
  PUBLIC_RUNTIME_PATH_PREFIXES.some((prefix) => value.startsWith(prefix));
