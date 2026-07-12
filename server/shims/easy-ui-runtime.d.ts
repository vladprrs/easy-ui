// Type declaration for the `easy-ui/runtime` module (host ABI v2). Published
// components import from here; the actual runtime is served from
// `/api/shims/v2/easy-ui-runtime.js`. Resolved during publish typecheck via a
// `paths` mapping written into the temporary tsconfig.
import type { ReactElement, ReactNode } from "react";
import type { BaseComponentProps } from "@json-render/react";

/** Props contract for ABI v2 custom components. */
export interface EasyUIComponentProps<P = Record<string, unknown>> extends BaseComponentProps<P> {
  /** Emit a declared event, optionally with a typed payload. */
  emit: (event: string, payload?: unknown) => void;
  /** Named-slot children (`default` always present). */
  slots: Record<string, ReactNode>;
}

/** Read a design-system token value (resolves against the active theme snapshot). */
export declare function token(key: string): string;

export interface IconProps {
  name: string;
  size?: number;
  theme?: "light" | "dark";
}

/** Render a design-system icon by name. */
export declare function Icon(props: IconProps): ReactElement | null;
