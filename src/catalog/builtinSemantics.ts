/**
 * Static name-based semantic metadata for builtin components and the host
 * content types Image/Hotspot, consumed by
 * `validatePrototype` to emit accessibility / composition / URL warnings.
 *
 * Custom components declare `interactive` / `accessibleLabelProps` / `urlProps`
 * on their own definition (see `ComponentDefinition`); builtins are code-backed
 * and get their semantics from this table, keyed by component name. The table is
 * shared across systems: a warning only fires when the referenced prop actually
 * carries a problematic value, so listing a prop a given system's component does
 * not have is harmless (its value is simply absent at runtime).
 *
 * `accessibleLabelProps` / `urlProps` were derived from the real prop schemas of
 * `@json-render/shadcn`'s catalog and `src/designSystems/wireframe/definitions.ts`.
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
  // Pure action triggers / value controls: dead without a handler or a two-way binding.
  Button: { interactive: true, accessibleLabelProps: ["label"] },
  // Host content type; kept name-based so it has identical semantics without a DS binding.
  Hotspot: { interactive: true, accessibleLabelProps: ["ariaLabel"] },
  Input: { interactive: true, accessibleLabelProps: ["label"] },
  Textarea: { interactive: true, accessibleLabelProps: ["label"] },
  Select: { interactive: true, accessibleLabelProps: ["label"] },
  Checkbox: { interactive: true, accessibleLabelProps: ["label"] },
  Radio: { interactive: true, accessibleLabelProps: ["label"] },
  Switch: { interactive: true, accessibleLabelProps: ["label"] },
  Slider: { interactive: true, accessibleLabelProps: ["label"] },
  Toggle: { interactive: true, accessibleLabelProps: ["label"] },
  // Self-driven interactive controls (exempt from the no-handler warning).
  Link: { interactive: true, selfDriven: true, accessibleLabelProps: ["label"], urlProps: ["href"] },
  Tabs: { interactive: true, selfDriven: true },
  DropdownMenu: { interactive: true, selfDriven: true, accessibleLabelProps: ["label"] },
  ToggleGroup: { interactive: true, selfDriven: true },
  ButtonGroup: { interactive: true, selfDriven: true },
  Pagination: { interactive: true, selfDriven: true },
  // Non-interactive components that nonetheless carry URL props.
  // Host content type; kept name-based so URL diagnostics work in custom-only catalogs.
  Image: { urlProps: ["src"] },
  Avatar: { urlProps: ["src"] },
};

/** Local-path prefixes served by the player runtime; URL-prop warnings skip these. */
export const PUBLIC_RUNTIME_PATH_PREFIXES = ["/api/assets/", "/design/", "/fonts/", "/images/"];

export const isPublicRuntimePath = (value: string): boolean =>
  PUBLIC_RUNTIME_PATH_PREFIXES.some((prefix) => value.startsWith(prefix));
